---
name: work-plan
description: Manage multi-day engineering projects across multiple Antigravity chats with a persistent task tree, dependency graph, structured task handoffs, project notes, and automatic live-edit protection. Use when planning multi-step work, starting or resuming a project task, handing off context between sessions, or checking ready/blocked tasks.
---

# Work Plan Workflow

Use **Work Plan** (`work_plan` MCP server) to coordinate multi-day or multi-chat engineering work on a single local SQLite WAL store without heavyweight ceremony.

## 1. Initialize or Inspect a Project

- Check existing projects with `project_list()`, or read the active workspace's project with `project_get()`.
- To start a new project, call `project_create(title, workspace_dir?, source_ref?, seed?)`:
  - Pass a `source_ref` pointing to `PLAN.md`/`SPEC.md`, a local directory, or a GitHub Issue URL to auto-seed tasks.
- To open the interactive task tree, left-to-right SVG dependency graph, and notes board in the UI, call `open_work_plan(project_id?)` and include the one-click sidecar aux pane pill `[Work Plan](sidecar://work-plan/work_plan/)` in your chat response.

## 2. Plan & Structure Tasks

- Use `task_plan(tasks, depends_on?, project_id?, parent_task_id?)` idempotently:
  - Provide concise kebab-case `task_id` slugs (or omit to auto-derive from `title`).
  - Include `brief`, expected `files` (repo-relative paths), `target_tests`, and recursive `children`.
  - Add `[upstream_id, downstream_id]` pairs in `depends_on` to express ordering constraints.
- Parent task statuses automatically roll up from children (`TODO`, `IN_PROGRESS`, `BLOCKED`, `IN_REVIEW`, `DONE`, `CANCELLED`).

## 3. Start a Task & Consume Upstream Handoffs

- Before making edits on a planned task, call `task_start(task_id, project_id?, branch_name?, worktree_path?)`.
- This binds the current conversation to the task, marks it `IN_PROGRESS`, surfaces upstream `handoff_notes`, warns about sibling chats editing overlapping files, and optionally suggests a `git worktree add` command if you want filesystem isolation.
- Note: a lightweight `PreInvocation` hook automatically refreshes your `[WORK PLAN]` brief whenever task state, handoffs, sibling edits, or pinned notes change, and `PreToolUse` + `Stop` hooks automatically guard same-folder file edits across concurrent chats.

## 4. Finish & Hand Off to Downstream Chats

- When wrapping up a task, call `task_update(task_id, status="DONE"|"IN_REVIEW"|"BLOCKED", handoff_notes="...")`.
- Keep `handoff_notes` concise and high-signal for the next chat:
  - Key files changed
  - Exported symbols / schemas / API contracts
  - Test commands run & pass/fail status
  - Caveats or remaining edge cases
- Note: marking a task `IN_REVIEW` with non-empty `handoff_notes` satisfies downstream readiness so the next chat can start immediately.

## 5. Project-Scoped Working Notes

- Use `note_save(title, body_markdown, kind="decision"|"gotcha"|"spec"|"note", task_id?, pinned?)` for durable project context that should live and archive with the project.
- Set `pinned: true` on critical invariants or gotchas (up to 3 pinned notes are surfaced automatically in `[WORK PLAN]` turn briefs).
- Retrieve notes anytime with `note_list(query?, kind?, task_id?)`.

## 6. Project Memory (Cross-Session Context)

- Use `memory_save(title, content, key?, category="architecture"|"convention"|"command"|"constraint"|"pitfall"|"context"|"fact", tags?, file_paths?, inject_mode="always"|"on_demand"|"disabled", confidence?)` to record durable repository truths, test/build commands, and conventions across all future sessions.
- Pass a stable kebab-case `key` so repeated discoveries update the same memory entry idempotently without creating duplicates.
- Use `inject_mode: "always"` for repo-wide truths and `inject_mode: "on_demand"` with `file_paths` for module-specific context (automatically injected by `PreInvocation` when a task touches matching files).
- Retrieve or clean up memories anytime with `memory_list(query?, category?, inject_mode?, confidence?, tag?, file_path?)` and `memory_delete(memory_id? | key?)`.

## Guardrails

- **Never hard-delete projects** from agent turns; cancel individual obsolete tasks (`status: "CANCELLED"`) or leave project deletion to the user in the UI.
- **Keep `handoff_notes` focused** rather than pasting entire files or long logs.
