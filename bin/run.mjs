#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..');

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

function isNodeCompatible() {
  const parts = String(process.versions.node || '0.0.0').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [major, minor] = parts;
  return major > 22 || (major === 22 && minor >= 5);
}

function failOpenHook(forwardedArgs) {
  const mode = forwardedArgs[0] || '';
  if (mode === 'pre-edit' || mode === 'stop') {
    process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
  } else {
    process.stdout.write('{}\n');
  }
  process.exit(0);
}

function findFallbackNode() {
  const candidates = [];
  if (process.env.ANTIGRAVITY_NODE_PATH) {
    candidates.push(process.env.ANTIGRAVITY_NODE_PATH);
  }
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const binNames = process.platform === 'win32' ? ['agy-node.cmd', 'agy-node.exe', 'agy-node'] : ['agy-node'];
  for (const dir of pathDirs) {
    for (const bin of binNames) {
      candidates.push(path.join(dir, bin));
    }
  }
  if (process.platform === 'darwin') {
    candidates.push(path.join(process.env.HOME || '', 'Library/Application Support/Antigravity/bin/agy-node'));
  }
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate) && path.resolve(candidate) !== path.resolve(process.execPath)) {
        return candidate;
      }
    } catch {
      // ignore inaccessible candidate
    }
  }
  return null;
}

async function run() {
  const [, , targetRel, ...forwardedArgs] = process.argv;
  if (!targetRel) {
    process.stderr.write('Usage: node bin/run.mjs <relative-script> [...args]\n');
    process.exit(1);
  }

  const isHook = targetRel.replace(/\\/g, '/').endsWith('hooks/hook.mjs');
  installWarningFilter();

  let sqliteAvailable = isNodeCompatible();
  if (sqliteAvailable) {
    try {
      await import('node:sqlite');
    } catch {
      sqliteAvailable = false;
    }
  }

  if (!sqliteAvailable) {
    if (!process.env.WORK_PLAN_REEXEC) {
      const fallback = findFallbackNode();
      if (fallback) {
        const res = spawnSync(fallback, [__filename, targetRel, ...forwardedArgs], {
          stdio: 'inherit',
          env: { ...process.env, WORK_PLAN_REEXEC: '1' },
        });
        if (res.error) {
          if (isHook) failOpenHook(forwardedArgs);
          process.stderr.write(`work-plan: failed to exec fallback Node (${fallback}): ${res.error.message}\n`);
          process.exit(1);
        }
        process.exit(res.status ?? 0);
      }
    }
    if (isHook) {
      failOpenHook(forwardedArgs);
    }
    process.stderr.write(
      `work-plan: Node.js >= 22.5 (with built-in node:sqlite) is required; found ${process.versions.node}. Please upgrade Node or set ANTIGRAVITY_NODE_PATH.\n`
    );
    process.exit(1);
  }

  const resolvedScript = path.resolve(PLUGIN_ROOT, targetRel);
  const relCheck = path.relative(PLUGIN_ROOT, resolvedScript);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    process.stderr.write(`work-plan: invalid target script outside plugin root: ${targetRel}\n`);
    process.exit(1);
  }

  const mod = await import(pathToFileURL(resolvedScript).href);
  if (typeof mod.main !== 'function') {
    process.stderr.write(`work-plan: module ${targetRel} does not export main(args)\n`);
    process.exit(1);
  }
  await mod.main(forwardedArgs, { pluginRoot: PLUGIN_ROOT });
}

run().catch((err) => {
  const isHook = (process.argv[2] || '').replace(/\\/g, '/').endsWith('hooks/hook.mjs');
  if (isHook) {
    failOpenHook(process.argv.slice(3));
  }
  process.stderr.write(`work-plan launcher error: ${err?.stack || err?.message || String(err)}\n`);
  process.exit(1);
});
