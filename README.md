# Work Plan (`work-plan`)

A zero-ops, fully local **Antigravity** plugin for a single developer managing multi-day engineering projects across sequential or concurrent chats — with **no backend servers**, **no external databases**, and **no runtime dependencies**.

## Screenshots

### Task Tree & Inspector

![Task Tree and Inspector](assets/screenshots/tasks-inspector.png)

### Interactive Dependency Graph

![Interactive Dependency Graph](assets/screenshots/dependency-graph.png)

### Project Memory

![Project Memory](assets/screenshots/project-memory.png)

### Live Active-Edits Guard

![Live Active-Edits Guard](assets/screenshots/active-edits.png)

## Features

- **Persistent Multi-Session Task Tree & Dependency DAG**: Hierarchical tasks (up to depth 8, 500 tasks/project) with automatic parent status roll-up, cycle/paradox prevention via dual-node Kahn topological validation, and `Ready` vs. `Waiting` filtering.
- **Structured Task-to-Task Handoffs**: Record concise `handoff_notes` when completing a task; downstream chats receive them automatically via `task_start` and SHA-deduped `PreInvocation` turn briefs.
- **Automatic Live-Edit Guard**: Zero-ceremony `PreToolUse` + `PostToolUse` + `Stop` lifecycle hooks prevent silent same-folder overwrites (`force_ask`) across parallel Antigravity chats and warn on shared lockfiles/schemas across Git worktrees (`ask`), clearing locks the instant a turn finishes.
- **Project-Scoped Working Notes**: Store `decision`, `gotcha`, `spec`, and `note` entries alongside the project; pin critical invariants (`pinned: true`) into turn briefs.
- **Project Memory (`Project Memory` tab + automatic `[WORK PLAN]` injection)**: Durable, categorized cross-session knowledge (`architecture`, `convention`, `command`, `constraint`, `pitfall`, `context`, `fact`) with idempotent `key` upserts, `always` / file-matched `on_demand` / `disabled` injection modes, confidence tracking (`confirmed`, `inferred`, `stale`), one-click Markdown export, and agent repo scanning.
- **Interactive Dual-Mode Aux Pane UI (`sidecars/work_plan/` + `ui://work-plan/app.html`)**: Ships both an **Antigravity Sidecar Aux Pane** (`sidecars/work_plan/sidecar.json` → `SIDECAR_UI_ENTRYPOINT_AUX_PANE`) for zero-flag out-of-the-box side pane support and a single-file **SEP-1865 MCP App** (`ui://work-plan/app.html`) sharing the same local SQLite WAL store. Features a responsive master-detail Task Tree + Inspector, interactive left-to-right SVG Dependency Graph, Notes manager, Project Memory tab, Active Edits tab, and one-click **Run in New Chat** / **Run Next Ready**.

## Installation (Antigravity)

Clone or symlink this repository directly into Antigravity's global plugins folder (no `npm install` or build step required for end users because `ui/app.html` is pre-bundled):

```bash
git clone https://github.com/minyaozhu/work-plan.git ~/.gemini/config/plugins/work-plan
# or symlink an existing local checkout:
ln -s /path/to/WorkPlan ~/.gemini/config/plugins/work-plan
```

Once installed:
- Open **Work Plan** from the conversation side pane **`+` menu**, or ask the agent `"Open Work Plan"` to receive a one-click `[Work Plan](sidecar://work-plan/work_plan/)` pill.
- If the plugin was already loaded before adding the sidecar, toggle **work-plan** off and back on in Customizations (or restart Antigravity) to register the aux pane.

## Requirements

- **Node.js `>= 22.5`** (for built-in `node:sqlite` WAL storage), or Antigravity's bundled `agy-node` fallback (`bin/run.mjs` detects and re-execs automatically).
- Optional: `git` (for canonical repo/worktree normalization and branch metadata) and `gh` CLI (for seeding from GitHub issue URLs).

## MCP Tools

- **Agent tools**: `project_list`, `project_create`, `project_get`, `task_plan`, `task_start`, `task_update`, `note_save`, `note_list`, `memory_save`, `memory_list`, `memory_delete`
- **UI entrypoints**: `open_work_plan` (`aux_pane` and `global` MCP App views) + `sidecars/work_plan/` (`SIDECAR_UI_ENTRYPOINT_AUX_PANE` at `/`)
- **App-only UI tools** (`visibility: ["app"]`): `ui_get_state`, `ui_select_project`, `ui_bind_conversation`, `ui_create_project`, `ui_update_project`, `ui_archive_project`, `ui_delete_project`, `ui_create_task`, `ui_update_task`, `ui_move_task`, `ui_delete_task`, `ui_set_dep`, `ui_save_note`, `ui_delete_note`, `ui_save_memory`, `ui_delete_memory`, `ui_clear_active_edit`, `ui_browse_dir`

## Lifecycle Hooks (`hooks.json`)

- `PreToolUse` (`pre-edit`): Fast-exits outside workspace / `os.tmpdir()` / `~/.gemini/`; checks active sibling edits (`force_ask` on same-folder collision, `ask` on cross-worktree shared manifests/schemas).
- `PostToolUse` (`post-edit`, `post-mcp`, `post-command`): Records approved edit locks, binds conversations to tasks after `task_start`/`project_create`, and opportunistically records `branch_name` / `pr_url`.
- `PreInvocation` (`pre-invocation`): Injects SHA-256-deduped `[WORK PLAN]` brief (<40 ms p95).
- `Stop` (`stop`): Immediately clears `ActiveEdits` locks held by the finished conversation.

## Development & Verification

```bash
npm install          # installs devDependencies only (esbuild + @modelcontextprotocol/ext-apps)
npm run build:ui     # bundles ui/src/* -> self-contained ui/app.html
npm run start:sidecar # optional standalone preview at http://127.0.0.1:8765
npm test             # runs core, MCP/hooks E2E, sidecar, and UI test suites
```
