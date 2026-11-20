import fs from 'node:fs';
import path from 'node:path';
import { getMeta, openDb, resolveDataDir, setMeta, WorkPlanError } from '../core/db.mjs';
import { clearSpecificEdit } from '../core/edit_guard.mjs';
import {
  deleteMemory,
  listMemories,
  MEMORY_CATEGORIES,
  MEMORY_CONFIDENCES,
  MEMORY_INJECT_MODES,
  MEMORY_SOURCES,
  saveMemory,
} from '../core/memory.mjs';
import { deleteNote, listNotes, saveNote } from '../core/notes.mjs';
import { browseDirectory } from '../core/sources.mjs';
import {
  archiveProject,
  bindConversation,
  createProject,
  deleteProject,
  deleteTask,
  getProjectState,
  listProjects,
  moveTask,
  planTasks,
  resolveProjectId,
  setTaskDep,
  startTask,
  updateProject,
  updateTask,
} from '../core/tasks.mjs';

const UI_URI = 'ui://work-plan/app.html';
const UI_MIME = 'text/html;profile=mcp-app';
const MAX_STRUCTURED_BYTES = 512 * 1024;

function debugLog(...args) {
  if (process.env.WORK_PLAN_DEBUG === '1') {
    process.stderr.write(`[work-plan mcp] ${args.join(' ')}\n`);
  }
}

