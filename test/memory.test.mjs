import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openDb, WorkPlanError } from '../core/db.mjs';
import {
  deleteMemory,
  exportMemoriesMarkdown,
  listMemories,
  saveMemory,
  selectMemoriesForBrief,
} from '../core/memory.mjs';
import { createProject } from '../core/tasks.mjs';

function makeTempDir(prefix = 'wp-memory-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('memory: saveMemory idempotent key upsert, duplicate key check, enum validation, and delete by id/key', () => {
  const dir = makeTempDir();
  const db = openDb(dir);

  try {
    const { project } = createProject(db, { title: 'Mem Project', workspace_dir: dir });
    const pid = project.project_id;

    // 1. Create with key
    const m1 = saveMemory(db, pid, {
      key: 'Test Runner',
      title: 'Run tests',
      content: 'Use npm test',
      category: 'command',
      tags: ['Testing', 'CI', 'testing'],
      file_paths: ['./package.json', 'test/'],
      inject_mode: 'always',
      confidence: 'confirmed',
      source: 'user',
    });
    assert.equal(m1.key, 'test-runner');
    assert.deepEqual(m1.tags, ['testing', 'ci']);
    assert.deepEqual(m1.file_paths, ['package.json', 'test']);
    assert.ok(m1.memory_id.startsWith('mem-test-runner-'));

    // 2. Idempotent upsert by key updates existing row in place
    const m1Updated = saveMemory(db, pid, {
      key: 'test-runner',
      title: 'Run full test suite',
      content: 'Run npm run build:ui && npm test',
      category: 'command',
      inject_mode: 'always',
      confidence: 'confirmed',
    });
    assert.equal(m1Updated.memory_id, m1.memory_id);
    assert.equal(m1Updated.title, 'Run full test suite');

    // 3. Create second memory and verify duplicate key rejection on rename
    const m2 = saveMemory(db, pid, {
      key: 'db-wal',
      title: 'WAL Mode',
      content: 'SQLite uses WAL mode',
      category: 'architecture',
    });
    assert.throws(
      () =>
        saveMemory(db, pid, {
          memory_id: m2.memory_id,
          key: 'test-runner',
          title: 'WAL Mode',
          content: 'SQLite uses WAL mode',
        }),
      (err) => err instanceof WorkPlanError && err.code === 'DUPLICATE_MEMORY_KEY'
    );

    // 4. Enum validation
    assert.throws(
      () =>
        saveMemory(db, pid, {
          title: 'Bad',
          content: 'Bad',
          category: 'invalid_category',
        }),
      (err) => err instanceof WorkPlanError && err.code === 'VALIDATION_ERROR'
    );
    assert.throws(
      () =>
        saveMemory(db, pid, {
          title: 'Bad',
          content: 'Bad',
          inject_mode: 'sometimes',
        }),
      (err) => err instanceof WorkPlanError && err.code === 'VALIDATION_ERROR'
    );

    // 5. Delete by memory_id and by key
    assert.equal(deleteMemory(db, pid, m2.memory_id), true);
    assert.equal(deleteMemory(db, pid, 'test-runner'), true);
    assert.equal(deleteMemory(db, pid, 'missing'), false);
    assert.equal(listMemories(db, pid).length, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('memory: listMemories filtering/ranking, selectMemoriesForBrief budget, and exportMemoriesMarkdown', () => {
  const dir = makeTempDir();
  const db = openDb(dir);

  try {
    const { project } = createProject(db, { title: 'Mem Filter', workspace_dir: dir });
    const pid = project.project_id;

    saveMemory(db, pid, {
      key: 'muted-note',
      title: 'Muted Fact',
      content: 'Should not inject',
      category: 'fact',
      inject_mode: 'disabled',
      confidence: 'confirmed',
    });
    saveMemory(db, pid, {
      key: 'stale-rule',
      title: 'Stale Rule',
      content: 'Outdated rule should not inject',
      category: 'convention',
      inject_mode: 'always',
      confidence: 'stale',
    });
    saveMemory(db, pid, {
      key: 'always-inferred',
      title: 'Inferred Architecture',
      content: 'Layered core + mcp + ui',
      category: 'architecture',
      inject_mode: 'always',
      confidence: 'inferred',
      tags: ['arch'],
    });
    saveMemory(db, pid, {
      key: 'always-confirmed',
      title: 'Always Confirmed Command',
      content: 'Run npm test before committing',
      category: 'command',
      inject_mode: 'always',
      confidence: 'confirmed',
      tags: ['ci'],
    });
    saveMemory(db, pid, {
      key: 'ui-pitfall',
      title: 'CSP Inline Bundle',
      content: 'Never emit <script src=...> into ui/app.html',
      category: 'pitfall',
      inject_mode: 'on_demand',
      confidence: 'confirmed',
      file_paths: ['ui/src/main.js', 'scripts'],
      tags: ['csp'],
    });
    saveMemory(db, pid, {
      key: 'unrelated-ondemand',
      title: 'Hook Timing',
      content: 'Hooks must finish < 40ms',
      category: 'constraint',
      inject_mode: 'on_demand',
      confidence: 'confirmed',
      file_paths: ['hooks/hook.mjs'],
    });

    // Ranking: always before on_demand before disabled; confirmed before inferred before stale
    const all = listMemories(db, pid);
    assert.equal(all[0].key, 'always-confirmed');
    assert.equal(all[1].key, 'always-inferred');
    assert.equal(all[2].key, 'stale-rule');
    assert.equal(all[3].inject_mode, 'on_demand');
    assert.equal(all[all.length - 1].key, 'muted-note');

    // Filtering
    assert.equal(listMemories(db, pid, { category: 'pitfall' }).length, 1);
    assert.equal(listMemories(db, pid, { tag: 'CSP' }).length, 1);
    assert.equal(listMemories(db, pid, { file_path: 'scripts/build-ui.mjs' }).length, 1);
    assert.equal(listMemories(db, pid, { query: 'kahn' }).length, 0);
    assert.equal(listMemories(db, pid, { query: 'inline' }).length, 1);

    // selectMemoriesForBrief: includes always + matching on_demand, excludes disabled/stale/non-matching
    const brief = selectMemoriesForBrief(db, pid, {
      taskFiles: ['scripts/build-ui.mjs'],
      maxTotalChars: 1800,
    });
    const briefKeys = brief.items.map((i) => i.key);
    assert.ok(briefKeys.includes('always-confirmed'));
    assert.ok(briefKeys.includes('always-inferred'));
    assert.ok(briefKeys.includes('ui-pitfall'));
    assert.ok(!briefKeys.includes('muted-note'));
    assert.ok(!briefKeys.includes('stale-rule'));
    assert.ok(!briefKeys.includes('unrelated-ondemand'));

    // Budget cap enforces maxTotalChars
    const tight = selectMemoriesForBrief(db, pid, {
      taskFiles: ['scripts/build-ui.mjs'],
      maxTotalChars: 80,
    });
    assert.equal(tight.items.length, 1);

    // exportMemoriesMarkdown excludes disabled memories
    const md = exportMemoriesMarkdown(project, all);
    assert.match(md, /# Mem Filter — Project Memory/);
    assert.match(md, /Always Confirmed Command/);
    assert.match(md, /CSP Inline Bundle/);
    assert.equal(/Muted Fact/.test(md), false);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('memory: openDb migrates existing v1 SQLite DB to v2 ProjectMemories preserving pre-existing data', () => {
  const dir = makeTempDir('wp-v1-migrate-');
  const dbPath = path.join(dir, 'work_plan.db');

  try {
    // Seed a legacy v1 DB with NO ProjectMemories table
    const v1 = new DatabaseSync(dbPath);
    v1.exec(`
      CREATE TABLE Meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO Meta (key, value) VALUES ('schema_version', '1');
      CREATE TABLE Projects (
        project_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        workspace_dir TEXT NOT NULL DEFAULT '',
        repo_id TEXT NOT NULL DEFAULT '',
        source_ref TEXT NOT NULL DEFAULT '',
        pinned INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE Tasks (
        project_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        parent_id TEXT,
        title TEXT NOT NULL,
        brief TEXT NOT NULL DEFAULT '',
        files_json TEXT NOT NULL DEFAULT '[]',
        target_tests_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'TODO',
        manual_status INTEGER NOT NULL DEFAULT 0,
        conv_id TEXT,
        worktree_path TEXT,
        branch_name TEXT,
        pr_url TEXT,
        handoff_notes TEXT NOT NULL DEFAULT '',
        sort_key INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, task_id)
      );
      CREATE TABLE ProjectNotes (
        note_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        task_id TEXT,
        kind TEXT NOT NULL DEFAULT 'note',
        title TEXT NOT NULL,
        body_markdown TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        source_conv_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO Projects VALUES ('legacy-1', 'Legacy Project', '', '', '', 0, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
      INSERT INTO Tasks (project_id, task_id, title, created_at, updated_at) VALUES ('legacy-1', 't-old', 'Old Task', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
      INSERT INTO ProjectNotes VALUES ('n-old', 'legacy-1', NULL, 'note', 'Old Note', 'Keep me', 1, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    `);
    v1.close();

    // Open with openDb() -> migrates cleanly to v2
    const db = openDb(dir);
    try {
      const ver = db.prepare("SELECT value FROM Meta WHERE key = 'schema_version'").get();
      assert.equal(ver.value, '2');

      const proj = db.prepare("SELECT title FROM Projects WHERE project_id = 'legacy-1'").get();
      assert.equal(proj.title, 'Legacy Project');
      const task = db.prepare("SELECT title FROM Tasks WHERE project_id = 'legacy-1' AND task_id = 't-old'").get();
      assert.equal(task.title, 'Old Task');
      const note = db.prepare("SELECT title FROM ProjectNotes WHERE note_id = 'n-old'").get();
      assert.equal(note.title, 'Old Note');

      const mem = saveMemory(db, 'legacy-1', {
        key: 'migrated',
        title: 'Migrated OK',
        content: 'v2 ProjectMemories works on migrated DB',
      });
      assert.equal(mem.key, 'migrated');
      assert.equal(listMemories(db, 'legacy-1').length, 1);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
