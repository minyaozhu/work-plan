import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';

const PASSTHROUGH_SCHEMA = {
  '~standard': {
    version: 1,
    vendor: 'work-plan',
    validate: (value) => ({ value }),
  },
};

function toFileUri(absPath) {
  const norm = String(absPath || '').replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(norm)) {
    return `file:///${encodeURI(norm)}`;
  }
  const prefixed = norm.startsWith('/') ? norm : `/${norm}`;
  return `file://${encodeURI(prefixed)}`;
}

function fromFileUri(uri) {
  const raw = String(uri || '').trim();
  if (!raw) return '';
  if (!raw.toLowerCase().startsWith('file://')) return raw;
  let rest = raw.slice('file://'.length);
  if (rest.toLowerCase().startsWith('localhost/')) {
    rest = rest.slice('localhost'.length);
  }
  try {
    rest = decodeURIComponent(rest);
  } catch {
    // keep raw string if malformed percent encoding
  }
  if (/^\/[a-zA-Z]:\//.test(rest)) {
    return rest.slice(1);
  }
  return rest;
}

function createStandaloneMockTransport({ onState }) {
  const sampleState = {
    projects: [
      {
        project_id: 'work-plan-demo',
        title: 'Work Plan Demo (Standalone Preview)',
        workspace_dir: '/Users/dev/demo-repo',
        repo_id: '/Users/dev/demo-repo/.git',
        source_ref: 'PLAN.md',
        pinned: true,
        archived_at: null,
        stats: { total: 5, leaf_total: 4, done: 1, in_progress: 1, blocked: 1, ready: 1, percent_done: 25, active_chats: 1 },
      },
    ],
    selected_project_id: 'work-plan-demo',
    state: {
      project: {
        project_id: 'work-plan-demo',
        title: 'Work Plan Demo (Standalone Preview)',
        workspace_dir: '/Users/dev/demo-repo',
        source_ref: 'PLAN.md',
        pinned: true,
        archived_at: null,
        stats: { total: 5, leaf_total: 4, done: 1, in_progress: 1, blocked: 1, ready: 1, percent_done: 25, active_chats: 1 },
      },
      tasks: [
        { task_id: 'core', parent_id: null, title: 'Core Engine', brief: 'SQLite WAL + DAG invariants', status: 'IN_PROGRESS', is_leaf: false, is_ready: false, is_waiting: false, waiting_on: [], upstream_ids: [], downstream_ids: ['ui-shell'], children_ids: ['db-schema', 'dag-check'], files: [], target_tests: [], handoff_notes: '', progress: { done: 1, total: 2 }, depth: 1 },
        { task_id: 'db-schema', parent_id: 'core', title: 'SQLite 7-Table Schema', brief: 'WAL mode + foreign keys', status: 'DONE', is_leaf: true, is_ready: false, is_waiting: false, waiting_on: [], upstream_ids: [], downstream_ids: ['dag-check'], children_ids: [], files: ['core/db.mjs'], target_tests: ['node --test test/core.test.mjs'], handoff_notes: 'Exported openDb() and withTransaction().', branch_name: 'feat/db-schema', progress: { done: 1, total: 1 }, depth: 2 },
        { task_id: 'dag-check', parent_id: 'core', title: 'Dual-Node Kahn Validator', brief: 'Prevent tree+DAG paradoxes', status: 'IN_PROGRESS', is_leaf: true, is_ready: false, is_waiting: false, waiting_on: [], upstream_ids: ['db-schema'], downstream_ids: [], children_ids: [], files: ['core/tasks.mjs'], target_tests: ['node --test test/core.test.mjs'], handoff_notes: '', conv_id: 'conv-demo-1', progress: { done: 0, total: 1 }, depth: 2 },
        { task_id: 'ui-shell', parent_id: null, title: 'MCP App UI Shell', brief: 'Split pane + SVG graph', status: 'TODO', is_leaf: true, is_ready: false, is_waiting: true, waiting_on: [{ task_id: 'core', title: 'Core Engine', status: 'IN_PROGRESS' }], upstream_ids: ['core'], downstream_ids: [], children_ids: [], files: ['ui/app.html'], target_tests: ['node --test test/ui.test.mjs'], handoff_notes: '', progress: { done: 0, total: 1 }, depth: 1 },
        { task_id: 'docs', parent_id: null, title: 'Skill & Docs', brief: 'Author SKILL.md and README', status: 'BLOCKED', is_leaf: true, is_ready: false, is_waiting: false, waiting_on: [], upstream_ids: [], downstream_ids: [], children_ids: [], files: ['skills/work-plan/SKILL.md'], target_tests: [], handoff_notes: '', progress: { done: 0, total: 1 }, depth: 1 },
      ],
      deps: [
        { upstream_id: 'db-schema', downstream_id: 'dag-check' },
        { upstream_id: 'core', downstream_id: 'ui-shell' },
      ],
      active_edits: [
        { repo_id: '/Users/dev/demo-repo/.git', workspace_dir: '/Users/dev/demo-repo', file_path: 'core/tasks.mjs', conv_id: 'conv-demo-1', project_id: 'work-plan-demo', task_id: 'dag-check', overlap: false },
      ],
      bindings: [{ conv_id: 'conv-demo-1', project_id: 'work-plan-demo', task_id: 'dag-check' }],
      notes: [
        { note_id: 'n1', project_id: 'work-plan-demo', task_id: null, kind: 'decision', title: 'Zero runtime dependencies', body_markdown: 'Use built-in node:sqlite + esbuild bundle at dev time only.', pinned: true, updated_at: new Date().toISOString() },
      ],
      memories: [
        {
          memory_id: 'mem-test-cmd-1',
          project_id: 'work-plan-demo',
          category: 'command',
          key: 'test-command',
          title: 'Run full test suite',
          content: 'Use `npm test` (runs node --test test/*.test.mjs) and `npm run build:ui` after editing ui/src/*.',
          tags: ['testing', 'build'],
          file_paths: ['package.json'],
          inject_mode: 'always',
          confidence: 'confirmed',
          source: 'user',
          updated_at: new Date().toISOString(),
        },
        {
          memory_id: 'mem-graph-dag-2',
          project_id: 'work-plan-demo',
          category: 'architecture',
          key: 'dual-node-dag',
          title: 'Dual-node topological check',
          content: 'Task dependencies validate both hierarchy and DAG edges with Kahn ordering.',
          tags: ['dag'],
          file_paths: ['core/tasks.mjs'],
          inject_mode: 'on_demand',
          confidence: 'inferred',
          source: 'agent',
          updated_at: new Date().toISOString(),
        },
      ],
    },
  };

  return {
    mode: 'standalone',
    async connect() {
      onState?.(sampleState);
      return sampleState;
    },
    async invoke(tool, params = {}) {
      if (tool === 'ui_get_state') return sampleState;
      if (tool === 'ui_browse_dir') {
        const cur = params.path || '/Users/dev/demo-repo';
        const includeFiles = Boolean(params.include_files);
        const includeHidden = Boolean(params.include_hidden);
        const exts = new Set(
          (Array.isArray(params.extensions) ? params.extensions : [])
            .map((e) => String(e || '').toLowerCase())
            .filter(Boolean)
            .map((e) => (e.startsWith('.') ? e : `.${e}`))
        );
        const mockEntries = [
          { name: '.git', path: `${cur}/.git`, is_dir: true, is_git_repo: false },
          { name: 'core', path: `${cur}/core`, is_dir: true, is_git_repo: false },
          { name: 'ui', path: `${cur}/ui`, is_dir: true, is_git_repo: false },
          { name: 'PLAN.md', path: `${cur}/PLAN.md`, is_dir: false, is_git_repo: false },
          { name: 'README.md', path: `${cur}/README.md`, is_dir: false, is_git_repo: false },
          { name: 'package.json', path: `${cur}/package.json`, is_dir: false, is_git_repo: false },
        ].filter((entry) => {
          if (!includeHidden && entry.name.startsWith('.')) return false;
          if (!entry.is_dir && !includeFiles) return false;
          if (!entry.is_dir && exts.size > 0) {
            const dotIdx = entry.name.lastIndexOf('.');
            const ext = dotIdx >= 0 ? entry.name.slice(dotIdx).toLowerCase() : '';
            if (!exts.has(ext)) return false;
          }
          if (params.query && !entry.name.toLowerCase().includes(String(params.query).toLowerCase())) return false;
          return true;
        });
        return {
          current: cur,
          parent: cur === '/Users/dev/demo-repo' ? '/Users/dev' : '/',
          home: '/Users/dev',
          is_git_repo: cur === '/Users/dev/demo-repo',
          notice: null,
          truncated: false,
          entries: mockEntries,
        };
      }
      if (tool === 'ui_clear_active_edit') {
        sampleState.state.active_edits = sampleState.state.active_edits.filter(
          (e) => e.conv_id !== params.conv_id || e.file_path !== params.file_path
        );
      }
      if (tool === 'ui_save_memory') {
        const list = sampleState.state.memories || [];
        const existingIdx = list.findIndex(
          (m) => (params.memory_id && m.memory_id === params.memory_id) || (params.key && m.key === params.key)
        );
        const entry = {
          memory_id: params.memory_id || (existingIdx >= 0 ? list[existingIdx].memory_id : `mem-${Date.now()}`),
          project_id: params.project_id || 'work-plan-demo',
          category: params.category || 'fact',
          key: params.key || '',
          title: params.title || 'Untitled',
          content: params.content || '',
          tags: Array.isArray(params.tags) ? params.tags : [],
          file_paths: Array.isArray(params.file_paths) ? params.file_paths : [],
          inject_mode: params.inject_mode || 'always',
          confidence: params.confidence || 'confirmed',
          source: params.source || 'user',
          updated_at: new Date().toISOString(),
        };
        if (existingIdx >= 0) list[existingIdx] = entry;
        else list.unshift(entry);
        sampleState.state.memories = list;
      }
      if (tool === 'ui_delete_memory') {
        sampleState.state.memories = (sampleState.state.memories || []).filter(
          (m) => m.memory_id !== params.memory_id
        );
      }
      return sampleState;
    },
    async startChat() {
      return { fallback: 'copy' };
    },
    async openFile() {
      return { fallback: 'copy' };
    },
    getCapabilities() {
      return { canStartChat: false, canOpenFile: false, displayMode: 'standalone' };
    },
    getDefaultWorkspaceDir() {
      return '';
    },
    getWorkspaceDirs() {
      return ['/Users/dev/demo-repo'];
    },
  };
}

