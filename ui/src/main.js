import { createTransport } from '../transport.js';
import { mountDependencyGraph } from './graph.js';

const STATUSES = ['TODO', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW', 'DONE', 'CANCELLED'];
const NOTE_KINDS = ['decision', 'gotcha', 'spec', 'note'];
const MEMORY_CATEGORIES = ['architecture', 'convention', 'command', 'constraint', 'pitfall', 'context', 'fact'];
const MEMORY_INJECT_MODES = ['always', 'on_demand', 'disabled'];
const MEMORY_CONFIDENCES = ['confirmed', 'inferred', 'stale'];

const appState = {
  snapshot: null,
  activeTab: 'tasks', // 'tasks' | 'notes' | 'memory' | 'active_edits'
  filterStatus: 'all', // 'all' | 'ready' | 'in_progress' | 'blocked' | 'done'
  searchQuery: '',
  selectedTaskId: null,
  detailOpenMobile: false,
  collapsedIds: new Set(),
  noteKindFilter: 'all',
  noteTaskFilter: 'all',
  noteSearch: '',
  editingNoteId: null,
  showNoteForm: false,
  memoryCategoryFilter: 'all',
  memoryInjectFilter: 'all',
  memoryConfidenceFilter: 'all',
  memorySearch: '',
  editingMemoryId: null,
  showMemoryForm: false,
  knowledgeSubTab: 'memory', // 'memory' | 'kp'
  kpTypeFilter: 'all',
  kpSearch: '',
  activeEditsFilter: 'all', // 'all' | 'overlaps'
  editExpanded: true,
  caps: { canStartChat: false, canOpenFile: false, displayMode: 'inline' },
};

let transport = null;
let saveTimer = null;
let pendingSaveTaskId = null;
let graphHandle = null;
let toastTimer = null;
const THEME_STORAGE_KEY = 'work-plan-theme';
let themeOverrideMem = null;

function safeStorageGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(key, val) {
  try {
    window.localStorage.setItem(key, val);
  } catch {
    // ignore storage errors in restricted sandboxes
  }
}

function safeStorageRemove(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore storage errors in restricted sandboxes
  }
}

function readInitialThemeOverride() {
  try {
    const p = new URLSearchParams(window.location.search).get('theme');
    if (p === 'dark' || p === 'light') return p;
  } catch {
    // ignore URL parse error
  }
  const stored = safeStorageGet(THEME_STORAGE_KEY);
  return stored === 'dark' || stored === 'light' ? stored : null;
}

function getSystemOrHostTheme() {
  const host = document.documentElement?.dataset?.hostTheme;
  if (host === 'dark' || host === 'light') return host;
  return window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light';
}

function getEffectiveTheme() {
  return themeOverrideMem || getSystemOrHostTheme();
}

function applyThemeState(overrideVal) {
  themeOverrideMem = overrideVal === 'dark' || overrideVal === 'light' ? overrideVal : null;
  const root = document.documentElement;
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) {
    meta.content = themeOverrideMem || 'light dark';
  }
  if (themeOverrideMem) {
    root.dataset.themeOverride = themeOverrideMem;
    root.dataset.theme = themeOverrideMem;
  } else {
    delete root.dataset.themeOverride;
    const host = root.dataset.hostTheme;
    if (host === 'dark' || host === 'light') {
      root.dataset.theme = host;
    } else {
      delete root.dataset.theme;
    }
  }
  const effective = getEffectiveTheme();
  const toggleBtn = document.getElementById('btn-theme-toggle');
  if (toggleBtn) {
    const next = effective === 'dark' ? 'light' : 'dark';
    const modeLabel = themeOverrideMem ? 'manual' : 'auto';
    toggleBtn.title = `Switch to ${next} theme (currently ${effective} — ${modeLabel})`;
  }
}

function esc(val) {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showToast(msg, durationMs = 2800) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, durationMs);
}

async function copyToClipboard(text, label = 'Copied to clipboard') {
  try {
    await navigator.clipboard.writeText(text);
    showToast(label);
  } catch {
    showToast('Copy failed — select and copy manually', 3600);
  }
}

function isUserTyping() {
  const active = document.activeElement;
  if (!active) return false;
  const tag = active.tagName;
  if (tag === 'TEXTAREA' || tag === 'INPUT') {
    return (
      active.id !== 'search-input' &&
      active.id !== 'note-search' &&
      active.id !== 'memory-search' &&
      active.id !== 'kp-search'
    );
  }
  return false;
}

function buildTaskPrompt(project, task, tasksById) {
  const lines = [
    `Work on task "${task.title}" (\`${task.task_id}\`) in Work Plan project "${project.title}" (\`${project.project_id}\`).`,
  ];
  if (task.brief) lines.push('', `## Brief`, task.brief);
  if (task.files?.length) lines.push('', `## Expected Files`, ...task.files.map((f) => `- ${f}`));
  if (task.target_tests?.length) lines.push('', `## Target Tests`, ...task.target_tests.map((t) => `- \`${t}\``));

  const upstreamIds = task.effective_upstream_ids || task.upstream_ids || [];
  const handoffs = upstreamIds
    .map((id) => tasksById.get(id))
    .filter((u) => u && u.handoff_notes && u.handoff_notes.trim());
  if (handoffs.length > 0) {
    lines.push('', '## Upstream Handoff Notes');
    for (const u of handoffs) {
      lines.push(`### ${u.title} (\`${u.task_id}\`, ${u.status})`, u.handoff_notes);
    }
  }
  lines.push(
    '',
    `Call \`task_start(task_id="${task.task_id}", project_id="${project.project_id}")\` first, and call \`task_update\` with \`handoff_notes\` when finished.`
  );
  return lines.join('\n');
}

