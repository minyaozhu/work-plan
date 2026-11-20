import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_JS = path.join(ROOT, 'ui', 'src', 'main.js');
const SRC_CSS = path.join(ROOT, 'ui', 'src', 'styles.css');
const OUT_HTML = path.join(ROOT, 'ui', 'app.html');

const bundled = await esbuild.build({
  entryPoints: [SRC_JS],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  legalComments: 'none',
});

const jsCode = bundled.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const cssCode = fs.readFileSync(SRC_CSS, 'utf8').replace(/<\/style/gi, '<\\/style');

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <script>(function(){try{var p=new URLSearchParams(location.search).get('theme');var t=(p==='dark'||p==='light')?p:localStorage.getItem('work-plan-theme');if(t==='dark'||t==='light'){var m=document.querySelector('meta[name="color-scheme"]');if(m)m.content=t;document.documentElement.dataset.theme=t;document.documentElement.dataset.themeOverride=t;}}catch(e){}})();</script>
  <title>Work Plan</title>
  <style>
${cssCode}
  </style>
</head>
<body>
  <div class="app-shell">
    <header class="topbar">
      <select id="project-select" class="project-select" aria-label="Select project"></select>
      <button type="button" id="btn-new-project" class="btn btn-primary">+ New Project</button>
      <input type="search" id="search-input" class="search-input" placeholder="Find by title or path..." aria-label="Filter tasks">
      <button type="button" id="btn-theme-toggle" class="btn btn-theme-toggle" title="Switch color theme">
        <span class="theme-opt theme-opt--to-light"><span class="theme-icon theme-icon--sun" aria-hidden="true">☀</span> Light<span class="sr-only"> theme (currently dark)</span></span>
        <span class="theme-opt theme-opt--to-dark"><span class="theme-icon theme-icon--moon" aria-hidden="true">☾</span> Dark<span class="sr-only"> theme (currently light)</span></span>
      </button>
      <button type="button" id="btn-settings" class="btn" popovertarget="settings-popover" aria-label="Project settings">⚙ Settings</button>
      <div id="settings-popover" popover="auto" class="popover-panel">
        <button type="button" id="menu-rename-btn" class="popover-item">Edit title / workspace</button>
        <button type="button" id="menu-archive-btn" class="popover-item">Archive project</button>
        <button type="button" id="menu-delete-btn" class="popover-item danger">Delete project</button>
      </div>
    </header>

    <section id="summary-ribbon" class="summary-ribbon" hidden></section>

    <nav id="tabbar" class="tabbar" hidden aria-label="Project sections">
      <button type="button" id="tab-tasks-btn" class="tab-btn active">Tasks<span id="tab-tasks-count" class="tab-count">0</span></button>
      <button type="button" id="tab-notes-btn" class="tab-btn">Notes<span id="tab-notes-count" class="tab-count">0</span></button>
      <button type="button" id="tab-memory-btn" class="tab-btn">Project Memory<span id="tab-memory-count" class="tab-count">0</span></button>
      <button type="button" id="tab-active-edits-btn" class="tab-btn">Active Edits<span id="tab-active-edits-count" class="tab-count">0</span></button>
    </nav>

    <main class="main-content">
      <div id="tasks-view"></div>
      <div id="notes-view" hidden></div>
      <div id="memory-view" hidden></div>
      <div id="active-edits-view" hidden></div>
    </main>
  </div>

  <!-- New Project Modal -->
  <dialog id="new-project-dialog" closedby="any" aria-labelledby="np-dialog-title">
    <form id="new-project-form">
      <div class="dialog-head">
        <h2 id="np-dialog-title" class="dialog-title">New Work Plan Project</h2>
        <button type="button" class="btn btn-sm" data-close-dialog="new-project-dialog">Close</button>
      </div>
      <div class="dialog-body">
        <label style="font-size:12px;font-weight:600;">Start from</label>
        <select id="np-mode" class="field-select">
          <option value="blank">Blank project</option>
          <option value="markdown">Markdown plan (PLAN.md / SPEC.md)</option>
          <option value="folder">Local folder subdirectories</option>
          <option value="github">GitHub Issue URL (via gh CLI)</option>
        </select>
        <label style="font-size:12px;font-weight:600;">Project title</label>
        <input id="np-title" class="field-input" placeholder="Optional when seeding from Markdown/folder/issue" autofocus>
        <label style="font-size:12px;font-weight:600;">Workspace directory</label>
        <div class="input-with-btn">
          <input id="np-workspace" class="field-input" placeholder="/path/to/repo">
          <button type="button" id="btn-browse-np-workspace" class="btn btn-sm">Browse…</button>
        </div>
        <div id="np-workspace-chips" class="quick-chips" hidden></div>
        <div id="np-source-row" hidden style="display:flex;flex-direction:column;gap:6px;">
          <label id="np-source-label" style="font-size:12px;font-weight:600;">Source reference</label>
          <div class="input-with-btn">
            <input id="np-source" class="field-input" placeholder="">
            <button type="button" id="btn-browse-np-source" class="btn btn-sm">Browse…</button>
          </div>
        </div>
      </div>
      <div class="dialog-foot">
        <button type="button" class="btn" data-close-dialog="new-project-dialog">Cancel</button>
        <button type="submit" class="btn btn-primary">Create Project</button>
      </div>
    </form>
  </dialog>

  <!-- New Task Modal -->
  <dialog id="new-task-dialog" closedby="any" aria-labelledby="nt-dialog-title">
    <form id="new-task-form">
      <div class="dialog-head">
        <h2 id="nt-dialog-title" class="dialog-title">Add Task</h2>
        <button type="button" class="btn btn-sm" data-close-dialog="new-task-dialog">Close</button>
      </div>
      <div class="dialog-body">
        <div id="new-task-parent-label" class="muted" style="font-size:12px;"></div>
        <input type="hidden" id="new-task-parent-id">
        <label style="font-size:12px;font-weight:600;">Title</label>
        <input id="new-task-title" class="field-input" required autofocus placeholder="e.g. Implement auth middleware">
        <label style="font-size:12px;font-weight:600;">Brief</label>
        <textarea id="new-task-brief" class="field-textarea" placeholder="Scope, contracts, acceptance criteria..."></textarea>
        <label style="font-size:12px;font-weight:600;">Expected files (comma-separated)</label>
        <div class="input-with-btn">
          <input id="new-task-files" class="field-input" placeholder="src/auth.ts, test/auth.test.ts">
          <button type="button" id="btn-browse-new-task-files" class="btn btn-sm">Browse…</button>
        </div>
        <label style="font-size:12px;font-weight:600;">Target tests (comma-separated)</label>
        <input id="new-task-tests" class="field-input" placeholder="npm test">
      </div>
      <div class="dialog-foot">
        <button type="button" class="btn" data-close-dialog="new-task-dialog">Cancel</button>
        <button type="submit" class="btn btn-primary">Add Task</button>
      </div>
    </form>
  </dialog>

  <!-- Project Settings Modal -->
  <dialog id="rename-dialog" closedby="any" aria-labelledby="rename-dialog-title">
    <form id="rename-form">
      <div class="dialog-head">
        <h2 id="rename-dialog-title" class="dialog-title">Project Settings</h2>
        <button type="button" class="btn btn-sm" data-close-dialog="rename-dialog">Close</button>
      </div>
      <div class="dialog-body">
        <label style="font-size:12px;font-weight:600;">Project title</label>
        <input id="rename-input" class="field-input" required autofocus>
        <label style="font-size:12px;font-weight:600;">Workspace directory</label>
        <div class="input-with-btn">
          <input id="rename-workspace" class="field-input" placeholder="/path/to/repo">
          <button type="button" id="btn-browse-rename-workspace" class="btn btn-sm">Browse…</button>
        </div>
      </div>
      <div class="dialog-foot">
        <button type="button" class="btn" data-close-dialog="rename-dialog">Cancel</button>
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
    </form>
  </dialog>

  <!-- Dependency Graph Modal -->
  <dialog id="graph-dialog" class="dialog-graph" closedby="any" aria-labelledby="graph-dialog-title">
    <div class="dialog-head">
      <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;">
        <h2 id="graph-dialog-title" class="dialog-title">Dependency graph</h2>
        <span class="dialog-legend"><span id="graph-node-count">0</span> nodes · solid = contains · dashed = dependency (upstream → downstream)</span>
      </div>
      <div class="action-row">
        <button type="button" id="graph-zoom-out" class="btn btn-sm" aria-label="Zoom out">−</button>
        <button type="button" id="graph-fit" class="btn btn-sm">Fit</button>
        <button type="button" id="graph-zoom-in" class="btn btn-sm" aria-label="Zoom in">+</button>
        <button type="button" class="btn btn-sm" data-close-dialog="graph-dialog" autofocus>Close</button>
      </div>
    </div>
    <div id="graph-stage-container" class="graph-container"></div>
  </dialog>

  <!-- Destructive Action Confirm Modal -->
  <dialog id="confirm-dialog" closedby="closerequest" aria-labelledby="confirm-title">
    <div class="dialog-head">
      <h2 id="confirm-title" class="dialog-title">Confirm</h2>
    </div>
    <div class="dialog-body">
      <p id="confirm-message" style="margin:0;"></p>
    </div>
    <div class="dialog-foot">
      <button type="button" class="btn" data-close-dialog="confirm-dialog" autofocus>Cancel</button>
      <button type="button" id="confirm-ok-btn" class="btn btn-danger">Delete</button>
    </div>
  </dialog>

  <!-- Server-Backed Path Browser Modal -->
  <dialog id="path-picker-dialog" class="dialog-picker" closedby="any" aria-labelledby="pp-title">
    <div class="dialog-head">
      <h2 id="pp-title" class="dialog-title">Browse</h2>
      <button type="button" class="btn btn-sm" data-close-dialog="path-picker-dialog">Close</button>
    </div>
    <div class="dialog-body">
      <div class="pp-nav">
        <button type="button" id="pp-up-btn" class="btn btn-sm">↑ Up</button>
        <button type="button" id="pp-home-btn" class="btn btn-sm">Home</button>
        <div id="pp-quick-chips" class="quick-chips"></div>
      </div>
      <div class="input-with-btn">
        <input id="pp-path-input" class="field-input mono" aria-label="Current path">
        <button type="button" id="pp-go-btn" class="btn btn-sm">Go</button>
      </div>
      <div class="pp-filter-row">
        <input type="search" id="pp-filter-input" class="search-input" placeholder="Filter entries...">
        <label class="pp-toggle"><input type="checkbox" id="pp-show-hidden"> Hidden</label>
        <label id="pp-ext-wrap" class="pp-toggle" hidden><input type="checkbox" id="pp-ext-only" checked> <span id="pp-ext-label">Markdown only</span></label>
      </div>
      <div id="pp-notice" class="pp-notice" hidden></div>
      <div id="pp-list" class="pp-list" role="listbox"></div>
      <div id="pp-selected-tray" class="pp-selected-tray" hidden>
        <div class="pp-selected-head">
          <span id="pp-selected-count">0 selected</span>
          <button type="button" id="pp-clear-selected" class="btn btn-sm">Clear</button>
        </div>
        <div id="pp-selected-chips" class="quick-chips"></div>
      </div>
    </div>
    <div class="dialog-foot">
      <button type="button" class="btn" data-close-dialog="path-picker-dialog">Cancel</button>
      <button type="button" id="pp-confirm-btn" class="btn btn-primary">Select</button>
    </div>
  </dialog>

  <div id="toast" class="toast" role="status" aria-live="polite" hidden></div>

  <script>
${jsCode}
  </script>
</body>
</html>
`;

fs.writeFileSync(OUT_HTML, html, 'utf8');
const bytes = Buffer.byteLength(html, 'utf8');
console.log(`Built ${path.relative(ROOT, OUT_HTML)} (${(bytes / 1024).toFixed(1)} KiB)`);
