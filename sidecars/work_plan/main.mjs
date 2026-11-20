import fs from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, resolveDataDir, WorkPlanError } from '../../core/db.mjs';
import { handleToolCall, UI_TOOL_NAMES } from '../../mcp/server.mjs';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function installWarningFilter() {
  const originalEmitWarning = process.emitWarning.bind(process);
  process.emitWarning = (warning, ...args) => {
    const msg = typeof warning === 'string' ? warning : warning?.message || '';
    const type =
      typeof args[0] === 'string'
        ? args[0]
        : typeof args[0] === 'object' && args[0] !== null
          ? args[0].type
          : warning?.name;
    if (type === 'ExperimentalWarning' && /SQLite/i.test(msg)) {
      return;
    }
    return originalEmitWarning(warning, ...args);
  };
}

/**
 * Inject sidecar transport marker and preload script at serve time
 * so ui/app.html on disk remains strictly SEP-1865 CSP-compliant.
 * @param {string} html
 * @returns {string}
 */
export function injectSidecarHead(html) {
  const snippet = '\n  <meta name="wp-transport" content="sidecar">\n  <script src="/preload.js"></script>';
  const src = String(html || '');
  if (/<head(\s[^>]*)?>/i.test(src)) {
    return src.replace(/<head(\s[^>]*)?>/i, (match) => `${match}${snippet}`);
  }
  return `${snippet}\n${src}`;
}

/**
 * Create shared HTML and tool-invocation handlers for both SidecarApp and standalone HTTP server.
 */