function writeJsonRpc(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function sendResult(id, result) {
  writeJsonRpc({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message, data) {
  writeJsonRpc({
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  });
}

function enforceSizeBudget(payload) {
  const measure = (obj) => Buffer.byteLength(JSON.stringify(obj), 'utf8');
  if (measure(payload) <= MAX_STRUCTURED_BYTES) return payload;

  const cloned = structuredClone(payload);
  const truncateFields = (stateObj, limit) => {
    if (!stateObj || typeof stateObj !== 'object') return;
    if (Array.isArray(stateObj.tasks)) {
      for (const t of stateObj.tasks) {
        if (typeof t.handoff_notes === 'string' && t.handoff_notes.length > limit) {
          t.handoff_notes = t.handoff_notes.slice(0, limit) + '… [truncated]';
        }
        if (typeof t.brief === 'string' && t.brief.length > limit) {
          t.brief = t.brief.slice(0, limit) + '… [truncated]';
        }
      }
    }
    if (Array.isArray(stateObj.notes)) {
      for (const n of stateObj.notes) {
        if (typeof n.body_markdown === 'string' && n.body_markdown.length > limit) {
          n.body_markdown = n.body_markdown.slice(0, limit) + '… [truncated]';
        }
      }
    }
    if (Array.isArray(stateObj.memories)) {
      for (const m of stateObj.memories) {
        if (typeof m.content === 'string' && m.content.length > limit) {
          m.content = m.content.slice(0, limit) + '… [truncated]';
        }
      }
    }
  };

  for (const limit of [2000, 500, 150]) {
    truncateFields(cloned.state || cloned, limit);
    if (measure(cloned) <= MAX_STRUCTURED_BYTES) return cloned;
  }

  if (cloned.state && Array.isArray(cloned.state.notes)) {
    cloned.state.notes = cloned.state.notes.slice(0, 50);
    cloned.truncated = true;
  }
  if (cloned.state && Array.isArray(cloned.state.memories)) {
    cloned.state.memories = cloned.state.memories.slice(0, 50);
    cloned.truncated = true;
  }
  return cloned;
}

function buildUiSnapshot(db, explicitProjectId = null, includeArchived = true) {
  const projects = listProjects(db, { includeArchived });
  let selectedId = explicitProjectId;

  if (selectedId && !projects.some((p) => p.project_id === selectedId)) {
    selectedId = null;
  }
  if (!selectedId) {
    const metaId = getMeta(db, 'selected_project_id');
    if (metaId && projects.some((p) => p.project_id === metaId && !p.archived_at)) {
      selectedId = metaId;
    }
  }
  if (!selectedId) {
    const firstActive = projects.find((p) => !p.archived_at);
    selectedId = firstActive ? firstActive.project_id : projects[0]?.project_id || null;
  }

  let state = null;
  if (selectedId) {
    setMeta(db, 'selected_project_id', selectedId);
    state = getProjectState(db, selectedId, { include_notes: true, include_memories: true });
  }

  return {
    projects,
    selected_project_id: selectedId,
    state,
  };
}

function summarizeProjectText(state) {
  const { project, tasks, active_edits, notes, memories = [] } = state;
  const ready = tasks.filter((t) => t.is_ready);
  const inProg = tasks.filter((t) => t.status === 'IN_PROGRESS');
  const blocked = tasks.filter((t) => t.status === 'BLOCKED');

  const lines = [
    `# ${project.title} (\`${project.project_id}\`)`,
    `Workspace: ${project.workspace_dir || '(none)'} | Progress: ${project.stats.done}/${project.stats.leaf_total} leaves (${project.stats.percent_done}%) | Ready: ${ready.length} | In Progress: ${inProg.length} | Blocked: ${blocked.length}`,
  ];

  if (ready.length > 0) {
    lines.push('', '## Ready Tasks');
    for (const t of ready.slice(0, 12)) {
      lines.push(`- \`${t.task_id}\`: ${t.title}${t.brief ? ` — ${t.brief.slice(0, 120)}` : ''}`);
    }
  }
  if (inProg.length > 0) {
    lines.push('', '## In Progress');
    for (const t of inProg.slice(0, 12)) {
      lines.push(`- \`${t.task_id}\`: ${t.title}`);
    }
  }
  if (active_edits.length > 0) {
    lines.push('', `## Active Edits (${active_edits.length})`);
    for (const e of active_edits.slice(0, 10)) {
      lines.push(`- \`${e.file_path}\` (chat ${e.conv_id.slice(0, 8)}${e.overlap ? ' ⚠ OVERLAP' : ''})`);
    }
  }
  const pinnedNotes = notes.filter((n) => n.pinned);
  if (pinnedNotes.length > 0) {
    lines.push('', '## Pinned Notes');
    for (const n of pinnedNotes.slice(0, 5)) {
      lines.push(`- [${n.kind}] **${n.title}**: ${n.body_markdown.slice(0, 160)}`);
    }
  }
  const activeMemories = memories.filter((m) => m.inject_mode === 'always' && m.confidence !== 'stale');
  if (activeMemories.length > 0) {
    lines.push('', '## Project Memory');
    for (const m of activeMemories.slice(0, 5)) {
      lines.push(`- [${m.category}] **${m.title}**: ${m.content.slice(0, 160)}`);
    }
  }
  return lines.join('\n');
}

const APP_ONLY_META = {
  ui: {
    resourceUri: UI_URI,
    visibility: ['app'],
  },
};

export const UI_TOOL_NAMES = new Set([
  'open_work_plan',
  'ui_get_state',
  'ui_select_project',
  'ui_bind_conversation',
  'ui_create_project',
  'ui_update_project',
  'ui_archive_project',
  'ui_delete_project',
  'ui_create_task',
  'ui_update_task',
  'ui_move_task',
  'ui_delete_task',
  'ui_set_dep',
  'ui_save_note',
  'ui_delete_note',
  'ui_save_memory',
  'ui_delete_memory',
  'ui_clear_active_edit',
  'ui_browse_dir',
]);

function getToolDefinitions() {
  return [
    // 11 Agent-Facing Tools
    {
      name: 'project_list',
      description: 'List local Work Plan projects with task progress counts, active chats, and workspace folder.',
      inputSchema: {
        type: 'object',
        properties: {
          include_archived: { type: 'boolean', description: 'Include archived projects (default false).' },
        },
      },
    },
    {
      name: 'project_create',
      description:
        'Create a new Work Plan project and optionally seed tasks from a local Markdown plan, folder subdirectories, or GitHub issue URL.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Project title (optional if seeded from Markdown, folder, or GitHub URL).' },
          workspace_dir: { type: 'string', description: 'Local workspace directory path.' },
          source_ref: { type: 'string', description: 'Optional path to PLAN.md/SPEC.md, local folder, or GitHub issue URL.' },
          seed: { type: 'boolean', description: 'Whether to auto-seed tasks from source_ref (default true).' },
        },
      },
    },
    {
      name: 'project_get',
      description:
        'Read the project task tree, ready/waiting status, active sibling chats/files, upstream handoff_notes, and pinned notes.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Optional project ID (auto-resolved when omitted).' },
          task_id: { type: 'string', description: 'Optional focus task ID to include upstream handoff_notes.' },
          include_notes: { type: 'boolean', description: 'Include project notes (default true).' },
        },
      },
    },
    {
      name: 'task_plan',
      description:
        'Idempotently create, update, or reorganize recursive tasks (task_id?, title, brief, files, target_tests, children) and depends_on edges ([upstream, downstream]).',
      inputSchema: {
        type: 'object',
        required: ['tasks'],
        properties: {
          project_id: { type: 'string', description: 'Optional project ID (auto-resolved when omitted).' },
          parent_task_id: { type: 'string', description: 'Optional parent task ID to attach tasks beneath.' },
          tasks: {
            type: 'array',
            description: 'Recursive list of task definitions.',
            items: {
              type: 'object',
              properties: {
                task_id: { type: 'string' },
                title: { type: 'string' },
                brief: { type: 'string' },
                files: { type: 'array', items: { type: 'string' } },
                target_tests: { type: 'array', items: { type: 'string' } },
                status: { type: 'string', enum: ['TODO', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW', 'DONE', 'CANCELLED'] },
                children: { type: 'array', items: { type: 'object' } },
              },
            },
          },
          depends_on: {
            type: 'array',
            description: 'Array of [upstream_id, downstream_id] dependency pairs.',
            items: {
              type: 'array',
              items: { type: 'string' },
              minItems: 2,
              maxItems: 2,
            },
          },
        },
      },
    },
    {
      name: 'task_start',
      description:
        'Start working on a task in this conversation: marks IN_PROGRESS, binds the conversation, and returns brief, upstream handoff_notes, active-file warnings, and optional git worktree command.',
      inputSchema: {
        type: 'object',
        required: ['task_id'],
        properties: {
          task_id: { type: 'string', description: 'Task slug ID to start.' },
          project_id: { type: 'string', description: 'Optional project ID (auto-resolved when omitted).' },
          branch_name: { type: 'string', description: 'Optional git branch name.' },
          worktree_path: { type: 'string', description: 'Optional dedicated git worktree path.' },
        },
      },
    },
    {
      name: 'task_update',
      description:
        'Advance task status (TODO, IN_PROGRESS, BLOCKED, IN_REVIEW, DONE, CANCELLED), attach concise handoff_notes for downstream chats, or record optional branch/PR metadata.',
      inputSchema: {
        type: 'object',
        required: ['task_id'],
        properties: {
          task_id: { type: 'string', description: 'Task slug ID to update.' },
          project_id: { type: 'string', description: 'Optional project ID (auto-resolved when omitted).' },
          status: { type: 'string', enum: ['TODO', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW', 'DONE', 'CANCELLED'] },
          handoff_notes: { type: 'string', description: 'Concise Markdown summary for downstream chats.' },
          files: { type: 'array', items: { type: 'string' } },
          target_tests: { type: 'array', items: { type: 'string' } },
          branch_name: { type: 'string' },
          pr_url: { type: 'string' },
          title: { type: 'string' },
          brief: { type: 'string' },
        },
      },
    },
    {
      name: 'note_save',
      description:
        'Save or update a project-scoped working note (decision, gotcha, spec, or note) persisted across conversations for this project.',
      inputSchema: {
        type: 'object',
        required: ['title', 'body_markdown'],
        properties: {
          project_id: { type: 'string', description: 'Optional project ID (auto-resolved when omitted).' },
          note_id: { type: 'string', description: 'Existing note ID to update.' },
          title: { type: 'string' },
          body_markdown: { type: 'string' },
          kind: { type: 'string', enum: ['decision', 'gotcha', 'spec', 'note'] },
          task_id: { type: 'string', description: 'Optional task ID to scope the note to.' },
          pinned: { type: 'boolean', description: 'Pin important invariants into turn briefs.' },
        },
      },
    },
    {
      name: 'note_list',
      description: 'Search or filter working notes for a project (pinned and task-scoped notes ranked first).',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Optional project ID (auto-resolved when omitted).' },
          query: { type: 'string', description: 'Substring search across note title and body.' },
          kind: { type: 'string', enum: ['decision', 'gotcha', 'spec', 'note'] },
          task_id: { type: 'string', description: 'Prioritize notes scoped to this task or its ancestors.' },
        },
      },
    },
    {
      name: 'memory_save',
      description:
        'Save or idempotently update a durable cross-session project memory (architecture, convention, command, constraint, pitfall, context, or fact).',
      inputSchema: {
        type: 'object',
        required: ['title', 'content'],
        properties: {
          project_id: { type: 'string', description: 'Optional project ID (auto-resolved when omitted).' },
          memory_id: { type: 'string', description: 'Existing memory ID to update.' },
          key: { type: 'string', description: 'Stable kebab-case slug key for idempotent updates.' },
          title: { type: 'string' },
          content: { type: 'string' },
          category: { type: 'string', enum: MEMORY_CATEGORIES },
          tags: { type: 'array', items: { type: 'string' } },
          file_paths: { type: 'array', items: { type: 'string' } },
          inject_mode: { type: 'string', enum: MEMORY_INJECT_MODES },
          confidence: { type: 'string', enum: MEMORY_CONFIDENCES },
        },
      },
    },
    {
      name: 'memory_list',
      description: 'Search or filter durable project memories (always-injected and confirmed entries ranked first).',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Optional project ID (auto-resolved when omitted).' },
          query: { type: 'string' },
          category: { type: 'string', enum: MEMORY_CATEGORIES },
          inject_mode: { type: 'string', enum: MEMORY_INJECT_MODES },
          confidence: { type: 'string', enum: MEMORY_CONFIDENCES },
          tag: { type: 'string' },
          file_path: { type: 'string' },
        },
      },
    },
    {
      name: 'memory_delete',
      description: 'Delete a project memory entry by memory_id or key.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Optional project ID (auto-resolved when omitted).' },
          memory_id: { type: 'string' },
          key: { type: 'string' },
        },
      },
    },

    // MCP App Entrypoint Tool
    {
      name: 'open_work_plan',
      description: 'Open the interactive Work Plan task tree, dependency graph, and notes board.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Optional project ID to focus.' },
        },
      },
      _meta: {
        ui: { resourceUri: UI_URI },
        'com.google.antigravity/ui': {
          entrypoints: [
            { type: 'aux_pane', title: 'Work Plan' },
            { type: 'global', title: 'Work Plan' },
          ],
        },
      },
    },

    // 18 App-Only UI Tools (hidden from model)
    {
      name: 'ui_get_state',
      description: 'App-only: fetch full UI snapshot for projects and active project.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          include_archived: { type: 'boolean' },
        },
      },
      _meta: APP_ONLY_META,
    },
    {
      name: 'ui_select_project',
      description: 'App-only: switch active project in the UI.',
      inputSchema: {
        type: 'object',
        required: ['project_id'],
        properties: { project_id: { type: 'string' } },
      },
      _meta: APP_ONLY_META,
    },
    {
      name: 'ui_bind_conversation',
      description: 'App-only: pre-bind a newly launched conversationId to a task.',
      inputSchema: {
        type: 'object',
        required: ['conv_id', 'project_id'],
        properties: {
          conv_id: { type: 'string' },
          project_id: { type: 'string' },
          task_id: { type: ['string', 'null'] },
          workspace_dir: { type: 'string' },
        },
      },
      _meta: APP_ONLY_META,
    },
    {
      name: 'ui_create_project',
      description: 'App-only: create a new project from the UI modal.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          workspace_dir: { type: 'string' },
          source_ref: { type: 'string' },
          seed: { type: 'boolean' },
        },
      },
      _meta: APP_ONLY_META,
    },
    {
      name: 'ui_update_project',
      description: 'App-only: rename, pin, or update project workspace/source.',
      inputSchema: {
        type: 'object',
        required: ['project_id'],
        properties: {
          project_id: { type: 'string' },
          title: { type: 'string' },
          pinned: { type: 'boolean' },
          workspace_dir: { type: 'string' },
          source_ref: { type: 'string' },
        },
      },
      _meta: APP_ONLY_META,
    },
    {
      name: 'ui_archive_project',
      description: 'App-only: archive or unarchive a project.',
      inputSchema: {
        type: 'object',
        required: ['project_id'],
        properties: {
          project_id: { type: 'string' },
          archived: { type: 'boolean' },
        },
      },
      _meta: APP_ONLY_META,
    },
    {
      name: 'ui_delete_project',
      description: 'App-only: permanently delete a project.',
      inputSchema: {
        type: 'object',
        required: ['project_id'],
        properties: { project_id: { type: 'string' } },
      },
      _meta: APP_ONLY_META,
    },
    {
      name: 'ui_create_task',
      description: 'App-only: create a task or sub-task from the UI.',
      inputSchema: {
        type: 'object',
        required: ['project_id', 'title'],
        properties: {
          project_id: { type: 'string' },
          parent_id: { type: ['string', 'null'] },
          title: { type: 'string' },
          brief: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          target_tests: { type: 'array', items: { type: 'string' } },
        },
      },
      _meta: APP_ONLY_META,
    },
    {
      name: 'ui_update_task',
      description: 'App-only: update task fields, status, manual_status, or handoff_notes.',
      inputSchema: {
        type: 'object',
        required: ['project_id', 'task_id'],
        properties: {
          project_id: { type: 'string' },
          task_id: { type: 'string' },
          title: { type: 'string' },
          brief: { type: 'string' },
          status: { type: 'string' },
          manual_status: { type: 'boolean' },
          handoff_notes: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          target_tests: { type: 'array', items: { type: 'string' } },
          branch_name: { type: ['string', 'null'] },
          pr_url: { type: ['string', 'null'] },
        },
      },
      _meta: APP_ONLY_META,
    },
    {
      name: 'ui_move_task',
      description: 'App-only: reparent or reorder a task.',
      inputSchema: {
        type: 'object',
        required: ['project_id', 'task_id'],
        properties: {
          project_id: { type: 'string' },
          task_id: { type: 'string' },
          new_parent_id: { type: ['string', 'null'] },
          sort_key: { type: 'number' },
        },
      },
      _meta: APP_ONLY_META,
    },
    {
      name: 'ui_delete_task',
      description: 'App-only: delete a task (and optionally its subtree).',
      inputSchema: {
        type: 'object',
        required: ['project_id', 'task_id'],
        properties: {
          project_id: { type: 'string' },
          task_id: { type: 'string' },
          cascade: { type: 'boolean' },
        },
      },
      _meta: APP_ONLY_META,
    },
    {
      name: 'ui_set_dep',
      description: 'App-only: add or remove a dependency edge between tasks.',
      inputSchema: {
        type: 'object',
        required: ['project_id', 'upstream_id', 'downstream_id'],
        properties: {
          project_id: { type: 'string' },
          upstream_id: { type: 'string' },
          downstream_id: { type: 'string' },
          action: { type: 'string', enum: ['add', 'remove'] },
        },
      },
      _meta: APP_ONLY_META,
    },
    {
      name: 'ui_save_note',
      description: 'App-only: create or update a project/task note from the UI.',
      inputSchema: {
        type: 'object',
        required: ['project_id', 'title', 'body_markdown'],
        properties: {
          project_id: { type: 'string' },
          note_id: { type: 'string' },
          title: { type: 'string' },
          body_markdown: { type: 'string' },
          kind: { type: 'string', enum: ['decision', 'gotcha', 'spec', 'note'] },
          task_id: { type: ['string', 'null'] },
          pinned: { type: 'boolean' },
        },
      },
      _meta: APP_ONLY_META,
    },
    {
      name: 'ui_delete_note',
      description: 'App-only: delete a project note.',
      inputSchema: {
        type: 'object',
        required: ['project_id', 'note_id'],
        properties: {
          project_id: { type: 'string' },
          note_id: { type: 'string' },
        },
      },
      _meta: APP_ONLY_META,
    },
    {
      name: 'ui_save_memory',
      description: 'App-only: create or update a project memory entry from the UI.',
      inputSchema: {
        type: 'object',
        required: ['project_id', 'title', 'content'],
        properties: {
          project_id: { type: 'string' },
          memory_id: { type: 'string' },
          key: { type: 'string' },
          title: { type: 'string' },
          content: { type: 'string' },
          category: { type: 'string', enum: MEMORY_CATEGORIES },
          tags: { type: 'array', items: { type: 'string' } },
          file_paths: { type: 'array', items: { type: 'string' } },
          inject_mode: { type: 'string', enum: MEMORY_INJECT_MODES },
          confidence: { type: 'string', enum: MEMORY_CONFIDENCES },
          source: { type: 'string', enum: MEMORY_SOURCES },
        },
      },
      _meta: APP_ONLY_META,
    },
    {
      name: 'ui_delete_memory',
      description: 'App-only: delete a project memory entry from the UI.',
      inputSchema: {
        type: 'object',
        required: ['project_id', 'memory_id'],
        properties: {
          project_id: { type: 'string' },
          memory_id: { type: 'string' },
        },
      },
      _meta: APP_ONLY_META,
    },
    {
      name: 'ui_clear_active_edit',
      description: 'App-only: clear a stale active-edit lock row.',
      inputSchema: {
        type: 'object',
        required: ['conv_id'],
        properties: {
          project_id: { type: 'string' },
          conv_id: { type: 'string' },
          repo_id: { type: 'string' },
          workspace_dir: { type: 'string' },
          file_path: { type: 'string' },
        },
      },
      _meta: APP_ONLY_META,
    },
    {
      name: 'ui_browse_dir',
      description: 'App-only: browse local directories and files for the UI path picker.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          include_files: { type: 'boolean' },
          include_hidden: { type: 'boolean' },
          extensions: { type: 'array', items: { type: 'string' } },
          query: { type: 'string' },
        },
      },
      _meta: APP_ONLY_META,
    },
  ];
}