function createSidecarTransport({ onState, onHostContext } = {}) {
  let workspaceDirs = [];
  let defaultWorkspaceDir = '';
  let currentTheme = '';
  let themeObserver = null;

  const applyWorkspaceUris = (uris) => {
    const next = [];
    const seen = new Set();
    if (Array.isArray(uris)) {
      for (const uri of uris) {
        const localPath = fromFileUri(uri);
        if (localPath && !seen.has(localPath)) {
          seen.add(localPath);
          next.push(localPath);
        }
      }
    }
    workspaceDirs = next;
    defaultWorkspaceDir = workspaceDirs[0] || '';
    onHostContext?.({ workspaceDirs: [...workspaceDirs] });
  };

  function detectSidecarTheme() {
    if (typeof document === 'undefined') return null;
    try {
      if (typeof window !== 'undefined') {
        const themeParam = new URLSearchParams(window.location.search).get('theme');
        if (themeParam === 'dark' || themeParam === 'light') {
          return themeParam;
        }
      }
      const hostBg = getComputedStyle(document.documentElement).getPropertyValue('--background').trim();
      if (!hostBg) {
        if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)')?.matches) {
          return 'dark';
        }
        return 'light';
      }
      const probe = document.createElement('span');
      probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f8fafc)';
      document.documentElement.appendChild(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      const nums = (c.match(/[\d.]+/g) || []).map(Number);
      if (nums.length < 3) return null;
      const scale = c.startsWith('color(') ? 1 : 255;
      const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      return lum < 0.5 ? 'dark' : 'light';
    } catch {
      return null;
    }
  }

  function syncSidecarTheme(notify = true) {
    const theme = detectSidecarTheme();
    if (!theme) return;
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
    }
    if (theme !== currentTheme) {
      currentTheme = theme;
      if (notify) onHostContext?.({ theme });
    }
  }

  async function invoke(toolName, params = {}) {
    const sidecar = typeof window !== 'undefined' ? window.sidecar : null;
    const fetcher = sidecar?.fetch ? sidecar.fetch.bind(sidecar) : fetch;
    const headers = { 'Content-Type': 'application/json' };
    if (!sidecar?.fetch && typeof window !== 'undefined') {
      const urlToken = new URLSearchParams(window.location.search).get('token');
      if (urlToken) headers['X-Sidecar-Token'] = urlToken;
    }
    const res = await fetcher('/api/tool', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: toolName, arguments: params }),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const msg = data?.error?.message || data?.error || text || `HTTP ${res.status}`;
      throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }
    if (data?.isError) {
      const msg =
        data?.structuredContent?.error?.message ||
        data?.error?.message ||
        data?.content?.[0]?.text ||
        'Tool call failed';
      throw new Error(msg);
    }
    return data?.structuredContent ?? data ?? null;
  }

  function getCapabilities() {
    const embedded = typeof window !== 'undefined' && window.parent && window.parent !== window;
    const sidecar = typeof window !== 'undefined' ? window.sidecar : null;
    return {
      canStartChat: Boolean(embedded && sidecar?.agent?.startConversation),
      canOpenFile: Boolean(embedded && sidecar?.ui?.toggleAuxPane),
      displayMode: 'sidecar',
    };
  }

  return {
    mode: 'sidecar',
    async connect() {
      syncSidecarTheme(false);
      if (!themeObserver && typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
        themeObserver = new MutationObserver(() => syncSidecarTheme(true));
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
      }
      const sidecar = typeof window !== 'undefined' ? window.sidecar : null;
      if (sidecar?.onWorkspaceChange) {
        sidecar.onWorkspaceChange(applyWorkspaceUris);
      }
      if (sidecar?.getWorkspaceUris) {
        Promise.resolve(sidecar.getWorkspaceUris()).then(applyWorkspaceUris).catch(() => {});
      }
      const snap = await invoke('ui_get_state', {});
      onState?.(snap);
      return snap;
    },
    invoke,
    async startChat(prompt, { projectId, taskId, workspaceDir } = {}) {
      const embedded = typeof window !== 'undefined' && window.parent && window.parent !== window;
      const sidecar = typeof window !== 'undefined' ? window.sidecar : null;
      if (!embedded || !sidecar?.agent?.startConversation) {
        return { fallback: 'copy' };
      }
      try {
        const result = await sidecar.agent.startConversation(
          prompt,
          taskId ? `Work Plan: ${taskId}` : undefined
        );
        if (result?.error) {
          return {
            fallback: 'copy',
            error: typeof result.error === 'string' ? result.error : result.error?.message || 'Host rejected message',
          };
        }
        const convId =
          result?.conversationId ||
          result?.conversation_id ||
          result?.id ||
          result?.response?.conversationId ||
          result?.response?.conversation_id ||
          null;
        if (convId && projectId) {
          await invoke('ui_bind_conversation', {
            conv_id: convId,
            project_id: projectId,
            task_id: taskId || null,
            workspace_dir: workspaceDir || defaultWorkspaceDir || '',
          });
        }
        return { started: true, convId };
      } catch (err) {
        return { fallback: 'copy', error: err?.message || String(err) };
      }
    },
    async openFile(absPath) {
      const embedded = typeof window !== 'undefined' && window.parent && window.parent !== window;
      const sidecar = typeof window !== 'undefined' ? window.sidecar : null;
      if (!absPath || !embedded || !sidecar?.ui?.toggleAuxPane) {
        return { fallback: 'copy' };
      }
      try {
        const uri = toFileUri(absPath);
        sidecar.ui.toggleAuxPane({ tabType: 'fileView', uri });
        return { opened: true, uri };
      } catch {
        return { fallback: 'copy' };
      }
    },
    getCapabilities,
    getDefaultWorkspaceDir() {
      return defaultWorkspaceDir;
    },
    getWorkspaceDirs() {
      return [...workspaceDirs];
    },
  };
}