export function createSidecarHandlers({ db, pluginRoot = PLUGIN_ROOT }) {
  function renderHtml() {
    const htmlPath = path.join(pluginRoot, 'ui', 'app.html');
    let html;
    try {
      html = fs.readFileSync(htmlPath, 'utf8');
    } catch {
      html =
        '<!doctype html><html><head><meta charset="utf-8"><title>Work Plan</title></head>' +
        '<body><p style="font-family:system-ui,sans-serif;padding:16px;">Work Plan UI bundle not found. Run <code>npm run build:ui</code>.</p></body></html>';
    }
    return injectSidecarHead(html);
  }

  function invokeTool(rawBody) {
    const body = rawBody && typeof rawBody === 'object' ? rawBody : {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const args = body.arguments && typeof body.arguments === 'object' ? body.arguments : {};

    if (!name || !UI_TOOL_NAMES.has(name)) {
      const errPayload = new WorkPlanError(
        'FORBIDDEN_TOOL',
        name ? `Tool "${name}" is not permitted on the sidecar UI endpoint.` : 'Missing required "name" field.'
      ).toPayload();
      return {
        isError: true,
        error: errPayload,
        content: [{ type: 'text', text: JSON.stringify(errPayload, null, 2) }],
        structuredContent: { error: errPayload },
      };
    }

    try {
      return handleToolCall(db, pluginRoot, name, args);
    } catch (err) {
      const wpErr =
        err instanceof WorkPlanError
          ? err
          : new WorkPlanError('INTERNAL_ERROR', err?.message || String(err));
      const payload = wpErr.toPayload();
      return {
        isError: true,
        error: payload,
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        structuredContent: { error: payload },
      };
    }
  }

  return { renderHtml, invokeTool };
}

function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let tooLarge = false;

    req.on('data', (chunk) => {
      if (tooLarge) return;
      total += chunk.length;
      if (total > maxBytes) {
        tooLarge = true;
        const err = new Error('Request body exceeds 2 MiB limit.');
        err.code = 'PAYLOAD_TOO_LARGE';
        reject(err);
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (tooLarge) return;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        const err = new Error('Invalid JSON request body.');
        err.code = 'INVALID_JSON';
        reject(err);
      }
    });

    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

/**
 * Lightweight localhost HTTP server used outside Antigravity and in tests.
 */
export async function startStandaloneServer({ db, pluginRoot = PLUGIN_ROOT, port = 0, token = '' }) {
  const handlers = createSidecarHandlers({ db, pluginRoot });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port || 80}`);

    if (url.pathname === '/') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'Method Not Allowed' });
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(handlers.renderHtml());
      return;
    }

    if (url.pathname === '/preload.js') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'Method Not Allowed' });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end('// Standalone Work Plan preload stub\n');
      return;
    }

    if (url.pathname === '/api/state') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'Method Not Allowed' });
        return;
      }
      const queryArgs = {};
      for (const [k, v] of url.searchParams.entries()) {
        if (k.toLowerCase() === 'token') continue;
        if (k === 'include_archived') {
          queryArgs[k] = v !== 'false' && v !== '0';
        } else {
          queryArgs[k] = v;
        }
      }
      sendJson(res, 200, handlers.invokeTool({ name: 'ui_get_state', arguments: queryArgs }));
      return;
    }

    if (url.pathname === '/api/tool') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'Method Not Allowed' });
        return;
      }
      if (token) {
        const provided = req.headers['x-sidecar-token'] || url.searchParams.get('token');
        if (provided !== token) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
      }
      try {
        const body = await readJsonBody(req);
        sendJson(res, 200, handlers.invokeTool(body));
      } catch (err) {
        if (err?.code === 'PAYLOAD_TOO_LARGE') {
          sendJson(res, 413, {
            isError: true,
            error: { code: 'PAYLOAD_TOO_LARGE', message: err.message },
          });
          return;
        }
        sendJson(res, 400, {
          isError: true,
          error: { code: err?.code || 'BAD_REQUEST', message: err?.message || String(err) },
        });
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;

  return {
    server,
    port: actualPort,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function parseCliArgs(argv) {
  let explicitDataDir = '';
  let port = 0;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--data-dir' && i + 1 < argv.length) {
      explicitDataDir = argv[++i];
    } else if (arg.startsWith('--data-dir=')) {
      explicitDataDir = arg.slice('--data-dir='.length);
    } else if (arg === '--port' && i + 1 < argv.length) {
      port = Number.parseInt(argv[++i], 10) || 0;
    } else if (arg.startsWith('--port=')) {
      port = Number.parseInt(arg.slice('--port='.length), 10) || 0;
    }
  }

  return { explicitDataDir, port };
}

export async function startSidecar(argv = process.argv.slice(2)) {
  installWarningFilter();

  const { explicitDataDir, port } = parseCliArgs(argv);
  const dataDir = resolveDataDir(explicitDataDir);
  const db = openDb(dataDir);
  let shutdownTarget = null;

  const cleanup = async () => {
    try {
      await shutdownTarget?.();
    } catch {
      // ignore close error
    }
    try {
      db.close();
    } catch {
      // ignore close error
    }
    process.exit(0);
  };

  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);

  const hasSidecarEnv = Boolean(
    process.env.ANTIGRAVITY_SIDECAR_WEB_PORT &&
      process.env.ANTIGRAVITY_LS_ADDRESS &&
      process.env.ANTIGRAVITY_CSRF_TOKEN
  );

  if (hasSidecarEnv) {
    try {
      const { SidecarApp, Response } = await import('sidecar_sdk');
      const handlers = createSidecarHandlers({ db, pluginRoot: PLUGIN_ROOT });
      const app = new SidecarApp();
      app.page(
        '/',
        () =>
          new Response(handlers.renderHtml(), {
            contentType: 'text/html; charset=utf-8',
            headers: { 'Cache-Control': 'no-store' },
          })
      );
      app.api('/api/tool', (data) => handlers.invokeTool(data), 'POST');
      app.api(
        '/api/state',
        (data) => handlers.invokeTool({ name: 'ui_get_state', arguments: data || {} }),
        'GET'
      );
      await app.run();
      shutdownTarget = () => app.close();
      return { mode: 'sidecar_sdk', dataDir };
    } catch (err) {
      if (process.env.WORK_PLAN_DEBUG === '1') {
        process.stderr.write(`[work-plan sidecar] sidecar_sdk unavailable, falling back to standalone: ${err?.message || err}\n`);
      }
    }
  }

  const standalonePort = port || Number.parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || '', 10) || 8765;
  const standalone = await startStandaloneServer({
    db,
    pluginRoot: PLUGIN_ROOT,
    port: standalonePort,
    token: process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '',
  });
  shutdownTarget = standalone.close;
  console.log(`[work-plan sidecar] listening on http://127.0.0.1:${standalone.port} (dataDir: ${dataDir})`);
  return { mode: 'standalone', dataDir, ...standalone };
}

const isMain =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startSidecar().catch((err) => {
    process.stderr.write(`[work-plan sidecar] fatal error: ${err?.stack || err?.message || String(err)}\n`);
    process.exit(1);
  });
}
