import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class WorkPlanError extends Error {
  /**
   * Structured error returned by Work Plan core & MCP tools.
   * @param {string} code
   * @param {string} message
   * @param {string} [hint]
   */
  constructor(code, message, hint = '') {
    super(message);
    this.name = 'WorkPlanError';
    this.code = code;
    this.hint = hint;
  }

  toPayload() {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
    };
  }
}

function cleanEnvPath(val) {
  if (typeof val !== 'string') return '';
  const trimmed = val.trim();
  if (!trimmed || /^\$\{[^}]+\}$/.test(trimmed)) return '';
  return trimmed;
}

/**
 * Resolve persistent plugin data directory.
 */
export function resolveDataDir(explicitDir) {
  const fromArg = cleanEnvPath(explicitDir);
  if (fromArg) return path.resolve(fromArg);
  const fromEnv = cleanEnvPath(process.env.PLUGIN_DATA);
  if (fromEnv) return path.resolve(fromEnv);
  const fromSidecar = cleanEnvPath(process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR);
  if (fromSidecar) {
    const resolvedSidecar = path.resolve(fromSidecar);
    let cur = resolvedSidecar;
    while (true) {
      if (path.basename(cur) === 'sidecar_data') {
        const appData = path.dirname(cur);
        const rel = path.relative(cur, resolvedSidecar);
        const pluginDirName = (rel && rel.split(path.sep)[0]) || 'work-plan';
        return path.join(appData, 'plugin_data', pluginDirName);
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return path.join(os.homedir(), '.gemini', 'config', 'plugin-data', 'work-plan');
}

export function getDbPath(dataDir) {
  return path.join(resolveDataDir(dataDir), 'work_plan.db');
}

export function dbExists(dataDir) {
  try {
    return fs.existsSync(getDbPath(dataDir));
  } catch {
    return false;
  }
}

/**
 * Normalize a filesystem path to canonical POSIX form so symlinked roots
 * (like macOS /tmp -> /private/tmp or /var -> /private/var) match consistently
 * even when the leaf file does not exist yet.
 */
export function normalizePath(p) {
  if (typeof p !== 'string') return '';
  const trimmed = p.trim();
  if (!trimmed) return '';

  const expanded =
    trimmed === '~'
      ? os.homedir()
      : trimmed.startsWith('~/') || trimmed.startsWith('~\\')
        ? path.join(os.homedir(), trimmed.slice(2))
        : trimmed;

  const abs = path.resolve(expanded);
  let resolved = abs;
  try {
    resolved = fs.realpathSync.native(abs);
  } catch {
    // Walk up until an existing ancestor can be realpath'd
    let cur = abs;
    const tail = [];
    while (true) {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      tail.unshift(path.basename(cur));
      cur = parent;
      try {
        const realParent = fs.realpathSync.native(cur);
        resolved = path.join(realParent, ...tail);
        break;
      } catch {
        // continue walking up
      }
    }
  }

  let posix = resolved.replace(/\\/g, '/');
  posix = posix.replace(/^([A-Z]):\//, (_, drive) => `${drive.toLowerCase()}:/`);
  if (posix.length > 1 && !/^[a-z]:\/$/.test(posix)) {
    posix = posix.replace(/\/+$/, '');
  }
  return posix;
}

export function nowIso() {
  return new Date().toISOString();
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS Meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS Projects (
  project_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  workspace_dir TEXT NOT NULL DEFAULT '',
  repo_id TEXT NOT NULL DEFAULT '',
  source_ref TEXT NOT NULL DEFAULT '',
  kp_path TEXT NOT NULL DEFAULT '',
  kp_mode TEXT NOT NULL DEFAULT 'auto',
  pinned INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_proj_workspace ON Projects(workspace_dir);
CREATE INDEX IF NOT EXISTS ix_proj_repo ON Projects(repo_id);

CREATE TABLE IF NOT EXISTS Tasks (
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  parent_id TEXT,
  title TEXT NOT NULL,
  brief TEXT NOT NULL DEFAULT '',
  files_json TEXT NOT NULL DEFAULT '[]',
  target_tests_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'TODO' CHECK (
    status IN ('TODO', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW', 'DONE', 'CANCELLED')
  ),
  manual_status INTEGER NOT NULL DEFAULT 0,
  conv_id TEXT,
  worktree_path TEXT,
  branch_name TEXT,
  pr_url TEXT,
  handoff_notes TEXT NOT NULL DEFAULT '',
  sort_key INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, task_id),
  FOREIGN KEY (project_id) REFERENCES Projects(project_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_tasks_parent ON Tasks(project_id, parent_id);
CREATE INDEX IF NOT EXISTS ix_tasks_conv ON Tasks(conv_id);

CREATE TABLE IF NOT EXISTS TaskDeps (
  project_id TEXT NOT NULL,
  upstream_id TEXT NOT NULL,
  downstream_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, upstream_id, downstream_id),
  CHECK (upstream_id != downstream_id),
  FOREIGN KEY (project_id) REFERENCES Projects(project_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, upstream_id) REFERENCES Tasks(project_id, task_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, downstream_id) REFERENCES Tasks(project_id, task_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_deps_down ON TaskDeps(project_id, downstream_id);

CREATE TABLE IF NOT EXISTS ActiveEdits (
  repo_id TEXT NOT NULL,
  workspace_dir TEXT NOT NULL,
  file_path TEXT NOT NULL,
  conv_id TEXT NOT NULL,
  project_id TEXT,
  task_id TEXT,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, workspace_dir, file_path, conv_id)
);
CREATE INDEX IF NOT EXISTS ix_edits_file ON ActiveEdits(repo_id, file_path, expires_at);
CREATE INDEX IF NOT EXISTS ix_edits_conv ON ActiveEdits(conv_id);

CREATE TABLE IF NOT EXISTS ProjectNotes (
  note_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT,
  kind TEXT NOT NULL DEFAULT 'note' CHECK (
    kind IN ('decision', 'gotcha', 'spec', 'note')
  ),
  title TEXT NOT NULL,
  body_markdown TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  source_conv_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES Projects(project_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_notes_project ON ProjectNotes(project_id, pinned, updated_at);

CREATE TABLE IF NOT EXISTS ConversationBindings (
  conv_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT,
  workspace_dir TEXT NOT NULL DEFAULT '',
  bound_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES Projects(project_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ProjectMemories (
  memory_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'fact' CHECK (
    category IN ('architecture', 'convention', 'command', 'constraint', 'pitfall', 'context', 'fact')
  ),
  key TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  file_paths_json TEXT NOT NULL DEFAULT '[]',
  inject_mode TEXT NOT NULL DEFAULT 'always' CHECK (
    inject_mode IN ('always', 'on_demand', 'disabled')
  ),
  confidence TEXT NOT NULL DEFAULT 'confirmed' CHECK (
    confidence IN ('confirmed', 'inferred', 'stale')
  ),
  source TEXT NOT NULL DEFAULT 'user' CHECK (
    source IN ('user', 'agent', 'file')
  ),
  source_conv_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES Projects(project_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_memories_project ON ProjectMemories(project_id, inject_mode, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS ix_memories_project_key ON ProjectMemories(project_id, key) WHERE key != '';
`;

const txDepthMap = new WeakMap();

/**
 * Open (or create) the SQLite WAL database and run idempotent schema migrations.
 */
export function openDb(dataDir) {
  const resolvedDir = resolveDataDir(dataDir);
  fs.mkdirSync(resolvedDir, { recursive: true });
  const dbPath = getDbPath(resolvedDir);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA_SQL);
  const projCols = new Set(
    db
      .prepare('PRAGMA table_info(Projects)')
      .all()
      .map((c) => c.name)
  );
  if (!projCols.has('kp_path')) {
    db.exec("ALTER TABLE Projects ADD COLUMN kp_path TEXT NOT NULL DEFAULT '';");
  }
  if (!projCols.has('kp_mode')) {
    db.exec("ALTER TABLE Projects ADD COLUMN kp_mode TEXT NOT NULL DEFAULT 'auto';");
  }
  db.prepare(
    `INSERT INTO Meta (key, value) VALUES ('schema_version', '2')
     ON CONFLICT(key) DO UPDATE SET value = '2'`
  ).run();
  return db;
}

/**
 * Execute callback inside an immediate transaction (or savepoint if nested).
 */
export function withTransaction(db, fn) {
  const depth = txDepthMap.get(db) || 0;
  if (depth === 0) {
    txDepthMap.set(db, 1);
    db.exec('BEGIN IMMEDIATE;');
    try {
      const result = fn();
      db.exec('COMMIT;');
      return result;
    } catch (err) {
      try {
        db.exec('ROLLBACK;');
      } catch {
        // ignore rollback failure
      }
      throw err;
    } finally {
      txDepthMap.set(db, 0);
    }
  } else {
    const sp = `wp_sp_${depth}`;
    txDepthMap.set(db, depth + 1);
    db.exec(`SAVEPOINT ${sp};`);
    try {
      const result = fn();
      db.exec(`RELEASE SAVEPOINT ${sp};`);
      return result;
    } catch (err) {
      try {
        db.exec(`ROLLBACK TO SAVEPOINT ${sp};`);
        db.exec(`RELEASE SAVEPOINT ${sp};`);
      } catch {
        // ignore
      }
      throw err;
    } finally {
      txDepthMap.set(db, depth);
    }
  }
}

export function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM Meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setMeta(db, key, value) {
  db.prepare(
    'INSERT INTO Meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

export function deleteMeta(db, key) {
  db.prepare('DELETE FROM Meta WHERE key = ?').run(key);
}
