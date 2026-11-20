import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dbExists, getMeta, normalizePath, openDb, resolveDataDir } from '../core/db.mjs';
import {
  checkAndRecordEdit,
  clearConversationEdits,
  listProjectActiveEdits,
  recordCommittedEdit,
} from '../core/edit_guard.mjs';
import { selectMemoriesForBrief } from '../core/memory.mjs';
import { listNotes } from '../core/notes.mjs';
import {
  bindConversation,
  getBinding,
  getProjectState,
  resolveProjectId,
  resolveTaskByWorktree,
  updateTask,
} from '../core/tasks.mjs';

function defaultAllow(mode) {
  if (mode === 'pre-edit' || mode === 'stop') {
    return { decision: 'allow' };
  }
  return {};
}

function readStdinSync() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function extractTargetFilePath(args) {
  if (!args || typeof args !== 'object') return '';
  const keys = [
    'Path',
    'path',
    'TargetFile',
    'target_file',
    'AbsolutePath',
    'file_path',
    'filePath',
    'notebook_path',
  ];
  for (const k of keys) {
    if (typeof args[k] === 'string' && args[k].trim()) {
      return args[k].trim();
    }
  }
  return '';
}

function parseWorkPlanMcpCall(toolCall) {
  if (!toolCall || typeof toolCall !== 'object') return null;
  const name = String(toolCall.name || '');
  const args = toolCall.args && typeof toolCall.args === 'object' ? toolCall.args : {};

  if (name === 'call_mcp_tool') {
    const serverName = String(args.ServerName || args.serverName || '');
    if (!/work[-_]?plan/i.test(serverName)) return null;
    const mcpTool = String(args.ToolName || args.toolName || '');
    let mcpArgs = args.Arguments ?? args.arguments ?? {};
    if (typeof mcpArgs === 'string') {
      try {
        mcpArgs = JSON.parse(mcpArgs);
      } catch {
        mcpArgs = {};
      }
    }
    return { mcpTool, mcpArgs };
  }

  const eagerMatch = /^mcp_.*work[-_]?plan.*_(task_start|project_create)$/i.exec(name);
  if (eagerMatch) {
    return { mcpTool: eagerMatch[1], mcpArgs: args };
  }
  if (name === 'task_start' || name === 'project_create') {
    return { mcpTool: name, mcpArgs: args };
  }
  return null;
}

function readTail(filePath, maxBytes = 65536) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return '';
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const len = stat.size - start;
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, start);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function handlePreEdit(db, payload) {
  const convId = payload.conversationId;
  const filePath = extractTargetFilePath(payload.toolCall?.args);
  if (!convId || !filePath) return { decision: 'allow' };

  const res = checkAndRecordEdit(db, {
    conv_id: convId,
    file_path: filePath,
    workspace_paths: payload.workspacePaths || [],
    cwd: payload.cwd || '',
    commitOnAllow: true,
  });

  if (res.decision === 'force_ask' || res.decision === 'ask') {
    return { decision: res.decision, reason: res.reason };
  }
  return { decision: 'allow' };
}

function handlePostEdit(db, payload) {
  if (payload.error) return {};
  const convId = payload.conversationId;
  const filePath = extractTargetFilePath(payload.toolCall?.args);
  if (!convId || !filePath) return {};

  recordCommittedEdit(db, {
    conv_id: convId,
    file_path: filePath,
    workspace_paths: payload.workspacePaths || [],
    cwd: payload.cwd || '',
  });
  return {};
}

function handlePostMcp(db, payload) {
  if (payload.error) return {};
  const convId = payload.conversationId;
  if (!convId) return {};

  const parsed = parseWorkPlanMcpCall(payload.toolCall);
  if (!parsed) return {};

  const { mcpTool, mcpArgs } = parsed;
  const wsDir = payload.cwd || payload.workspacePaths?.[0] || '';

  if (mcpTool === 'task_start' && mcpArgs?.task_id) {
    let projectId = null;
    try {
      projectId = resolveProjectId(db, {
        project_id: mcpArgs.project_id,
        conv_id: convId,
        workspace_dir: wsDir,
        workspace_paths: payload.workspacePaths || [],
      });
    } catch {
      const metaRaw = getMeta(db, 'last_started_task');
      if (metaRaw) {
        try {
          const meta = JSON.parse(metaRaw);
          if (
            meta.task_id === mcpArgs.task_id &&
            Date.now() - Date.parse(meta.at || 0) < 30_000
          ) {
            projectId = meta.project_id;
          }
        } catch {
          // ignore
        }
      }
    }
    if (projectId) {
      bindConversation(db, {
        conv_id: convId,
        project_id: projectId,
        task_id: mcpArgs.task_id,
        workspace_dir: wsDir,
      });
    }
  } else if (mcpTool === 'project_create') {
    const metaRaw = getMeta(db, 'last_created_project');
    if (metaRaw) {
      try {
        const meta = JSON.parse(metaRaw);
        if (meta.project_id && Date.now() - Date.parse(meta.at || 0) < 30_000) {
          bindConversation(db, {
            conv_id: convId,
            project_id: meta.project_id,
            task_id: null,
            workspace_dir: wsDir,
          });
        }
      } catch {
        // ignore
      }
    }
  }

  return {};
}

