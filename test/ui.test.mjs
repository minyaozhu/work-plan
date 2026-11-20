import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CARD_H, CARD_W, formatNodeTooltip, layoutGraph } from '../ui/src/graph.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_HTML_PATH = path.join(ROOT, 'ui', 'app.html');

test('ui: bundled app.html is self-contained, CSP-safe, themed, and under 1 MiB', () => {
  assert.equal(fs.existsSync(APP_HTML_PATH), true);
  const stat = fs.statSync(APP_HTML_PATH);
  assert.ok(stat.size > 10_000, `Expected non-trivial bundle, got ${stat.size} bytes`);
  assert.ok(stat.size < 1024 * 1024, `Expected bundle < 1 MiB, got ${stat.size} bytes`);

  const html = fs.readFileSync(APP_HTML_PATH, 'utf8');
  assert.match(html, /<meta\s+name="color-scheme"\s+content="light dark">/i);
  assert.match(html, /--color-background-primary/);
  assert.match(html, /com\.google\.antigravity\/toggle-aux-pane/);
  assert.match(html, /com\.google\.antigravity\/message/);
  assert.match(html, /closedby="any"/);
  assert.match(html, /closedBy/); // JS light-dismiss fallback

  // Zero external scripts, stylesheets, or inline onclick handlers
  assert.equal(/<script[^>]+src=/i.test(html), false);
  assert.equal(/<link[^>]+href=["']https?:/i.test(html), false);
  assert.equal(/\bonclick=/i.test(html), false);

  // Never call sandbox-blocked browser dialogs
  assert.equal(/\bwindow\.(confirm|prompt|alert)\(/i.test(html), false);

  // Active Edits tab replaces top #active-strip
  assert.match(html, /id="tab-active-edits-btn"/);
  assert.match(html, /id="active-edits-view"/);
  assert.equal(/id="active-strip"/.test(html), false);
});

test('ui: formatNodeTooltip returns task title and trimmed brief', () => {
  assert.deepEqual(formatNodeTooltip({ task_id: 't1', title: 'Build API', brief: '  REST routes + schema  ' }), {
    title: 'Build API',
    brief: 'REST routes + schema',
  });
  assert.deepEqual(formatNodeTooltip({ task_id: 't2', title: 'No Brief' }), {
    title: 'No Brief',
    brief: '',
  });
});

test('ui: layoutGraph generates non-overlapping LR coordinates and solid/dashed edges for 35-node DAG', () => {
  const tasks = [];
  const deps = [];
  for (let i = 0; i < 5; i++) {
    const pid = `phase-${i}`;
    tasks.push({ task_id: pid, parent_id: null, title: `Phase ${i}`, status: 'IN_PROGRESS', sort_key: i });
    if (i > 0) deps.push({ upstream_id: `phase-${i - 1}`, downstream_id: pid });
    for (let j = 0; j < 6; j++) {
      const cid = `task-${i}-${j}`;
      tasks.push({
        task_id: cid,
        parent_id: pid,
        title: `Subtask ${i}.${j}`,
        status: j === 0 ? 'DONE' : 'TODO',
        sort_key: j,
      });
      if (j > 0) deps.push({ upstream_id: `task-${i}-${j - 1}`, downstream_id: cid });
    }
  }
  assert.equal(tasks.length, 35);

  const layout = layoutGraph(tasks, deps);
  assert.equal(layout.nodes.length, 35);
  assert.equal(layout.containsEdges.length, 30);
  assert.equal(layout.depEdges.length, 29);

  // Verify zero rectangle overlaps across all 35 nodes
  for (let i = 0; i < layout.nodes.length; i++) {
    const a = layout.nodes[i];
    assert.ok(a.x >= 0 && a.y >= 0);
    assert.ok(a.x + CARD_W <= layout.width);
    assert.ok(a.y + CARD_H <= layout.height);
    for (let j = i + 1; j < layout.nodes.length; j++) {
      const b = layout.nodes[j];
      const overlapsX = a.x < b.x + CARD_W && a.x + CARD_W > b.x;
      const overlapsY = a.y < b.y + CARD_H && a.y + CARD_H > b.y;
      assert.equal(overlapsX && overlapsY, false, `Nodes ${a.task_id} and ${b.task_id} overlap`);
    }
  }

  // Verify every dependency flows left-to-right (upstream x < downstream x)
  const nodeMap = new Map(layout.nodes.map((n) => [n.task_id, n]));
  for (const edge of layout.depEdges) {
    assert.ok(
      nodeMap.get(edge.from).x < nodeMap.get(edge.to).x,
      `Expected ${edge.from} left of ${edge.to}`
    );
  }
});