export function handleToolCall(db, pluginRoot, name, rawArgs) {
  const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};

  switch (name) {
    // Agent tools
    case 'project_list': {
      const projects = listProjects(db, { includeArchived: Boolean(args.include_archived) });
      const text =
        projects.length === 0
          ? 'No Work Plan projects yet. Call `project_create` to start one.'
          : projects
              .map(
                (p) =>
                  `- **${p.title}** (\`${p.project_id}\`): ${p.stats.done}/${p.stats.leaf_total} done (${p.stats.percent_done}%), ${p.stats.ready} ready, ${p.stats.active_chats} active chats${p.workspace_dir ? ` — \`${p.workspace_dir}\`` : ''}`
              )
              .join('\n');
      return {
        content: [{ type: 'text', text }],
        structuredContent: enforceSizeBudget({ projects }),
      };
    }

    case 'project_create': {
      const res = createProject(db, {
        title: args.title || '',
        workspace_dir: args.workspace_dir || '',
        source_ref: args.source_ref || '',
        seed: args.seed !== false,
      });
      const text = `Created project **${res.project.title}** (\`${res.project.project_id}\`) with ${res.seeded_count} seeded task(s).${res.warning ? `\nNote: ${res.warning}` : ''}`;
      return {
        content: [{ type: 'text', text }],
        structuredContent: enforceSizeBudget(res),
      };
    }

    case 'project_get': {
      const projectId = resolveProjectId(db, { project_id: args.project_id });
      const state = getProjectState(db, projectId, {
        task_id: args.task_id || null,
        include_notes: args.include_notes !== false,
      });
      return {
        content: [{ type: 'text', text: summarizeProjectText(state) }],
        structuredContent: enforceSizeBudget(state),
      };
    }

    case 'task_plan': {
      const projectId = resolveProjectId(db, { project_id: args.project_id });
      const res = planTasks(db, projectId, {
        tasks: args.tasks || [],
        depends_on: args.depends_on || [],
        parent_task_id: args.parent_task_id ?? null,
      });
      const text = `Planned ${res.upserted_ids.length} task(s) in \`${projectId}\` (${res.added_deps.length} new dependencies).`;
      return {
        content: [{ type: 'text', text }],
        structuredContent: enforceSizeBudget({ project_id: projectId, ...res }),
      };
    }

    case 'task_start': {
      const projectId = resolveProjectId(db, { project_id: args.project_id });
      const res = startTask(db, projectId, {
        task_id: args.task_id,
        branch_name: args.branch_name,
        worktree_path: args.worktree_path,
      });
      const lines = [
        `Started task **${res.task.title}** (\`${res.task.task_id}\`) in \`${projectId}\`.`,
        res.task.brief ? `Brief: ${res.task.brief}` : '',
      ].filter(Boolean);
      if (res.upstream_handoffs.length > 0) {
        lines.push('', 'Upstream handoffs:');
        for (const h of res.upstream_handoffs) {
          lines.push(`- \`${h.task_id}\` (${h.status}): ${h.handoff_notes || '(no handoff notes)'}`);
        }
      }
      if (res.sibling_active_edits.length > 0) {
        lines.push('', 'Active sibling file edits:');
        for (const e of res.sibling_active_edits) {
          lines.push(`- \`${e.file_path}\` in ${e.workspace_dir} (chat ${e.conv_id.slice(0, 8)})`);
        }
      }
      if (res.suggested_worktree_command) {
        lines.push('', `Optional isolated worktree: \`${res.suggested_worktree_command}\``);
      }
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: enforceSizeBudget(res),
      };
    }

    case 'task_update': {
      const projectId = resolveProjectId(db, { project_id: args.project_id });
      const updated = updateTask(db, projectId, args.task_id, args);
      const text = `Updated task \`${updated.task_id}\` → status **${updated.status}**${updated.handoff_notes ? ' (handoff_notes recorded)' : ''}.`;
      return {
        content: [{ type: 'text', text }],
        structuredContent: enforceSizeBudget({ project_id: projectId, task: updated }),
      };
    }

    case 'note_save': {
      const projectId = resolveProjectId(db, { project_id: args.project_id });
      const note = saveNote(db, projectId, args);
      const text = `Saved ${note.kind} note **${note.title}** (\`${note.note_id}\`)${note.pinned ? ' [pinned]' : ''}.`;
      return {
        content: [{ type: 'text', text }],
        structuredContent: enforceSizeBudget({ note }),
      };
    }

    case 'note_list': {
      const projectId = resolveProjectId(db, { project_id: args.project_id });
      const notes = listNotes(db, projectId, {
        query: args.query || '',
        kind: args.kind || '',
        task_id: args.task_id || null,
      });
      const text =
        notes.length === 0
          ? `No matching notes in \`${projectId}\`.`
          : notes
              .map(
                (n) =>
                  `- [${n.kind}]${n.pinned ? ' [PINNED]' : ''} **${n.title}** (\`${n.note_id}\`${n.task_id ? `, task \`${n.task_id}\`` : ''}): ${n.body_markdown.slice(0, 180)}`
              )
              .join('\n');
      return {
        content: [{ type: 'text', text }],
        structuredContent: enforceSizeBudget({ project_id: projectId, notes }),
      };
    }

    case 'memory_save': {
      const projectId = resolveProjectId(db, { project_id: args.project_id });
      const memory = saveMemory(db, projectId, {
        ...args,
        source: 'agent',
        confidence: args.confidence || 'inferred',
      });
      const text = `Saved ${memory.category} memory **${memory.title}** (\`${memory.memory_id}\`${memory.key ? `, key \`${memory.key}\`` : ''}) [${memory.inject_mode}, ${memory.confidence}].`;
      return {
        content: [{ type: 'text', text }],
        structuredContent: enforceSizeBudget({ project_id: projectId, memory }),
      };
    }

    case 'memory_list': {
      const projectId = resolveProjectId(db, { project_id: args.project_id });
      const memories = listMemories(db, projectId, {
        query: args.query || '',
        category: args.category || '',
        inject_mode: args.inject_mode || '',
        confidence: args.confidence || '',
        tag: args.tag || '',
        file_path: args.file_path || '',
      });
      const text =
        memories.length === 0
          ? `No matching memories in \`${projectId}\`.`
          : memories
              .map(
                (m) =>
                  `- [${m.category} | ${m.inject_mode} | ${m.confidence}] **${m.title}** (\`${m.memory_id}\`${m.key ? `, key \`${m.key}\`` : ''}): ${m.content.slice(0, 180)}`
              )
              .join('\n');
      return {
        content: [{ type: 'text', text }],
        structuredContent: enforceSizeBudget({ project_id: projectId, memories }),
      };
    }

    case 'memory_delete': {
      const target = args.memory_id || args.key;
      if (!target || !String(target).trim()) {
        throw new WorkPlanError('VALIDATION_ERROR', 'Provide memory_id or key to delete a memory.');
      }
      const projectId = resolveProjectId(db, { project_id: args.project_id });
      const deleted = deleteMemory(db, projectId, target);
      const text = deleted
        ? `Deleted memory \`${target}\` from \`${projectId}\`.`
        : `No memory matching \`${target}\` found in \`${projectId}\`.`;
      return {
        content: [{ type: 'text', text }],
        structuredContent: { project_id: projectId, deleted, target: String(target) },
      };
    }

    // Entrypoint + App-only UI tools
    case 'open_work_plan':
    case 'ui_get_state': {
      const snap = buildUiSnapshot(db, args.project_id || null, args.include_archived !== false);
      const text = snap.state
        ? summarizeProjectText(snap.state)
        : 'Work Plan board opened (no projects created yet).';
      return {
        content: [{ type: 'text', text }],
        structuredContent: enforceSizeBudget(snap),
      };
    }

    case 'ui_select_project': {
      const snap = buildUiSnapshot(db, args.project_id, true);
      return {
        content: [{ type: 'text', text: `Selected project ${args.project_id}.` }],
        structuredContent: enforceSizeBudget(snap),
      };
    }

    case 'ui_bind_conversation': {
      const binding = bindConversation(db, {
        conv_id: args.conv_id,
        project_id: args.project_id,
        task_id: args.task_id || null,
        workspace_dir: args.workspace_dir || '',
      });
      const snap = buildUiSnapshot(db, args.project_id, true);
      return {
        content: [{ type: 'text', text: `Bound conversation ${args.conv_id}.` }],
        structuredContent: enforceSizeBudget({ ...snap, binding }),
      };
    }

    case 'ui_create_project': {
      const created = createProject(db, {
        title: args.title || '',
        workspace_dir: args.workspace_dir || '',
        source_ref: args.source_ref || '',
        seed: args.seed !== false,
      });
      const snap = buildUiSnapshot(db, created.project.project_id, true);
      return {
        content: [{ type: 'text', text: `Created project ${created.project.title}.` }],
        structuredContent: enforceSizeBudget({ ...snap, warning: created.warning || null }),
      };
    }

    case 'ui_update_project': {
      updateProject(db, args.project_id, args);
      const snap = buildUiSnapshot(db, args.project_id, true);
      return {
        content: [{ type: 'text', text: `Updated project ${args.project_id}.` }],
        structuredContent: enforceSizeBudget(snap),
      };
    }

    case 'ui_archive_project': {
      archiveProject(db, args.project_id, args.archived !== false);
      const snap = buildUiSnapshot(db, args.project_id, true);
      return {
        content: [{ type: 'text', text: `Updated archive state for ${args.project_id}.` }],
        structuredContent: enforceSizeBudget(snap),
      };
    }

    case 'ui_delete_project': {
      deleteProject(db, args.project_id);
      const snap = buildUiSnapshot(db, null, true);
      return {
        content: [{ type: 'text', text: `Deleted project ${args.project_id}.` }],
        structuredContent: enforceSizeBudget(snap),
      };
    }

    case 'ui_create_task': {
      const res = planTasks(db, args.project_id, {
        parent_task_id: args.parent_id ?? null,
        tasks: [
          {
            title: args.title,
            brief: args.brief || '',
            files: args.files || [],
            target_tests: args.target_tests || [],
          },
        ],
      });
      const snap = buildUiSnapshot(db, args.project_id, true);
      return {
        content: [{ type: 'text', text: `Created task ${res.upserted_ids[0]}.` }],
        structuredContent: enforceSizeBudget({ ...snap, created_task_id: res.upserted_ids[0] }),
      };
    }

    case 'ui_update_task': {
      updateTask(db, args.project_id, args.task_id, args);
      const snap = buildUiSnapshot(db, args.project_id, true);
      return {
        content: [{ type: 'text', text: `Updated task ${args.task_id}.` }],
        structuredContent: enforceSizeBudget(snap),
      };
    }

    case 'ui_move_task': {
      moveTask(db, args.project_id, args.task_id, args);
      const snap = buildUiSnapshot(db, args.project_id, true);
      return {
        content: [{ type: 'text', text: `Moved task ${args.task_id}.` }],
        structuredContent: enforceSizeBudget(snap),
      };
    }

    case 'ui_delete_task': {
      deleteTask(db, args.project_id, args.task_id, { cascade: args.cascade !== false });
      const snap = buildUiSnapshot(db, args.project_id, true);
      return {
        content: [{ type: 'text', text: `Deleted task ${args.task_id}.` }],
        structuredContent: enforceSizeBudget(snap),
      };
    }

    case 'ui_set_dep': {
      setTaskDep(db, args.project_id, {
        upstream_id: args.upstream_id,
        downstream_id: args.downstream_id,
        action: args.action || 'add',
      });
      const snap = buildUiSnapshot(db, args.project_id, true);
      return {
        content: [{ type: 'text', text: `Updated dependency ${args.upstream_id} -> ${args.downstream_id}.` }],
        structuredContent: enforceSizeBudget(snap),
      };
    }

    case 'ui_save_note': {
      saveNote(db, args.project_id, args);
      const snap = buildUiSnapshot(db, args.project_id, true);
      return {
        content: [{ type: 'text', text: `Saved note.` }],
        structuredContent: enforceSizeBudget(snap),
      };
    }

    case 'ui_delete_note': {
      deleteNote(db, args.project_id, args.note_id);
      const snap = buildUiSnapshot(db, args.project_id, true);
      return {
        content: [{ type: 'text', text: `Deleted note ${args.note_id}.` }],
        structuredContent: enforceSizeBudget(snap),
      };
    }

    case 'ui_save_memory': {
      saveMemory(db, args.project_id, {
        ...args,
        source: args.source || 'user',
        confidence: args.confidence || 'confirmed',
      });
      const snap = buildUiSnapshot(db, args.project_id, true);
      return {
        content: [{ type: 'text', text: `Saved project memory.` }],
        structuredContent: enforceSizeBudget(snap),
      };
    }

    case 'ui_delete_memory': {
      deleteMemory(db, args.project_id, args.memory_id);
      const snap = buildUiSnapshot(db, args.project_id, true);
      return {
        content: [{ type: 'text', text: `Deleted project memory ${args.memory_id}.` }],
        structuredContent: enforceSizeBudget(snap),
      };
    }

    case 'ui_clear_active_edit': {
      clearSpecificEdit(db, {
        conv_id: args.conv_id,
        repo_id: args.repo_id ?? null,
        workspace_dir: args.workspace_dir ?? null,
        file_path: args.file_path ?? null,
      });
      const snap = buildUiSnapshot(db, args.project_id || null, true);
      return {
        content: [{ type: 'text', text: `Cleared active edit for ${args.conv_id}.` }],
        structuredContent: enforceSizeBudget(snap),
      };
    }

    case 'ui_browse_dir': {
      const res = browseDirectory({
        dirPath: args.path || '',
        include_files: Boolean(args.include_files),
        include_hidden: Boolean(args.include_hidden),
        extensions: Array.isArray(args.extensions) ? args.extensions : [],
        query: args.query || '',
      });
      return {
        content: [{ type: 'text', text: `Listed ${res.entries.length} entries in ${res.current}.` }],
        structuredContent: enforceSizeBudget(res),
      };
    }

    default:
      throw new WorkPlanError('UNKNOWN_TOOL', `Unknown tool "${name}".`);
  }
}