function handlePostCommand(db, payload) {
  if (payload.error) return {};
  const convId = payload.conversationId;
  if (!convId) return {};

  const binding = getBinding(db, convId);
  if (!binding || !binding.task_id) return {};

  const cmd = String(payload.toolCall?.args?.CommandLine || payload.toolCall?.args?.command || '');
  if (!/\b(git\s+(checkout\s+-b|switch\s+-c|push)|gh\s+pr\s+(create|merge))\b/i.test(cmd)) {
    return {};
  }

  const updates = {};
  const cwd = normalizePath(payload.cwd || payload.workspacePaths?.[0] || '');
  if (cwd && fs.existsSync(cwd)) {
    try {
      const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd,
        timeout: 1500,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (branch && branch !== 'HEAD') {
        updates.branch_name = branch;
      }
    } catch {
      // ignore git failures
    }
  }

  if (/\b(gh\s+pr\s+(create|merge)|git\s+push)\b/i.test(cmd) && payload.transcriptPath) {
    const tail = readTail(payload.transcriptPath);
    const prMatches = tail.match(/https:\/\/github\.com\/[^\s"')<>\\]+\/pull\/\d+/g);
    if (prMatches && prMatches.length > 0) {
      updates.pr_url = prMatches[prMatches.length - 1];
    }
  }

  if (Object.keys(updates).length > 0) {
    updateTask(db, binding.project_id, binding.task_id, updates);
  }
  return {};
}

function handlePreInvocation(db, dataDir, payload) {
  const convId = payload.conversationId;
  if (!convId) return {};

  const digestDir = path.join(dataDir, 'digest');
  const safeConv = String(convId).replace(/[^a-zA-Z0-9._-]/g, '_');
  const digestFile = path.join(digestDir, `${safeConv}.sha`);
  const hasPriorDigest = fs.existsSync(digestFile);

  let binding = getBinding(db, convId);
  const candidateDirs = [payload.cwd, ...(payload.workspacePaths || [])].filter(Boolean);

  if (!binding) {
    for (const d of candidateDirs) {
      const wt = resolveTaskByWorktree(db, d);
      if (wt) {
        binding = bindConversation(db, {
          conv_id: convId,
          project_id: wt.project_id,
          task_id: wt.task_id,
          workspace_dir: wt.worktree_path,
        });
        break;
      }
    }
  }

  let projectId = binding?.project_id || null;
  const taskId = binding?.task_id || null;

  if (!projectId) {
    // Unbound chat: only surface lightweight brief on turn 1
    if (hasPriorDigest) return {};
    try {
      projectId = resolveProjectId(db, {
        workspace_dir: payload.cwd || '',
        workspace_paths: payload.workspacePaths || [],
      });
    } catch {
      return {};
    }
  }

  const state = getProjectState(db, projectId, {
    task_id: taskId,
    include_notes: false,
    include_memories: false,
  });
  const lines = [
    `[WORK PLAN]`,
    `Project: ${state.project.title} (${state.project.project_id}) — ${state.project.stats.done}/${state.project.stats.leaf_total} done (${state.project.stats.percent_done}%)`,
  ];

  if (state.focus_task) {
    const t = state.focus_task;
    lines.push(`Bound task: ${t.task_id} — ${t.title} [${t.status}]`);
    if (t.brief) lines.push(`Brief: ${t.brief.slice(0, 600)}`);
    if (t.files?.length > 0) lines.push(`Files: ${t.files.join(', ')}`);
    if (t.target_tests?.length > 0) lines.push(`Tests: ${t.target_tests.join(', ')}`);

    const nonEmptyHandoffs = (state.upstream_handoffs || []).filter((h) => h.handoff_notes?.trim());
    if (nonEmptyHandoffs.length > 0) {
      lines.push('Upstream handoffs:');
      for (const h of nonEmptyHandoffs.slice(0, 5)) {
        lines.push(`- ${h.task_id} (${h.status}): ${h.handoff_notes.slice(0, 400)}`);
      }
    }
  } else {
    const ready = state.tasks.filter((t) => t.is_ready).slice(0, 5);
    if (ready.length > 0) {
      lines.push(`Ready tasks: ${ready.map((r) => `${r.task_id} ("${r.title}")`).join(', ')}`);
    }
  }

  const siblingEdits = (state.active_edits || []).filter((e) => e.conv_id !== convId);
  if (siblingEdits.length > 0) {
    lines.push(
      `Active sibling edits: ${siblingEdits
        .slice(0, 6)
        .map((e) => `${e.file_path} (chat ${e.conv_id.slice(0, 8)})`)
        .join(', ')}`
    );
  }

  const pinnedNotes = listNotes(db, projectId, { task_id: taskId }).filter((n) => n.pinned).slice(0, 3);
  if (pinnedNotes.length > 0) {
    lines.push('Pinned notes:');
    for (const n of pinnedNotes) {
      lines.push(`- [${n.kind}] ${n.title}: ${n.body_markdown.slice(0, 260)}`);
    }
  }

  const memBrief = selectMemoriesForBrief(db, projectId, {
    taskFiles: state.focus_task?.files || [],
  });
  if (memBrief.items.length > 0) {
    lines.push('Project memory:');
    for (const m of memBrief.items) {
      lines.push(`- [${m.category}] ${m.title}: ${m.snippet}`);
    }
  }

  const briefText = lines.join('\n');
  const digest = crypto.createHash('sha256').update(briefText, 'utf8').digest('hex');

  if (hasPriorDigest) {
    try {
      const prev = fs.readFileSync(digestFile, 'utf8').trim();
      if (prev === digest) return {};
    } catch {
      // proceed to update digest
    }
  }

  fs.mkdirSync(digestDir, { recursive: true });
  fs.writeFileSync(digestFile, digest + '\n', 'utf8');

  return {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: briefText,
        },
      },
    ],
  };
}

