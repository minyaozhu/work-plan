import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { openDb } from '../core/db.mjs';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN_MJS = path.join(PLUGIN_ROOT, 'bin', 'run.mjs');

function makeTempDir(prefix = 'wp-mcp-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runHook(mode, payloadObj, dataDir, extraEnv = {}) {
  const input = typeof payloadObj === 'string' ? payloadObj : JSON.stringify(payloadObj);
  const start = performance.now();
  const res = spawnSync('node', [RUN_MJS, 'hooks/hook.mjs', mode, '--data-dir', dataDir], {
    cwd: PLUGIN_ROOT,
    input,
    encoding: 'utf8',
    env: { ...process.env, PLUGIN_DATA: dataDir, ...extraEnv },
  });
  const elapsedMs = performance.now() - start;
  return { ...res, elapsedMs };
}

class StdioMcpClient {
  constructor(dataDir) {
    this.child = spawn('node', [RUN_MJS, 'mcp/server.mjs', '--data-dir', dataDir], {
      cwd: PLUGIN_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PLUGIN_DATA: dataDir },
    });
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
    this.buffer = '';

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk;
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let idx;
      while ((idx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          resolve(msg);
        }
      }
    });
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timeout for ${method}`));
      }, 5000);
      this.pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async close() {
    this.child.stdin.end();
    await new Promise((resolve) => this.child.on('close', resolve));
  }
}

test('mcp: stdio JSON-RPC lifecycle, 30 tools metadata, full task/note/memory/UI workflow, zero stderr warnings', async () => {
  const dataDir = makeTempDir('wp-mcp-data-');
  const wsDir = makeTempDir('wp-mcp-ws-');
  const client = new StdioMcpClient(dataDir);

  try {
    const init = await client.request('initialize', { protocolVersion: '2025-11-25' });
    assert.equal(init.result.serverInfo.name, 'work-plan');
    assert.ok(init.result.capabilities.extensions['io.modelcontextprotocol/ui']);
    client.notify('notifications/initialized');

    const ping = await client.request('ping');
    assert.deepEqual(ping.result, {});

    const listRes = await client.request('tools/list');
    const tools = listRes.result.tools;
    assert.equal(tools.length, 30); // 11 agent + 1 entrypoint + 18 app-only

    const openTool = tools.find((t) => t.name === 'open_work_plan');
    assert.equal(openTool._meta.ui.resourceUri, 'ui://work-plan/app.html');
    assert.equal(openTool._meta['com.google.antigravity/ui'].entrypoints.length, 2);

    const appOnlyTools = tools.filter((t) => t.name.startsWith('ui_'));
    assert.equal(appOnlyTools.length, 18);
    assert.ok(appOnlyTools.every((t) => t._meta?.ui?.visibility?.includes('app')));

    const resList = await client.request('resources/list');
    assert.equal(resList.result.resources[0].uri, 'ui://work-plan/app.html');
    assert.equal(resList.result.resources[0].mimeType, 'text/html;profile=mcp-app');

    const resRead = await client.request('resources/read', { uri: 'ui://work-plan/app.html' });
    assert.equal(resRead.result.contents[0].mimeType, 'text/html;profile=mcp-app');

    // Empty open_work_plan works cleanly
    const emptyOpen = await client.request('tools/call', { name: 'open_work_plan', arguments: {} });
    assert.equal(emptyOpen.result.structuredContent.projects.length, 0);

    // Create project -> plan tasks -> start -> update with handoff -> note -> get
    const created = await client.request('tools/call', {
      name: 'project_create',
      arguments: { title: 'MCP E2E', workspace_dir: wsDir },
    });
    const projectId = created.result.structuredContent.project.project_id;
    assert.ok(projectId.startsWith('mcp-e2e-'));

    await client.request('tools/call', {
      name: 'task_plan',
      arguments: {
        project_id: projectId,
        tasks: [
          { task_id: 'step-1', title: 'Step 1', brief: 'Build schema' },
          { task_id: 'step-2', title: 'Step 2', brief: 'Build UI', files: ['ui/app.html'] },
        ],
        depends_on: [['step-1', 'step-2']],
      },
    });

    await client.request('tools/call', {
      name: 'task_start',
      arguments: { project_id: projectId, task_id: 'step-1' },
    });
    await client.request('tools/call', {
      name: 'task_update',
      arguments: {
        project_id: projectId,
        task_id: 'step-1',
        status: 'DONE',
        handoff_notes: 'Schema exported cleanly.',
      },
    });

    const start2 = await client.request('tools/call', {
      name: 'task_start',
      arguments: { project_id: projectId, task_id: 'step-2' },
    });
    assert.equal(start2.result.structuredContent.upstream_handoffs[0].handoff_notes, 'Schema exported cleanly.');

    await client.request('tools/call', {
      name: 'note_save',
      arguments: {
        project_id: projectId,
        title: 'Key Rule',
        body_markdown: 'Always validate DAG',
        kind: 'decision',
        pinned: true,
      },
    });

    const notes = await client.request('tools/call', {
      name: 'note_list',
      arguments: { project_id: projectId },
    });
    assert.equal(notes.result.structuredContent.notes.length, 1);

    // Project Memory agent workflow: save -> idempotent upsert by key -> list -> delete
    const mem1 = await client.request('tools/call', {
      name: 'memory_save',
      arguments: {
        project_id: projectId,
        key: 'test-cmd',
        title: 'Run tests',
        content: 'Run npm test',
        category: 'command',
        inject_mode: 'always',
      },
    });
    assert.equal(mem1.result.isError, undefined);
    const mem1Id = mem1.result.structuredContent.memory.memory_id;
    assert.equal(mem1.result.structuredContent.memory.source, 'agent');
    assert.equal(mem1.result.structuredContent.memory.confidence, 'inferred');

    const mem1Upsert = await client.request('tools/call', {
      name: 'memory_save',
      arguments: {
        project_id: projectId,
        key: 'test-cmd',
        title: 'Run test suite',
        content: 'Run npm run build:ui && npm test',
        category: 'command',
        confidence: 'confirmed',
      },
    });
    assert.equal(mem1Upsert.result.structuredContent.memory.memory_id, mem1Id);

    const memList = await client.request('tools/call', {
      name: 'memory_list',
      arguments: { project_id: projectId, category: 'command' },
    });
    assert.equal(memList.result.structuredContent.memories.length, 1);
    assert.equal(memList.result.structuredContent.memories[0].title, 'Run test suite');

    const memDel = await client.request('tools/call', {
      name: 'memory_delete',
      arguments: { project_id: projectId, key: 'test-cmd' },
    });
    assert.equal(memDel.result.structuredContent.deleted, true);

    // Cycle check returns structured isError payload
    const badCycle = await client.request('tools/call', {
      name: 'task_plan',
      arguments: {
        project_id: projectId,
        tasks: [],
        depends_on: [['step-2', 'step-1']],
      },
    });
    assert.equal(badCycle.result.isError, true);
    assert.equal(badCycle.result.structuredContent.error.code, 'CYCLE_DETECTED');

    // UI tool mutation
    const uiRes = await client.request('tools/call', {
      name: 'ui_create_task',
      arguments: { project_id: projectId, title: 'Step 3' },
    });
    assert.equal(uiRes.result.structuredContent.state.tasks.length, 3);

    // UI path browser tool
    fs.writeFileSync(path.join(wsDir, 'PLAN.md'), '# Plan\n');
    const browseRes = await client.request('tools/call', {
      name: 'ui_browse_dir',
      arguments: { path: wsDir, include_files: true, extensions: ['.md'] },
    });
    assert.equal(browseRes.result.isError, undefined);
    assert.ok(browseRes.result.structuredContent.entries.some((e) => e.name === 'PLAN.md' && !e.is_dir));

    await client.close();
    assert.equal(client.stderr.trim(), '');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
});

test('hooks: fail-open missing DB/corrupt stdin, post-mcp, pre-edit/post-edit, stop, post-command, pre-invocation SHA', () => {
  const dataDir = makeTempDir('wp-hooks-data-');
  const repoDir = makeTempDir('wp-hooks-repo-');

  try {
    // 1. Missing DB fails open cleanly with zero stderr warnings
    const missingPre = runHook('pre-edit', { conversationId: 'c0', toolCall: { args: { Path: 'a.js' } } }, dataDir);
    assert.equal(missingPre.status, 0);
    assert.equal(missingPre.stderr, '');
    assert.deepEqual(JSON.parse(missingPre.stdout), { decision: 'allow' });

    const missingPreInv = runHook('pre-invocation', { conversationId: 'c0' }, dataDir);
    assert.equal(missingPreInv.status, 0);
    assert.deepEqual(JSON.parse(missingPreInv.stdout), {});

    // 2. Init git repo + seed project via DB
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'index.js'), 'console.log(1);\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['checkout', '-b', 'feat/work'], { cwd: repoDir, stdio: 'ignore' });

    const clientSeed = spawnSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `import { openDb } from './core/db.mjs';
         import { createProject, planTasks, updateTask } from './core/tasks.mjs';
         import { saveNote } from './core/notes.mjs';
         import { saveMemory } from './core/memory.mjs';
         const db = openDb(process.argv[1]);
         const { project } = createProject(db, { title: 'Hook Test', workspace_dir: process.argv[2] });
         planTasks(db, project.project_id, {
           tasks: [
             { task_id: 't1', title: 'Upstream', handoff_notes: 'Ready for t2' },
             { task_id: 't2', title: 'Downstream', brief: 'Consume t1', files: ['index.js'] },
             { task_id: 't3', title: 'Other' }
           ],
           depends_on: [['t1', 't2']]
         });
         updateTask(db, project.project_id, 't1', { status: 'DONE' });
         saveNote(db, project.project_id, { title: 'Note 1', body_markdown: 'Important gotcha', kind: 'gotcha', pinned: true });
         saveMemory(db, project.project_id, { key: 'always-mem', title: 'Always Rule', content: 'Always use WAL mode', category: 'architecture', inject_mode: 'always', confidence: 'confirmed' });
         saveMemory(db, project.project_id, { key: 'index-mem', title: 'Index Context', content: 'index.js exports main handler', category: 'context', inject_mode: 'on_demand', file_paths: ['index.js'], confidence: 'confirmed' });
         saveMemory(db, project.project_id, { key: 'muted-mem', title: 'Muted Context', content: 'Should stay muted', category: 'fact', inject_mode: 'disabled', confidence: 'confirmed' });
         saveMemory(db, project.project_id, { key: 'stale-mem', title: 'Stale Context', content: 'Should stay stale', category: 'fact', inject_mode: 'always', confidence: 'stale' });
         db.close();`,
        dataDir,
        repoDir,
      ],
      { cwd: PLUGIN_ROOT, encoding: 'utf8' }
    );
    assert.equal(clientSeed.status, 0, clientSeed.stderr);

    // 3. Corrupt stdin fails open
    const corrupt = runHook('pre-edit', '{not valid json', dataDir);
    assert.equal(corrupt.status, 0);
    assert.deepEqual(JSON.parse(corrupt.stdout), { decision: 'allow' });

    // 4. post-mcp binds conv-a via call_mcp_tool and conv-b via eager mcp_work_plan_task_start
    const pm1 = runHook(
      'post-mcp',
      {
        conversationId: 'conv-a',
        workspacePaths: [repoDir],
        cwd: repoDir,
        toolCall: {
          name: 'call_mcp_tool',
          args: { ServerName: 'work_plan', ToolName: 'task_start', Arguments: { task_id: 't2' } },
        },
      },
      dataDir
    );
    assert.equal(pm1.status, 0);

    const pm2 = runHook(
      'post-mcp',
      {
        conversationId: 'conv-b',
        workspacePaths: [repoDir],
        cwd: repoDir,
        toolCall: {
          name: 'mcp_work_plan_task_start',
          args: { task_id: 't3' },
        },
      },
      dataDir
    );
    assert.equal(pm2.status, 0);

    // 5. pre-edit: conv-a allowed -> conv-b force_ask (no phantom lock) -> post-edit commits conv-b lock -> stop clears conv-b
    const pe1 = runHook(
      'pre-edit',
      {
        conversationId: 'conv-a',
        workspacePaths: [repoDir],
        cwd: repoDir,
        toolCall: { name: 'edit_file', args: { TargetFile: path.join(repoDir, 'index.js') } },
      },
      dataDir
    );
    assert.deepEqual(JSON.parse(pe1.stdout), { decision: 'allow' });

    const pe2 = runHook(
      'pre-edit',
      {
        conversationId: 'conv-b',
        workspacePaths: [repoDir],
        cwd: repoDir,
        toolCall: { name: 'replace_file_content', args: { TargetFile: path.join(repoDir, 'index.js') } },
      },
      dataDir
    );
    const pe2Json = JSON.parse(pe2.stdout);
    assert.equal(pe2Json.decision, 'force_ask');
    assert.match(pe2Json.reason, /t2|conv-a/);

    // Verify no phantom lock for conv-b before post-edit
    let db = openDb(dataDir);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM ActiveEdits WHERE conv_id = 'conv-b'").get().c, 0);
    db.close();

    // Simulate user approval -> post-edit records lock
    const postEd = runHook(
      'post-edit',
      {
        conversationId: 'conv-b',
        workspacePaths: [repoDir],
        cwd: repoDir,
        toolCall: { name: 'replace_file_content', args: { TargetFile: path.join(repoDir, 'index.js') } },
      },
      dataDir
    );
    assert.equal(postEd.status, 0);
    db = openDb(dataDir);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM ActiveEdits WHERE conv_id = 'conv-b'").get().c, 1);
    db.close();

    // Stop clears conv-b on USER_CANCELED and conv-a on fullyIdle
    const stopB = runHook('stop', { conversationId: 'conv-b', fullyIdle: false, terminationReason: 'USER_CANCELED' }, dataDir);
    assert.deepEqual(JSON.parse(stopB.stdout), { decision: 'allow' });
    const stopA = runHook('stop', { conversationId: 'conv-a', fullyIdle: true, terminationReason: 'NO_TOOL_CALL' }, dataDir);
    assert.deepEqual(JSON.parse(stopA.stdout), { decision: 'allow' });

    db = openDb(dataDir);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM ActiveEdits').get().c, 0);
    db.close();

    // 6. post-command captures git branch + PR URL from transcript
    const transcriptFile = path.join(dataDir, 'transcript.jsonl');
    fs.writeFileSync(
      transcriptFile,
      JSON.stringify({ content: 'Created PR https://github.com/acme/demo/pull/42' }) + '\n'
    );
    const pc = runHook(
      'post-command',
      {
        conversationId: 'conv-a',
        cwd: repoDir,
        transcriptPath: transcriptFile,
        toolCall: { name: 'run_command', args: { CommandLine: 'gh pr create --fill' } },
      },
      dataDir
    );
    assert.equal(pc.status, 0);
    db = openDb(dataDir);
    const t2Row = db.prepare("SELECT branch_name, pr_url FROM Tasks WHERE task_id = 't2'").get();
    assert.equal(t2Row.branch_name, 'feat/work');
    assert.equal(t2Row.pr_url, 'https://github.com/acme/demo/pull/42');
    db.close();

    // 7. pre-invocation injects brief on first run, dedups via SHA on second run, re-injects when changed
    const pi1 = runHook('pre-invocation', { conversationId: 'conv-a', workspacePaths: [repoDir], cwd: repoDir }, dataDir);
    const pi1Json = JSON.parse(pi1.stdout);
    assert.equal(pi1Json.injectSteps.length, 1);
    const brief1 = pi1Json.injectSteps[0].systemMessage.systemMessage;
    assert.match(brief1, /\[WORK PLAN\]/);
    assert.match(brief1, /Ready for t2/);
    assert.match(brief1, /Important gotcha/);
    assert.match(brief1, /Project memory:/);
    assert.match(brief1, /Always Rule: Always use WAL mode/);
    assert.match(brief1, /Index Context: index\.js exports main handler/);
    assert.equal(/Should stay muted/.test(brief1), false);
    assert.equal(/Should stay stale/.test(brief1), false);

    const latencies = [];
    for (let i = 0; i < 10; i++) {
      const piWarm = runHook('pre-invocation', { conversationId: 'conv-a', workspacePaths: [repoDir], cwd: repoDir }, dataDir);
      assert.deepEqual(JSON.parse(piWarm.stdout), {});
      latencies.push(piWarm.elapsedMs);
    }
    latencies.sort((a, b) => a - b);
    const p95 = latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)];
    test.diagnostic?.(`pre-invocation warm subprocess p95: ${p95.toFixed(1)} ms`);
    console.log(`# pre-invocation warm subprocess p95: ${p95.toFixed(1)} ms`);

    // Updating a memory changes the digest and triggers a fresh injection
    const memUpdate = spawnSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `import { openDb } from './core/db.mjs';
         import { saveMemory } from './core/memory.mjs';
         import { resolveProjectId } from './core/tasks.mjs';
         const db = openDb(process.argv[1]);
         const pid = resolveProjectId(db, { conv_id: 'conv-a' });
         saveMemory(db, pid, { key: 'always-mem', title: 'Always Rule', content: 'Always use WAL + busy_timeout', category: 'architecture', inject_mode: 'always', confidence: 'confirmed' });
         db.close();`,
        dataDir,
      ],
      { cwd: PLUGIN_ROOT, encoding: 'utf8' }
    );
    assert.equal(memUpdate.status, 0, memUpdate.stderr);
    const piUpdated = runHook('pre-invocation', { conversationId: 'conv-a', workspacePaths: [repoDir], cwd: repoDir }, dataDir);
    const piUpdatedJson = JSON.parse(piUpdated.stdout);
    assert.equal(piUpdatedJson.injectSteps.length, 1);
    assert.match(piUpdatedJson.injectSteps[0].systemMessage.systemMessage, /busy_timeout/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
