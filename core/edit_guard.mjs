import os from 'node:os';
import path from 'node:path';
import { normalizePath, nowIso, withTransaction } from './db.mjs';
import { resolveGitInfo, toRepoRelativePath } from './sources.mjs';

export const ACTIVE_EDIT_TTL_MS = 15 * 60 * 1000;

const HIGH_CONFLICT_EXACT = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'cargo.toml',
  'cargo.lock',
  'go.mod',
  'go.sum',
  'pyproject.toml',
  'uv.lock',
  'poetry.lock',
]);

/**
 * Check whether a file path is a shared manifest, lockfile, or schema prone to merge conflicts across worktrees.
 */
export function isHighConflictFile(filePath) {
  const base = path.posix.basename(String(filePath || '').replace(/\\/g, '/')).toLowerCase();
  if (!base) return false;
  if (HIGH_CONFLICT_EXACT.has(base)) return true;
  if (base.endsWith('.proto')) return true;
  if (/^schema\..+$/.test(base)) return true;
  if (/^openapi\..+$/.test(base)) return true;
  return false;
}

function isInsideDir(targetNorm, dirNorm) {
  if (!targetNorm || !dirNorm) return false;
  if (targetNorm === dirNorm) return true;
  const prefix = dirNorm.endsWith('/') ? dirNorm : `${dirNorm}/`;
  return targetNorm.startsWith(prefix);
}

/**
 * Fast-exit check: ignore edits inside ~/.gemini/, outside all active workspace paths,
 * or inside os.tmpdir() (unless the active workspace itself is a dedicated subdirectory inside os.tmpdir()).
 */
export function isIgnoredPath(rawFilePath, workspacePaths = [], cwd = '') {
  if (!rawFilePath) return true;
  const resolved = path.isAbsolute(rawFilePath) || !cwd ? rawFilePath : path.join(cwd, rawFilePath);
  const normFile = normalizePath(resolved);
  if (!normFile) return true;

  const geminiDir = normalizePath(path.join(os.homedir(), '.gemini'));
  if (isInsideDir(normFile, geminiDir)) {
    return true;
  }

  const validWorkspaces = (workspacePaths || []).map((w) => normalizePath(w)).filter(Boolean);
  if (validWorkspaces.length > 0) {
    const insideAny = validWorkspaces.some((ws) => isInsideDir(normFile, ws));
    if (!insideAny) return true;
  }

  const tmpDir = normalizePath(os.tmpdir());
  if (isInsideDir(normFile, tmpDir)) {
    const hasScopedTmpWorkspace = validWorkspaces.some(
      (ws) => ws !== tmpDir && isInsideDir(ws, tmpDir)
    );
    if (!hasScopedTmpWorkspace) {
      return true;
    }
  }

  return false;
}

function resolveEditTarget({ file_path, workspace_paths = [], cwd = '' }) {
  const rawAbs = path.isAbsolute(file_path) || !cwd ? file_path : path.join(cwd, file_path);
  const normFile = normalizePath(rawAbs);

  const normWorkspaces = (workspace_paths || []).map((w) => normalizePath(w)).filter(Boolean);
  let matchedWorkspace = '';
  for (const ws of normWorkspaces) {
    if (isInsideDir(normFile, ws) && ws.length > matchedWorkspace.length) {
      matchedWorkspace = ws;
    }
  }
  const fallbackDir = normalizePath(cwd) || normalizePath(path.dirname(normFile));
  const checkDir = matchedWorkspace || fallbackDir || normalizePath(path.dirname(normFile));
  const gitInfo = resolveGitInfo(checkDir);

  const repoId = gitInfo.isGit ? gitInfo.repoId : '';
  const workspaceDir = gitInfo.isGit && gitInfo.topLevel ? gitInfo.topLevel : matchedWorkspace || fallbackDir;
  const relFilePath = gitInfo.isGit ? toRepoRelativePath(normFile, gitInfo) : normFile;

  return {
    normFile,
    repoId,
    workspaceDir,
    relFilePath,
    isGit: gitInfo.isGit,
  };
}

export function pruneExpiredEdits(db, now = nowIso()) {
  db.prepare('DELETE FROM ActiveEdits WHERE expires_at <= ?').run(now);
}