function handleStop(db, payload) {
  const convId = payload.conversationId;
  const shouldClear =
    payload.fullyIdle === true ||
    payload.terminationReason === 'USER_CANCELED' ||
    payload.terminationReason === 'ERROR';

  if (convId && shouldClear) {
    clearConversationEdits(db, convId);
  }
  return { decision: 'allow' };
}

export async function main(args = []) {
  let mode = '';
  let explicitDataDir = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--data-dir' && i + 1 < args.length) {
      explicitDataDir = args[i + 1];
      i += 1;
    } else if (!mode) {
      mode = args[i];
    }
  }

  let db = null;
  try {
    const dataDir = resolveDataDir(explicitDataDir);
    if (!dbExists(dataDir)) {
      process.stdout.write(JSON.stringify(defaultAllow(mode)) + '\n');
      return;
    }

    const rawStdin = readStdinSync().trim();
    if (!rawStdin) {
      process.stdout.write(JSON.stringify(defaultAllow(mode)) + '\n');
      return;
    }
    const payload = JSON.parse(rawStdin);
    db = openDb(dataDir);

    let out;
    switch (mode) {
      case 'pre-edit':
        out = handlePreEdit(db, payload);
        break;
      case 'post-edit':
        out = handlePostEdit(db, payload);
        break;
      case 'post-mcp':
        out = handlePostMcp(db, payload);
        break;
      case 'post-command':
        out = handlePostCommand(db, payload);
        break;
      case 'pre-invocation':
        out = handlePreInvocation(db, dataDir, payload);
        break;
      case 'stop':
        out = handleStop(db, payload);
        break;
      default:
        out = defaultAllow(mode);
        break;
    }

    process.stdout.write(JSON.stringify(out) + '\n');
  } catch (err) {
    if (process.env.WORK_PLAN_DEBUG === '1') {
      process.stderr.write(`[work-plan hook ${mode}] fail-open: ${err?.message || err}\n`);
    }
    process.stdout.write(JSON.stringify(defaultAllow(mode)) + '\n');
  } finally {
    try {
      db?.close();
    } catch {
      // ignore close error
    }
  }
}