function buildDecomposePrompt(project, task) {
  return [
    `Decompose task "${task.title}" (\`${task.task_id}\`) in Work Plan project "${project.title}" (\`${project.project_id}\`) into actionable child sub-tasks using \`task_plan(project_id="${project.project_id}", parent_task_id="${task.task_id}", tasks=[...])\`.`,
    task.brief ? `\nCurrent brief:\n${task.brief}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildMemoryScanPrompt(project) {
  return [
    `Inspect the repository for Work Plan project "${project.title}" (\`${project.project_id}\`)${project.workspace_dir ? ` at \`${project.workspace_dir}\`` : ''}.`,
    'Read its README, package/build config, test setup, and core modules, then record durable cross-session facts using `memory_save` (with concise `key`, `category`, `title`, `content`, `file_paths`, and `inject_mode`).',
    'Focus on architecture boundaries, non-obvious conventions, test/build commands, constraints, and pitfalls.',
  ].join('\n\n');
}

function formatMemoriesAsMarkdown(project, memories = []) {
  const active = (Array.isArray(memories) ? memories : []).filter((m) => m.inject_mode !== 'disabled');
  const title = project?.title ? `${project.title} — Project Memory` : 'Project Memory';
  if (active.length === 0) {
    return `# ${title}\n\n_(No active project memories recorded yet.)_\n`;
  }
  const lines = [`# ${title}`];
  for (const cat of MEMORY_CATEGORIES) {
    const group = active.filter((m) => m.category === cat);
    if (group.length === 0) continue;
    lines.push('', `## ${cat.charAt(0).toUpperCase() + cat.slice(1)}`);
    for (const m of group) {
      const meta = [];
      if (m.key) meta.push(`key: \`${m.key}\``);
      if (m.inject_mode === 'on_demand') meta.push('inject: on-demand');
      if (m.confidence !== 'confirmed') meta.push(`confidence: ${m.confidence}`);
      if (m.file_paths?.length) meta.push(`files: ${m.file_paths.map((f) => `\`${f}\``).join(', ')}`);
      if (m.tags?.length) meta.push(`tags: ${m.tags.map((t) => `#${t}`).join(' ')}`);
      lines.push(`- **${m.title}**${meta.length ? ` (${meta.join(' · ')})` : ''}: ${m.content}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function resolveAbsFile(workspaceDir, filePath) {
  if (!filePath) return '';
  if (/^(\/|[a-zA-Z]:[/\\])/.test(filePath)) return filePath;
  if (!workspaceDir) return filePath;
  const cleanWs = workspaceDir.replace(/\/+$/, '');
  const cleanFile = filePath.replace(/^(\.\/)+/, '').replace(/^\/+/, '');
  return `${cleanWs}/${cleanFile}`;
}

function toRepoRelativePath(absPath, baseDir) {
  const normPath = String(absPath || '').trim().replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  const cleanBase = String(baseDir || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!cleanBase) return normPath;
  if (normPath === cleanBase) return '.';
  const prefix = `${cleanBase}/`;
  if (
    normPath.startsWith(prefix) ||
    (/^[a-zA-Z]:\//.test(cleanBase) && normPath.toLowerCase().startsWith(prefix.toLowerCase()))
  ) {
    return normPath.slice(prefix.length);
  }
  return normPath;
}

function collectKnownWorkspaces() {
  const seen = new Set();
  const list = [];
  const add = (dir) => {
    const clean = String(dir || '').trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    list.push(clean);
  };
  for (const dir of transport?.getWorkspaceDirs?.() || []) add(dir);
  add(appState.snapshot?.state?.project?.workspace_dir);
  for (const proj of appState.snapshot?.projects || []) add(proj.workspace_dir);
  return list;
}

function renderWorkspaceChips(containerEl, onPick) {
  if (!containerEl) return;
  const dirs = collectKnownWorkspaces();
  containerEl.innerHTML = '';
  containerEl.hidden = dirs.length === 0;
  for (const dir of dirs) {
    const label = dir.split(/[\\/]/).filter(Boolean).pop() || dir;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'quick-chip';
    btn.title = dir;
    btn.textContent = label;
    btn.addEventListener('click', () => onPick(dir));
    containerEl.appendChild(btn);
  }
}

function parseListInput(raw) {
  return String(raw || '')
    .split(/[,\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function installDialogFallbacks() {
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.addEventListener('close', () => {
      dialog.returnValue = '';
    });
  }

  if (!('closedBy' in HTMLDialogElement.prototype)) {
    const outside = (e, dialog) => {
      const r = dialog.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
      let pressedOutside = false;
      dialog.addEventListener('pointerdown', (e) => {
        pressedOutside = outside(e, dialog);
      });
      dialog.addEventListener('pointerup', (e) => {
        if (pressedOutside && outside(e, dialog)) dialog.close();
      });
    }
  }
}

let confirmCallback = null;
function openConfirmDialog({ title, message, confirmLabel = 'Delete', onConfirm }) {
  const dlg = document.getElementById('confirm-dialog');
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-message').textContent = message;
  const okBtn = document.getElementById('confirm-ok-btn');
  okBtn.textContent = confirmLabel;
  confirmCallback = onConfirm;
  dlg.showModal();
}

async function runTool(tool, params) {
  try {
    const snap = await transport.invoke(tool, params);
    if (snap && snap.projects !== undefined) {
      applySnapshot(snap);
    }
    return snap;
  } catch (err) {
    showToast(err?.message || String(err), 3800);
    return null;
  }
}

function applySnapshot(snap) {
  if (!snap || typeof snap !== 'object') return;
  if (snap.projects === undefined && snap.project) {
    // Project-scoped tool result from agent turn; trigger clean refresh
    transport.invoke('ui_get_state', {}).then((full) => {
      if (full) applySnapshot(full);
    }).catch(() => {});
    return;
  }

  appState.snapshot = snap;
  const tasks = snap.state?.tasks || [];
  if (appState.selectedTaskId && !tasks.some((t) => t.task_id === appState.selectedTaskId)) {
    appState.selectedTaskId = null;
    appState.detailOpenMobile = false;
  }
  if (!appState.selectedTaskId && tasks.length > 0) {
    const preferred =
      tasks.find((t) => t.is_ready) ||
      tasks.find((t) => t.status === 'IN_PROGRESS') ||
      tasks[0];
    appState.selectedTaskId = preferred?.task_id || null;
  }
  render();
}

function computeVisibleTreeRows(tasks) {
  const byId = new Map(tasks.map((t) => [t.task_id, t]));
  const childrenMap = new Map();
  for (const t of tasks) {
    const pid = t.parent_id && byId.has(t.parent_id) ? t.parent_id : '__root__';
    if (!childrenMap.has(pid)) childrenMap.set(pid, []);
    childrenMap.get(pid).push(t);
  }
  for (const arr of childrenMap.values()) {
    arr.sort((a, b) => (a.sort_key || 0) - (b.sort_key || 0));
  }

  const q = appState.searchQuery.trim().toLowerCase();
  const filter = appState.filterStatus;

  const matchesDirect = (t) => {
    if (q) {
      const hay = `${t.title} ${t.task_id} ${(t.files || []).join(' ')} ${t.branch_name || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (filter === 'ready') return t.is_ready;
    if (filter === 'in_progress') return t.status === 'IN_PROGRESS';
    if (filter === 'blocked') return t.status === 'BLOCKED' || t.is_waiting;
    if (filter === 'done') return t.status === 'DONE';
    return true;
  };

  const memoMatch = new Map();
  const matchesSubtree = (id) => {
    if (memoMatch.has(id)) return memoMatch.get(id);
    const t = byId.get(id);
    let ok = matchesDirect(t);
    for (const c of childrenMap.get(id) || []) {
      if (matchesSubtree(c.task_id)) ok = true;
    }
    memoMatch.set(id, ok);
    return ok;
  };

  const rows = [];
  const walk = (parentId, depth) => {
    for (const t of childrenMap.get(parentId) || []) {
      if (!matchesSubtree(t.task_id)) continue;
      const children = childrenMap.get(t.task_id) || [];
      const hasChildren = children.length > 0;
      const collapsed = !q && filter === 'all' && appState.collapsedIds.has(t.task_id);
      rows.push({ task: t, depth, hasChildren, collapsed });
      if (hasChildren && !collapsed) {
        walk(t.task_id, depth + 1);
      }
    }
  };
  walk('__root__', 0);
  return { rows, byId, childrenMap };
}

function renderTopbar(snap) {
  const select = document.getElementById('project-select');
  const projects = snap?.projects || [];
  const selectedId = snap?.selected_project_id || '';

  select.innerHTML = '';
  if (projects.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No projects yet';
    select.appendChild(opt);
  } else {
    const groups = [
      { label: 'Pinned', items: projects.filter((p) => p.pinned && !p.archived_at) },
      { label: 'Active', items: projects.filter((p) => !p.pinned && !p.archived_at) },
      { label: 'Archived', items: projects.filter((p) => Boolean(p.archived_at)) },
    ];
    for (const grp of groups) {
      if (grp.items.length === 0) continue;
      const og = document.createElement('optgroup');
      og.label = grp.label;
      for (const p of grp.items) {
        const opt = document.createElement('option');
        opt.value = p.project_id;
        opt.textContent = `${p.title} (${p.stats.done}/${p.stats.leaf_total})`;
        opt.selected = p.project_id === selectedId;
        og.appendChild(opt);
      }
      select.appendChild(og);
    }
  }

  const hasProject = Boolean(snap?.state?.project);
  document.getElementById('btn-settings').disabled = !hasProject;
  const archiveBtn = document.getElementById('menu-archive-btn');
  if (archiveBtn && snap?.state?.project) {
    archiveBtn.textContent = snap.state.project.archived_at ? 'Unarchive project' : 'Archive project';
  }
}

function renderSummaryAndStrip(state) {
  const ribbon = document.getElementById('summary-ribbon');
  const tabbar = document.getElementById('tabbar');
  const activeEditsBtn = document.getElementById('tab-active-edits-btn');

  if (!state) {
    ribbon.hidden = true;
    tabbar.hidden = true;
    activeEditsBtn?.classList.remove('has-overlap', 'has-active');
    return;
  }

  ribbon.hidden = false;
  tabbar.hidden = false;

  const { project, tasks, notes, active_edits = [] } = state;
  const s = project.stats;

  const parts = [
    `<h1 class="project-title">${esc(project.title)}</h1>`,
  ];
  if (project.source_ref) {
    parts.push(`<span class="pill pill-mono" title="${esc(project.source_ref)}">${esc(project.source_ref.slice(0, 36))}</span>`);
  }
  if (project.archived_at) {
    parts.push(`<span class="pill">Archived</span>`);
  }
  parts.push(`<span class="pill">${s.total} tasks</span>`);
  if (s.in_progress > 0) parts.push(`<span class="pill pill-prog">${s.in_progress} in progress</span>`);
  if (s.blocked > 0) parts.push(`<span class="pill pill-block">${s.blocked} blocked</span>`);
  if (s.ready > 0) parts.push(`<span class="pill pill-ready">${s.ready} ready</span>`);
  parts.push(`<span class="pill pill-done">${s.percent_done}% done</span>`);
  parts.push(
    `<button type="button" id="btn-pin-project" class="btn btn-sm">${project.pinned ? '★ Pinned' : '☆ Pin'}</button>`
  );
  ribbon.innerHTML = parts.join('');

  document.getElementById('btn-pin-project')?.addEventListener('click', () => {
    runTool('ui_update_project', { project_id: project.project_id, pinned: !project.pinned });
  });

  document.getElementById('tab-tasks-count').textContent = String(tasks.length);
  document.getElementById('tab-notes-count').textContent = String(notes.length);
  document.getElementById('tab-memory-count').textContent = String((state.memories || []).length);
  document.getElementById('tab-active-edits-count').textContent = String(active_edits.length);

  const anyOverlap = active_edits.some((e) => e.overlap);
  activeEditsBtn?.classList.toggle('has-overlap', anyOverlap);
  activeEditsBtn?.classList.toggle('has-active', active_edits.length > 0 && !anyOverlap);
}

function openNewProjectModal() {
  document.getElementById('np-mode').value = 'blank';
  document.getElementById('np-source-row').hidden = true;
  document.getElementById('btn-browse-np-source').hidden = true;
  document.getElementById('np-title').value = '';
  document.getElementById('np-workspace').value =
    appState.snapshot?.state?.project?.workspace_dir || transport?.getDefaultWorkspaceDir?.() || '';
  document.getElementById('np-source').value = '';
  renderWorkspaceChips(document.getElementById('np-workspace-chips'), (ws) => {
    document.getElementById('np-workspace').value = ws;
  });
  document.getElementById('new-project-dialog').showModal();
}

function renderTasksTab(state) {
  const view = document.getElementById('tasks-view');
  if (!state) {
    view.innerHTML = `<div class="empty-state">
      <p>Create or select a Work Plan project to manage multi-session tasks, dependencies, and handoffs.</p>
      <button type="button" id="empty-create-btn" class="btn btn-primary">+ New Project</button>
    </div>`;
    document.getElementById('empty-create-btn')?.addEventListener('click', openNewProjectModal);
    return;
  }

  const { project, tasks, active_edits, notes } = state;
  const { rows, byId, childrenMap } = computeVisibleTreeRows(tasks);
  const readyTasks = tasks.filter((t) => t.is_ready);
  const activeTaskIds = new Set((active_edits || []).map((e) => e.task_id).filter(Boolean));
  const splitClass = `split-pane${appState.detailOpenMobile ? ' detail-open' : ''}`;

  const treeHtml =
    rows.length === 0
      ? `<div class="empty-state"><p>No matching tasks.</p><button type="button" id="btn-empty-add-task" class="btn btn-primary btn-sm">+ Add Task</button></div>`
      : rows
          .map(({ task: t, depth, hasChildren, collapsed }) => {
            const isSel = t.task_id === appState.selectedTaskId;
            const statusClass = t.status.toLowerCase();
            const pct =
              t.progress && t.progress.total > 0
                ? Math.round((t.progress.done / t.progress.total) * 100)
                : t.status === 'DONE'
                  ? 100
                  : 0;
            const showBar = hasChildren || t.status === 'DONE';
            const hasWarn = t.status === 'BLOCKED' || t.is_waiting;
            const isLive = activeTaskIds.has(t.task_id);
            const caret = hasChildren ? (collapsed ? '▸' : '▾') : '·';

            return `<div class="tree-row status-${statusClass}${isSel ? ' selected' : ''}" style="padding-left:${10 + depth * 16}px" data-task-id="${esc(t.task_id)}">
              <button type="button" class="tree-caret${hasChildren ? '' : ' placeholder'}" data-toggle-id="${esc(t.task_id)}" aria-label="${collapsed ? 'Expand' : 'Collapse'}">${caret}</button>
              <span class="status-dot dot-${statusClass}" title="${esc(t.status)}"></span>
              <span class="tree-title" title="${esc(t.title)}">${esc(t.title)}</span>
              ${t.branch_name ? `<span class="tree-branch">${esc(t.branch_name)}</span>` : ''}
              ${isLive ? `<span class="badge-live" title="Live chat editing"></span>` : ''}
              ${t.is_ready ? `<span class="badge-ready">Ready</span>` : ''}
              ${showBar ? `<span class="mini-progress" title="${pct}%"><span class="mini-progress-fill" style="width:${pct}%"></span></span>` : ''}
              ${hasWarn ? `<span class="badge-warn" title="${t.status === 'BLOCKED' ? 'Blocked' : 'Waiting on upstream'}">⚠</span>` : ''}
            </div>`;
          })
          .join('');

  const selTask = appState.selectedTaskId ? byId.get(appState.selectedTaskId) : null;
  let inspectorHtml = `<div class="empty-state"><p>Select a task from the tree to inspect or edit its brief, dependencies, and handoff notes.</p></div>`;

  if (selTask) {
    const taskNotes = notes.filter((n) => n.task_id === selTask.task_id);
    const parentTask = selTask.parent_id ? byId.get(selTask.parent_id) : null;
    const childTasks = (childrenMap.get(selTask.task_id) || []);
    const upTasks = (selTask.upstream_ids || []).map((id) => byId.get(id)).filter(Boolean);
    const candidateUpstreams = tasks.filter(
      (t) =>
        t.task_id !== selTask.task_id &&
        !(selTask.upstream_ids || []).includes(t.task_id)
    );
    const canStartChat = appState.caps.canStartChat;
    const primaryChatLabel = canStartChat ? '▶ Run in New Chat' : '📋 Copy Prompt';

    inspectorHtml = `<div class="inspector-card">
      <div class="mobile-back-bar">
        <button type="button" id="btn-mobile-back" class="btn btn-sm">← Back to tasks</button>
      </div>
      <div class="inspector-header">
        <div>
          <div class="inspector-sub">${parentTask ? `${esc(parentTask.title)} / ` : ''}${esc(selTask.task_id)}</div>
          <h2 class="inspector-title">${esc(selTask.title)}</h2>
        </div>
        ${!selTask.is_leaf && selTask.manual_status ? `<button type="button" id="btn-reset-rollup" class="btn btn-sm" title="Resume automatic parent status roll-up">↺ Auto-rollup</button>` : ''}
      </div>

      <div class="status-pills" role="group" aria-label="Task status">
        ${STATUSES.map(
          (st) =>
            `<button type="button" class="status-pill-btn${selTask.status === st ? ` active-${st.toLowerCase()}` : ''}" data-set-status="${st}">${st}</button>`
        ).join('')}
      </div>

      <div class="meta-grid">
        <div class="meta-label">Expected files</div>
        <div class="meta-val">
          ${selTask.files?.length ? selTask.files.map((f) => `<button type="button" class="chip-link" data-open-file="${esc(f)}">${esc(f)}</button>`).join(' ') : '<span class="muted">—</span>'}
        </div>

        <div class="meta-label">Target tests</div>
        <div class="meta-val">
          ${selTask.target_tests?.length ? selTask.target_tests.map((t) => `<code class="pill pill-mono">${esc(t)}</code>`).join(' ') : '<span class="muted">—</span>'}
        </div>

        ${selTask.branch_name || selTask.pr_url ? `
          <div class="meta-label">Branch / PR</div>
          <div class="meta-val">
            ${selTask.branch_name ? `<span class="pill pill-mono">${esc(selTask.branch_name)}</span>` : ''}
            ${selTask.pr_url ? `<span class="pill pill-mono">${esc(selTask.pr_url)}</span>` : ''}
          </div>
        ` : ''}

        ${selTask.waiting_on?.length ? `
          <div class="meta-label">Waiting on</div>
          <div class="meta-val">
            ${selTask.waiting_on.map((w) => `<button type="button" class="dep-chip" data-jump-task="${esc(w.task_id)}">${esc(w.title)} (${esc(w.status)})</button>`).join(' ')}
          </div>
        ` : ''}

        <div class="meta-label">Dependencies</div>
        <div class="meta-val">
          ${upTasks.map((u) => `<span class="dep-chip">${esc(u.title)} <button type="button" class="chip-clear" data-remove-dep="${esc(u.task_id)}" aria-label="Remove dependency">×</button></span>`).join('')}
          ${candidateUpstreams.length > 0 ? `<select id="add-dep-select" class="field-select" style="width:auto;height:24px;padding:0 6px;font-size:11.5px;">
            <option value="">+ depends on...</option>
            ${candidateUpstreams.map((c) => `<option value="${esc(c.task_id)}">${esc(c.title)} (${esc(c.task_id)})</option>`).join('')}
          </select>` : ''}
        </div>
      </div>

      <details class="edit-box" id="edit-details"${appState.editExpanded ? ' open' : ''}>
        <summary style="cursor:pointer;font-weight:600;">Edit Brief, Files & Handoff Notes</summary>
        <label class="muted" style="font-size:11px;">Title</label>
        <input id="edit-title" class="field-input" value="${esc(selTask.title)}">
        <label class="muted" style="font-size:11px;">Brief (what this task owns, contracts, tests)</label>
        <textarea id="edit-brief" class="field-textarea" placeholder="Brief...">${esc(selTask.brief)}</textarea>
        <label class="muted" style="font-size:11px;">Expected files (comma-separated repo-relative paths)</label>
        <div class="input-with-btn">
          <input id="edit-files" class="field-input" value="${esc((selTask.files || []).join(', '))}" placeholder="src/api.ts, test/api.test.ts">
          <button type="button" id="btn-browse-edit-files" class="btn btn-sm">Browse…</button>
        </div>
        <label class="muted" style="font-size:11px;">Target tests (comma-separated commands)</label>
        <input id="edit-tests" class="field-input" value="${esc((selTask.target_tests || []).join(', '))}" placeholder="npm test">
        <label class="muted" style="font-size:11px;">Handoff Notes (Markdown passed automatically to downstream chats)</label>
        <textarea id="edit-handoff" class="field-textarea mono" placeholder="Files changed, exported interfaces, test results, caveats...">${esc(selTask.handoff_notes)}</textarea>
        <div class="action-row" style="justify-content:space-between;">
          <span id="autosave-hint" class="muted" style="font-size:11px;">Autosaves on edit</span>
          <button type="button" id="btn-save-task" class="btn btn-primary btn-sm">Save</button>
        </div>
      </details>

      <div class="action-row">
        <button type="button" id="btn-run-task-chat" class="btn btn-primary btn-sm">${primaryChatLabel}</button>
        <button type="button" id="btn-add-subtask" class="btn btn-sm">+ Sub-task</button>
        <button type="button" id="btn-decompose-task" class="btn btn-sm">✨ Decompose with agent</button>
        <button type="button" id="btn-jump-notes" class="btn btn-sm">🗒 ${taskNotes.length} notes</button>
        <button type="button" id="btn-delete-task" class="btn btn-danger btn-sm">Delete</button>
      </div>

      ${childTasks.length > 0 ? `
        <div>
          <div class="muted" style="font-size:12px;font-weight:600;margin-bottom:4px;">Children (${childTasks.length})</div>
          <div class="children-list">
            ${childTasks.map((c) => `<button type="button" class="child-link-btn" data-jump-task="${esc(c.task_id)}">
              <span class="status-dot dot-${c.status.toLowerCase()}"></span>
              <span>${esc(c.title)}</span>
            </button>`).join('')}
          </div>
        </div>
      ` : ''}
    </div>`;
  }

  view.innerHTML = `<div class="${splitClass}">
    <section class="tree-pane">
      <div class="pane-toolbar">
        <span class="pane-toolbar-title">Tasks <span class="muted">${tasks.length}</span></span>
        <div class="pane-toolbar-actions">
          <select id="filter-status-select" class="field-select" style="width:auto;height:26px;padding:0 6px;font-size:12px;">
            <option value="all"${appState.filterStatus === 'all' ? ' selected' : ''}>All</option>
            <option value="ready"${appState.filterStatus === 'ready' ? ' selected' : ''}>Ready (${readyTasks.length})</option>
            <option value="in_progress"${appState.filterStatus === 'in_progress' ? ' selected' : ''}>In Progress</option>
            <option value="blocked"${appState.filterStatus === 'blocked' ? ' selected' : ''}>Blocked / Waiting</option>
            <option value="done"${appState.filterStatus === 'done' ? ' selected' : ''}>Done</option>
          </select>
          <button type="button" id="btn-open-graph" class="btn btn-sm">⇄ Graph</button>
          <button type="button" id="btn-add-root-task" class="btn btn-sm">+ Task</button>
          <button type="button" id="btn-run-next-ready" class="btn btn-primary btn-sm"${readyTasks.length === 0 ? ' disabled' : ''}>Run Next Ready</button>
        </div>
      </div>
      <div class="tree-list">${treeHtml}</div>
    </section>
    <section class="inspector-pane">${inspectorHtml}</section>
  </div>`;

  // Bind tree controls
  document.getElementById('filter-status-select')?.addEventListener('change', (e) => {
    appState.filterStatus = e.target.value;
    render();
  });
  document.getElementById('btn-open-graph')?.addEventListener('click', openGraphModal);
  document.getElementById('btn-add-root-task')?.addEventListener('click', () => openNewTaskModal(null));
  document.getElementById('btn-empty-add-task')?.addEventListener('click', () => openNewTaskModal(null));
  document.getElementById('btn-run-next-ready')?.addEventListener('click', async () => {
    if (readyTasks.length === 0) return;
    const next = readyTasks[0];
    appState.selectedTaskId = next.task_id;
    const prompt = buildTaskPrompt(project, next, byId);
    const res = await transport.startChat(prompt, {
      projectId: project.project_id,
      taskId: next.task_id,
      workspaceDir: project.workspace_dir,
    });
    if (res?.fallback === 'copy') {
      await copyToClipboard(prompt, `Copied prompt for "${next.title}"`);
    } else {
      showToast(`Launched new chat for "${next.title}"`);
    }
  });

  view.querySelectorAll('[data-toggle-id]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.toggleId;
      if (appState.collapsedIds.has(id)) appState.collapsedIds.delete(id);
      else appState.collapsedIds.add(id);
      render();
    });
  });

  view.querySelectorAll('.tree-row').forEach((row) => {
    row.addEventListener('click', () => {
      flushPendingTaskSave();
      appState.selectedTaskId = row.dataset.taskId;
      appState.detailOpenMobile = true;
      render();
    });
  });

  if (selTask) {
    document.getElementById('btn-mobile-back')?.addEventListener('click', () => {
      appState.detailOpenMobile = false;
      render();
    });

    document.getElementById('btn-reset-rollup')?.addEventListener('click', () => {
      runTool('ui_update_task', {
        project_id: project.project_id,
        task_id: selTask.task_id,
        manual_status: false,
      });
    });

    view.querySelectorAll('[data-set-status]').forEach((btn) => {
      btn.addEventListener('click', () => {
        runTool('ui_update_task', {
          project_id: project.project_id,
          task_id: selTask.task_id,
          status: btn.dataset.setStatus,
        });
      });
    });

    view.querySelectorAll('[data-open-file]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const abs = resolveAbsFile(selTask.worktree_path || project.workspace_dir, btn.dataset.openFile);
        const res = await transport.openFile(abs);
        if (res?.fallback === 'copy') await copyToClipboard(abs, `Copied path: ${abs}`);
      });
    });

    view.querySelectorAll('[data-jump-task]').forEach((btn) => {
      btn.addEventListener('click', () => {
        flushPendingTaskSave();
        appState.selectedTaskId = btn.dataset.jumpTask;
        appState.detailOpenMobile = true;
        render();
      });
    });

    view.querySelectorAll('[data-remove-dep]').forEach((btn) => {
      btn.addEventListener('click', () => {
        runTool('ui_set_dep', {
          project_id: project.project_id,
          upstream_id: btn.dataset.removeDep,
          downstream_id: selTask.task_id,
          action: 'remove',
        });
      });
    });

    document.getElementById('add-dep-select')?.addEventListener('change', (e) => {
      const uid = e.target.value;
      if (!uid) return;
      runTool('ui_set_dep', {
        project_id: project.project_id,
        upstream_id: uid,
        downstream_id: selTask.task_id,
        action: 'add',
      });
    });

    const editDetails = document.getElementById('edit-details');
    editDetails?.addEventListener('toggle', () => {
      appState.editExpanded = editDetails.open;
    });

    const collectEditFields = () => ({
      project_id: project.project_id,
      task_id: selTask.task_id,
      title: document.getElementById('edit-title')?.value?.trim() || selTask.title,
      brief: document.getElementById('edit-brief')?.value ?? '',
      files: parseListInput(document.getElementById('edit-files')?.value),
      target_tests: parseListInput(document.getElementById('edit-tests')?.value),
      handoff_notes: document.getElementById('edit-handoff')?.value ?? '',
    });

    const scheduleAutosave = () => {
      const hint = document.getElementById('autosave-hint');
      if (hint) hint.textContent = 'Saving...';
      clearTimeout(saveTimer);
      pendingSaveTaskId = selTask.task_id;
      saveTimer = setTimeout(async () => {
        const taskId = selTask.task_id;
        pendingSaveTaskId = null;
        saveTimer = null;
        const payload = collectEditFields();
        const activeEl = document.activeElement;
        const activeId =
          activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')
            ? activeEl.id
            : '';
        const selStart = typeof activeEl?.selectionStart === 'number' ? activeEl.selectionStart : null;
        const selEnd = typeof activeEl?.selectionEnd === 'number' ? activeEl.selectionEnd : null;

        try {
          const snap = await transport.invoke('ui_update_task', payload);
          if (pendingSaveTaskId) return;
          if (snap && snap.projects !== undefined) {
            applySnapshot(snap);
          }
          if (activeId && appState.selectedTaskId === taskId) {
            const restored = document.getElementById(activeId);
            if (restored) {
              restored.focus();
              if (selStart !== null && selEnd !== null && typeof restored.setSelectionRange === 'function') {
                restored.setSelectionRange(selStart, selEnd);
              }
            }
          }
          const h = document.getElementById('autosave-hint');
          if (h) h.textContent = 'Saved';
        } catch (err) {
          showToast(err?.message || String(err), 3800);
        }
      }, 600);
    };

    for (const id of ['edit-title', 'edit-brief', 'edit-files', 'edit-tests', 'edit-handoff']) {
      const el = document.getElementById(id);
      el?.addEventListener('input', scheduleAutosave);
      el?.addEventListener('blur', () => {
        if (pendingSaveTaskId === selTask.task_id) {
          clearTimeout(saveTimer);
          pendingSaveTaskId = null;
          runTool('ui_update_task', collectEditFields());
        }
      });
    }

    document.getElementById('btn-save-task')?.addEventListener('click', () => {
      clearTimeout(saveTimer);
      pendingSaveTaskId = null;
      runTool('ui_update_task', collectEditFields()).then(() => showToast('Task saved'));
    });

    document.getElementById('btn-browse-edit-files')?.addEventListener('click', () => {
      const baseDir =
        selTask.worktree_path || project.workspace_dir || transport?.getDefaultWorkspaceDir?.() || '';
      openPathPicker({
        mode: 'files',
        title: 'Select Expected Files',
        startPath: baseDir,
        baseDir,
        initialSelection: parseListInput(document.getElementById('edit-files')?.value),
        onSelect: async (paths) => {
          const el = document.getElementById('edit-files');
          if (el) el.value = paths.join(', ');
          clearTimeout(saveTimer);
          pendingSaveTaskId = null;
          await runTool('ui_update_task', collectEditFields());
          showToast('Updated expected files');
        },
      });
    });

    document.getElementById('btn-run-task-chat')?.addEventListener('click', async () => {
      const prompt = buildTaskPrompt(project, selTask, byId);
      const res = await transport.startChat(prompt, {
        projectId: project.project_id,
        taskId: selTask.task_id,
        workspaceDir: selTask.worktree_path || project.workspace_dir,
      });
      if (res?.fallback === 'copy') {
        await copyToClipboard(prompt, 'Copied task prompt');
      } else {
        showToast('Launched new chat');
      }
    });

    document.getElementById('btn-add-subtask')?.addEventListener('click', () => openNewTaskModal(selTask.task_id));

    document.getElementById('btn-decompose-task')?.addEventListener('click', async () => {
      const prompt = buildDecomposePrompt(project, selTask);
      const res = await transport.startChat(prompt, {
        projectId: project.project_id,
        taskId: selTask.task_id,
        workspaceDir: selTask.worktree_path || project.workspace_dir,
      });
      if (res?.fallback === 'copy') {
        await copyToClipboard(prompt, 'Copied decomposition prompt');
      } else {
        showToast('Launched decomposition chat');
      }
    });

    document.getElementById('btn-jump-notes')?.addEventListener('click', () => {
      appState.activeTab = 'notes';
      appState.noteTaskFilter = selTask.task_id;
      render();
    });

    document.getElementById('btn-delete-task')?.addEventListener('click', () => {
      openConfirmDialog({
        title: 'Delete task?',
        message: `Delete "${selTask.title}" (${selTask.task_id}) and its sub-tasks?`,
        confirmLabel: 'Delete Task',
        onConfirm: () => runTool('ui_delete_task', { project_id: project.project_id, task_id: selTask.task_id, cascade: true }),
      });
    });
  }
}

function flushPendingTaskSave() {
  if (saveTimer && pendingSaveTaskId && appState.snapshot?.state?.project) {
    clearTimeout(saveTimer);
    const project = appState.snapshot.state.project;
    const payload = {
      project_id: project.project_id,
      task_id: pendingSaveTaskId,
      title: document.getElementById('edit-title')?.value?.trim(),
      brief: document.getElementById('edit-brief')?.value,
      files: parseListInput(document.getElementById('edit-files')?.value),
      target_tests: parseListInput(document.getElementById('edit-tests')?.value),
      handoff_notes: document.getElementById('edit-handoff')?.value,
    };
    pendingSaveTaskId = null;
    if (payload.title) {
      runTool('ui_update_task', payload);
    }
  }
}

function renderNotesTab(state) {
  const view = document.getElementById('notes-view');
  if (!state) {
    view.innerHTML = '';
    return;
  }

  const { project, tasks, notes } = state;
  const q = appState.noteSearch.trim().toLowerCase();
  const filtered = notes.filter((n) => {
    if (appState.noteKindFilter !== 'all' && n.kind !== appState.noteKindFilter) return false;
    if (appState.noteTaskFilter === '__project__' && n.task_id) return false;
    if (appState.noteTaskFilter !== 'all' && appState.noteTaskFilter !== '__project__' && n.task_id !== appState.noteTaskFilter) return false;
    if (q && !`${n.title} ${n.body_markdown}`.toLowerCase().includes(q)) return false;
    return true;
  });

  const editingNote = appState.editingNoteId
    ? notes.find((n) => n.note_id === appState.editingNoteId) || null
    : null;

  const formHtml =
    appState.showNoteForm || editingNote
      ? `<form id="note-form" class="edit-box">
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <input id="note-title" class="field-input" style="flex:2 1 180px;" placeholder="Note title..." value="${esc(editingNote?.title || '')}" required>
            <select id="note-kind" class="field-select" style="flex:1 1 110px;">
              ${NOTE_KINDS.map((k) => `<option value="${k}"${(editingNote?.kind || 'note') === k ? ' selected' : ''}>${k}</option>`).join('')}
            </select>
            <select id="note-task-scope" class="field-select" style="flex:1 1 140px;">
              <option value="">Project-wide</option>
              ${tasks.map((t) => `<option value="${esc(t.task_id)}"${editingNote?.task_id === t.task_id ? ' selected' : ''}>${esc(t.title)}</option>`).join('')}
            </select>
          </div>
          <textarea id="note-body" class="field-textarea" placeholder="Markdown note content...">${esc(editingNote?.body_markdown || '')}</textarea>
          <div class="action-row" style="justify-content:space-between;">
            <label style="display:inline-flex;align-items:center;gap:6px;font-size:12px;">
              <input type="checkbox" id="note-pinned"${editingNote?.pinned ? ' checked' : ''}> Pin to turn briefs
            </label>
            <div class="action-row">
              <button type="button" id="btn-cancel-note" class="btn btn-sm">Cancel</button>
              <button type="submit" class="btn btn-primary btn-sm">Save Note</button>
            </div>
          </div>
        </form>`
      : '';

  view.innerHTML = `<div class="notes-view">
    <div class="notes-toolbar">
      <div class="action-row">
        ${['all', ...NOTE_KINDS]
          .map(
            (k) =>
              `<button type="button" class="btn btn-sm${appState.noteKindFilter === k ? ' btn-primary' : ''}" data-note-kind="${k}">${k === 'all' ? 'All' : k}</button>`
          )
          .join('')}
      </div>
      <select id="note-task-filter" class="field-select" style="width:auto;height:28px;padding:0 8px;">
        <option value="all"${appState.noteTaskFilter === 'all' ? ' selected' : ''}>All scopes</option>
        <option value="__project__"${appState.noteTaskFilter === '__project__' ? ' selected' : ''}>Project-wide only</option>
        ${tasks.map((t) => `<option value="${esc(t.task_id)}"${appState.noteTaskFilter === t.task_id ? ' selected' : ''}>Task: ${esc(t.title)}</option>`).join('')}
      </select>
      <input id="note-search" class="search-input" style="max-width:220px;height:28px;" placeholder="Filter notes..." value="${esc(appState.noteSearch)}">
      <button type="button" id="btn-add-note" class="btn btn-primary btn-sm">+ Add Note</button>
    </div>
    ${formHtml}
    <div id="notes-list-host"></div>
  </div>`;

  const renderNotesList = () => {
    const host = document.getElementById('notes-list-host');
    if (!host) return;
    const nq = appState.noteSearch.trim().toLowerCase();
    const visible = notes.filter((n) => {
      if (appState.noteKindFilter !== 'all' && n.kind !== appState.noteKindFilter) return false;
      if (appState.noteTaskFilter === '__project__' && n.task_id) return false;
      if (appState.noteTaskFilter !== 'all' && appState.noteTaskFilter !== '__project__' && n.task_id !== appState.noteTaskFilter) return false;
      if (nq && !`${n.title} ${n.body_markdown}`.toLowerCase().includes(nq)) return false;
      return true;
    });

    host.innerHTML =
      visible.length === 0
        ? `<div class="empty-state"><p>No notes match the current filter.</p></div>`
        : `<div class="notes-grid">
            ${visible
              .map(
                (n) => `<article class="note-card${n.pinned ? ' pinned' : ''}">
                  <div class="note-header">
                    <div style="display:flex;align-items:center;gap:6px;min-width:0;">
                      <span class="pill">${esc(n.kind)}</span>
                      <strong style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(n.title)}</strong>
                    </div>
                    <div class="action-row">
                      <button type="button" class="btn btn-sm" data-pin-note="${esc(n.note_id)}">${n.pinned ? '★' : '☆'}</button>
                      <button type="button" class="btn btn-sm" data-edit-note="${esc(n.note_id)}">Edit</button>
                      <button type="button" class="btn btn-sm" data-del-note="${esc(n.note_id)}">×</button>
                    </div>
                  </div>
                  ${n.task_id ? `<div class="muted" style="font-size:11px;">Scoped to <code>${esc(n.task_id)}</code></div>` : ''}
                  <p class="note-body">${esc(n.body_markdown)}</p>
                </article>`
              )
              .join('')}
          </div>`;

    host.querySelectorAll('[data-pin-note]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const note = notes.find((x) => x.note_id === btn.dataset.pinNote);
        if (!note) return;
        runTool('ui_save_note', {
          project_id: project.project_id,
          note_id: note.note_id,
          title: note.title,
          kind: note.kind,
          task_id: note.task_id,
          body_markdown: note.body_markdown,
          pinned: !note.pinned,
        });
      });
    });

    host.querySelectorAll('[data-edit-note]').forEach((btn) => {
      btn.addEventListener('click', () => {
        appState.editingNoteId = btn.dataset.editNote;
        appState.showNoteForm = true;
        render();
      });
    });

    host.querySelectorAll('[data-del-note]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const note = notes.find((x) => x.note_id === btn.dataset.delNote);
        if (!note) return;
        openConfirmDialog({
          title: 'Delete note?',
          message: `Delete note "${note.title}"?`,
          confirmLabel: 'Delete Note',
          onConfirm: () => runTool('ui_delete_note', { project_id: project.project_id, note_id: note.note_id }),
        });
      });
    });
  };

  renderNotesList();

  view.querySelectorAll('[data-note-kind]').forEach((btn) => {
    btn.addEventListener('click', () => {
      appState.noteKindFilter = btn.dataset.noteKind;
      render();
    });
  });

  document.getElementById('note-task-filter')?.addEventListener('change', (e) => {
    appState.noteTaskFilter = e.target.value;
    render();
  });

  document.getElementById('note-search')?.addEventListener('input', (e) => {
    appState.noteSearch = e.target.value;
    renderNotesList();
  });

  document.getElementById('btn-add-note')?.addEventListener('click', () => {
    appState.editingNoteId = null;
    appState.showNoteForm = true;
    render();
  });

  document.getElementById('btn-cancel-note')?.addEventListener('click', () => {
    appState.editingNoteId = null;
    appState.showNoteForm = false;
    render();
  });

  document.getElementById('note-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = document.getElementById('note-title').value.trim();
    const kind = document.getElementById('note-kind').value;
    const taskId = document.getElementById('note-task-scope').value || null;
    const body = document.getElementById('note-body').value;
    const pinned = document.getElementById('note-pinned').checked;
    if (!title) return;
    const saved = await runTool('ui_save_note', {
      project_id: project.project_id,
      ...(editingNote ? { note_id: editingNote.note_id } : {}),
      title,
      kind,
      task_id: taskId,
      body_markdown: body,
      pinned,
    });
    if (saved) {
      appState.editingNoteId = null;
      appState.showNoteForm = false;
      render();
    }
  });
}

function renderMemoryTab(state) {
  const view = document.getElementById('memory-view');
  if (!state) {
    view.innerHTML = `<div class="empty-state"><p>Select or create a project to manage Knowledge (Knowledge Pack & Memory).</p></div>`;
    return;
  }

  const { project, memories = [], knowledge_pack: kp = null } = state;
  const alwaysCount = memories.filter((m) => m.inject_mode === 'always' && m.confidence !== 'stale').length;
  const onDemandCount = memories.filter((m) => m.inject_mode === 'on_demand' && m.confidence !== 'stale').length;
  const reviewCount = memories.filter((m) => m.confidence === 'inferred' || m.confidence === 'stale').length;

  const kpItemCount = kp?.exists
    ? kp.format === 'okf'
      ? (kp.concepts || []).length
      : (kp.sections || []).length
    : 0;
  const kpBadgeLabel = kp?.configured
    ? kp.exists
      ? kp.format === 'okf'
        ? `OKF · ${kpItemCount}`
        : `MD · ${kpItemCount}`
      : 'missing'
    : 'none';

  const kpOpenPath = kp?.exists
    ? kp.format === 'okf' && kp.has_index
      ? kp.index_path || kp.index_repo_path
      : kp.resolved_path || kp.repo_path
    : '';
  const kpDisplayPath =
    kp?.format === 'okf' && kp?.has_index
      ? kp.index_repo_path || kp.kp_path
      : kp?.repo_path || kp?.kp_path || project.kp_path || '';

  let kpStatusHtml = '';
  if (kp?.configured) {
    const statusPill = !kp.enabled
      ? `<span class="pill">⏸ KP Disabled</span>`
      : !kp.exists
        ? `<span class="pill pill-ready">⚠ KP path not found</span>`
        : kp.format === 'okf'
          ? `<span class="pill pill-prog">📦 OKF v${esc(kp.okf_version || '0.2')} · ${kpItemCount} concept${kpItemCount === 1 ? '' : 's'}</span>`
          : `<span class="pill pill-rev">📄 Markdown KP · ${kpItemCount} section${kpItemCount === 1 ? '' : 's'}</span>`;

    const pathChip =
      kp.exists && kpOpenPath
        ? `<button type="button" class="chip-link" id="btn-open-kp-status-file" title="Open Knowledge Pack">${esc(kpDisplayPath)}</button>`
        : `<code class="pill pill-mono">${esc(kpDisplayPath)}</code>`;

    kpStatusHtml = `<div class="kp-status-strip">
      ${statusPill}
      ${pathChip}
      ${
        appState.knowledgeSubTab === 'memory'
          ? `<button type="button" class="btn btn-sm" id="btn-jump-kp-settings">⚙ KP Settings</button>`
          : ''
      }
    </div>`;
  } else {
    kpStatusHtml = `<div class="kp-status-strip">
      <span class="pill">No Knowledge Pack linked</span>
      ${
        appState.knowledgeSubTab === 'memory'
          ? `<button type="button" class="btn btn-sm" id="btn-jump-kp-settings">+ Set Knowledge Pack</button>`
          : ''
      }
    </div>`;
  }

  const topbarHtml = `<div class="knowledge-topbar">
    <div class="knowledge-subswitch" role="tablist" aria-label="Knowledge views">
      <button type="button" id="btn-ksub-memory" role="tab" aria-selected="${appState.knowledgeSubTab === 'memory'}" class="knowledge-subbtn${appState.knowledgeSubTab === 'memory' ? ' active' : ''}">
        Memory <span class="tab-count">${memories.length}</span>
      </button>
      <button type="button" id="btn-ksub-kp" role="tab" aria-selected="${appState.knowledgeSubTab === 'kp'}" class="knowledge-subbtn${appState.knowledgeSubTab === 'kp' ? ' active' : ''}">
        Knowledge Pack <span class="tab-count">${esc(kpBadgeLabel)}</span>
      </button>
    </div>
    ${kpStatusHtml}
  </div>`;

  const wireSubSwitchAndStatus = () => {
    document.getElementById('btn-ksub-memory')?.addEventListener('click', () => {
      appState.knowledgeSubTab = 'memory';
      render();
    });
    document.getElementById('btn-ksub-kp')?.addEventListener('click', () => {
      appState.knowledgeSubTab = 'kp';
      render();
    });
    document.getElementById('btn-jump-kp-settings')?.addEventListener('click', () => {
      appState.knowledgeSubTab = 'kp';
      render();
    });
    document.getElementById('btn-open-kp-status-file')?.addEventListener('click', async () => {
      if (!kpOpenPath) return;
      const abs = resolveAbsFile(project.workspace_dir, kpOpenPath);
      const res = await transport.openFile(abs);
      if (res?.fallback === 'copy') await copyToClipboard(abs, `Copied path: ${abs}`);
    });
  };

  if (appState.knowledgeSubTab === 'kp') {
    const currentMode = project.kp_mode || 'auto';
    const currentPath = project.kp_path || '';
    const concepts = kp?.concepts || [];
    const sections = kp?.sections || [];
    const conceptTypes = ['all', ...new Set(concepts.map((c) => c.type).filter(Boolean))];

    view.innerHTML = `<div class="memory-view">
      ${topbarHtml}

      <form id="kp-settings-form" class="kp-settings-card">
        <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;flex-wrap:wrap;">
          <div>
            <h2 style="margin:0;font-size:13.5px;font-weight:700;">Knowledge Pack (KP) Setting</h2>
            <p class="muted" style="margin:3px 0 0;font-size:12px;">
              Support an <strong>OKF (Open Knowledge Format)</strong> directory / <code>index.md</code> bundle or a <strong>single Markdown file</strong> (<code>.md</code>). Active KPs auto-inject into <code>[WORK PLAN]</code> turn briefs.
            </p>
          </div>
        </div>

        <div class="kp-settings-grid">
          <select id="kp-mode-select" class="field-select" style="flex:1 1 210px;max-width:270px;" aria-label="Knowledge Pack format">
            <option value="auto"${currentMode === 'auto' ? ' selected' : ''}>Auto-detect (OKF or Single .md)</option>
            <option value="okf"${currentMode === 'okf' ? ' selected' : ''}>OKF Bundle (folder or index.md)</option>
            <option value="markdown"${currentMode === 'markdown' ? ' selected' : ''}>Single Markdown File (.md)</option>
            <option value="disabled"${currentMode === 'disabled' ? ' selected' : ''}>Disabled (mute brief injection)</option>
          </select>
          <div class="input-with-btn" style="flex:2 1 280px;">
            <input id="kp-path-input" class="field-input mono" placeholder="knowledge/ (OKF folder), knowledge/index.md, or KNOWLEDGE.md" value="${esc(currentPath)}" aria-label="Knowledge Pack path">
            <button type="button" id="btn-browse-kp-dir" class="btn btn-sm" title="Browse for an OKF bundle folder">Browse Folder…</button>
            <button type="button" id="btn-browse-kp-file" class="btn btn-sm" title="Browse for an index.md or single Markdown file">Browse .md…</button>
          </div>
        </div>

        <div class="action-row" style="justify-content:space-between;flex-wrap:wrap;gap:8px;">
          <div class="action-row" style="flex-wrap:wrap;">
            <button type="button" id="btn-kp-import" class="btn btn-sm"${!kp?.exists ? ' disabled' : ''} title="Import OKF concepts or Markdown sections into Memory cards">⬇ Import KP to Memory</button>
            <button type="button" id="btn-kp-export-okf" class="btn btn-sm" title="Export active Memory cards to an OKF v0.2 bundle on disk">⬆ Export Memory as OKF</button>
            <button type="button" id="btn-kp-export-md" class="btn btn-sm" title="Export active Memory cards to a single Markdown file on disk">⬆ Export Memory as .md</button>
          </div>
          <div class="action-row">
            ${currentPath ? `<button type="button" id="btn-kp-clear" class="btn btn-sm">Unlink</button>` : ''}
            <button type="submit" id="btn-kp-save" class="btn btn-primary btn-sm">Save KP Setting</button>
          </div>
        </div>
      </form>

      ${
        kp?.configured && kp?.exists && kp.format === 'okf'
          ? `<div class="memory-banner">
               <div class="memory-banner-stats">
                 <span class="pill pill-prog">📦 OKF v${esc(kp.okf_version || '0.2')}</span>
                 <strong>${esc(kp.title)}</strong>
                 ${kp.description ? `<span class="muted">— ${esc(kp.description)}</span>` : ''}
                 <span class="pill">${concepts.length} concept${concepts.length === 1 ? '' : 's'}</span>
                 <span class="pill">${kp.has_index ? 'index.md ✓' : 'directory scan'}</span>
               </div>
               <div class="action-row">
                 ${
                   kpOpenPath
                     ? `<button type="button" class="btn btn-sm" id="btn-open-kp-root">Open ${kp.has_index ? 'index.md' : 'Folder'}</button>`
                     : ''
                 }
               </div>
             </div>
             <div class="memory-toolbar">
               <div class="action-row">
                 ${conceptTypes
                   .map(
                     (t) =>
                       `<button type="button" class="btn btn-sm${appState.kpTypeFilter === t ? ' btn-primary' : ''}" data-kp-type="${esc(t)}">${t === 'all' ? 'All types' : esc(t)}</button>`
                   )
                   .join('')}
               </div>
               <input id="kp-search" class="search-input" style="max-width:220px;height:28px;" placeholder="Filter OKF concepts..." value="${esc(appState.kpSearch)}">
             </div>`
          : kp?.configured && kp?.exists && kp.format === 'markdown'
            ? `<div class="memory-banner">
                 <div class="memory-banner-stats">
                   <span class="pill pill-rev">📄 Single Markdown KP</span>
                   <strong>${esc(kp.title)}</strong>
                   ${kp.description ? `<span class="muted">— ${esc(kp.description)}</span>` : ''}
                   <span class="pill">${sections.length} section${sections.length === 1 ? '' : 's'}</span>
                 </div>
                 <div class="action-row">
                   ${kpOpenPath ? `<button type="button" class="btn btn-sm" id="btn-open-kp-root">Open Markdown File</button>` : ''}
                 </div>
               </div>
               <div class="memory-toolbar">
                 <input id="kp-search" class="search-input" style="max-width:240px;height:28px;" placeholder="Filter Markdown sections..." value="${esc(appState.kpSearch)}">
               </div>`
            : ''
      }

      <div id="kp-list-host"></div>
    </div>`;

    wireSubSwitchAndStatus();

    const saveKpConfig = async (nextPath, nextMode, extra = {}) => {
      const res = await runTool('ui_update_project', {
        project_id: project.project_id,
        kp_path: nextPath,
        kp_mode: nextMode,
        ...extra,
      });
      return res;
    };

    const renderKpList = () => {
      const host = document.getElementById('kp-list-host');
      if (!host) return;

      if (!kp?.configured) {
        host.innerHTML = `<div class="empty-state">
          <p>No Knowledge Pack configured yet. Link an existing <strong>OKF bundle</strong> (directory with <code>index.md</code> + concept <code>.md</code> files) or a <strong>single Markdown file</strong> (e.g. <code>KNOWLEDGE.md</code>), or bootstrap one directly from your project's Memory cards:</p>
          <div class="action-row">
            <button type="button" id="btn-empty-init-okf" class="btn btn-primary btn-sm">📦 Bootstrap OKF Bundle (knowledge/)</button>
            <button type="button" id="btn-empty-init-md" class="btn btn-sm">📄 Bootstrap Single Markdown (KNOWLEDGE.md)</button>
          </div>
        </div>`;

        host.querySelector('#btn-empty-init-okf')?.addEventListener('click', async () => {
          await saveKpConfig('knowledge', 'okf', {
            kp_action: 'export_okf',
            kp_export_path: 'knowledge',
          });
          showToast('Created OKF bundle in knowledge/');
        });
        host.querySelector('#btn-empty-init-md')?.addEventListener('click', async () => {
          await saveKpConfig('KNOWLEDGE.md', 'markdown', {
            kp_action: 'export_markdown',
            kp_export_path: 'KNOWLEDGE.md',
          });
          showToast('Created single Markdown KP at KNOWLEDGE.md');
        });
        return;
      }

      if (!kp.exists) {
        host.innerHTML = `<div class="empty-state">
          <p>Configured Knowledge Pack path <code>${esc(kp.kp_path)}</code> does not exist on disk yet.</p>
          <div class="action-row">
            <button type="button" id="btn-missing-init-okf" class="btn btn-primary btn-sm">📦 Initialize OKF Bundle at ${esc(kp.kp_path)}</button>
            <button type="button" id="btn-missing-init-md" class="btn btn-sm">📄 Create Single Markdown at ${esc(kp.kp_path)}</button>
          </div>
        </div>`;

        host.querySelector('#btn-missing-init-okf')?.addEventListener('click', async () => {
          await saveKpConfig(kp.kp_path, 'okf', {
            kp_action: 'export_okf',
            kp_export_path: kp.kp_path,
          });
          showToast(`Initialized OKF bundle at ${kp.kp_path}`);
        });
        host.querySelector('#btn-missing-init-md')?.addEventListener('click', async () => {
          await saveKpConfig(kp.kp_path, 'markdown', {
            kp_action: 'export_markdown',
            kp_export_path: kp.kp_path,
          });
          showToast(`Created Markdown KP at ${kp.kp_path}`);
        });
        return;
      }

      const kq = appState.kpSearch.trim().toLowerCase();

      if (kp.format === 'okf') {
        const filteredConcepts = concepts.filter((c) => {
          if (appState.kpTypeFilter !== 'all' && c.type !== appState.kpTypeFilter) return false;
          if (kq) {
            const hay = `${c.title} ${c.description} ${c.rel_path} ${c.type} ${c.resource || ''} ${(c.tags || []).join(' ')} ${(c.file_paths || []).join(' ')}`.toLowerCase();
            if (!hay.includes(kq)) return false;
          }
          return true;
        });

        host.innerHTML =
          filteredConcepts.length === 0
            ? `<div class="empty-state"><p>${concepts.length === 0 ? 'No concept .md files found inside this OKF bundle yet. Click "⬆ Export Memory as OKF" above to populate it.' : 'No OKF concepts match the current filter.'}</p></div>`
            : `<div class="memory-grid">
                ${filteredConcepts
                  .map((c) => {
                    const tagsHtml = (c.tags || [])
                      .map((t) => `<span class="quick-chip">#${esc(t)}</span>`)
                      .join('');
                    const filesHtml = (c.file_paths || [])
                      .map((f) => `<button type="button" class="chip-link" data-open-kp-file="${esc(f)}">${esc(f)}</button>`)
                      .join('');
                    return `<article class="memory-card inject-${esc(c.inject_mode || 'always')} confidence-${esc(c.confidence || 'confirmed')}">
                      <div class="memory-header">
                        <div class="memory-meta">
                          <span class="pill pill-prog">${esc(c.type || 'concept')}</span>
                          ${c.category && c.category !== c.type ? `<span class="pill">${esc(c.category)}</span>` : ''}
                          <button type="button" class="chip-link mono" data-open-kp-file="${esc(c.abs_path || c.repo_path)}" title="Open concept Markdown file">${esc(c.rel_path)}</button>
                        </div>
                        <div class="action-row">
                          <button type="button" class="btn btn-sm" data-import-kp-item="${esc(c.id)}" title="Import this concept into Memory">+ To Memory</button>
                        </div>
                      </div>
                      <h3 class="memory-title">${esc(c.title)}</h3>
                      <p class="memory-body">${esc(c.description || c.body_preview || '')}</p>
                      ${c.resource ? `<div><code class="pill pill-mono">${esc(c.resource)}</code></div>` : ''}
                      ${tagsHtml || filesHtml ? `<div class="memory-tags">${tagsHtml}${filesHtml}</div>` : ''}
                    </article>`;
                  })
                  .join('')}
              </div>`;
      } else {
        const filteredSections = sections.filter((s) => {
          if (!kq) return true;
          return `${s.heading} ${s.content_preview} ${(s.file_paths || []).join(' ')}`.toLowerCase().includes(kq);
        });

        host.innerHTML =
          filteredSections.length === 0
            ? `<div class="empty-state"><p>No Markdown sections match the current filter.</p></div>`
            : `<div class="memory-grid">
                ${filteredSections
                  .map((s) => {
                    const filesHtml = (s.file_paths || [])
                      .map((f) => `<button type="button" class="chip-link" data-open-kp-file="${esc(f)}">${esc(f)}</button>`)
                      .join('');
                    return `<article class="memory-card inject-always confidence-confirmed">
                      <div class="memory-header">
                        <div class="memory-meta">
                          <span class="pill pill-rev">H${esc(s.level || 2)}</span>
                          <span class="pill">${esc(s.category || 'fact')}</span>
                        </div>
                        <div class="action-row">
                          <button type="button" class="btn btn-sm" data-import-kp-item="${esc(s.id)}" title="Import this section into Memory">+ To Memory</button>
                        </div>
                      </div>
                      <h3 class="memory-title">${esc(s.heading)}</h3>
                      <p class="memory-body">${esc(s.content_preview || '(empty section)')}</p>
                      ${filesHtml ? `<div class="memory-tags">${filesHtml}</div>` : ''}
                    </article>`;
                  })
                  .join('')}
              </div>`;
      }

      host.querySelectorAll('[data-open-kp-file]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const abs = resolveAbsFile(project.workspace_dir, btn.dataset.openKpFile);
          const res = await transport.openFile(abs);
          if (res?.fallback === 'copy') await copyToClipboard(abs, `Copied path: ${abs}`);
        });
      });

      host.querySelectorAll('[data-import-kp-item]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const itemId = btn.dataset.importKpItem;
          await runTool('ui_update_project', {
            project_id: project.project_id,
            kp_action: 'import',
            kp_item_id: itemId,
          });
          showToast('Imported into Memory');
        });
      });
    };

    renderKpList();

    document.getElementById('btn-browse-kp-dir')?.addEventListener('click', () => {
      const baseDir = project.workspace_dir || transport?.getDefaultWorkspaceDir?.() || '';
      const curVal = document.getElementById('kp-path-input')?.value?.trim() || '';
      openPathPicker({
        mode: 'dir',
        title: 'Select OKF Knowledge Pack Directory',
        startPath: curVal ? resolveAbsFile(baseDir, curVal) : baseDir,
        baseDir,
        onSelect: (chosenDir) => {
          const input = document.getElementById('kp-path-input');
          if (input) input.value = toRepoRelativePath(chosenDir, baseDir);
          const modeSel = document.getElementById('kp-mode-select');
          if (modeSel && modeSel.value === 'markdown') modeSel.value = 'okf';
        },
      });
    });

    document.getElementById('btn-browse-kp-file')?.addEventListener('click', () => {
      const baseDir = project.workspace_dir || transport?.getDefaultWorkspaceDir?.() || '';
      const curVal = document.getElementById('kp-path-input')?.value?.trim() || '';
      openPathPicker({
        mode: 'file',
        title: 'Select OKF index.md or Single Markdown File',
        startPath: curVal ? resolveAbsFile(baseDir, curVal) : baseDir,
        baseDir,
        extensions: ['.md', '.markdown'],
        extLabel: 'Markdown (.md) only',
        onSelect: (chosenFile) => {
          const rel = toRepoRelativePath(chosenFile, baseDir);
          const input = document.getElementById('kp-path-input');
          if (input) input.value = rel;
          const modeSel = document.getElementById('kp-mode-select');
          if (modeSel && modeSel.value === 'okf' && !/index\.md$/i.test(rel)) {
            modeSel.value = 'auto';
          }
        },
      });
    });

    document.getElementById('kp-settings-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const nextPath = document.getElementById('kp-path-input').value.trim();
      const nextMode = document.getElementById('kp-mode-select').value;
      await saveKpConfig(nextPath, nextMode);
      showToast(nextPath ? `Saved Knowledge Pack (${nextPath})` : 'Cleared Knowledge Pack');
    });

    document.getElementById('btn-kp-clear')?.addEventListener('click', async () => {
      await saveKpConfig('', 'auto');
      showToast('Unlinked Knowledge Pack');
    });

    document.getElementById('btn-kp-import')?.addEventListener('click', async () => {
      const nextPath = document.getElementById('kp-path-input').value.trim();
      const nextMode = document.getElementById('kp-mode-select').value;
      const snap = await saveKpConfig(nextPath, nextMode, { kp_action: 'import' });
      const count = snap?.kp_result?.imported_count ?? 0;
      showToast(`Imported ${count} item(s) from Knowledge Pack into Memory`);
    });

    document.getElementById('btn-kp-export-okf')?.addEventListener('click', async () => {
      const rawInput = document.getElementById('kp-path-input').value.trim();
      const targetPath = rawInput || 'knowledge';
      const snap = await saveKpConfig(targetPath, 'okf', {
        kp_action: 'export_okf',
        kp_export_path: targetPath,
      });
      const count = snap?.kp_result?.exported_count ?? memories.length;
      showToast(`Exported ${count} memories to OKF bundle (${snap?.kp_result?.repo_path || targetPath})`);
    });

    document.getElementById('btn-kp-export-md')?.addEventListener('click', async () => {
      const rawInput = document.getElementById('kp-path-input').value.trim();
      const targetPath =
        rawInput && /\.(md|markdown)$/i.test(rawInput) && !/index\.md$/i.test(rawInput)
          ? rawInput
          : 'KNOWLEDGE.md';
      const snap = await saveKpConfig(targetPath, 'markdown', {
        kp_action: 'export_markdown',
        kp_export_path: targetPath,
      });
      const count = snap?.kp_result?.exported_count ?? memories.length;
      showToast(`Exported ${count} memories to ${snap?.kp_result?.repo_path || targetPath}`);
    });

    document.getElementById('btn-open-kp-root')?.addEventListener('click', async () => {
      if (!kpOpenPath) return;
      const abs = resolveAbsFile(project.workspace_dir, kpOpenPath);
      const res = await transport.openFile(abs);
      if (res?.fallback === 'copy') await copyToClipboard(abs, `Copied path: ${abs}`);
    });

    view.querySelectorAll('[data-kp-type]').forEach((btn) => {
      btn.addEventListener('click', () => {
        appState.kpTypeFilter = btn.dataset.kpType;
        render();
      });
    });

    document.getElementById('kp-search')?.addEventListener('input', (e) => {
      appState.kpSearch = e.target.value;
      renderKpList();
    });

    return;
  }

  const editingMem = appState.editingMemoryId
    ? memories.find((m) => m.memory_id === appState.editingMemoryId)
    : null;

  const formHtml =
    appState.showMemoryForm || editingMem
      ? `<form id="memory-form" class="edit-box">
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <input id="mem-title" class="field-input" style="flex:2 1 180px;" required placeholder="Memory title (e.g. SQLite WAL mode)" value="${esc(editingMem?.title || '')}">
            <select id="mem-category" class="field-select" style="flex:1 1 120px;">
              ${MEMORY_CATEGORIES.map((c) => `<option value="${c}"${(editingMem?.category || 'fact') === c ? ' selected' : ''}>${c}</option>`).join('')}
            </select>
            <select id="mem-inject-mode" class="field-select" style="flex:1 1 120px;">
              <option value="always"${(editingMem?.inject_mode || 'always') === 'always' ? ' selected' : ''}>Always inject</option>
              <option value="on_demand"${editingMem?.inject_mode === 'on_demand' ? ' selected' : ''}>On demand (file match)</option>
              <option value="disabled"${editingMem?.inject_mode === 'disabled' ? ' selected' : ''}>Disabled (muted)</option>
            </select>
            <select id="mem-confidence" class="field-select" style="flex:1 1 110px;">
              ${MEMORY_CONFIDENCES.map((c) => `<option value="${c}"${(editingMem?.confidence || 'confirmed') === c ? ' selected' : ''}>${c}</option>`).join('')}
            </select>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <input id="mem-key" class="field-input mono" style="flex:1 1 160px;" placeholder="Stable slug key (optional, e.g. db-wal)" value="${esc(editingMem?.key || '')}">
            <input id="mem-tags" class="field-input" style="flex:1 1 160px;" placeholder="Tags (comma-separated, e.g. sqlite, testing)" value="${esc((editingMem?.tags || []).join(', '))}">
          </div>
          <div class="input-with-btn">
            <input id="mem-files" class="field-input" placeholder="Related repo files for on-demand injection (comma-separated)" value="${esc((editingMem?.file_paths || []).join(', '))}">
            <button type="button" id="btn-browse-mem-files" class="btn btn-sm">Browse…</button>
          </div>
          <textarea id="mem-content" class="field-textarea" required placeholder="Durable fact, command, architecture rule, or pitfall...">${esc(editingMem?.content || '')}</textarea>
          <div class="action-row" style="justify-content:flex-end;">
            <button type="button" id="btn-cancel-memory" class="btn btn-sm">Cancel</button>
            <button type="submit" class="btn btn-primary btn-sm">Save Memory</button>
          </div>
        </form>`
      : '';

  const INJECT_LABELS = { always: '⚡ Always', on_demand: '🔍 On demand', disabled: '⏸ Muted' };
  const NEXT_INJECT_MODE = { always: 'on_demand', on_demand: 'disabled', disabled: 'always' };
  const scanLabel = appState.caps.canStartChat ? '✨ Scan Repo with Agent' : '📋 Copy Scan Prompt';

  view.innerHTML = `<div class="memory-view">
    ${topbarHtml}
    <div class="memory-banner">
      <div class="memory-banner-stats">
        <span class="pill pill-prog">⚡ ${alwaysCount} always injected</span>
        <span class="pill pill-rev">🔍 ${onDemandCount} on-demand</span>
        ${reviewCount > 0 ? `<span class="pill pill-confidence-inferred">${reviewCount} need review</span>` : ''}
      </div>
      <div class="action-row">
        <button type="button" id="btn-export-memory" class="btn btn-sm">📋 Copy as Markdown</button>
        <button type="button" id="btn-scan-memory" class="btn btn-sm">${scanLabel}</button>
        <button type="button" id="btn-add-memory" class="btn btn-primary btn-sm">+ Add Memory</button>
      </div>
    </div>

    <div class="memory-toolbar">
      <div class="action-row">
        ${['all', ...MEMORY_CATEGORIES]
          .map(
            (c) =>
              `<button type="button" class="btn btn-sm${appState.memoryCategoryFilter === c ? ' btn-primary' : ''}" data-mem-cat="${c}">${c === 'all' ? 'All' : c}</button>`
          )
          .join('')}
      </div>
      <select id="mem-inject-filter" class="field-select" style="width:auto;height:28px;padding:0 8px;">
        <option value="all"${appState.memoryInjectFilter === 'all' ? ' selected' : ''}>All inject modes</option>
        <option value="always"${appState.memoryInjectFilter === 'always' ? ' selected' : ''}>Always</option>
        <option value="on_demand"${appState.memoryInjectFilter === 'on_demand' ? ' selected' : ''}>On demand</option>
        <option value="disabled"${appState.memoryInjectFilter === 'disabled' ? ' selected' : ''}>Disabled</option>
      </select>
      <select id="mem-confidence-filter" class="field-select" style="width:auto;height:28px;padding:0 8px;">
        <option value="all"${appState.memoryConfidenceFilter === 'all' ? ' selected' : ''}>All confidence</option>
        ${MEMORY_CONFIDENCES.map((c) => `<option value="${c}"${appState.memoryConfidenceFilter === c ? ' selected' : ''}>${c}</option>`).join('')}
      </select>
      <input id="memory-search" class="search-input" style="max-width:220px;height:28px;" placeholder="Filter memory..." value="${esc(appState.memorySearch)}">
    </div>

    ${formHtml}
    <div id="memory-list-host"></div>
  </div>`;

  wireSubSwitchAndStatus();

  const triggerScan = async () => {
    const prompt = buildMemoryScanPrompt(project);
    const res = await transport.startChat(prompt, {
      projectId: project.project_id,
      workspaceDir: project.workspace_dir,
    });
    if (res?.fallback === 'copy') {
      await copyToClipboard(prompt, 'Copied repo memory scan prompt');
    } else {
      showToast('Launched agent to scan repo memory');
    }
  };

  const renderMemoryList = () => {
    const host = document.getElementById('memory-list-host');
    if (!host) return;
    const mq = appState.memorySearch.trim().toLowerCase();
    const visible = memories.filter((m) => {
      if (appState.memoryCategoryFilter !== 'all' && m.category !== appState.memoryCategoryFilter) return false;
      if (appState.memoryInjectFilter !== 'all' && m.inject_mode !== appState.memoryInjectFilter) return false;
      if (appState.memoryConfidenceFilter !== 'all' && m.confidence !== appState.memoryConfidenceFilter) return false;
      if (mq) {
        const hay = `${m.title} ${m.content} ${m.key || ''} ${(m.tags || []).join(' ')} ${(m.file_paths || []).join(' ')}`.toLowerCase();
        if (!hay.includes(mq)) return false;
      }
      return true;
    });

    host.innerHTML =
      visible.length === 0
        ? memories.length === 0
          ? `<div class="empty-state">
               <p>No project memories yet. Record architecture rules, test commands, conventions, or pitfalls to auto-inject into every chat.</p>
               <div class="action-row">
                 <button type="button" id="btn-empty-add-memory" class="btn btn-primary">+ Add First Memory</button>
                 <button type="button" id="btn-empty-scan-memory" class="btn">${scanLabel}</button>
               </div>
             </div>`
          : `<div class="empty-state"><p>No memories match the current filter.</p></div>`
        : `<div class="memory-grid">
            ${visible
              .map((m) => {
                const injectLabel = INJECT_LABELS[m.inject_mode] || m.inject_mode;
                const tagsHtml = (m.tags || [])
                  .map((t) => `<button type="button" class="quick-chip" data-mem-tag="${esc(t)}">#${esc(t)}</button>`)
                  .join('');
                const filesHtml = (m.file_paths || [])
                  .map((f) => `<button type="button" class="chip-link" data-open-mem-file="${esc(f)}">${esc(f)}</button>`)
                  .join('');
                return `<article class="memory-card inject-${esc(m.inject_mode)} confidence-${esc(m.confidence)}">
                  <div class="memory-header">
                    <div class="memory-meta">
                      <span class="pill">${esc(m.category)}</span>
                      <span class="pill pill-confidence-${esc(m.confidence)}">${esc(m.confidence)}</span>
                      <span class="pill">${esc(m.source)}</span>
                      ${m.key ? `<code class="pill pill-mono">${esc(m.key)}</code>` : ''}
                    </div>
                    <div class="action-row">
                      <button type="button" class="btn btn-sm" data-cycle-mem-inject="${esc(m.memory_id)}" title="Cycle injection mode">${injectLabel}</button>
                      ${m.confidence !== 'confirmed' ? `<button type="button" class="btn btn-sm" data-confirm-mem="${esc(m.memory_id)}" title="Mark confirmed">✓ Confirm</button>` : ''}
                      <button type="button" class="btn btn-sm" data-edit-mem="${esc(m.memory_id)}">Edit</button>
                      <button type="button" class="btn btn-sm" data-del-mem="${esc(m.memory_id)}" aria-label="Delete memory">×</button>
                    </div>
                  </div>
                  <h3 class="memory-title">${esc(m.title)}</h3>
                  <p class="memory-body">${esc(m.content)}</p>
                  ${tagsHtml || filesHtml ? `<div class="memory-tags">${tagsHtml}${filesHtml}</div>` : ''}
                </article>`;
              })
              .join('')}
          </div>`;

    host.querySelector('#btn-empty-add-memory')?.addEventListener('click', () => {
      appState.editingMemoryId = null;
      appState.showMemoryForm = true;
      render();
    });
    host.querySelector('#btn-empty-scan-memory')?.addEventListener('click', triggerScan);

    host.querySelectorAll('[data-cycle-mem-inject]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mem = memories.find((x) => x.memory_id === btn.dataset.cycleMemInject);
        if (!mem) return;
        runTool('ui_save_memory', {
          ...mem,
          project_id: project.project_id,
          inject_mode: NEXT_INJECT_MODE[mem.inject_mode] || 'always',
        });
      });
    });

    host.querySelectorAll('[data-confirm-mem]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mem = memories.find((x) => x.memory_id === btn.dataset.confirmMem);
        if (!mem) return;
        runTool('ui_save_memory', {
          ...mem,
          project_id: project.project_id,
          confidence: 'confirmed',
        });
      });
    });

    host.querySelectorAll('[data-edit-mem]').forEach((btn) => {
      btn.addEventListener('click', () => {
        appState.editingMemoryId = btn.dataset.editMem;
        appState.showMemoryForm = true;
        render();
      });
    });

    host.querySelectorAll('[data-del-mem]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mem = memories.find((x) => x.memory_id === btn.dataset.delMem);
        if (!mem) return;
        openConfirmDialog({
          title: 'Delete project memory?',
          message: `Delete memory "${mem.title}"?`,
          confirmLabel: 'Delete Memory',
          onConfirm: () =>
            runTool('ui_delete_memory', { project_id: project.project_id, memory_id: mem.memory_id }),
        });
      });
    });

    host.querySelectorAll('[data-mem-tag]').forEach((btn) => {
      btn.addEventListener('click', () => {
        appState.memorySearch = btn.dataset.memTag;
        render();
      });
    });

    host.querySelectorAll('[data-open-mem-file]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const abs = resolveAbsFile(project.workspace_dir, btn.dataset.openMemFile);
        const res = await transport.openFile(abs);
        if (res?.fallback === 'copy') await copyToClipboard(abs, `Copied path: ${abs}`);
      });
    });
  };

  renderMemoryList();

  document.getElementById('btn-add-memory')?.addEventListener('click', () => {
    appState.editingMemoryId = null;
    appState.showMemoryForm = true;
    render();
  });
  document.getElementById('btn-scan-memory')?.addEventListener('click', triggerScan);
  document.getElementById('btn-export-memory')?.addEventListener('click', () => {
    const md = formatMemoriesAsMarkdown(project, memories);
    copyToClipboard(md, 'Copied Project Memory Markdown');
  });

  view.querySelectorAll('[data-mem-cat]').forEach((btn) => {
    btn.addEventListener('click', () => {
      appState.memoryCategoryFilter = btn.dataset.memCat;
      render();
    });
  });

  document.getElementById('mem-inject-filter')?.addEventListener('change', (e) => {
    appState.memoryInjectFilter = e.target.value;
    render();
  });

  document.getElementById('mem-confidence-filter')?.addEventListener('change', (e) => {
    appState.memoryConfidenceFilter = e.target.value;
    render();
  });

  document.getElementById('memory-search')?.addEventListener('input', (e) => {
    appState.memorySearch = e.target.value;
    renderMemoryList();
  });

  document.getElementById('btn-cancel-memory')?.addEventListener('click', () => {
    appState.editingMemoryId = null;
    appState.showMemoryForm = false;
    render();
  });

  document.getElementById('btn-browse-mem-files')?.addEventListener('click', () => {
    const baseDir = project.workspace_dir || transport?.getDefaultWorkspaceDir?.() || '';
    openPathPicker({
      mode: 'files',
      title: 'Select Related Files',
      startPath: baseDir,
      baseDir,
      initialSelection: parseListInput(document.getElementById('mem-files')?.value),
      onSelect: (paths) => {
        const el = document.getElementById('mem-files');
        if (el) el.value = paths.join(', ');
      },
    });
  });

  document.getElementById('memory-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = document.getElementById('mem-title').value.trim();
    const content = document.getElementById('mem-content').value.trim();
    if (!title || !content) return;
    const saved = await runTool('ui_save_memory', {
      project_id: project.project_id,
      ...(editingMem ? { memory_id: editingMem.memory_id } : {}),
      key: document.getElementById('mem-key').value.trim(),
      title,
      content,
      category: document.getElementById('mem-category').value,
      inject_mode: document.getElementById('mem-inject-mode').value,
      confidence: document.getElementById('mem-confidence').value,
      tags: parseListInput(document.getElementById('mem-tags').value),
      file_paths: parseListInput(document.getElementById('mem-files').value),
      source: editingMem?.source || 'user',
    });
    if (saved) {
      appState.editingMemoryId = null;
      appState.showMemoryForm = false;
      render();
    }
  });
}

function renderActiveEditsTab(state) {
  const view = document.getElementById('active-edits-view');
  if (!state) {
    view.innerHTML = `<div class="empty-state"><p>Select or create a project to view active edits.</p></div>`;
    return;
  }

  const { project, tasks = [], active_edits = [] } = state;
  if (active_edits.length === 0) {
    view.innerHTML = `<div class="empty-state">
      <p>No active file edits right now. Live file locks from concurrent chats appear here automatically and clear when a turn finishes.</p>
    </div>`;
    return;
  }

  const tasksById = new Map(tasks.map((t) => [t.task_id, t]));
  const overlapCount = active_edits.filter((e) => e.overlap).length;
  const uniqueChats = new Set(active_edits.map((e) => e.conv_id)).size;

  const sorted = [...active_edits].sort((a, b) => {
    if (Boolean(a.overlap) !== Boolean(b.overlap)) return a.overlap ? -1 : 1;
    return String(a.file_path || '').localeCompare(String(b.file_path || ''));
  });
  const filtered =
    appState.activeEditsFilter === 'overlaps' && overlapCount > 0
      ? sorted.filter((e) => e.overlap)
      : sorted;

  view.innerHTML = `<div class="active-edits-view">
    <div class="active-edits-banner${overlapCount > 0 ? ' has-overlap' : ''}">
      <div class="action-row">
        ${overlapCount > 0
          ? `<span class="pill pill-block">⚠ ${overlapCount} overlap alert${overlapCount === 1 ? '' : 's'}</span>`
          : `<span class="pill pill-prog">No edit overlaps</span>`}
        <span class="pill">${active_edits.length} active lock${active_edits.length === 1 ? '' : 's'}</span>
        <span class="pill">${uniqueChats} active chat${uniqueChats === 1 ? '' : 's'}</span>
      </div>
      <div class="action-row">
        ${overlapCount > 0
          ? `<button type="button" class="btn btn-sm${appState.activeEditsFilter === 'all' ? ' btn-primary' : ''}" data-ae-filter="all">All (${active_edits.length})</button>
             <button type="button" class="btn btn-sm${appState.activeEditsFilter === 'overlaps' ? ' btn-primary' : ''}" data-ae-filter="overlaps">Overlaps only (${overlapCount})</button>`
          : ''}
        <button type="button" id="btn-clear-all-edits" class="btn btn-danger btn-sm">Clear All Locks</button>
      </div>
    </div>

    <div class="active-edits-list">
      ${filtered
        .map((e, idx) => {
          const linkedTask = e.task_id ? tasksById.get(e.task_id) : null;
          const badge = e.same_folder_overlap
            ? '<span class="pill pill-block">⚠ SAME-DIR OVERLAP</span>'
            : e.cross_worktree_overlap
              ? '<span class="pill pill-ready">⚠ CROSS-WORKTREE OVERLAP</span>'
              : e.overlap
                ? '<span class="pill pill-block">⚠ OVERLAP</span>'
                : '';
          return `<article class="active-edit-card${e.overlap ? ' overlap' : ''}">
            <div class="active-edit-head">
              <div class="action-row">
                <button type="button" class="chip-link" data-open-edit="${idx}" title="Open file">${esc(e.file_path)}</button>
                ${badge}
              </div>
              <button type="button" class="btn btn-sm" data-clear-edit="${idx}" title="Clear stale lock">Clear lock</button>
            </div>
            <div class="active-edit-meta">
              ${e.task_id
                ? `<button type="button" class="dep-chip" data-jump-edit-task="${esc(e.task_id)}">Task: ${esc(linkedTask?.title || e.task_id)}</button>`
                : ''}
              <span class="pill pill-mono">chat ${esc(e.conv_id.slice(0, 8))}</span>
              ${e.workspace_dir ? `<span class="muted mono" title="${esc(e.workspace_dir)}">${esc(e.workspace_dir)}</span>` : ''}
            </div>
          </article>`;
        })
        .join('')}
    </div>
  </div>`;

  view.querySelectorAll('[data-ae-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      appState.activeEditsFilter = btn.dataset.aeFilter;
      render();
    });
  });

  document.getElementById('btn-clear-all-edits')?.addEventListener('click', () => {
    openConfirmDialog({
      title: 'Clear all active edit locks?',
      message: `Clear all ${active_edits.length} active edit lock(s) for "${project.title}"?`,
      confirmLabel: 'Clear All Locks',
      onConfirm: async () => {
        let lastSnap = null;
        try {
          for (const e of active_edits) {
            lastSnap = await transport.invoke('ui_clear_active_edit', {
              project_id: project.project_id,
              conv_id: e.conv_id,
              repo_id: e.repo_id,
              workspace_dir: e.workspace_dir,
              file_path: e.file_path,
            });
          }
          if (lastSnap) applySnapshot(lastSnap);
          showToast('Cleared all active edit locks');
        } catch (err) {
          showToast(err?.message || String(err), 3800);
        }
      },
    });
  });

  view.querySelectorAll('[data-open-edit]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const e = filtered[Number(btn.dataset.openEdit)];
      if (!e) return;
      const abs = resolveAbsFile(e.workspace_dir || project.workspace_dir, e.file_path);
      const res = await transport.openFile(abs);
      if (res?.fallback === 'copy') await copyToClipboard(abs, `Copied path: ${abs}`);
    });
  });

  view.querySelectorAll('[data-clear-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const e = filtered[Number(btn.dataset.clearEdit)];
      if (!e) return;
      runTool('ui_clear_active_edit', {
        project_id: project.project_id,
        conv_id: e.conv_id,
        repo_id: e.repo_id,
        workspace_dir: e.workspace_dir,
        file_path: e.file_path,
      });
    });
  });

  view.querySelectorAll('[data-jump-edit-task]').forEach((btn) => {
    btn.addEventListener('click', () => {
      appState.selectedTaskId = btn.dataset.jumpEditTask;
      appState.detailOpenMobile = true;
      appState.activeTab = 'tasks';
      render();
    });
  });
}

function openGraphModal() {
  const state = appState.snapshot?.state;
  if (!state) return;
  const dlg = document.getElementById('graph-dialog');
  document.getElementById('graph-node-count').textContent = String(state.tasks.length);
  const stage = document.getElementById('graph-stage-container');
  dlg.showModal();
  graphHandle = mountDependencyGraph(stage, {
    tasks: state.tasks,
    deps: state.deps,
    selectedTaskId: appState.selectedTaskId,
    onSelectTask: (taskId) => {
      appState.selectedTaskId = taskId;
      appState.detailOpenMobile = true;
      dlg.close();
      render();
    },
  });
}

function openNewTaskModal(parentId) {
  const state = appState.snapshot?.state;
  if (!state) return;
  const dlg = document.getElementById('new-task-dialog');
  document.getElementById('new-task-parent-id').value = parentId || '';
  document.getElementById('new-task-parent-label').textContent = parentId ? `Sub-task under ${parentId}` : 'Top-level task';
  document.getElementById('new-task-title').value = '';
  document.getElementById('new-task-brief').value = '';
  document.getElementById('new-task-files').value = '';
  document.getElementById('new-task-tests').value = '';
  dlg.showModal();
}

const pickerState = {
  mode: 'dir', // 'dir' | 'file' | 'files'
  baseDir: '',
  extensions: [],
  current: '',
  parent: null,
  home: '',
  entries: [],
  selectedFile: '',
  selectedFiles: new Set(),
  onSelect: null,
};

function renderPickerFooter() {
  const tray = document.getElementById('pp-selected-tray');
  const confirmBtn = document.getElementById('pp-confirm-btn');

  if (pickerState.mode === 'dir') {
    tray.hidden = true;
    confirmBtn.disabled = !pickerState.current;
    confirmBtn.textContent = 'Select This Folder';
    return;
  }

  if (pickerState.mode === 'file') {
    tray.hidden = true;
    confirmBtn.disabled = !pickerState.selectedFile;
    confirmBtn.textContent = 'Select File';
    return;
  }

  tray.hidden = false;
  const countEl = document.getElementById('pp-selected-count');
  const chipsEl = document.getElementById('pp-selected-chips');
  countEl.textContent = `${pickerState.selectedFiles.size} selected`;
  chipsEl.innerHTML = '';

  for (const absPath of pickerState.selectedFiles) {
    const rel = toRepoRelativePath(absPath, pickerState.baseDir);
    const chip = document.createElement('span');
    chip.className = 'quick-chip';
    chip.title = absPath;

    const label = document.createElement('span');
    label.textContent = rel;
    label.style.overflow = 'hidden';
    label.style.textOverflow = 'ellipsis';

    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'quick-chip-clear';
    rm.setAttribute('aria-label', `Remove ${rel}`);
    rm.textContent = '×';
    rm.addEventListener('click', () => {
      pickerState.selectedFiles.delete(absPath);
      renderPickerList();
      renderPickerFooter();
    });

    chip.appendChild(label);
    chip.appendChild(rm);
    chipsEl.appendChild(chip);
  }

  confirmBtn.disabled = false;
  confirmBtn.textContent = `Apply (${pickerState.selectedFiles.size})`;
}

function renderPickerList() {
  const listEl = document.getElementById('pp-list');
  const q = document.getElementById('pp-filter-input').value.trim().toLowerCase();
  const filtered = q
    ? pickerState.entries.filter((e) => e.name.toLowerCase().includes(q))
    : pickerState.entries;

  listEl.innerHTML = '';
  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'pp-empty';
    empty.textContent = q ? 'No matching entries' : 'Empty folder';
    listEl.appendChild(empty);
    return;
  }

  const dlg = document.getElementById('path-picker-dialog');
  for (const entry of filtered) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'pp-row';
    row.setAttribute('role', 'option');
    row.title = entry.path;

    if (entry.is_dir) {
      const icon = document.createElement('span');
      icon.textContent = '📁';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'pp-row-name';
      nameSpan.textContent = entry.name;
      row.appendChild(icon);
      row.appendChild(nameSpan);
      if (entry.is_git_repo) {
        const badge = document.createElement('span');
        badge.className = 'pp-git-badge';
        badge.textContent = 'git';
        row.appendChild(badge);
      }
      row.addEventListener('click', () => {
        loadPickerDir(entry.path);
      });
    } else if (pickerState.mode === 'files') {
      const checked = pickerState.selectedFiles.has(entry.path);
      if (checked) row.classList.add('selected');
      row.setAttribute('aria-selected', String(checked));

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = checked;
      cb.tabIndex = -1;
      cb.setAttribute('aria-hidden', 'true');

      const icon = document.createElement('span');
      icon.textContent = '📄';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'pp-row-name';
      nameSpan.textContent = entry.name;

      row.appendChild(cb);
      row.appendChild(icon);
      row.appendChild(nameSpan);
      row.addEventListener('click', () => {
        if (pickerState.selectedFiles.has(entry.path)) {
          pickerState.selectedFiles.delete(entry.path);
        } else {
          pickerState.selectedFiles.add(entry.path);
        }
        renderPickerList();
        renderPickerFooter();
      });
    } else {
      const isSelected = pickerState.selectedFile === entry.path;
      if (isSelected) row.classList.add('selected');
      row.setAttribute('aria-selected', String(isSelected));

      const icon = document.createElement('span');
      icon.textContent = '📄';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'pp-row-name';
      nameSpan.textContent = entry.name;

      row.appendChild(icon);
      row.appendChild(nameSpan);
      row.addEventListener('click', () => {
        pickerState.selectedFile = entry.path;
        renderPickerList();
        renderPickerFooter();
      });
      row.addEventListener('dblclick', () => {
        const cb = pickerState.onSelect;
        dlg.close();
        cb?.(entry.path);
      });
    }

    listEl.appendChild(row);
  }
}

async function loadPickerDir(targetPath) {
  const noticeEl = document.getElementById('pp-notice');
  const listEl = document.getElementById('pp-list');
  const showHidden = document.getElementById('pp-show-hidden').checked;
  const extOnly = document.getElementById('pp-ext-only').checked;

  noticeEl.hidden = true;
  noticeEl.textContent = '';
  listEl.innerHTML = '<div class="pp-empty">Loading...</div>';

  try {
    const res = await transport.invoke('ui_browse_dir', {
      path: targetPath || '',
      include_files: pickerState.mode !== 'dir',
      include_hidden: showHidden,
      extensions:
        pickerState.mode === 'file' && pickerState.extensions.length > 0 && extOnly
          ? pickerState.extensions
          : [],
    });

    if (pickerState.mode === 'file' && pickerState.current !== res.current) {
      pickerState.selectedFile = '';
    }
    pickerState.current = res.current || '';
    pickerState.parent = res.parent || null;
    pickerState.home = res.home || '';
    pickerState.entries = Array.isArray(res.entries) ? res.entries : [];

    document.getElementById('pp-path-input').value = pickerState.current;
    document.getElementById('pp-up-btn').disabled = !pickerState.parent;

    const notices = [];
    if (res.notice) notices.push(res.notice);
    if (res.truncated) notices.push(`Showing first ${pickerState.entries.length} entries; type to narrow.`);
    if (notices.length > 0) {
      noticeEl.textContent = notices.join(' · ');
      noticeEl.hidden = false;
    }

    renderPickerList();
    renderPickerFooter();
  } catch (err) {
    pickerState.entries = [];
    noticeEl.textContent = err?.message || String(err);
    noticeEl.hidden = false;
    renderPickerList();
    renderPickerFooter();
  }
}

function openPathPicker({
  mode = 'dir',
  title = '',
  startPath = '',
  baseDir = '',
  extensions = [],
  extLabel = 'Matching files only',
  initialSelection = [],
  onSelect,
} = {}) {
  pickerState.mode = mode;
  pickerState.baseDir = baseDir || '';
  pickerState.extensions = Array.isArray(extensions) ? extensions : [];
  pickerState.current = '';
  pickerState.parent = null;
  pickerState.home = '';
  pickerState.entries = [];
  pickerState.selectedFile = '';
  pickerState.selectedFiles = new Set();
  pickerState.onSelect = onSelect || null;

  if (mode === 'files' && Array.isArray(initialSelection)) {
    for (const item of initialSelection) {
      const abs = resolveAbsFile(pickerState.baseDir, item).replace(/\\/g, '/');
      if (abs) pickerState.selectedFiles.add(abs);
    }
  }

  document.getElementById('pp-title').textContent =
    title || (mode === 'dir' ? 'Select Folder' : mode === 'files' ? 'Select Files' : 'Select File');
  document.getElementById('pp-filter-input').value = '';
  document.getElementById('pp-show-hidden').checked = false;

  const hasExt = mode === 'file' && pickerState.extensions.length > 0;
  document.getElementById('pp-ext-wrap').hidden = !hasExt;
  if (hasExt) {
    document.getElementById('pp-ext-only').checked = true;
    document.getElementById('pp-ext-label').textContent = extLabel || 'Matching files only';
  }

  renderWorkspaceChips(document.getElementById('pp-quick-chips'), (ws) => loadPickerDir(ws));

  const initialDir = startPath
    ? resolveAbsFile(pickerState.baseDir, startPath)
    : pickerState.baseDir || transport?.getDefaultWorkspaceDir?.() || '';

  const dlg = document.getElementById('path-picker-dialog');
  dlg.showModal();
  loadPickerDir(initialDir);
}

function render() {
  const snap = appState.snapshot;
  renderTopbar(snap);
  renderSummaryAndStrip(snap?.state || null);

  const tasksBtn = document.getElementById('tab-tasks-btn');
  const notesBtn = document.getElementById('tab-notes-btn');
  const memoryBtn = document.getElementById('tab-memory-btn');
  const activeEditsBtn = document.getElementById('tab-active-edits-btn');
  const tasksView = document.getElementById('tasks-view');
  const notesView = document.getElementById('notes-view');
  const memoryView = document.getElementById('memory-view');
  const activeEditsView = document.getElementById('active-edits-view');

  tasksBtn.classList.toggle('active', appState.activeTab === 'tasks');
  notesBtn.classList.toggle('active', appState.activeTab === 'notes');
  memoryBtn.classList.toggle('active', appState.activeTab === 'memory');
  activeEditsBtn.classList.toggle('active', appState.activeTab === 'active_edits');
  tasksView.hidden = appState.activeTab !== 'tasks';
  notesView.hidden = appState.activeTab !== 'notes';
  memoryView.hidden = appState.activeTab !== 'memory';
  activeEditsView.hidden = appState.activeTab !== 'active_edits';

  if (appState.activeTab === 'tasks') {
    renderTasksTab(snap?.state || null);
  } else if (appState.activeTab === 'notes') {
    renderNotesTab(snap?.state || null);
  } else if (appState.activeTab === 'memory') {
    renderMemoryTab(snap?.state || null);
  } else {
    renderActiveEditsTab(snap?.state || null);
  }
}

function wireStaticHandlers() {
  installDialogFallbacks();

  themeOverrideMem = readInitialThemeOverride();
  applyThemeState(themeOverrideMem);

  document.getElementById('btn-theme-toggle')?.addEventListener('click', () => {
    const effective = getEffectiveTheme();
    const target = effective === 'dark' ? 'light' : 'dark';
    const hostOrSystem = getSystemOrHostTheme();
    if (target === hostOrSystem) {
      safeStorageRemove(THEME_STORAGE_KEY);
      applyThemeState(null);
    } else {
      safeStorageSet(THEME_STORAGE_KEY, target);
      applyThemeState(target);
    }
  });

  window.addEventListener('storage', (e) => {
    if (e.key === THEME_STORAGE_KEY) {
      const next = e.newValue === 'dark' || e.newValue === 'light' ? e.newValue : null;
      applyThemeState(next);
    }
  });

  const colorMedia = window.matchMedia?.('(prefers-color-scheme: dark)');
  colorMedia?.addEventListener?.('change', () => {
    if (!themeOverrideMem) {
      applyThemeState(null);
    }
  });

  document.querySelectorAll('[data-close-dialog]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.getElementById(btn.dataset.closeDialog)?.close();
    });
  });

  document.getElementById('project-select').addEventListener('change', (e) => {
    if (e.target.value) {
      appState.selectedTaskId = null;
      appState.detailOpenMobile = false;
      appState.editingNoteId = null;
      appState.showNoteForm = false;
      appState.noteTaskFilter = 'all';
      appState.editingMemoryId = null;
      appState.showMemoryForm = false;
      appState.kpTypeFilter = 'all';
      appState.kpSearch = '';
      appState.activeEditsFilter = 'all';
      runTool('ui_select_project', { project_id: e.target.value });
    }
  });

  document.getElementById('search-input').addEventListener('input', (e) => {
    appState.searchQuery = e.target.value;
    render();
  });

  document.getElementById('tab-tasks-btn').addEventListener('click', () => {
    appState.activeTab = 'tasks';
    render();
  });

  document.getElementById('tab-notes-btn').addEventListener('click', () => {
    appState.activeTab = 'notes';
    render();
  });

  document.getElementById('tab-memory-btn').addEventListener('click', () => {
    appState.activeTab = 'memory';
    render();
  });

  document.getElementById('tab-active-edits-btn').addEventListener('click', () => {
    appState.activeTab = 'active_edits';
    render();
  });

  document.getElementById('btn-new-project').addEventListener('click', openNewProjectModal);

  document.getElementById('btn-browse-np-workspace').addEventListener('click', () => {
    const startPath =
      document.getElementById('np-workspace').value.trim() ||
      transport?.getDefaultWorkspaceDir?.() ||
      '';
    openPathPicker({
      mode: 'dir',
      title: 'Select Workspace Directory',
      startPath,
      onSelect: (dir) => {
        document.getElementById('np-workspace').value = dir;
      },
    });
  });

  document.getElementById('btn-browse-np-source').addEventListener('click', () => {
    const mode = document.getElementById('np-mode').value;
    if (mode === 'github' || mode === 'blank') return;
    const npWs = document.getElementById('np-workspace').value.trim();
    const npSrc = document.getElementById('np-source').value.trim();
    const fallbackStart = npWs || transport?.getDefaultWorkspaceDir?.() || '';

    if (mode === 'markdown') {
      openPathPicker({
        mode: 'file',
        title: 'Select Markdown Plan File',
        startPath: npSrc || fallbackStart,
        baseDir: npWs,
        extensions: ['.md', '.markdown', '.txt'],
        extLabel: 'Markdown only',
        onSelect: (filePath) => {
          let wsDir = document.getElementById('np-workspace').value.trim();
          if (!wsDir) {
            const idx = filePath.lastIndexOf('/');
            wsDir = idx > 0 ? filePath.slice(0, idx) : filePath;
            document.getElementById('np-workspace').value = wsDir;
          }
          document.getElementById('np-source').value = toRepoRelativePath(filePath, wsDir);
        },
      });
    } else if (mode === 'folder') {
      openPathPicker({
        mode: 'dir',
        title: 'Select Folder to Seed From',
        startPath: npSrc || fallbackStart,
        onSelect: (dirPath) => {
          document.getElementById('np-source').value = dirPath;
          if (!document.getElementById('np-workspace').value.trim()) {
            document.getElementById('np-workspace').value = dirPath;
          }
        },
      });
    }
  });

  document.getElementById('np-mode').addEventListener('change', (e) => {
    const mode = e.target.value;
    const sourceRow = document.getElementById('np-source-row');
    const sourceInput = document.getElementById('np-source');
    const sourceLabel = document.getElementById('np-source-label');
    const sourceBrowseBtn = document.getElementById('btn-browse-np-source');
    if (mode === 'blank') {
      sourceRow.hidden = true;
      sourceBrowseBtn.hidden = true;
    } else {
      sourceRow.hidden = false;
      sourceBrowseBtn.hidden = mode === 'github';
      if (mode === 'markdown') {
        sourceLabel.textContent = 'Markdown plan path';
        sourceInput.placeholder = 'PLAN.md or /abs/path/to/SPEC.md';
      } else if (mode === 'folder') {
        sourceLabel.textContent = 'Folder path to seed from subdirectories';
        sourceInput.placeholder = '/abs/path/to/project';
      } else {
        sourceLabel.textContent = 'GitHub Issue URL';
        sourceInput.placeholder = 'https://github.com/owner/repo/issues/123';
      }
    }
  });

  document.getElementById('new-project-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const mode = document.getElementById('np-mode').value;
    const title = document.getElementById('np-title').value.trim();
    const workspace_dir = document.getElementById('np-workspace').value.trim();
    const source_ref = mode === 'blank' ? '' : document.getElementById('np-source').value.trim();
    const snap = await runTool('ui_create_project', {
      title,
      workspace_dir,
      source_ref,
      seed: mode !== 'blank',
    });
    if (snap) {
      document.getElementById('new-project-dialog').close();
      if (snap.warning) showToast(snap.warning, 4200);
    }
  });

  document.getElementById('btn-browse-new-task-files').addEventListener('click', () => {
    const baseDir =
      appState.snapshot?.state?.project?.workspace_dir || transport?.getDefaultWorkspaceDir?.() || '';
    openPathPicker({
      mode: 'files',
      title: 'Select Expected Files',
      startPath: baseDir,
      baseDir,
      initialSelection: parseListInput(document.getElementById('new-task-files').value),
      onSelect: (paths) => {
        document.getElementById('new-task-files').value = paths.join(', ');
      },
    });
  });

  document.getElementById('new-task-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const projectId = appState.snapshot?.state?.project?.project_id;
    if (!projectId) return;
    const title = document.getElementById('new-task-title').value.trim();
    if (!title) return;
    const parentId = document.getElementById('new-task-parent-id').value || null;
    const snap = await runTool('ui_create_task', {
      project_id: projectId,
      parent_id: parentId,
      title,
      brief: document.getElementById('new-task-brief').value,
      files: parseListInput(document.getElementById('new-task-files').value),
      target_tests: parseListInput(document.getElementById('new-task-tests').value),
    });
    if (snap) {
      if (snap.created_task_id) {
        appState.selectedTaskId = snap.created_task_id;
        appState.detailOpenMobile = true;
      }
      document.getElementById('new-task-dialog').close();
    }
  });

  // Settings popover actions
  const closeSettingsPopover = () => {
    try {
      document.getElementById('settings-popover').hidePopover?.();
    } catch {
      // ignore if unsupported
    }
  };

  document.getElementById('menu-rename-btn').addEventListener('click', () => {
    closeSettingsPopover();
    const proj = appState.snapshot?.state?.project;
    if (!proj) return;
    document.getElementById('rename-input').value = proj.title;
    document.getElementById('rename-workspace').value = proj.workspace_dir || '';
    document.getElementById('rename-dialog').showModal();
  });

  document.getElementById('btn-browse-rename-workspace').addEventListener('click', () => {
    const startPath =
      document.getElementById('rename-workspace').value.trim() ||
      transport?.getDefaultWorkspaceDir?.() ||
      '';
    openPathPicker({
      mode: 'dir',
      title: 'Select Workspace Directory',
      startPath,
      onSelect: (dir) => {
        document.getElementById('rename-workspace').value = dir;
      },
    });
  });

  document.getElementById('rename-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const proj = appState.snapshot?.state?.project;
    const title = document.getElementById('rename-input').value.trim();
    const workspace_dir = document.getElementById('rename-workspace').value.trim();
    if (!proj || !title) return;
    const res = await runTool('ui_update_project', {
      project_id: proj.project_id,
      title,
      workspace_dir,
    });
    if (res) document.getElementById('rename-dialog').close();
  });

  document.getElementById('menu-archive-btn').addEventListener('click', () => {
    closeSettingsPopover();
    const proj = appState.snapshot?.state?.project;
    if (!proj) return;
    runTool('ui_archive_project', { project_id: proj.project_id, archived: !proj.archived_at });
  });

  document.getElementById('menu-delete-btn').addEventListener('click', () => {
    closeSettingsPopover();
    const proj = appState.snapshot?.state?.project;
    if (!proj) return;
    openConfirmDialog({
      title: 'Delete project permanently?',
      message: `This removes "${proj.title}", all tasks, dependencies, and project notes from local SQLite.`,
      confirmLabel: 'Delete Project',
      onConfirm: () => runTool('ui_delete_project', { project_id: proj.project_id }),
    });
  });

  document.getElementById('confirm-ok-btn').addEventListener('click', async () => {
    const fn = confirmCallback;
    confirmCallback = null;
    document.getElementById('confirm-dialog').close();
    if (fn) await fn();
  });

  document.getElementById('graph-zoom-in').addEventListener('click', () => graphHandle?.zoomIn());
  document.getElementById('graph-zoom-out').addEventListener('click', () => graphHandle?.zoomOut());
  document.getElementById('graph-fit').addEventListener('click', () => graphHandle?.fit());

  // Path Picker modal static handlers
  document.getElementById('pp-up-btn').addEventListener('click', () => {
    if (pickerState.parent) loadPickerDir(pickerState.parent);
  });
  document.getElementById('pp-home-btn').addEventListener('click', () => {
    loadPickerDir(pickerState.home || '');
  });
  document.getElementById('pp-go-btn').addEventListener('click', () => {
    loadPickerDir(document.getElementById('pp-path-input').value.trim());
  });
  document.getElementById('pp-path-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      loadPickerDir(e.target.value.trim());
    }
  });
  document.getElementById('pp-filter-input').addEventListener('input', () => {
    renderPickerList();
  });
  document.getElementById('pp-show-hidden').addEventListener('change', () => {
    loadPickerDir(pickerState.current);
  });
  document.getElementById('pp-ext-only').addEventListener('change', () => {
    loadPickerDir(pickerState.current);
  });
  document.getElementById('pp-clear-selected').addEventListener('click', () => {
    pickerState.selectedFiles.clear();
    renderPickerList();
    renderPickerFooter();
  });
  document.getElementById('pp-confirm-btn').addEventListener('click', () => {
    const dlg = document.getElementById('path-picker-dialog');
    const cb = pickerState.onSelect;
    if (pickerState.mode === 'dir') {
      if (!pickerState.current) return;
      const chosen = pickerState.current;
      dlg.close();
      cb?.(chosen);
      return;
    }
    if (pickerState.mode === 'file') {
      if (!pickerState.selectedFile) return;
      const chosen = pickerState.selectedFile;
      dlg.close();
      cb?.(chosen);
      return;
    }
    const paths = [...pickerState.selectedFiles].map((p) => toRepoRelativePath(p, pickerState.baseDir));
    dlg.close();
    cb?.(paths);
  });
}

async function boot() {
  wireStaticHandlers();

  transport = createTransport({
    onState: (snap) => applySnapshot(snap),
    onHostContext: (ctx) => {
      appState.caps = transport.getCapabilities();
      if ((ctx?.hostTheme || ctx?.theme) && !themeOverrideMem) {
        applyThemeState(null);
      }
      if (ctx?.workspaceDirs) {
        if (document.getElementById('new-project-dialog')?.open) {
          renderWorkspaceChips(document.getElementById('np-workspace-chips'), (ws) => {
            document.getElementById('np-workspace').value = ws;
          });
        }
        if (document.getElementById('path-picker-dialog')?.open) {
          renderWorkspaceChips(document.getElementById('pp-quick-chips'), (ws) => loadPickerDir(ws));
        }
      }
      render();
    },
  });

  try {
    const initial = await transport.connect();
    applyThemeState(themeOverrideMem);
    appState.caps = transport.getCapabilities();
    if (initial) applySnapshot(initial);
  } catch (err) {
    showToast(`Connection error: ${err?.message || err}`, 5000);
  }

  // Visibility-aware 4s polling so parallel sessions appear live
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (document.querySelector('dialog[open]')) return;
    if (appState.showMemoryForm || appState.showNoteForm) return;
    if (appState.activeTab === 'memory' && appState.knowledgeSubTab === 'kp') {
      const savedProj = appState.snapshot?.state?.project;
      const kpInput = document.getElementById('kp-path-input');
      const kpMode = document.getElementById('kp-mode-select');
      if (
        (kpInput && kpInput.value.trim() !== (savedProj?.kp_path || '')) ||
        (kpMode && kpMode.value !== (savedProj?.kp_mode || 'auto'))
      ) {
        return;
      }
    }
    if (isUserTyping()) return;
    const projId = appState.snapshot?.selected_project_id;
    transport
      .invoke('ui_get_state', projId ? { project_id: projId } : {})
      .then((snap) => {
        if (snap) applySnapshot(snap);
      })
      .catch(() => {});
  }, 4000);
}

boot();