export async function main(args = [], { pluginRoot } = {}) {
  const rootDir = pluginRoot || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  let explicitDataDir = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--data-dir' && i + 1 < args.length) {
      explicitDataDir = args[i + 1];
      i += 1;
    }
  }
  const dataDir = resolveDataDir(explicitDataDir);
  const db = openDb(dataDir);
  debugLog('started with dataDir =', dataDir);

  let buffer = '';
  process.stdin.setEncoding('utf8');

  const handleMessage = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req;
    try {
      req = JSON.parse(trimmed);
    } catch (err) {
      sendError(null, -32700, `Parse error: ${err.message}`);
      return;
    }

    const { id, method, params } = req;
    if (id === undefined || id === null) {
      // JSON-RPC notification; no reply
      return;
    }

    try {
      switch (method) {
        case 'initialize': {
          const clientVer = params?.protocolVersion || '2025-11-25';
          sendResult(id, {
            protocolVersion: clientVer,
            serverInfo: { name: 'work-plan', version: '0.1.0' },
            capabilities: {
              tools: { listChanged: false },
              resources: { subscribe: false, listChanged: false },
              extensions: {
                'io.modelcontextprotocol/ui': {
                  mimeTypes: [UI_MIME],
                },
              },
            },
          });
          break;
        }

        case 'ping':
          sendResult(id, {});
          break;

        case 'resources/list':
          sendResult(id, {
            resources: [
              {
                uri: UI_URI,
                name: 'Work Plan',
                description: 'Interactive task tree, dependency graph, and notes board',
                mimeType: UI_MIME,
              },
            ],
          });
          break;

        case 'resources/read': {
          const uri = params?.uri;
          if (uri !== UI_URI) {
            sendError(id, -32602, `Unknown resource URI: ${uri}`);
            break;
          }
          const htmlPath = path.join(rootDir, 'ui', 'app.html');
          let html;
          try {
            html = fs.readFileSync(htmlPath, 'utf8');
          } catch {
            html = '<!doctype html><html><body><p>Work Plan UI bundle not found. Run npm run build:ui.</p></body></html>';
          }
          sendResult(id, {
            contents: [
              {
                uri: UI_URI,
                mimeType: UI_MIME,
                text: html,
                _meta: {
                  ui: {
                    csp: {},
                    prefersBorder: false,
                  },
                },
              },
            ],
          });
          break;
        }

        case 'tools/list':
          sendResult(id, { tools: getToolDefinitions() });
          break;

        case 'tools/call': {
          const toolName = params?.name;
          const toolArgs = params?.arguments;
          try {
            const result = handleToolCall(db, rootDir, toolName, toolArgs);
            sendResult(id, result);
          } catch (err) {
            const wpErr =
              err instanceof WorkPlanError
                ? err
                : new WorkPlanError('INTERNAL_ERROR', err?.message || String(err));
            const payload = wpErr.toPayload();
            sendResult(id, {
              isError: true,
              content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
              structuredContent: { error: payload },
            });
          }
          break;
        }

        default:
          sendError(id, -32601, `Method not found: ${method}`);
          break;
      }
    } catch (err) {
      sendError(id, -32603, err?.message || String(err));
    }
  };

  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      handleMessage(line);
    }
  });

  await new Promise((resolve) => {
    process.stdin.on('end', () => {
      if (buffer.trim()) handleMessage(buffer);
      try {
        db.close();
      } catch {
        // ignore close error
      }
      resolve();
    });
  });
}