/**
 * Decoupled UI transport adapter wrapping @modelcontextprotocol/ext-apps (SEP-1865)
 * and Antigravity Sidecar HTTP transport.
 */
export function createTransport({ onState, onHostContext } = {}) {
  const isSidecar =
    typeof document !== 'undefined' &&
    (Boolean(typeof window !== 'undefined' && window.sidecar) ||
      Boolean(document.querySelector('meta[name="wp-transport"][content="sidecar"]')));
  if (isSidecar) {
    return createSidecarTransport({ onState, onHostContext });
  }

  const isEmbedded = typeof window !== 'undefined' && window.parent && window.parent !== window;
  if (!isEmbedded) {
    return createStandaloneMockTransport({ onState });
  }

  const app = new App({ name: 'Work Plan', version: '0.1.0' }, {}, { autoResize: true });

  const applyContext = (ctx) => {
    if (!ctx) return;
    if (ctx.theme === 'dark' || ctx.theme === 'light') {
      applyDocumentTheme(ctx.theme);
    }
    if (ctx.styles?.variables) {
      applyHostStyleVariables(ctx.styles.variables);
    }
    if (ctx.styles?.css?.fonts) {
      applyHostFonts(ctx.styles.css.fonts);
    }
    onHostContext?.(ctx);
  };

  app.ontoolresult = (params) => {
    if (params?.structuredContent && !params.isError) {
      onState?.(params.structuredContent);
    }
  };

  app.onhostcontextchanged = (ctx) => {
    applyContext(ctx);
  };

  async function invoke(toolName, params = {}) {
    const res = await app.callServerTool({ name: toolName, arguments: params });
    if (res?.isError) {
      const msg = res.structuredContent?.error?.message || res.content?.[0]?.text || 'Tool call failed';
      throw new Error(msg);
    }
    return res?.structuredContent || null;
  }

  function getCapabilities() {
    const caps = app.getHostCapabilities?.() || {};
    const ctx = app.getHostContext?.() || {};
    const canStartChat = Boolean(caps.message);
    const canOpenFile = Boolean(
      caps.experimental?.['com.google.antigravity/toggle-aux-pane'] ||
        caps['com.google.antigravity/toggle-aux-pane'] ||
        ctx.userAgent?.toLowerCase?.().includes('antigravity') ||
        app.getHostVersion?.()?.name?.toLowerCase?.().includes('antigravity') ||
        canStartChat
    );
    return {
      canStartChat,
      canOpenFile,
      displayMode: ctx.displayMode || 'inline',
      hostContext: ctx,
    };
  }

  return {
    mode: 'mcp-app',
    async connect() {
      await app.connect();
      applyContext(app.getHostContext?.());
      return invoke('ui_get_state', {});
    },
    invoke,
    async startChat(prompt, { projectId, taskId, workspaceDir } = {}) {
      const caps = app.getHostCapabilities?.() || {};
      if (!caps.message) {
        return { fallback: 'copy' };
      }
      try {
        const result = await app.sendMessage({
          role: 'user',
          content: [{ type: 'text', text: prompt }],
          _meta: {
            'com.google.antigravity/message': { target: 'new' },
          },
        });
        if (result?.isError) {
          return { fallback: 'copy', error: 'Host rejected message' };
        }
        const convId = result?.conversationId || result?._meta?.conversationId || null;
        if (convId && projectId) {
          await invoke('ui_bind_conversation', {
            conv_id: convId,
            project_id: projectId,
            task_id: taskId || null,
            workspace_dir: workspaceDir || '',
          });
        }
        return { started: true, convId };
      } catch (err) {
        return { fallback: 'copy', error: err?.message || String(err) };
      }
    },
    async openFile(absPath) {
      if (!absPath) return { fallback: 'copy' };
      try {
        const uri = toFileUri(absPath);
        await app.request(
          {
            method: 'com.google.antigravity/toggle-aux-pane',
            params: { tabType: 'fileView', uri },
          },
          PASSTHROUGH_SCHEMA
        );
        return { opened: true, uri };
      } catch {
        return { fallback: 'copy' };
      }
    },
    getCapabilities,
    getDefaultWorkspaceDir() {
      return '';
    },
    getWorkspaceDirs() {
      return [];
    },
  };
}
