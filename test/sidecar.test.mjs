import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { openDb, resolveDataDir } from '../core/db.mjs';
import { startStandaloneServer } from '../sidecars/work_plan/main.mjs';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeTempDir(prefix = 'wp-sidecar-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('sidecar: sidecar.json declares valid AUX_PANE web UI entrypoint', () => {
  const manifestPath = path.join(PLUGIN_ROOT, 'sidecars', 'work_plan', 'sidecar.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  assert.equal(manifest.has_web_ui, true);
  assert.equal(manifest.command, 'node');
  assert.deepEqual(manifest.args, ['main.mjs']);
  assert.ok(Array.isArray(manifest.ui_config?.views));
  const auxView = manifest.ui_config.views.find((v) => v.entrypoint === 'SIDECAR_UI_ENTRYPOINT_AUX_PANE');
  assert.ok(auxView, 'Expected SIDECAR_UI_ENTRYPOINT_AUX_PANE view');
  assert.equal(auxView.path, '/');
});

test('sidecar: resolveDataDir maps ANTIGRAVITY_EXECUTABLE_DATA_DIR to plugin_data with proper precedence', () => {
  const prevPluginData = process.env.PLUGIN_DATA;
  const prevSidecarData = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;

  try {
    delete process.env.PLUGIN_DATA;
    process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = '/tmp/app/sidecar_data/work-plan/work_plan/data';
    assert.equal(resolveDataDir(), path.resolve('/tmp/app/plugin_data/work-plan'));

    process.env.PLUGIN_DATA = '/tmp/explicit-plugin-data';
    assert.equal(resolveDataDir(), path.resolve('/tmp/explicit-plugin-data'));

    assert.equal(resolveDataDir('/tmp/cli-arg-data'), path.resolve('/tmp/cli-arg-data'));
  } finally {
    if (prevPluginData === undefined) delete process.env.PLUGIN_DATA;
    else process.env.PLUGIN_DATA = prevPluginData;
    if (prevSidecarData === undefined) delete process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
    else process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = prevSidecarData;
  }
});