function upsertActiveEditRow(db, { repoId, workspaceDir, relFilePath, convId, now, expiresAt }) {
  const binding = db
    .prepare('SELECT project_id, task_id FROM ConversationBindings WHERE conv_id = ?')
    .get(convId);

  db.prepare(
    `INSERT INTO ActiveEdits (
       repo_id, workspace_dir, file_path, conv_id, project_id, task_id, updated_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo_id, workspace_dir, file_path, conv_id) DO UPDATE SET
       project_id = COALESCE(excluded.project_id, ActiveEdits.project_id),
       task_id = COALESCE(excluded.task_id, ActiveEdits.task_id),
       updated_at = excluded.updated_at,
       expires_at = excluded.expires_at`
  ).run(
    repoId,
    workspaceDir,
    relFilePath,
    convId,
    binding?.project_id || null,
    binding?.task_id || null,
    now,
    expiresAt
  );
}

/**
 * Evaluate live edit conflicts for PreToolUse.
 * Only upserts ActiveEdits immediately when decision is "allow" (no phantom locks on denied force_ask/ask).
 */
export function checkAndRecordEdit(
  db,
  { conv_id, file_path, workspace_paths = [], cwd = '', commitOnAllow = true }
) {
  if (!conv_id || !file_path || isIgnoredPath(file_path, workspace_paths, cwd)) {
    return { decision: 'allow', ignored: true, conflicts: [] };
  }

  const target = resolveEditTarget({ file_path, workspace_paths, cwd });
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const expiresAt = new Date(nowDate.getTime() + ACTIVE_EDIT_TTL_MS).toISOString();

  return withTransaction(db, () => {
    pruneExpiredEdits(db, now);

    const conflicts = db
      .prepare(
        `SELECT repo_id, workspace_dir, file_path, conv_id, project_id, task_id, updated_at, expires_at
         FROM ActiveEdits
         WHERE repo_id = ? AND file_path = ? AND conv_id != ? AND expires_at > ?`
      )
      .all(target.repoId, target.relFilePath, conv_id, now);

    const sameFolder = conflicts.filter((c) => c.workspace_dir === target.workspaceDir);
    if (sameFolder.length > 0) {
      const peerDesc = sameFolder
        .map((c) => (c.task_id ? `chat ${c.conv_id.slice(0, 8)} (task "${c.task_id}")` : `chat ${c.conv_id.slice(0, 8)}`))
        .join(', ');
      return {
        decision: 'force_ask',
        reason: `Work Plan edit guard: ${target.relFilePath} in the same folder (${target.workspaceDir}) is actively being edited by ${peerDesc}. Confirm before overwriting.`,
        conflicts: sameFolder,
        target,
      };
    }

    const diffWorktree = conflicts.filter((c) => c.workspace_dir !== target.workspaceDir);
    if (diffWorktree.length > 0 && target.isGit && isHighConflictFile(target.relFilePath)) {
      const peerDesc = diffWorktree
        .map((c) => `${c.task_id ? `task "${c.task_id}"` : `chat ${c.conv_id.slice(0, 8)}`} in ${c.workspace_dir}`)
        .join(', ');
      return {
        decision: 'ask',
        reason: `Work Plan worktree guard: shared high-conflict file ${target.relFilePath} is also active in another worktree (${peerDesc}).`,
        conflicts: diffWorktree,
        target,
      };
    }

    if (commitOnAllow) {
      upsertActiveEditRow(db, {
        repoId: target.repoId,
        workspaceDir: target.workspaceDir,
        relFilePath: target.relFilePath,
        convId: conv_id,
        now,
        expiresAt,
      });
    }

    if (diffWorktree.length > 0) {
      const peerDesc = diffWorktree
        .map((c) => `${c.task_id ? `task "${c.task_id}"` : `chat ${c.conv_id.slice(0, 8)}`} in ${c.workspace_dir}`)
        .join(', ');
      return {
        decision: 'allow',
        reason: `Info: ${target.relFilePath} is also being edited in another worktree (${peerDesc}).`,
        conflicts: diffWorktree,
        target,
      };
    }

    return {
      decision: 'allow',
      conflicts: [],
      target,
    };
  });
}

/**
 * Record an active edit row after a file-editing tool completes (handles approved force_ask/ask prompts).
 */
