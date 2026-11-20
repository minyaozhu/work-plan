import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDb, normalizePath, WorkPlanError } from '../core/db.mjs';
import {
  checkAndRecordEdit,
  clearConversationEdits,
  clearSpecificEdit,
  isHighConflictFile,
  isIgnoredPath,
  listProjectActiveEdits,
  recordCommittedEdit,
} from '../core/edit_guard.mjs';
import { deleteNote, listNotes, saveNote } from '../core/notes.mjs';
import { parseMarkdownPlan, seedFromFolder, seedProjectSource } from '../core/sources.mjs';
import {
  archiveProject,
  bindConversation,
  computeReadiness,
  createProject,
  deleteProject,
  deleteTask,
  getProjectState,
  listProjects,
  MAX_DEPTH,
  MAX_TASKS,
  moveTask,
  planTasks,
  resolveProjectId,
  setTaskDep,
  startTask,
  updateProject,
  updateTask,
  validateGraphInvariants,
} from '../core/tasks.mjs';

function makeTempDir(prefix = 'work-plan-core-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('db: WAL mode, pragmas, schema migrations, and normalizePath', () => {
  const tmp = makeTempDir();
  try {
    const db = openDb(tmp);
    const mode = db.prepare('PRAGMA journal_mode').get();
    assert.equal(mode.journal_mode.toLowerCase(), 'wal');
    const fk = db.prepare('PRAGMA foreign_keys').get();
    assert.equal(fk.foreign_keys, 1);
    const version = db.prepare("SELECT value FROM Meta WHERE key = 'schema_version'").get();
    assert.equal(version.value, '2');

    // Non-existent nested file inside tmp resolves consistently with existing directory
    const p1 = normalizePath(path.join(tmp, 'new-sub', 'file.js'));
    const p2 = normalizePath(fs.realpathSync.native(tmp) + '/new-sub/file.js/');
    assert.equal(p1, p2);
    db.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('tasks: depth=8 allowed, depth=9 rejected; 500 tasks allowed, 501 rejected', () => {
  const tmp = makeTempDir();
  try {
    const db = openDb(tmp);
    const { project } = createProject(db, { title: 'Bounds Test', workspace_dir: tmp });

    // Depth 8 nested chain
    let nested = { title: 'Level 8' };
    for (let i = 7; i >= 1; i--) {
      nested = { title: `Level ${i}`, children: [nested] };
    }
    planTasks(db, project.project_id, { tasks: [nested] });
    const state = getProjectState(db, project.project_id);
    assert.equal(state.tasks.find((t) => t.task_id === 'level-8').depth, MAX_DEPTH);

    // Depth 9 must fail
    assert.throws(
      () =>
        planTasks(db, project.project_id, {
          parent_task_id: 'level-8',
          tasks: [{ title: 'Level 9' }],
        }),
      (err) => err instanceof WorkPlanError && err.code === 'MAX_DEPTH_EXCEEDED'
    );

    // 500 tasks allowed, 501 rejected
    const { project: p2 } = createProject(db, { title: 'Count Limit' });
    const batch = [];
    for (let i = 1; i <= MAX_TASKS; i++) {
      batch.push({ task_id: `t-${i}`, title: `Task ${i}` });
    }
    planTasks(db, p2.project_id, { tasks: batch });
    assert.equal(getProjectState(db, p2.project_id).tasks.length, MAX_TASKS);

    assert.throws(
      () => planTasks(db, p2.project_id, { tasks: [{ task_id: 't-501', title: 'Overflow' }] }),
      (err) => err instanceof WorkPlanError && err.code === 'MAX_TASKS_EXCEEDED'
    );
    db.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('tasks: DAG cycles, ancestor-descendant deps, and hierarchical cross-cycles', () => {
  const tasks = [
    { task_id: 'p', parent_id: null },
    { task_id: 'c1', parent_id: 'p' },
    { task_id: 'c2', parent_id: 'p' },
    { task_id: 'q', parent_id: null },
    { task_id: 'q1', parent_id: 'q' },
    { task_id: 'x', parent_id: null },
  ];

  // Valid cross-subtree interleaving: c1 -> q1, q1 -> c2 (does not involve p -> q -> p)
  assert.doesNotThrow(() =>
    validateGraphInvariants(tasks, [
      { upstream_id: 'c1', downstream_id: 'q1' },
      { upstream_id: 'q1', downstream_id: 'c2' },
    ])
  );

  // Direct self-loop
  assert.throws(
    () => validateGraphInvariants(tasks, [{ upstream_id: 'x', downstream_id: 'x' }]),
    (err) => err.code === 'CYCLE_DETECTED'
  );

  // Ancestor-descendant dep
  assert.throws(
    () => validateGraphInvariants(tasks, [{ upstream_id: 'p', downstream_id: 'c1' }]),
    (err) => err.code === 'CYCLE_DETECTED'
  );

  // Hierarchical cross-cycle 1: p -> x and x -> c1 (p contains c1)
  assert.throws(
    () =>
      validateGraphInvariants(tasks, [
        { upstream_id: 'p', downstream_id: 'x' },
        { upstream_id: 'x', downstream_id: 'c1' },
      ]),
    (err) => err.code === 'CYCLE_DETECTED'
  );

  // Hierarchical cross-cycle 2: x -> p and c1 -> x
  assert.throws(
    () =>
      validateGraphInvariants(tasks, [
        { upstream_id: 'x', downstream_id: 'p' },
        { upstream_id: 'c1', downstream_id: 'x' },
      ]),
    (err) => err.code === 'CYCLE_DETECTED'
  );

  // Cross-subtree bi-directional parent inversion: p -> q and q1 -> c1
  assert.throws(
    () =>
      validateGraphInvariants(tasks, [
        { upstream_id: 'p', downstream_id: 'q' },
        { upstream_id: 'q1', downstream_id: 'c1' },
      ]),
    (err) => err.code === 'CYCLE_DETECTED'
  );
});

test('tasks: idempotent task_plan updates same parent and allocates -2 + remaps on collision', () => {
  const tmp = makeTempDir();
  try {
    const db = openDb(tmp);
    const { project } = createProject(db, { title: 'Slug Test' });

    planTasks(db, project.project_id, {
      tasks: [
        { title: 'Auth', children: [{ title: 'Schema', brief: 'v1' }] },
        { title: 'Billing' },
      ],
    });

    // Re-plan Auth/Schema idempotently -> updates in place, preserves status
    updateTask(db, project.project_id, 'schema', { status: 'IN_PROGRESS' });
    planTasks(db, project.project_id, {
      tasks: [{ title: 'Auth', children: [{ title: 'Schema', brief: 'v2' }] }],
    });
    let state = getProjectState(db, project.project_id);
    const schema1 = state.tasks.find((t) => t.task_id === 'schema');
    assert.equal(schema1.brief, 'v2');
    assert.equal(schema1.status, 'IN_PROGRESS');

    // Add "Schema" under Billing -> allocates schema-2 and remaps depends_on within same call
    const res = planTasks(db, project.project_id, {
      parent_task_id: 'billing',
      tasks: [{ title: 'Schema' }, { title: 'Stripe Hook' }],
      depends_on: [['schema', 'stripe-hook']],
    });
    assert.deepEqual(res.remapped_slugs, { schema: 'schema-2' });
    assert.deepEqual(res.added_deps, [['schema-2', 'stripe-hook']]);

    state = getProjectState(db, project.project_id);
    const schema2 = state.tasks.find((t) => t.task_id === 'schema-2');
    assert.equal(schema2.parent_id, 'billing');
    assert.deepEqual(schema2.downstream_ids, ['stripe-hook']);
    db.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('tasks: auto-rollup rules, manual_status preservation, and readiness/handoffs', () => {
  const tmp = makeTempDir();
  try {
    const db = openDb(tmp);
    const { project } = createProject(db, { title: 'Rollup Test' });

    planTasks(db, project.project_id, {
      tasks: [
        {
          task_id: 'gp',
          title: 'Grandparent',
          children: [
            {
              task_id: 'p1',
              title: 'Parent 1',
              children: [
                { task_id: 'c1', title: 'Child 1' },
                { task_id: 'c2', title: 'Child 2' },
              ],
            },
            { task_id: 'p2', title: 'Parent 2' },
          ],
        },
      ],
      depends_on: [['p1', 'p2']],
    });

    // Mix of TODO + DONE -> IN_PROGRESS
    updateTask(db, project.project_id, 'c1', { status: 'DONE' });
    let state = getProjectState(db, project.project_id);
    assert.equal(state.tasks.find((t) => t.task_id === 'p1').status, 'IN_PROGRESS');
    assert.equal(state.tasks.find((t) => t.task_id === 'gp').status, 'IN_PROGRESS');
    assert.equal(state.tasks.find((t) => t.task_id === 'p2').is_ready, false);

    // p1 = IN_REVIEW without handoff -> p2 still waiting
    updateTask(db, project.project_id, 'c2', { status: 'IN_REVIEW' });
    state = getProjectState(db, project.project_id);
    assert.equal(state.tasks.find((t) => t.task_id === 'p1').status, 'IN_REVIEW');
    assert.equal(state.tasks.find((t) => t.task_id === 'p2').is_ready, false);

    // Attach handoff_notes to p1 while IN_REVIEW -> p2 becomes ready!
    updateTask(db, project.project_id, 'p1', { handoff_notes: 'Exported API in src/api.ts' });
    state = getProjectState(db, project.project_id);
    assert.equal(state.tasks.find((t) => t.task_id === 'p1').manual_status, false); // unchanged status didn't set manual
    assert.equal(state.tasks.find((t) => t.task_id === 'p2').is_ready, true);

    // Manual override on p1 stays sticky even if children change, while gp rolls up from p1=BLOCKED + p2=TODO -> BLOCKED
    updateTask(db, project.project_id, 'p1', { status: 'BLOCKED' });
    updateTask(db, project.project_id, 'c2', { status: 'DONE' });
    state = getProjectState(db, project.project_id);
    assert.equal(state.tasks.find((t) => t.task_id === 'p1').status, 'BLOCKED');
    assert.equal(state.tasks.find((t) => t.task_id === 'p1').manual_status, true);
    assert.equal(state.tasks.find((t) => t.task_id === 'gp').status, 'BLOCKED');

    // Resetting manual_status restores auto-rollup -> p1 becomes DONE and gp becomes IN_PROGRESS (DONE + TODO)
    updateTask(db, project.project_id, 'p1', { manual_status: false });
    state = getProjectState(db, project.project_id);
    assert.equal(state.tasks.find((t) => t.task_id === 'p1').status, 'DONE');
    assert.equal(state.tasks.find((t) => t.task_id === 'gp').status, 'IN_PROGRESS');

    // Cancel both children -> p1 rolls up to CANCELLED
    updateTask(db, project.project_id, 'c1', { status: 'CANCELLED' });
    updateTask(db, project.project_id, 'c2', { status: 'CANCELLED' });
    state = getProjectState(db, project.project_id);
    assert.equal(state.tasks.find((t) => t.task_id === 'p1').status, 'CANCELLED');

    db.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('tasks: startTask, moveTask, deleteTask, setTaskDep, and project resolution', () => {
  const tmp = makeTempDir();
  const ws = makeTempDir('ws-');
  try {
    const db = openDb(tmp);
    const { project } = createProject(db, { title: 'Lifecycle', workspace_dir: ws });
    planTasks(db, project.project_id, {
      tasks: [
        { task_id: 'a', title: 'Task A', handoff_notes: 'Schema ready' },
        { task_id: 'b', title: 'Task B', files: ['src/b.ts'] },
        { task_id: 'c', title: 'Task C' },
      ],
      depends_on: [['a', 'b']],
    });
    updateTask(db, project.project_id, 'a', { status: 'DONE' });

    const started = startTask(db, project.project_id, { task_id: 'b', conv_id: 'conv-1' });
    assert.equal(started.task.status, 'IN_PROGRESS');
    assert.equal(started.upstream_handoffs.length, 1);
    assert.equal(started.upstream_handoffs[0].handoff_notes, 'Schema ready');

    // Resolve project automatically via conv_id, workspace_dir, or sole active
    assert.equal(resolveProjectId(db, { conv_id: 'conv-1' }), project.project_id);
    assert.equal(resolveProjectId(db, { workspace_dir: ws }), project.project_id);
    assert.equal(resolveProjectId(db, {}), project.project_id);

    // Move c under b, check depth, then delete b non-cascading
    moveTask(db, project.project_id, 'c', { new_parent_id: 'b' });
    assert.equal(getProjectState(db, project.project_id).tasks.find((t) => t.task_id === 'c').parent_id, 'b');
    deleteTask(db, project.project_id, 'b', { cascade: false });
    const afterDel = getProjectState(db, project.project_id).tasks;
    assert.equal(afterDel.find((t) => t.task_id === 'b'), undefined);
    assert.equal(afterDel.find((t) => t.task_id === 'c').parent_id, null);

    setTaskDep(db, project.project_id, { upstream_id: 'a', downstream_id: 'c', action: 'add' });
    assert.deepEqual(
      getProjectState(db, project.project_id).deps.map((d) => [d.upstream_id, d.downstream_id]),
      [['a', 'c']]
    );
    setTaskDep(db, project.project_id, { upstream_id: 'a', downstream_id: 'c', action: 'remove' });
    assert.equal(getProjectState(db, project.project_id).deps.length, 0);

    // Rename, pin, archive, delete project
    const updatedProj = updateProject(db, project.project_id, { title: 'Lifecycle v2', pinned: true });
    assert.equal(updatedProj.title, 'Lifecycle v2');
    assert.equal(updatedProj.pinned, true);
    archiveProject(db, project.project_id, true);
    assert.equal(listProjects(db, { includeArchived: false }).length, 0);
    assert.equal(listProjects(db, { includeArchived: true }).length, 1);
    deleteProject(db, project.project_id);
    assert.equal(listProjects(db, { includeArchived: true }).length, 0);

    db.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('edit_guard: same-folder force_ask without phantom lock, worktree ask/allow, ignored paths, stop cleanup', () => {
  const dataDir = makeTempDir('data-');
  const repoMain = makeTempDir('repo-main-');
  const repoWt = path.join(path.dirname(repoMain), `${path.basename(repoMain)}-wt`);
  try {
    // Initialize real git repo + secondary worktree
    execFileSync('git', ['init'], { cwd: repoMain, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoMain });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoMain });
    fs.mkdirSync(path.join(repoMain, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoMain, 'src', 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(repoMain, 'package.json'), '{"name":"demo"}\n');
    execFileSync('git', ['add', '.'], { cwd: repoMain });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoMain, stdio: 'ignore' });
    execFileSync('git', ['worktree', 'add', '-b', 'feat-b', repoWt], { cwd: repoMain, stdio: 'ignore' });

    const db = openDb(dataDir);
    const { project } = createProject(db, { title: 'Repo Proj', workspace_dir: repoMain });
    planTasks(db, project.project_id, { tasks: [{ task_id: 't1', title: 'T1' }] });
    bindConversation(db, { conv_id: 'conv-a', project_id: project.project_id, task_id: 't1', workspace_dir: repoMain });

    // Ignored paths
    assert.equal(isIgnoredPath(path.join(os.tmpdir(), 'scratch.txt'), ['/Users/fake/project']), true);
    assert.equal(isIgnoredPath(path.join(os.tmpdir(), 'scratch.txt'), [repoMain]), true);
    assert.equal(isIgnoredPath(path.join(os.homedir(), '.gemini', 'foo.json'), [repoMain]), true);
    assert.equal(isIgnoredPath(path.join(os.homedir(), '.gemini', 'foo.json'), [os.homedir()]), true);
    assert.equal(isIgnoredPath('/etc/hosts', [repoMain]), true);
    assert.equal(isIgnoredPath(path.join(repoMain, 'src', 'a.ts'), [repoMain]), false);
    assert.equal(isHighConflictFile('package.json'), true);
    assert.equal(isHighConflictFile('api/service.proto'), true);
    assert.equal(isHighConflictFile('src/a.ts'), false);

    // Chat A edits src/a.ts -> allowed & recorded
    const resA = checkAndRecordEdit(db, {
      conv_id: 'conv-a',
      file_path: path.join(repoMain, 'src', 'a.ts'),
      workspace_paths: [repoMain],
      cwd: repoMain,
    });
    assert.equal(resA.decision, 'allow');

    // Chat B in SAME folder attempts src/a.ts -> force_ask, NO phantom lock for conv-b
    const resB = checkAndRecordEdit(db, {
      conv_id: 'conv-b',
      file_path: path.join(repoMain, 'src', 'a.ts'),
      workspace_paths: [repoMain],
      cwd: repoMain,
    });
    assert.equal(resB.decision, 'force_ask');
    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM ActiveEdits WHERE conv_id = 'conv-b'").get().c,
      0
    );

    // If user approves, post-edit commits lock for conv-b
    recordCommittedEdit(db, {
      conv_id: 'conv-b',
      file_path: path.join(repoMain, 'src', 'a.ts'),
      workspace_paths: [repoMain],
      cwd: repoMain,
    });
    const active = listProjectActiveEdits(db, getProjectState(db, project.project_id).project);
    assert.equal(active.length, 2);
    assert.equal(active.every((e) => e.same_folder_overlap === true), true);

    // Chat C in SECONDARY worktree edits src/a.ts -> allow (with info)
    const resC = checkAndRecordEdit(db, {
      conv_id: 'conv-c',
      file_path: path.join(repoWt, 'src', 'a.ts'),
      workspace_paths: [repoWt],
      cwd: repoWt,
    });
    assert.equal(resC.decision, 'allow');
    assert.match(resC.reason, /another worktree/i);

    // Chat A edits package.json, Chat C in worktree edits package.json -> ask
    checkAndRecordEdit(db, {
      conv_id: 'conv-a',
      file_path: path.join(repoMain, 'package.json'),
      workspace_paths: [repoMain],
      cwd: repoMain,
    });
    const resPkg = checkAndRecordEdit(db, {
      conv_id: 'conv-c',
      file_path: path.join(repoWt, 'package.json'),
      workspace_paths: [repoWt],
      cwd: repoWt,
    });
    assert.equal(resPkg.decision, 'ask');

    // Clear on Stop and clearSpecificEdit
    clearConversationEdits(db, 'conv-a');
    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM ActiveEdits WHERE conv_id = 'conv-a'").get().c,
      0
    );
    clearSpecificEdit(db, { conv_id: 'conv-b' });
    clearConversationEdits(db, 'conv-c');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM ActiveEdits').get().c, 0);

    db.close();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(repoMain, { recursive: true, force: true });
    fs.rmSync(repoWt, { recursive: true, force: true });
  }
});

test('notes & sources: Markdown/folder seeding and pinned/task-scoped note ranking', () => {
  const tmp = makeTempDir('notes-src-');
  const ws = makeTempDir('src-ws-');
  try {
    fs.mkdirSync(path.join(ws, 'backend'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'frontend'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'node_modules'), { recursive: true });
    const planMd = path.join(ws, 'PLAN.md');
    fs.writeFileSync(
      planMd,
      `# My Service Plan\n\n## API Gateway\nBuild routing layer.\n\n### Auth Middleware\nVerify JWT tokens.\n\n## Frontend Shell\nRender dashboard.\n`
    );

    const parsed = parseMarkdownPlan(fs.readFileSync(planMd, 'utf8'));
    assert.equal(parsed.title, 'My Service Plan');
    assert.equal(parsed.tasks.length, 2);
    assert.equal(parsed.tasks[0].children[0].title, 'Auth Middleware');

    const checkboxParsed = parseMarkdownPlan(
      `# E2E Demo Plan\n\n- [ ] Initialize API router\n- [x] Add UI components\n- [ ] Verify end-to-end tests\n`
    );
    assert.equal(checkboxParsed.title, 'E2E Demo Plan');
    assert.equal(checkboxParsed.tasks.length, 3);
    assert.equal(checkboxParsed.tasks[0].status, 'TODO');
    assert.equal(checkboxParsed.tasks[1].status, 'DONE');

    const mixedParsed = parseMarkdownPlan(
      `# Mixed Plan\n\n## Phase 1\nSetup phase\n- [ ] Item A\n- [x] Item B\n`
    );
    assert.equal(mixedParsed.tasks.length, 1);
    assert.equal(mixedParsed.tasks[0].brief, 'Setup phase');
    assert.equal(mixedParsed.tasks[0].children.length, 2);
    assert.equal(mixedParsed.tasks[0].children[1].status, 'DONE');

    const folderSeed = seedFromFolder(ws);
    assert.deepEqual(
      folderSeed.tasks.map((t) => t.title),
      ['backend', 'frontend']
    );

    const seeded = seedProjectSource({ source_ref: planMd, seed: true });
    assert.equal(seeded.title, 'My Service Plan');
    assert.equal(seeded.tasks.length, 2);

    const db = openDb(tmp);
    const { project } = createProject(db, { title: '', source_ref: planMd, seed: true });
    const n1 = saveNote(db, project.project_id, {
      title: 'Project Spec',
      body_markdown: 'Must run offline',
      kind: 'spec',
      pinned: false,
    });
    const n2 = saveNote(db, project.project_id, {
      title: 'Pinned Gotcha',
      body_markdown: 'Watch SQLite locks',
      kind: 'gotcha',
      pinned: true,
    });
    const n3 = saveNote(db, project.project_id, {
      title: 'Auth Decision',
      body_markdown: 'Use RS256',
      kind: 'decision',
      task_id: 'auth-middleware',
      pinned: false,
    });

    const ranked = listNotes(db, project.project_id, { task_id: 'auth-middleware' });
    assert.equal(ranked[0].note_id, n2.note_id); // pinned first
    assert.equal(ranked[1].note_id, n3.note_id); // task-scoped second
    assert.equal(ranked[2].note_id, n1.note_id);

    const filtered = listNotes(db, project.project_id, { query: 'rs256', kind: 'decision' });
    assert.equal(filtered.length, 1);
    assert.equal(deleteNote(db, project.project_id, n1.note_id), true);
    assert.equal(listNotes(db, project.project_id).length, 2);

    db.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