test('sidecar: HTTP server injects sidecar head, enforces token, allowlists UI tools, and handles WorkPlanError', async () => {
  const dataDir = makeTempDir('wp-sidecar-data-');
  const wsDir = makeTempDir('wp-sidecar-ws-');
  const db = openDb(dataDir);
  const token = 'test-secret-token';
  let srv = null;

  try {
    srv = await startStandaloneServer({ db, pluginRoot: PLUGIN_ROOT, port: 0, token });
    const baseUrl = `http://127.0.0.1:${srv.port}`;

    // Verify GET / injects sidecar meta & preload while on-disk ui/app.html remains SEP-1865 CSP-safe
    const htmlRes = await fetch(`${baseUrl}/`);
    assert.equal(htmlRes.status, 200);
    const servedHtml = await htmlRes.text();
    assert.match(servedHtml, /<meta\s+name="wp-transport"\s+content="sidecar">/i);
    assert.match(servedHtml, /<script\s+src="\/preload\.js"><\/script>/i);

    const diskHtml = fs.readFileSync(path.join(PLUGIN_ROOT, 'ui', 'app.html'), 'utf8');
    assert.equal(/<script[^>]+src=/i.test(diskHtml), false);

    // Token enforcement on POST /api/tool
    const unauthRes = await fetch(`${baseUrl}/api/tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ui_get_state', arguments: {} }),
    });
    assert.equal(unauthRes.status, 401);

    const callTool = async (name, args = {}) => {
      const res = await fetch(`${baseUrl}/api/tool`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sidecar-Token': token,
        },
        body: JSON.stringify({ name, arguments: args }),
      });
      return { status: res.status, body: await res.json() };
    };

    // Allowed UI tools: create project -> create two tasks -> inspect state
    const projRes = await callTool('ui_create_project', {
      title: 'Sidecar Test',
      workspace_dir: wsDir,
      seed: false,
    });
    assert.equal(projRes.status, 200);
    assert.equal(projRes.body.isError, undefined);
    const projectId = projRes.body.structuredContent.selected_project_id;
    assert.ok(projectId.startsWith('sidecar-test-'));

    const t1Res = await callTool('ui_create_task', { project_id: projectId, title: 'Step A' });
    assert.equal(t1Res.status, 200);
    const t1Id = t1Res.body.structuredContent.created_task_id;

    const t2Res = await callTool('ui_create_task', { project_id: projectId, title: 'Step B' });
    assert.equal(t2Res.status, 200);
    const t2Id = t2Res.body.structuredContent.created_task_id;

    const stateRes = await callTool('ui_get_state', { project_id: projectId });
    assert.equal(stateRes.status, 200);
    assert.equal(stateRes.body.structuredContent.state.tasks.length, 2);

    // Reject non-UI agent tools with FORBIDDEN_TOOL
    const forbiddenRes = await callTool('project_create', { title: 'Nope' });
    assert.equal(forbiddenRes.status, 200);
    assert.equal(forbiddenRes.body.isError, true);
    assert.equal(forbiddenRes.body.error.code, 'FORBIDDEN_TOOL');

    // Dependency cycle returns HTTP 200 with structured CYCLE_DETECTED error
    const depOk = await callTool('ui_set_dep', {
      project_id: projectId,
      upstream_id: t1Id,
      downstream_id: t2Id,
      action: 'add',
    });
    assert.equal(depOk.status, 200);
    assert.equal(depOk.body.isError, undefined);

    const depCycle = await callTool('ui_set_dep', {
      project_id: projectId,
      upstream_id: t2Id,
      downstream_id: t1Id,
      action: 'add',
    });
    assert.equal(depCycle.status, 200);
    assert.equal(depCycle.body.isError, true);
    assert.equal(depCycle.body.error.code, 'CYCLE_DETECTED');

    // Project Memory UI endpoints over Sidecar POST /api/tool
    const memSave = await callTool('ui_save_memory', {
      project_id: projectId,
      key: 'build-ui',
      title: 'UI Build Command',
      content: 'Run npm run build:ui after modifying ui/src/*',
      category: 'command',
      tags: ['ui', 'build'],
      file_paths: ['scripts/build-ui.mjs'],
      inject_mode: 'always',
      confidence: 'confirmed',
    });
    assert.equal(memSave.status, 200);
    assert.equal(memSave.body.isError, undefined);
    assert.equal(memSave.body.structuredContent.state.memories.length, 1);
    const savedMemId = memSave.body.structuredContent.state.memories[0].memory_id;

    const memDelete = await callTool('ui_delete_memory', {
      project_id: projectId,
      memory_id: savedMemId,
    });
    assert.equal(memDelete.status, 200);
    assert.equal(memDelete.body.isError, undefined);
    assert.equal(memDelete.body.structuredContent.state.memories.length, 0);
  } finally {
    await srv?.close();
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
});

test('sidecar: ui_browse_dir supports dirs-only, git detection, extensions preserving dirs, dotfiles, symlinks, and missing-path notice', async () => {
  const dataDir = makeTempDir('wp-browse-data-');
  const rootDir = makeTempDir('wp-browse-root-');
  const db = openDb(dataDir);
  const token = 'browse-token';
  let srv = null;

  try {
    fs.mkdirSync(path.join(rootDir, 'repo', '.git'), { recursive: true });
    fs.mkdirSync(path.join(rootDir, 'plain-dir'));
    fs.mkdirSync(path.join(rootDir, '.hidden-dir'));
    fs.writeFileSync(path.join(rootDir, '.hidden.md'), '# Hidden\n');
    fs.writeFileSync(path.join(rootDir, 'PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(rootDir, 'index.js'), 'console.log(1);\n');
    try {
      fs.symlinkSync(path.join(rootDir, 'plain-dir'), path.join(rootDir, 'link-dir'));
    } catch {
      // ignore if symlinks are unsupported
    }

    srv = await startStandaloneServer({ db, pluginRoot: PLUGIN_ROOT, port: 0, token });
    const baseUrl = `http://127.0.0.1:${srv.port}`;

    const browse = async (args) => {
      const res = await fetch(`${baseUrl}/api/tool`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sidecar-Token': token,
        },
        body: JSON.stringify({ name: 'ui_browse_dir', arguments: args }),
      });
      assert.equal(res.status, 200);
      return res.json();
    };

    // 1. Dirs-only excludes files & dotfiles, marks git repos, follows symlinked dirs
    const dirsOnly = await browse({ path: rootDir, include_files: false });
    const dirNames = dirsOnly.structuredContent.entries.map((e) => e.name);
    assert.ok(dirNames.includes('repo'));
    assert.ok(dirNames.includes('plain-dir'));
    assert.ok(!dirNames.includes('.hidden-dir'));
    assert.ok(!dirNames.includes('PLAN.md'));
    assert.equal(dirsOnly.structuredContent.entries.find((e) => e.name === 'repo').is_git_repo, true);
    assert.equal(dirsOnly.structuredContent.entries.find((e) => e.name === 'plain-dir').is_git_repo, false);
    if (fs.existsSync(path.join(rootDir, 'link-dir'))) {
      const linkEntry = dirsOnly.structuredContent.entries.find((e) => e.name === 'link-dir');
      assert.ok(linkEntry && linkEntry.is_dir === true);
    }

    // 2. Extension filter filters files while preserving directories
    const mdOnly = await browse({ path: rootDir, include_files: true, extensions: ['.md'] });
    const mdNames = mdOnly.structuredContent.entries.map((e) => e.name);
    assert.ok(mdNames.includes('repo'));
    assert.ok(mdNames.includes('plain-dir'));
    assert.ok(mdNames.includes('PLAN.md'));
    assert.ok(!mdNames.includes('index.js'));

    // 3. include_hidden reveals dotfiles and dotdirs
    const hidden = await browse({ path: rootDir, include_files: true, include_hidden: true });
    const hiddenNames = hidden.structuredContent.entries.map((e) => e.name);
    assert.ok(hiddenNames.includes('.hidden-dir'));
    assert.ok(hiddenNames.includes('.hidden.md'));

    // 4. Nonexistent nested path walks up to nearest existing parent with a notice
    const missing = await browse({ path: path.join(rootDir, 'does-not-exist', 'nested') });
    assert.equal(missing.structuredContent.current, dirsOnly.structuredContent.current);
    assert.match(missing.structuredContent.notice, /^Path not found; showing /);

    // 5. HTTP edge cases: GET /api/state, 405 wrong methods, 400 malformed JSON, 404 unknown route
    const stateGet = await fetch(`${baseUrl}/api/state`);
    assert.equal(stateGet.status, 200);
    const stateJson = await stateGet.json();
    assert.ok(Array.isArray(stateJson.structuredContent.projects));

    const wrongToolMethod = await fetch(`${baseUrl}/api/tool`, { method: 'GET' });
    assert.equal(wrongToolMethod.status, 405);

    const wrongStateMethod = await fetch(`${baseUrl}/api/state`, { method: 'POST' });
    assert.equal(wrongStateMethod.status, 405);

    const badJson = await fetch(`${baseUrl}/api/tool`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sidecar-Token': token,
      },
      body: '{not-valid-json',
    });
    assert.equal(badJson.status, 400);

    const notFound = await fetch(`${baseUrl}/no-such-route`);
    assert.equal(notFound.status, 404);
  } finally {
    await srv?.close();
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