export function recordCommittedEdit(db, { conv_id, file_path, workspace_paths = [], cwd = '' }) {
  if (!conv_id || !file_path || isIgnoredPath(file_path, workspace_paths, cwd)) {
    return false;
  }
  const target = resolveEditTarget({ file_path, workspace_paths, cwd });
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const expiresAt = new Date(nowDate.getTime() + ACTIVE_EDIT_TTL_MS).toISOString();

  withTransaction(db, () => {
    pruneExpiredEdits(db, now);
    upsertActiveEditRow(db, {
      repoId: target.repoId,
      workspaceDir: target.workspaceDir,
      relFilePath: target.relFilePath,
      convId: conv_id,
      now,
      expiresAt,
    });
  });
  return true;
}

/**
 * Remove all active edit locks held by a conversation (called on Stop).
 */
export function clearConversationEdits(db, convId) {
  if (!convId) return 0;
  return withTransaction(db, () => {
    const res = db.prepare('DELETE FROM ActiveEdits WHERE conv_id = ?').run(convId);
    return res.changes;
  });
}

/**
 * Clear a single stale/crashed active edit lock (called from UI Strip).
 */
export function clearSpecificEdit(db, { conv_id, repo_id = null, workspace_dir = null, file_path = null }) {
  if (!conv_id) return 0;
  return withTransaction(db, () => {
    if (file_path !== null && workspace_dir !== null && repo_id !== null) {
      return db
        .prepare(
          'DELETE FROM ActiveEdits WHERE conv_id = ? AND repo_id = ? AND workspace_dir = ? AND file_path = ?'
        )
        .run(conv_id, repo_id, workspace_dir, file_path).changes;
    }
    return db.prepare('DELETE FROM ActiveEdits WHERE conv_id = ?').run(conv_id).changes;
  });
}

/**
 * List active non-expired edits associated with a project, annotated with file overlap flags.
 */
export function listProjectActiveEdits(db, project) {
  if (!project) return [];
  const now = nowIso();
  pruneExpiredEdits(db, now);

  let rows;
  if (project.repo_id) {
    rows = db
      .prepare(
        `SELECT * FROM ActiveEdits
         WHERE expires_at > ? AND (repo_id = ? OR workspace_dir = ? OR project_id = ?)
         ORDER BY updated_at DESC`
      )
      .all(now, project.repo_id, project.workspace_dir || '', project.project_id);
  } else if (project.workspace_dir) {
    rows = db
      .prepare(
        `SELECT * FROM ActiveEdits
         WHERE expires_at > ? AND (workspace_dir = ? OR project_id = ?)
         ORDER BY updated_at DESC`
      )
      .all(now, project.workspace_dir, project.project_id);
  } else {
    rows = db
      .prepare(
        `SELECT * FROM ActiveEdits
         WHERE expires_at > ? AND project_id = ?
         ORDER BY updated_at DESC`
      )
      .all(now, project.project_id);
  }

  const fileConvs = new Map();
  const sameFolderFileConvs = new Map();
  for (const r of rows) {
    const fKey = `${r.repo_id}::${r.file_path}`;
    if (!fileConvs.has(fKey)) fileConvs.set(fKey, new Set());
    fileConvs.get(fKey).add(r.conv_id);

    const sfKey = `${r.repo_id}::${r.workspace_dir}::${r.file_path}`;
    if (!sameFolderFileConvs.has(sfKey)) sameFolderFileConvs.set(sfKey, new Set());
    sameFolderFileConvs.get(sfKey).add(r.conv_id);
  }

  return rows.map((r) => {
    const fKey = `${r.repo_id}::${r.file_path}`;
    const sfKey = `${r.repo_id}::${r.workspace_dir}::${r.file_path}`;
    const sameFolderOverlap = (sameFolderFileConvs.get(sfKey)?.size || 0) > 1;
    const crossWorktreeOverlap = !sameFolderOverlap && (fileConvs.get(fKey)?.size || 0) > 1;
    return {
      ...r,
      overlap: sameFolderOverlap || crossWorktreeOverlap,
      same_folder_overlap: sameFolderOverlap,
      cross_worktree_overlap: crossWorktreeOverlap,
    };
  });
}
