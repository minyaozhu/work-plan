import path from 'node:path';
import {
  deleteMeta,
  getMeta,
  normalizePath,
  nowIso,
  setMeta,
  withTransaction,
  WorkPlanError,
} from './db.mjs';
import { listProjectActiveEdits } from './edit_guard.mjs';
import { listMemories } from './memory.mjs';
import { listNotes } from './notes.mjs';
import { resolveGitInfo, seedProjectSource, slugify } from './sources.mjs';

export const STATUSES = ['TODO', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW', 'DONE', 'CANCELLED'];
export const MAX_DEPTH = 8;
export const MAX_TASKS = 500;

function parseJsonArray(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeStringArray(val) {
  if (!Array.isArray(val)) return [];
  return val.map((x) => String(x || '').trim()).filter(Boolean);
}

function formatProjectIdTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

/**
 * Validate strict forest depth <= 8, task count <= 500, ancestor/descendant dep exclusion,
 * and dual-node interval topological order (Kahn's algorithm) across containment U TaskDeps.
 */
export function validateGraphInvariants(tasks, deps) {
  if (tasks.length > MAX_TASKS) {
    throw new WorkPlanError(
      'MAX_TASKS_EXCEEDED',
      `Project exceeds the maximum of ${MAX_TASKS} tasks (found ${tasks.length}).`,
      'Cancel/delete obsolete tasks or split work into another project.'
    );
  }

  const taskMap = new Map();
  for (const t of tasks) {
    if (taskMap.has(t.task_id)) {
      throw new WorkPlanError('VALIDATION_ERROR', `Duplicate task_id "${t.task_id}".`);
    }
    taskMap.set(t.task_id, t);
  }

  const depthMap = new Map();
  for (const t of tasks) {
    if (t.parent_id !== null && t.parent_id !== undefined && !taskMap.has(t.parent_id)) {
      throw new WorkPlanError(
        'TASK_NOT_FOUND',
        `Parent task "${t.parent_id}" for "${t.task_id}" does not exist.`
      );
    }
  }

  const computeDepth = (taskId) => {
    if (depthMap.has(taskId)) return depthMap.get(taskId);
    const seen = new Set();
    let curId = taskId;
    const chain = [];
    while (curId) {
      if (seen.has(curId)) {
        throw new WorkPlanError(
          'CYCLE_DETECTED',
          `Parent-child cycle detected involving task "${curId}".`,
          'Break the parent_id cycle before saving.'
        );
      }
      if (depthMap.has(curId)) {
        let base = depthMap.get(curId);
        for (let i = chain.length - 1; i >= 0; i--) {
          base += 1;
          depthMap.set(chain[i], base);
        }
        return depthMap.get(taskId);
      }
      seen.add(curId);
      chain.push(curId);
      curId = taskMap.get(curId)?.parent_id || null;
    }
    let depth = 0;
    for (let i = chain.length - 1; i >= 0; i--) {
      depth += 1;
      depthMap.set(chain[i], depth);
    }
    return depthMap.get(taskId);
  };

  for (const t of tasks) {
    const d = computeDepth(t.task_id);
    if (d > MAX_DEPTH) {
      throw new WorkPlanError(
        'MAX_DEPTH_EXCEEDED',
        `Task "${t.task_id}" exceeds maximum hierarchy depth of ${MAX_DEPTH} (depth=${d}).`,
        'Flatten sub-tasks or move this subtree higher in the project.'
      );
    }
  }

  const getAncestors = (taskId) => {
    const ancestors = new Set();
    let cur = taskMap.get(taskId)?.parent_id || null;
    while (cur) {
      ancestors.add(cur);
      cur = taskMap.get(cur)?.parent_id || null;
    }
    return ancestors;
  };

  for (const dep of deps) {
    const u = dep.upstream_id;
    const d = dep.downstream_id;
    if (!taskMap.has(u)) {
      throw new WorkPlanError('TASK_NOT_FOUND', `Upstream dependency task "${u}" does not exist.`);
    }
    if (!taskMap.has(d)) {
      throw new WorkPlanError('TASK_NOT_FOUND', `Downstream dependency task "${d}" does not exist.`);
    }
    if (u === d) {
      throw new WorkPlanError('CYCLE_DETECTED', `Task "${u}" cannot depend on itself.`);
    }
    if (getAncestors(u).has(d) || getAncestors(d).has(u)) {
      throw new WorkPlanError(
        'CYCLE_DETECTED',
        `Dependency between "${u}" and "${d}" links an ancestor and its descendant.`,
        'Link sibling/non-ancestor tasks instead of parent-to-child.'
      );
    }
  }

  // Dual-node interval DAG: (s:<id>, e:<id>) catches all containment + dependency paradoxes
  const adj = new Map();
  const inDegree = new Map();
  const addVertex = (v) => {
    if (!adj.has(v)) {
      adj.set(v, []);
      inDegree.set(v, 0);
    }
  };
  const addEdge = (from, to) => {
    addVertex(from);
    addVertex(to);
    adj.get(from).push(to);
    inDegree.set(to, (inDegree.get(to) || 0) + 1);
  };

  for (const t of tasks) {
    const s = `s:${t.task_id}`;
    const e = `e:${t.task_id}`;
    addEdge(s, e);
    if (t.parent_id) {
      addEdge(`s:${t.parent_id}`, s);
      addEdge(e, `e:${t.parent_id}`);
    }
  }

  for (const dep of deps) {
    addEdge(`e:${dep.upstream_id}`, `s:${dep.downstream_id}`);
  }

  const queue = [];
  for (const [v, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(v);
  }

  let visited = 0;
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    visited += 1;
    for (const nxt of adj.get(cur) || []) {
      const nextDeg = inDegree.get(nxt) - 1;
      inDegree.set(nxt, nextDeg);
      if (nextDeg === 0) queue.push(nxt);
    }
  }

  if (visited !== inDegree.size) {
    throw new WorkPlanError(
      'CYCLE_DETECTED',
      'Task hierarchy and dependencies contain a cycle.',
      'Remove the conflicting dependency edge so all upstream -> downstream paths are acyclic.'
    );
  }

  return depthMap;
}

/**
 * Recompute bottom-up parent task status rollups for a project.
 */
export function recomputeRollups(db, projectId) {
  const rows = db
    .prepare('SELECT task_id, parent_id, status, manual_status FROM Tasks WHERE project_id = ?')
    .all(projectId);
  if (rows.length === 0) return;

  const byId = new Map(rows.map((r) => [r.task_id, { ...r }]));
  const childrenMap = new Map();
  for (const r of byId.values()) {
    if (r.parent_id) {
      if (!childrenMap.has(r.parent_id)) childrenMap.set(r.parent_id, []);
      childrenMap.get(r.parent_id).push(r);
    }
  }

  const depthMap = new Map();
  const getDepth = (id) => {
    if (depthMap.has(id)) return depthMap.get(id);
    const p = byId.get(id)?.parent_id;
    const d = p && byId.has(p) ? getDepth(p) + 1 : 1;
    depthMap.set(id, d);
    return d;
  };
  for (const id of byId.keys()) getDepth(id);

  const ordered = [...byId.values()].sort((a, b) => depthMap.get(b.task_id) - depthMap.get(a.task_id));
  const now = nowIso();
  const updateStmt = db.prepare(
    'UPDATE Tasks SET status = ?, updated_at = ? WHERE project_id = ? AND task_id = ?'
  );

  for (const node of ordered) {
    const children = childrenMap.get(node.task_id);
    if (!children || children.length === 0) continue;
    if (node.manual_status) continue;

    const active = children.filter((c) => c.status !== 'CANCELLED');
    let nextStatus;
    if (active.length === 0) {
      nextStatus = 'CANCELLED';
    } else {
      const hasInProgress = active.some((c) => c.status === 'IN_PROGRESS');
      const hasTodo = active.some((c) => c.status === 'TODO');
      const hasReviewOrDone = active.some((c) => c.status === 'IN_REVIEW' || c.status === 'DONE');
      const hasBlocked = active.some((c) => c.status === 'BLOCKED');
      const allReviewOrDone = active.every((c) => c.status === 'IN_REVIEW' || c.status === 'DONE');

      if (hasInProgress || (hasTodo && hasReviewOrDone)) {
        nextStatus = 'IN_PROGRESS';
      } else if (hasBlocked) {
        nextStatus = 'BLOCKED';
      } else if (allReviewOrDone) {
        nextStatus = active.some((c) => c.status === 'IN_REVIEW') ? 'IN_REVIEW' : 'DONE';
      } else {
        nextStatus = 'TODO';
      }
    }

    if (nextStatus !== node.status) {
      node.status = nextStatus;
      updateStmt.run(nextStatus, now, projectId, node.task_id);
    }
  }
}

export function isUpstreamSatisfied(task) {
  if (!task) return false;
  if (task.status === 'DONE') return true;
  if (task.status === 'IN_REVIEW' && String(task.handoff_notes || '').trim().length > 0) {
    return true;
  }
  return false;
}

/**
 * Compute per-task readiness, waiting_on, upstream/downstream lists, depth, and leaf progress.
 */
export function computeReadiness(tasks, deps) {
  const byId = new Map(tasks.map((t) => [t.task_id, t]));
  const childrenMap = new Map();
  for (const t of tasks) {
    if (t.parent_id) {
      if (!childrenMap.has(t.parent_id)) childrenMap.set(t.parent_id, []);
      childrenMap.get(t.parent_id).push(t);
    }
  }

  const directUpstream = new Map();
  const directDownstream = new Map();
  for (const d of deps) {
    if (!directUpstream.has(d.downstream_id)) directUpstream.set(d.downstream_id, []);
    directUpstream.get(d.downstream_id).push(d.upstream_id);
    if (!directDownstream.has(d.upstream_id)) directDownstream.set(d.upstream_id, []);
    directDownstream.get(d.upstream_id).push(d.downstream_id);
  }

  const depthMap = new Map();
  const getDepth = (id) => {
    if (depthMap.has(id)) return depthMap.get(id);
    const p = byId.get(id)?.parent_id;
    const d = p && byId.has(p) ? getDepth(p) + 1 : 1;
    depthMap.set(id, d);
    return d;
  };
  for (const t of tasks) getDepth(t.task_id);

  const progressMap = new Map();
  const computeProgress = (id) => {
    if (progressMap.has(id)) return progressMap.get(id);
    const t = byId.get(id);
    const children = childrenMap.get(id) || [];
    const activeChildren = children.filter((c) => c.status !== 'CANCELLED');
    let res;
    if (children.length === 0) {
      if (t.status === 'CANCELLED') {
        res = { done: 0, total: 0 };
      } else {
        res = { done: t.status === 'DONE' ? 1 : 0, total: 1 };
      }
    } else if (activeChildren.length === 0) {
      res = { done: 0, total: 0 };
    } else {
      let done = 0;
      let total = 0;
      for (const c of activeChildren) {
        const cp = computeProgress(c.task_id);
        done += cp.done;
        total += cp.total;
      }
      res = { done, total };
    }
    progressMap.set(id, res);
    return res;
  };
  for (const t of tasks) computeProgress(t.task_id);

  return tasks.map((t) => {
    const allChildren = childrenMap.get(t.task_id) || [];
    const activeChildren = allChildren.filter((c) => c.status !== 'CANCELLED');
    const isLeaf = activeChildren.length === 0;

    // Collect direct + ancestor-inherited upstream dependencies
    const effectiveUpstream = [];
    const seen = new Set();
    let cur = t.task_id;
    while (cur) {
      for (const uid of directUpstream.get(cur) || []) {
        if (!seen.has(uid)) {
          seen.add(uid);
          effectiveUpstream.push(uid);
        }
      }
      cur = byId.get(cur)?.parent_id || null;
    }

    const waitingOn = [];
    for (const uid of effectiveUpstream) {
      const up = byId.get(uid);
      if (up && !isUpstreamSatisfied(up)) {
        waitingOn.push({
          task_id: up.task_id,
          title: up.title,
          status: up.status,
        });
      }
    }

    const isReady = t.status === 'TODO' && isLeaf && waitingOn.length === 0;
    const isWaiting = t.status === 'TODO' && isLeaf && waitingOn.length > 0;

    return {
      ...t,
      files: parseJsonArray(t.files_json),
      target_tests: parseJsonArray(t.target_tests_json),
      manual_status: Boolean(t.manual_status),
      depth: depthMap.get(t.task_id) || 1,
      is_leaf: isLeaf,
      is_ready: isReady,
      is_waiting: isWaiting,
      waiting_on: waitingOn,
      upstream_ids: directUpstream.get(t.task_id) || [],
      effective_upstream_ids: effectiveUpstream,
      downstream_ids: directDownstream.get(t.task_id) || [],
      children_ids: allChildren.map((c) => c.task_id),
      progress: progressMap.get(t.task_id) || { done: 0, total: 0 },
    };
  });
}

function formatProjectSummary(db, row) {
  const taskRows = db
    .prepare('SELECT task_id, parent_id, status, handoff_notes, files_json, target_tests_json, manual_status FROM Tasks WHERE project_id = ?')
    .all(row.project_id);
  const depRows = db
    .prepare('SELECT upstream_id, downstream_id FROM TaskDeps WHERE project_id = ?')
    .all(row.project_id);
  const enriched = computeReadiness(taskRows, depRows);
  const nonCancelled = enriched.filter((t) => t.status !== 'CANCELLED');
  const leaves = nonCancelled.filter((t) => t.is_leaf);
  const doneCount = leaves.filter((t) => t.status === 'DONE').length;
  const inProgressCount = nonCancelled.filter((t) => t.status === 'IN_PROGRESS').length;
  const blockedCount = nonCancelled.filter((t) => t.status === 'BLOCKED').length;
  const readyCount = enriched.filter((t) => t.is_ready).length;
  const activeEdits = listProjectActiveEdits(db, row);
  const activeConvs = new Set(activeEdits.map((e) => e.conv_id));

  return {
    project_id: row.project_id,
    title: row.title,
    workspace_dir: row.workspace_dir,
    repo_id: row.repo_id,
    source_ref: row.source_ref,
    pinned: Boolean(row.pinned),
    archived_at: row.archived_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    stats: {
      total: nonCancelled.length,
      leaf_total: leaves.length,
      done: doneCount,
      in_progress: inProgressCount,
      blocked: blockedCount,
      ready: readyCount,
      percent_done: leaves.length > 0 ? Math.round((doneCount / leaves.length) * 100) : 0,
      active_chats: activeConvs.size,
    },
  };
}

export function listProjects(db, { includeArchived = false } = {}) {
  const rows = includeArchived
    ? db.prepare('SELECT * FROM Projects ORDER BY pinned DESC, (archived_at IS NOT NULL) ASC, updated_at DESC').all()
    : db
        .prepare('SELECT * FROM Projects WHERE archived_at IS NULL ORDER BY pinned DESC, updated_at DESC')
        .all();
  return rows.map((r) => formatProjectSummary(db, r));
}

export function createProject(db, { title = '', workspace_dir = '', source_ref = '', seed = true } = {}) {
  const seeded = seedProjectSource({ title, workspace_dir, source_ref, seed });
  const baseSlug = slugify(seeded.title, 'project');
  const stamp = formatProjectIdTimestamp();

  return withTransaction(db, () => {
    let projectId = `${baseSlug}-${stamp}`;
    let suffix = 2;
    while (db.prepare('SELECT 1 FROM Projects WHERE project_id = ?').get(projectId)) {
      projectId = `${baseSlug}-${stamp}-${suffix}`;
      suffix += 1;
    }

    const now = nowIso();
    db.prepare(
      `INSERT INTO Projects (
         project_id, title, workspace_dir, repo_id, source_ref, pinned, archived_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?)`
    ).run(projectId, seeded.title, seeded.workspace_dir, seeded.repo_id, seeded.source_ref, now, now);

    if (seeded.tasks.length > 0) {
      planTasks(db, projectId, { tasks: seeded.tasks });
    }

    setMeta(db, 'last_created_project', JSON.stringify({ project_id: projectId, title: seeded.title, at: now }));
    setMeta(db, 'selected_project_id', projectId);

    const row = db.prepare('SELECT * FROM Projects WHERE project_id = ?').get(projectId);
    return {
      project: formatProjectSummary(db, row),
      seeded_count: seeded.tasks.length,
      ...(seeded.warning ? { warning: seeded.warning } : {}),
    };
  });
}

export function updateProject(db, projectId, { title, pinned, workspace_dir, source_ref } = {}) {
  return withTransaction(db, () => {
    const existing = db.prepare('SELECT * FROM Projects WHERE project_id = ?').get(projectId);
    if (!existing) {
      throw new WorkPlanError('PROJECT_NOT_FOUND', `Project "${projectId}" does not exist.`);
    }

    const nextTitle = title !== undefined ? String(title).trim() : existing.title;
    if (!nextTitle) {
      throw new WorkPlanError('VALIDATION_ERROR', 'Project title cannot be empty.');
    }
    const nextPinned = pinned !== undefined ? (pinned ? 1 : 0) : existing.pinned;
    let nextWorkspace = existing.workspace_dir;
    let nextRepoId = existing.repo_id;
    if (workspace_dir !== undefined) {
      nextWorkspace = normalizePath(workspace_dir);
      nextRepoId = nextWorkspace ? resolveGitInfo(nextWorkspace).repoId : '';
    }
    const nextSourceRef = source_ref !== undefined ? String(source_ref).trim() : existing.source_ref;
    const now = nowIso();

    db.prepare(
      `UPDATE Projects
       SET title = ?, workspace_dir = ?, repo_id = ?, source_ref = ?, pinned = ?, updated_at = ?
       WHERE project_id = ?`
    ).run(nextTitle, nextWorkspace, nextRepoId, nextSourceRef, nextPinned, now, projectId);

    return formatProjectSummary(db, db.prepare('SELECT * FROM Projects WHERE project_id = ?').get(projectId));
  });
}

export function archiveProject(db, projectId, archived = true) {
  return withTransaction(db, () => {
    const existing = db.prepare('SELECT * FROM Projects WHERE project_id = ?').get(projectId);
    if (!existing) {
      throw new WorkPlanError('PROJECT_NOT_FOUND', `Project "${projectId}" does not exist.`);
    }
    const now = nowIso();
    db.prepare('UPDATE Projects SET archived_at = ?, updated_at = ? WHERE project_id = ?').run(
      archived ? now : null,
      now,
      projectId
    );
    return formatProjectSummary(db, db.prepare('SELECT * FROM Projects WHERE project_id = ?').get(projectId));
  });
}

export function deleteProject(db, projectId) {
  return withTransaction(db, () => {
    const existing = db.prepare('SELECT project_id FROM Projects WHERE project_id = ?').get(projectId);
    if (!existing) {
      throw new WorkPlanError('PROJECT_NOT_FOUND', `Project "${projectId}" does not exist.`);
    }
    db.prepare('DELETE FROM Projects WHERE project_id = ?').run(projectId);
    if (getMeta(db, 'selected_project_id') === projectId) {
      deleteMeta(db, 'selected_project_id');
    }
    return true;
  });
}

export function getBinding(db, convId) {
  if (!convId) return null;
  return db.prepare('SELECT * FROM ConversationBindings WHERE conv_id = ?').get(convId) || null;
}

export function bindConversation(db, { conv_id, project_id, task_id = null, workspace_dir = '' }) {
  if (!conv_id) {
    throw new WorkPlanError('VALIDATION_ERROR', 'conv_id is required to bind a conversation.');
  }
  return withTransaction(db, () => {
    const project = db.prepare('SELECT project_id FROM Projects WHERE project_id = ?').get(project_id);
    if (!project) {
      throw new WorkPlanError('PROJECT_NOT_FOUND', `Project "${project_id}" does not exist.`);
    }
    let cleanTaskId = task_id ? String(task_id).trim() : null;
    if (cleanTaskId) {
      const task = db
        .prepare('SELECT task_id FROM Tasks WHERE project_id = ? AND task_id = ?')
        .get(project_id, cleanTaskId);
      if (!task) {
        throw new WorkPlanError(
          'TASK_NOT_FOUND',
          `Task "${cleanTaskId}" does not exist in project "${project_id}".`
        );
      }
    }
    const now = nowIso();
    const normWs = normalizePath(workspace_dir || '');
    db.prepare(
      `INSERT INTO ConversationBindings (conv_id, project_id, task_id, workspace_dir, bound_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(conv_id) DO UPDATE SET
         project_id = excluded.project_id,
         task_id = excluded.task_id,
         workspace_dir = CASE WHEN excluded.workspace_dir != '' THEN excluded.workspace_dir ELSE ConversationBindings.workspace_dir END,
         bound_at = excluded.bound_at`
    ).run(conv_id, project_id, cleanTaskId, normWs, now);

    if (cleanTaskId) {
      db.prepare('UPDATE Tasks SET conv_id = ?, updated_at = ? WHERE project_id = ? AND task_id = ?').run(
        conv_id,
        now,
        project_id,
        cleanTaskId
      );
      db.prepare('UPDATE ActiveEdits SET project_id = ?, task_id = ? WHERE conv_id = ?').run(
        project_id,
        cleanTaskId,
        conv_id
      );
    } else {
      db.prepare('UPDATE ActiveEdits SET project_id = ? WHERE conv_id = ?').run(project_id, conv_id);
    }

    return getBinding(db, conv_id);
  });
}

export function resolveTaskByWorktree(db, workspaceDir) {
  const normDir = normalizePath(workspaceDir);
  if (!normDir) return null;
  const rows = db
    .prepare(
      `SELECT t.project_id, t.task_id, t.worktree_path, p.workspace_dir AS project_workspace_dir
       FROM Tasks t
       JOIN Projects p ON p.project_id = t.project_id
       WHERE p.archived_at IS NULL AND t.worktree_path IS NOT NULL AND t.worktree_path != ''`
    )
    .all();

  for (const row of rows) {
    const wt = normalizePath(row.worktree_path);
    const pws = normalizePath(row.project_workspace_dir);
    if (wt && wt !== pws && (normDir === wt || normDir.startsWith(`${wt}/`))) {
      return { project_id: row.project_id, task_id: row.task_id, worktree_path: wt };
    }
  }
  return null;
}

function pickUniqueOrThrow(candidates, reasonLabel) {
  if (candidates.length === 1) return candidates[0].project_id;
  if (candidates.length > 1) {
    const pinned = candidates.filter((c) => c.pinned);
    if (pinned.length === 1) return pinned[0].project_id;
    const summary = candidates.map((c) => `${c.project_id} ("${c.title}")`).join(', ');
    throw new WorkPlanError(
      'AMBIGUOUS_PROJECT',
      `Multiple active projects match ${reasonLabel}: ${summary}.`,
      'Pass project_id explicitly (call project_list to see IDs).'
    );
  }
  return null;
}

/**
 * Automatically resolve project_id: explicit -> ConversationBindings -> worktree -> workspace/repo -> sole active.
 */
export function resolveProjectId(db, { project_id, conv_id, workspace_dir, workspace_paths } = {}) {
  if (project_id) {
    const exists = db.prepare('SELECT project_id FROM Projects WHERE project_id = ?').get(project_id);
    if (!exists) {
      throw new WorkPlanError(
        'PROJECT_NOT_FOUND',
        `Project "${project_id}" not found.`,
        'Call project_list to inspect existing projects or project_create to make a new one.'
      );
    }
    return project_id;
  }

  if (conv_id) {
    const binding = getBinding(db, conv_id);
    if (binding) return binding.project_id;
  }

  const dirsToCheck = [];
  if (workspace_dir) dirsToCheck.push(workspace_dir);
  if (Array.isArray(workspace_paths)) dirsToCheck.push(...workspace_paths);
  const normDirs = [...new Set(dirsToCheck.map((d) => normalizePath(d)).filter(Boolean))];

  for (const dir of normDirs) {
    const wtMatch = resolveTaskByWorktree(db, dir);
    if (wtMatch) return wtMatch.project_id;
  }

  const activeProjects = db.prepare('SELECT * FROM Projects WHERE archived_at IS NULL').all();
  if (activeProjects.length === 0) {
    throw new WorkPlanError(
      'PROJECT_NOT_FOUND',
      'No active Work Plan projects exist.',
      'Create a project first with project_create.'
    );
  }

  for (const dir of normDirs) {
    const wsMatches = activeProjects.filter(
      (p) => p.workspace_dir && (dir === p.workspace_dir || dir.startsWith(`${p.workspace_dir}/`))
    );
    const chosenWs = pickUniqueOrThrow(wsMatches, `workspace "${dir}"`);
    if (chosenWs) return chosenWs;

    const gitInfo = resolveGitInfo(dir);
    if (gitInfo.isGit && gitInfo.repoId) {
      const repoMatches = activeProjects.filter((p) => p.repo_id === gitInfo.repoId);
      const chosenRepo = pickUniqueOrThrow(repoMatches, `git repository "${gitInfo.repoId}"`);
      if (chosenRepo) return chosenRepo;
    }
  }

  if (activeProjects.length === 1) {
    return activeProjects[0].project_id;
  }

  const list = activeProjects.map((p) => `${p.project_id} ("${p.title}")`).join(', ');
  throw new WorkPlanError(
    'AMBIGUOUS_PROJECT',
    `Multiple active projects exist (${list}) and none uniquely matched the current workspace.`,
    'Pass project_id explicitly (use project_list to inspect projects).'
  );
}

/**
 * Idempotently plan, create, or update recursive tasks and dependency edges.
 */
export function planTasks(db, projectId, { tasks = [], depends_on = [], parent_task_id = null } = {}) {
  return withTransaction(db, () => {
    const project = db.prepare('SELECT * FROM Projects WHERE project_id = ?').get(projectId);
    if (!project) {
      throw new WorkPlanError('PROJECT_NOT_FOUND', `Project "${projectId}" does not exist.`);
    }

    const explicitRootParent = parent_task_id !== undefined && parent_task_id !== null && parent_task_id !== '';
    const rootParentId = explicitRootParent ? String(parent_task_id).trim() : null;

    const existingRows = db
      .prepare('SELECT * FROM Tasks WHERE project_id = ? ORDER BY sort_key ASC, created_at ASC')
      .all(projectId);
    const existingDeps = db
      .prepare('SELECT project_id, upstream_id, downstream_id, created_at FROM TaskDeps WHERE project_id = ?')
      .all(projectId);

    if (rootParentId && !existingRows.some((r) => r.task_id === rootParentId)) {
      throw new WorkPlanError(
        'TASK_NOT_FOUND',
        `parent_task_id "${rootParentId}" does not exist in project "${projectId}".`
      );
    }

    const workingMap = new Map(existingRows.map((r) => [r.task_id, { ...r }]));
    const touchedIds = new Set();
    const collisionRemap = new Map();
    let nextSortSeed =
      existingRows.reduce((mx, r) => Math.max(mx, Number(r.sort_key) || 0), 0) + 1;
    const now = nowIso();

    const allocateUniqueSlug = (baseSlug) => {
      if (!workingMap.has(baseSlug)) return baseSlug;
      let idx = 2;
      while (workingMap.has(`${baseSlug}-${idx}`)) idx += 1;
      return `${baseSlug}-${idx}`;
    };

    const upsertSubtree = (nodes, currentParentId, isRootLevel) => {
      if (!Array.isArray(nodes)) return;
      for (const node of nodes) {
        if (!node || typeof node !== 'object') {
          throw new WorkPlanError('VALIDATION_ERROR', 'Each task entry must be an object.');
        }

        const hasExplicitId = typeof node.task_id === 'string' && node.task_id.trim().length > 0;
        let taskId;
        let effectiveParentId = currentParentId;

        if (hasExplicitId) {
          taskId = node.task_id.trim();
          const existing = workingMap.get(taskId);
          if (existing && isRootLevel && !explicitRootParent && node.parent_id === undefined) {
            effectiveParentId = existing.parent_id;
          } else if (node.parent_id !== undefined) {
            effectiveParentId = node.parent_id ? String(node.parent_id).trim() : null;
          }
        } else {
          const cleanTitle = String(node.title || '').trim();
          if (!cleanTitle) {
            throw new WorkPlanError('VALIDATION_ERROR', 'Task title is required when task_id is omitted.');
          }
          const baseSlug = slugify(cleanTitle, 'task');
          const existingSameSlug = workingMap.get(baseSlug);
          if (!existingSameSlug) {
            taskId = baseSlug;
          } else if ((existingSameSlug.parent_id || null) === (effectiveParentId || null) && !touchedIds.has(baseSlug)) {
            taskId = baseSlug;
          } else {
            taskId = allocateUniqueSlug(baseSlug);
            if (!touchedIds.has(baseSlug)) {
              collisionRemap.set(baseSlug, taskId);
            }
          }
        }

        touchedIds.add(taskId);
        const existing = workingMap.get(taskId);
        const cleanTitle =
          node.title !== undefined ? String(node.title).trim() : existing?.title || taskId;
        if (!cleanTitle) {
          throw new WorkPlanError('VALIDATION_ERROR', `Task "${taskId}" cannot have an empty title.`);
        }

        const nextStatus = node.status !== undefined ? String(node.status).trim().toUpperCase() : existing?.status || 'TODO';
        if (!STATUSES.includes(nextStatus)) {
          throw new WorkPlanError('VALIDATION_ERROR', `Invalid status "${nextStatus}" for task "${taskId}".`);
        }

        const merged = {
          project_id: projectId,
          task_id: taskId,
          parent_id: effectiveParentId || null,
          title: cleanTitle,
          brief: node.brief !== undefined ? String(node.brief) : existing?.brief || '',
          files_json:
            node.files !== undefined
              ? JSON.stringify(normalizeStringArray(node.files))
              : existing?.files_json || '[]',
          target_tests_json:
            node.target_tests !== undefined
              ? JSON.stringify(normalizeStringArray(node.target_tests))
              : existing?.target_tests_json || '[]',
          status: nextStatus,
          manual_status: existing?.manual_status || 0,
          conv_id: existing?.conv_id || null,
          worktree_path:
            node.worktree_path !== undefined
              ? node.worktree_path
                ? normalizePath(node.worktree_path)
                : null
              : existing?.worktree_path || null,
          branch_name:
            node.branch_name !== undefined
              ? node.branch_name || null
              : existing?.branch_name || null,
          pr_url: node.pr_url !== undefined ? node.pr_url || null : existing?.pr_url || null,
          handoff_notes:
            node.handoff_notes !== undefined ? String(node.handoff_notes) : existing?.handoff_notes || '',
          sort_key:
            node.sort_key !== undefined
              ? Number(node.sort_key) || 0
              : existing?.sort_key ?? nextSortSeed++,
          created_at: existing?.created_at || now,
          updated_at: now,
          _isNew: !existing,
        };

        workingMap.set(taskId, merged);

        if (Array.isArray(node.children) && node.children.length > 0) {
          upsertSubtree(node.children, taskId, false);
        }
      }
    };

    upsertSubtree(tasks, rootParentId, true);

    const depKeys = new Set(existingDeps.map((d) => `${d.upstream_id}=>${d.downstream_id}`));
    const workingDeps = [...existingDeps];
    const addedEdges = [];

    for (const edge of depends_on || []) {
      let rawUp;
      let rawDown;
      if (Array.isArray(edge) && edge.length >= 2) {
        [rawUp, rawDown] = edge;
      } else if (edge && typeof edge === 'object') {
        rawUp = edge.upstream_id ?? edge.upstream ?? edge.from;
        rawDown = edge.downstream_id ?? edge.downstream ?? edge.to;
      } else {
        throw new WorkPlanError(
          'VALIDATION_ERROR',
          'Each depends_on entry must be [upstream_id, downstream_id].'
        );
      }
      let u = String(rawUp || '').trim();
      let d = String(rawDown || '').trim();
      if (collisionRemap.has(u)) u = collisionRemap.get(u);
      if (collisionRemap.has(d)) d = collisionRemap.get(d);

      const key = `${u}=>${d}`;
      if (!depKeys.has(key)) {
        depKeys.add(key);
        const depRow = { project_id: projectId, upstream_id: u, downstream_id: d, created_at: now };
        workingDeps.push(depRow);
        addedEdges.push(depRow);
      }
    }

    const allTasks = [...workingMap.values()];
    validateGraphInvariants(allTasks, workingDeps);

    const insertStmt = db.prepare(
      `INSERT INTO Tasks (
         project_id, task_id, parent_id, title, brief, files_json, target_tests_json,
         status, manual_status, conv_id, worktree_path, branch_name, pr_url,
         handoff_notes, sort_key, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const updateStmt = db.prepare(
      `UPDATE Tasks
       SET parent_id = ?, title = ?, brief = ?, files_json = ?, target_tests_json = ?,
           status = ?, worktree_path = ?, branch_name = ?, pr_url = ?, handoff_notes = ?,
           sort_key = ?, updated_at = ?
       WHERE project_id = ? AND task_id = ?`
    );

    for (const t of allTasks) {
      if (!touchedIds.has(t.task_id)) continue;
      if (t._isNew) {
        insertStmt.run(
          t.project_id,
          t.task_id,
          t.parent_id,
          t.title,
          t.brief,
          t.files_json,
          t.target_tests_json,
          t.status,
          t.manual_status,
          t.conv_id,
          t.worktree_path,
          t.branch_name,
          t.pr_url,
          t.handoff_notes,
          t.sort_key,
          t.created_at,
          t.updated_at
        );
      } else {
        updateStmt.run(
          t.parent_id,
          t.title,
          t.brief,
          t.files_json,
          t.target_tests_json,
          t.status,
          t.worktree_path,
          t.branch_name,
          t.pr_url,
          t.handoff_notes,
          t.sort_key,
          t.updated_at,
          projectId,
          t.task_id
        );
      }
    }

    const depInsertStmt = db.prepare(
      'INSERT OR IGNORE INTO TaskDeps (project_id, upstream_id, downstream_id, created_at) VALUES (?, ?, ?, ?)'
    );
    for (const dep of addedEdges) {
      depInsertStmt.run(dep.project_id, dep.upstream_id, dep.downstream_id, dep.created_at);
    }

    recomputeRollups(db, projectId);
    db.prepare('UPDATE Projects SET updated_at = ? WHERE project_id = ?').run(now, projectId);

    return {
      upserted_ids: [...touchedIds],
      added_deps: addedEdges.map((e) => [e.upstream_id, e.downstream_id]),
      remapped_slugs: Object.fromEntries(collisionRemap),
    };
  });
}

export function getUpstreamHandoffs(db, projectId, taskId) {
  const rows = db.prepare('SELECT * FROM Tasks WHERE project_id = ?').all(projectId);
  const deps = db.prepare('SELECT * FROM TaskDeps WHERE project_id = ?').all(projectId);
  const enriched = computeReadiness(rows, deps);
  const byId = new Map(enriched.map((t) => [t.task_id, t]));
  const target = byId.get(taskId);
  if (!target) return [];

  return target.effective_upstream_ids
    .map((uid) => byId.get(uid))
    .filter(Boolean)
    .map((u) => ({
      task_id: u.task_id,
      title: u.title,
      status: u.status,
      handoff_notes: u.handoff_notes,
      files: u.files,
      branch_name: u.branch_name || null,
      pr_url: u.pr_url || null,
    }));
}

export function startTask(db, projectId, { task_id, conv_id = null, branch_name, worktree_path } = {}) {
  return withTransaction(db, () => {
    const project = db.prepare('SELECT * FROM Projects WHERE project_id = ?').get(projectId);
    if (!project) {
      throw new WorkPlanError('PROJECT_NOT_FOUND', `Project "${projectId}" does not exist.`);
    }
    const existing = db
      .prepare('SELECT * FROM Tasks WHERE project_id = ? AND task_id = ?')
      .get(projectId, task_id);
    if (!existing) {
      throw new WorkPlanError('TASK_NOT_FOUND', `Task "${task_id}" does not exist in project "${projectId}".`);
    }

    const now = nowIso();
    const hasChildren = Boolean(
      db.prepare('SELECT 1 FROM Tasks WHERE project_id = ? AND parent_id = ?').get(projectId, task_id)
    );
    const nextBranch = branch_name !== undefined ? branch_name || null : existing.branch_name;
    const nextWorktree =
      worktree_path !== undefined
        ? worktree_path
          ? normalizePath(worktree_path)
          : null
        : existing.worktree_path;

    db.prepare(
      `UPDATE Tasks
       SET status = 'IN_PROGRESS',
           manual_status = CASE WHEN ? = 1 THEN 1 ELSE manual_status END,
           conv_id = COALESCE(?, conv_id),
           branch_name = ?,
           worktree_path = ?,
           updated_at = ?
       WHERE project_id = ? AND task_id = ?`
    ).run(hasChildren ? 1 : 0, conv_id || null, nextBranch, nextWorktree, now, projectId, task_id);

    if (conv_id) {
      bindConversation(db, {
        conv_id,
        project_id: projectId,
        task_id,
        workspace_dir: nextWorktree || project.workspace_dir || '',
      });
    }

    setMeta(db, 'last_started_task', JSON.stringify({ project_id: projectId, task_id, at: now }));
    recomputeRollups(db, projectId);
    db.prepare('UPDATE Projects SET updated_at = ? WHERE project_id = ?').run(now, projectId);

    const updatedTask = db
      .prepare('SELECT * FROM Tasks WHERE project_id = ? AND task_id = ?')
      .get(projectId, task_id);
    const upstreamHandoffs = getUpstreamHandoffs(db, projectId, task_id);
    const activeEdits = listProjectActiveEdits(db, project).filter((e) => e.conv_id !== conv_id);
    const expectedFiles = parseJsonArray(updatedTask.files_json);
    const siblingWarnings = activeEdits.filter((e) => {
      if (expectedFiles.length === 0) return true;
      return expectedFiles.some((pat) => {
        const clean = pat.replace(/\/\*\*$/, '');
        return e.file_path === clean || e.file_path.startsWith(`${clean}/`);
      });
    });

    let suggestedWorktreeCmd = null;
    if (!nextWorktree && project.repo_id && project.workspace_dir) {
      const parentDir = path.posix.dirname(project.workspace_dir);
      const baseName = path.posix.basename(project.workspace_dir);
      const wtSlug = slugify(task_id, 'wt');
      suggestedWorktreeCmd = `git worktree add -b work/${wtSlug} "${parentDir}/${baseName}-wt-${wtSlug}"`;
    }

    return {
      project: formatProjectSummary(db, project),
      task: {
        ...updatedTask,
        files: expectedFiles,
        target_tests: parseJsonArray(updatedTask.target_tests_json),
        manual_status: Boolean(updatedTask.manual_status),
      },
      upstream_handoffs: upstreamHandoffs,
      sibling_active_edits: siblingWarnings,
      suggested_worktree_command: suggestedWorktreeCmd,
    };
  });
}

export function updateTask(db, projectId, taskId, fields = {}) {
  return withTransaction(db, () => {
    const existing = db
      .prepare('SELECT * FROM Tasks WHERE project_id = ? AND task_id = ?')
      .get(projectId, taskId);
    if (!existing) {
      throw new WorkPlanError('TASK_NOT_FOUND', `Task "${taskId}" does not exist in project "${projectId}".`);
    }

    const hasChildren = Boolean(
      db.prepare('SELECT 1 FROM Tasks WHERE project_id = ? AND parent_id = ?').get(projectId, taskId)
    );

    let nextStatus = existing.status;
    let nextManual = existing.manual_status;

    if (fields.manual_status !== undefined) {
      nextManual = fields.manual_status ? 1 : 0;
    }

    if (fields.status !== undefined) {
      const s = String(fields.status).trim().toUpperCase();
      if (!STATUSES.includes(s)) {
        throw new WorkPlanError(
          'VALIDATION_ERROR',
          `Invalid status "${fields.status}". Allowed: ${STATUSES.join(', ')}.`
        );
      }
      nextStatus = s;
      if (hasChildren && fields.manual_status === undefined) {
        nextManual = 1;
      }
    }

    const nextTitle = fields.title !== undefined ? String(fields.title).trim() : existing.title;
    if (!nextTitle) {
      throw new WorkPlanError('VALIDATION_ERROR', 'Task title cannot be empty.');
    }

    const nextBrief = fields.brief !== undefined ? String(fields.brief) : existing.brief;
    const nextHandoff =
      fields.handoff_notes !== undefined ? String(fields.handoff_notes) : existing.handoff_notes;
    const nextFiles =
      fields.files !== undefined ? JSON.stringify(normalizeStringArray(fields.files)) : existing.files_json;
    const nextTests =
      fields.target_tests !== undefined
        ? JSON.stringify(normalizeStringArray(fields.target_tests))
        : existing.target_tests_json;
    const nextBranch =
      fields.branch_name !== undefined ? fields.branch_name || null : existing.branch_name;
    const nextPr = fields.pr_url !== undefined ? fields.pr_url || null : existing.pr_url;
    const nextWorktree =
      fields.worktree_path !== undefined
        ? fields.worktree_path
          ? normalizePath(fields.worktree_path)
          : null
        : existing.worktree_path;
    const nextSortKey =
      fields.sort_key !== undefined ? Number(fields.sort_key) || 0 : existing.sort_key;

    const now = nowIso();
    db.prepare(
      `UPDATE Tasks
       SET title = ?, brief = ?, files_json = ?, target_tests_json = ?, status = ?, manual_status = ?,
           handoff_notes = ?, branch_name = ?, pr_url = ?, worktree_path = ?, sort_key = ?, updated_at = ?
       WHERE project_id = ? AND task_id = ?`
    ).run(
      nextTitle,
      nextBrief,
      nextFiles,
      nextTests,
      nextStatus,
      nextManual,
      nextHandoff,
      nextBranch,
      nextPr,
      nextWorktree,
      nextSortKey,
      now,
      projectId,
      taskId
    );

    recomputeRollups(db, projectId);
    db.prepare('UPDATE Projects SET updated_at = ? WHERE project_id = ?').run(now, projectId);

    const row = db
      .prepare('SELECT * FROM Tasks WHERE project_id = ? AND task_id = ?')
      .get(projectId, taskId);
    return {
      ...row,
      files: parseJsonArray(row.files_json),
      target_tests: parseJsonArray(row.target_tests_json),
      manual_status: Boolean(row.manual_status),
    };
  });
}

export function moveTask(db, projectId, taskId, { new_parent_id, sort_key } = {}) {
  return withTransaction(db, () => {
    const rows = db.prepare('SELECT * FROM Tasks WHERE project_id = ?').all(projectId);
    const deps = db.prepare('SELECT * FROM TaskDeps WHERE project_id = ?').all(projectId);
    const target = rows.find((r) => r.task_id === taskId);
    if (!target) {
      throw new WorkPlanError('TASK_NOT_FOUND', `Task "${taskId}" does not exist in project "${projectId}".`);
    }

    const nextParent =
      new_parent_id !== undefined ? (new_parent_id ? String(new_parent_id).trim() : null) : target.parent_id;
    const nextSort = sort_key !== undefined ? Number(sort_key) || 0 : target.sort_key;

    const simulated = rows.map((r) =>
      r.task_id === taskId ? { ...r, parent_id: nextParent, sort_key: nextSort } : r
    );
    validateGraphInvariants(simulated, deps);

    const now = nowIso();
    db.prepare('UPDATE Tasks SET parent_id = ?, sort_key = ?, updated_at = ? WHERE project_id = ? AND task_id = ?').run(
      nextParent,
      nextSort,
      now,
      projectId,
      taskId
    );

    recomputeRollups(db, projectId);
    db.prepare('UPDATE Projects SET updated_at = ? WHERE project_id = ?').run(now, projectId);
    return true;
  });
}

export function deleteTask(db, projectId, taskId, { cascade = true } = {}) {
  return withTransaction(db, () => {
    const rows = db.prepare('SELECT task_id, parent_id FROM Tasks WHERE project_id = ?').all(projectId);
    const target = rows.find((r) => r.task_id === taskId);
    if (!target) {
      throw new WorkPlanError('TASK_NOT_FOUND', `Task "${taskId}" does not exist in project "${projectId}".`);
    }

    const now = nowIso();
    if (cascade) {
      const toDelete = new Set([taskId]);
      let added = true;
      while (added) {
        added = false;
        for (const r of rows) {
          if (r.parent_id && toDelete.has(r.parent_id) && !toDelete.has(r.task_id)) {
            toDelete.add(r.task_id);
            added = true;
          }
        }
      }
      const delTaskStmt = db.prepare('DELETE FROM Tasks WHERE project_id = ? AND task_id = ?');
      const clearBindingStmt = db.prepare(
        'UPDATE ConversationBindings SET task_id = NULL WHERE project_id = ? AND task_id = ?'
      );
      const clearNoteStmt = db.prepare(
        'UPDATE ProjectNotes SET task_id = NULL WHERE project_id = ? AND task_id = ?'
      );
      for (const id of toDelete) {
        clearBindingStmt.run(projectId, id);
        clearNoteStmt.run(projectId, id);
        delTaskStmt.run(projectId, id);
      }
    } else {
      db.prepare('UPDATE Tasks SET parent_id = ?, updated_at = ? WHERE project_id = ? AND parent_id = ?').run(
        target.parent_id,
        now,
        projectId,
        taskId
      );
      db.prepare('UPDATE ConversationBindings SET task_id = NULL WHERE project_id = ? AND task_id = ?').run(
        projectId,
        taskId
      );
      db.prepare('UPDATE ProjectNotes SET task_id = NULL WHERE project_id = ? AND task_id = ?').run(
        projectId,
        taskId
      );
      db.prepare('DELETE FROM Tasks WHERE project_id = ? AND task_id = ?').run(projectId, taskId);
    }

    recomputeRollups(db, projectId);
    db.prepare('UPDATE Projects SET updated_at = ? WHERE project_id = ?').run(now, projectId);
    return true;
  });
}

export function setTaskDep(db, projectId, { upstream_id, downstream_id, action = 'add' } = {}) {
  const u = String(upstream_id || '').trim();
  const d = String(downstream_id || '').trim();
  if (!u || !d) {
    throw new WorkPlanError('VALIDATION_ERROR', 'Both upstream_id and downstream_id are required.');
  }

  return withTransaction(db, () => {
    const now = nowIso();
    if (action === 'remove') {
      db.prepare(
        'DELETE FROM TaskDeps WHERE project_id = ? AND upstream_id = ? AND downstream_id = ?'
      ).run(projectId, u, d);
      db.prepare('UPDATE Projects SET updated_at = ? WHERE project_id = ?').run(now, projectId);
      return true;
    }

    const rows = db.prepare('SELECT * FROM Tasks WHERE project_id = ?').all(projectId);
    const deps = db.prepare('SELECT * FROM TaskDeps WHERE project_id = ?').all(projectId);
    const exists = deps.some((x) => x.upstream_id === u && x.downstream_id === d);
    if (!exists) {
      const simulated = [...deps, { project_id: projectId, upstream_id: u, downstream_id: d, created_at: now }];
      validateGraphInvariants(rows, simulated);
      db.prepare(
        'INSERT INTO TaskDeps (project_id, upstream_id, downstream_id, created_at) VALUES (?, ?, ?, ?)'
      ).run(projectId, u, d, now);
      db.prepare('UPDATE Projects SET updated_at = ? WHERE project_id = ?').run(now, projectId);
    }
    return true;
  });
}

/**
 * Return full enriched project snapshot (used by project_get and MCP App UI state responses).
 */
export function getProjectState(
  db,
  projectId,
  { task_id = null, include_notes = true, include_memories = true } = {}
) {
  const projectRow = db.prepare('SELECT * FROM Projects WHERE project_id = ?').get(projectId);
  if (!projectRow) {
    throw new WorkPlanError('PROJECT_NOT_FOUND', `Project "${projectId}" does not exist.`);
  }

  const taskRows = db
    .prepare('SELECT * FROM Tasks WHERE project_id = ? ORDER BY sort_key ASC, created_at ASC')
    .all(projectId);
  const depRows = db
    .prepare('SELECT upstream_id, downstream_id, created_at FROM TaskDeps WHERE project_id = ? ORDER BY created_at ASC')
    .all(projectId);

  const tasks = computeReadiness(taskRows, depRows);
  const activeEdits = listProjectActiveEdits(db, projectRow);
  const bindings = db
    .prepare('SELECT * FROM ConversationBindings WHERE project_id = ? ORDER BY bound_at DESC')
    .all(projectId);
  const project = formatProjectSummary(db, projectRow);
  const notes = include_notes ? listNotes(db, projectId, { task_id }) : [];
  const memories = include_memories ? listMemories(db, projectId) : [];

  let focusTask = null;
  let upstreamHandoffs = [];
  if (task_id) {
    focusTask = tasks.find((t) => t.task_id === task_id) || null;
    if (!focusTask) {
      throw new WorkPlanError(
        'TASK_NOT_FOUND',
        `Task "${task_id}" does not exist in project "${projectId}".`
      );
    }
    upstreamHandoffs = getUpstreamHandoffs(db, projectId, task_id);
  }

  return {
    project,
    tasks,
    deps: depRows,
    active_edits: activeEdits,
    bindings,
    notes,
    memories,
    ...(focusTask ? { focus_task: focusTask, upstream_handoffs: upstreamHandoffs } : {}),
  };
}
