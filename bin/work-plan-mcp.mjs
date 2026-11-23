#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const RUN_MJS = path.join(ROOT, 'bin', 'run.mjs');
const SIDECAR_MJS = path.join(ROOT, 'sidecars', 'work_plan', 'main.mjs');

const args = process.argv.slice(2);
const first = args[0] || '';

if (first === '-h' || first === '--help' || first === 'help') {
  process.stdout.write(`work-plan-mcp — Local SQLite task DAG, Knowledge & Memory (OKF/Markdown), and live edit guard MCP server

Usage:
  work-plan-mcp [--data-dir <dir>]          Start stdio MCP server (default)
  work-plan-mcp ui [--port 8765]            Start local web UI preview (default http://127.0.0.1:8765)
  work-plan-mcp --version                   Print package version
  work-plan-mcp --help                      Show this help

Environment:
  PLUGIN_DATA   Optional persistent data directory for work_plan.db
`);
  process.exit(0);
}

if (first === '-v' || first === '--version') {
  const { default: fs } = await import('node:fs');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}

let childArgs;
if (first === 'ui' || first === 'sidecar') {
  const rest = args.slice(1);
  if (!rest.includes('--port')) {
    rest.push('--port', '8765');
  }
  childArgs = [SIDECAR_MJS, ...rest];
} else {
  const rest = first === 'mcp' ? args.slice(1) : args;
  childArgs = [RUN_MJS, 'mcp/server.mjs', ...rest];
}

const child = spawn(process.execPath, childArgs, {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
