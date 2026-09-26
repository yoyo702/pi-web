# Task templates and Claude terminal permission modes

Date: 2026-09-26 · Status: approved in chat, implementing on `feat/task-templates`

## Goal

Save common Claude/Codex terminal launches as named templates and start one in the
current workspace with one click. Claude terminals also gain the Plan and Accept-edits
permission modes (Claude Chat already has them). Batch start, cross-project queues and
prompt variables are out of scope (next batch).

## Template

```json
{
  "id": "uuid",
  "name": "Review changes",          // 1–80 chars; also the terminal title
  "provider": "codex" | "claude",
  "permissionMode": "confirm" | "on-request" | "never" | "bypass" | "plan" | "accept-edits",
  "model": "gpt-5.5" | null,          // same character rules as the terminal API
  "initialPrompt": "..." | null,      // ≤ 8000 chars
  "webSearch": false,                 // Codex only; always false for Claude
  "cwd": "/abs/path" | null,          // null = every workspace; else only that folder
  "createdAt": "ISO", "updatedAt": "ISO"
}
```

Permission modes per provider: Codex `confirm | on-request | never | bypass`;
Claude `confirm | plan | accept-edits | bypass`.

## Server

- `server/task-templates.cjs` — store in `~/.pi-web/task-templates.json`
  (`PI_WEB_TASK_TEMPLATES_FILE` overrides; tests always set it). Mode 0600, written to a
  temp file then renamed. At most 100 templates. `list(cwd?)` returns templates for every
  workspace plus those whose `cwd` is `cwd` (compared after `realpath`), sorted by name.
  `create(input)`, `update(id, input)`, `remove(id)` validate with one `normalize()`.
- `server/task-templates-api.cjs`, routed after the login check like
  `notifications-api.cjs`; mutations reject cross-origin requests.
  - `GET /api/task-templates?cwd=` → `{templates}`
  - `POST /api/task-templates` → 201 `{template}`
  - `PUT /api/task-templates/:id` → `{template}`; `DELETE` → 204
  - 400 invalid input (`{error}`), 404 unknown id, 409 limit reached, 405 other methods.
- Running a template uses the existing `POST /api/terminals` with the template's fields
  plus `title`. The terminal API now passes `title` through to `createTerminal`.
- Claude terminals: `plan` → `--permission-mode plan`, `accept-edits` →
  `--permission-mode acceptEdits`; `--model <model>` and the initial prompt as the last
  argument (after `--` when it starts with "-"), same rules as Codex. Resume/fork also
  accept the new modes.

## UI (Agents panel)

- A "Templates" row above the provider rows, collapsed by default, with the count. Each
  template: provider badge, name, permission/model summary, "Run", and a ⋯ menu with
  Edit / Delete (delete asks to confirm).
- "New template" opens `TaskTemplateDialog` (name, provider, permissions, model, initial
  prompt, web search for Codex, "Available in": this workspace / all workspaces).
  The New agent dialog gets "Save as template…", which opens the same dialog prefilled.
- Run starts the terminal in the panel's `cwd` and opens it. A bypass template asks for
  confirmation on every run. Errors show inline in the Templates list.
- The list reloads when the panel mounts, when `cwd` changes and after each change.
- Claude permission choices everywhere Claude terminals start (New agent dialog, Claude
  resume/fork dialog): Keep CLI confirmations, Plan (read-only until you approve),
  Accept edits (still confirms commands), Dangerous bypass.

## Tests

- Store and API unit tests with temp files (validation per provider, scope filter, limit,
  404/400/405/409, cross-origin rejection).
- Terminal manager: Claude args for plan / accept-edits / model / prompt with a fake spawn.
- Playwright on 30142: create a template, run it, the terminal tab opens (fake CLI on PATH).

## Docs

PRD `docs/prd/agent-workspace.md` (new "任务模板" section, Claude permission modes, follow-up
list) and AGENTS.md (file map, storage file, test env var).
