# TianForge pi - Development Notes

## Quick Start

```bash
npm run dev   # port 30141
```

Typecheck: `node_modules/.bin/tsc --noEmit`  
Lint: `npm run lint`  
**Never run `next build` during dev** — pollutes `.next/` and breaks `npm run dev`.

Pi runtime packages (`pi-agent-core`, `pi-ai`, `pi-coding-agent`, `pi-tui`) are pinned together at **0.87.1** in `package.json` and `package-lock.json`. Restart the server after dependency upgrades so existing in-process sessions do not retain the old SDK. This version adds built-in Opus 5.5 support; an intermediary's Claude Code version rejection can still occur independently of the installed Pi version.

---

## Architecture

```
Browser                Next.js Server              AgentSession (in-process)
  │                        │                               │
  ├─ GET /api/sessions ────▶ reads ~/.pi/agent/sessions/   │
  ├─ GET /api/sessions/[id] reads .jsonl file directly     │
  ├─ GET /api/agent/running/events ───▶ running ids + bounded background events
  │                        │                               │
  ├─ send message ─────────▶ POST /api/agent/[id]          │
  │                        │   startRpcSession() ─────────▶│ createAgentSession()
  │                        │   session.send(cmd) ─────────▶│ session.prompt()
  │                        │                               │
  ├─ SSE connect ──────────▶ GET /api/agent/[id]/events    │
  │                        │   session.onEvent() ◀─────────│ session.subscribe()
  │◀── data: {...} ─────────│                               │
```

**Session browsing** (read-only): reads `.jsonl` files through SDK `SessionManager` helpers and `lib/session-reader.ts` — no AgentSession created.  
**Sending a message**: `startRpcSession()` in `lib/rpc-manager.ts` creates an AgentSession in-process.

---

## File Map

```
app/api/
  sessions/route.ts               GET  list all sessions
  sessions/[id]/route.ts          GET/PATCH/DELETE session; GET supports paged context
  sessions/[id]/context/route.ts  GET ?leafId=&limit=&beforeEntryId= — paged branch context
  sessions/[id]/meta/route.ts     GET cheap stat() probe { modified, size }
  sessions/[id]/export/route.ts   GET exported HTML for a session
  agent/new/route.ts              POST { cwd, message, toolNames?, provider?, modelId? }
  agent/[id]/route.ts             GET state | POST any command
  agent/[id]/events/route.ts      GET dedicated SSE stream with coalesced message updates
  agent/running/events/route.ts   GET running ids + bounded background session events
  auth/all-providers/route.ts     GET API-key provider list
  auth/api-key/[provider]/route.ts GET/POST/DELETE provider API key status/storage
  auth/login/[provider]/route.ts  GET OAuth/device-code SSE | POST manual code
  auth/logout/[provider]/route.ts POST OAuth logout
  auth/providers/route.ts         GET OAuth provider list
  cwd/validate/route.ts           POST validate/select a cwd
  default-cwd/route.ts            POST create ~/pi-cwd-YYYYMMDD
  files/[...path]/route.ts        GET file contents for viewer
  access/route.ts                 GET LAN/Tailscale access origins and reachability
  git/repositories/route.ts       GET Git repositories found under a workspace
  home/route.ts                   GET user home directory
  models/route.ts                 GET { models, modelList, defaultModel }
  models-config/route.ts          GET/PUT — read/write ~/.pi/agent/models.json
  models-config/test/route.ts     POST test a configured model/provider
  plugins/route.ts                GET/POST package plugin management
  skills/route.ts                 GET/PATCH loaded skills and disable-model-invocation
  skills/install/route.ts         POST install skills through npx skills add
  skills/search/route.ts          GET/POST skills.sh search
  worktrees/route.ts              GET/POST/DELETE git worktrees

server/
  workspace-status.cjs process-wide bus for terminal/Codex run status; coalesces notify() calls and forwards snapshots to the running-status SSE
  notifications.cjs    activity notification log (~/.pi-web/notifications.json, PI_WEB_NOTIFICATIONS_FILE); each new entry is also sent by web-push.cjs
  web-push.cjs         Web Push to subscribed devices: VAPID key + subscriptions in ~/.pi-web/push.json (0600, PI_WEB_PUSH_FILE; VAPID sub PI_WEB_PUSH_SUBJECT), RFC 8291/8292 with node:crypto + global fetch (no redirects); endpoints limited to the browser push services (no SSRF), drops devices on 404/410; each device keeps its own `events` (approval/failed/completed, default all) and only hears those
  terminal-hook.cjs    run by the Claude Code hooks of a Claude terminal (`working|waiting|approval|idle`); POSTs {token, activity, detail} to /api/terminal-hook (loopback-only, the terminal's own token instead of a login), always exits 0 silently
  terminal-hook-api.cjs  POST /api/terminal-hook: token check via terminal-manager reportHookActivity; this-machine peers only (403)
  web-push-api.cjs     POST /api/push {endpoint?} → {publicKey, subscribed, events}; /api/push/subscribe {subscription, events?}; /api/push/events {endpoint, events}; /api/push/unsubscribe {endpoint}; JSON only, cross-origin rejected even without a password

lib/
  access-links.ts      classifies and formats LAN/Tailscale addresses
  agent-client.ts      typed fetch helper for /api/agent commands
  draft-store.ts       local draft persistence helpers
  file-access.ts       allowed file roots for /api/files and worktrees
  file-paths.ts        client/server path encoding helpers
  markdown.ts          shared markdown helpers
  npx.ts               npx runner used by skill install
  pi-types.ts          local structural types for pi SDK objects
  rpc-manager.ts      AgentSessionWrapper + registry + startRpcSession
  session-reader.ts   SessionManager wrappers + path cache + buildSessionContext adapter
  session-file-cache.ts incremental parsed-entry cache for read-only session loads
  session-snapshot-cache.ts bounded recent-session memory + IndexedDB cache
  session-background-sync.ts reduces background events into cached snapshots
  background-session-event.ts bounds events broadcast to inactive sessions
  git-repositories.ts discovers nested Git repositories within an allowed workspace
  tool-presets.ts     PRESET_NONE/DEFAULT/FULL + getPresetFromTools()
  types.ts            shared TypeScript types
  normalize.ts        normalizeToolCalls() — field name mismatch between file format and our types
  workspace-status-store.ts client store applying pushed terminals/codex_runtimes/claude_runtimes/running snapshots
  rail-activity.ts    project rail activity items (running / ended / recently completed) grouped per workspace
  activity-center.ts  activity center sections (current workspace first), summaries, totals, new-notification diffing
  push-support.ts     whether this browser can use Web Push and why not (insecure origin, iOS Home Screen); VAPID key helpers
  worktree.ts         project/worktree resolution and git worktree operations
  workspace/
    tabs.ts           type definitions for tab kinds
    tab-kinds.ts      registry of tab kinds with slot and parse
    panel-state.ts    pure reducer for panel state
    panel-storage.ts  localStorage persistence with legacy-compatible keys

components/
  AppShell.tsx        layout + URL state + tab management
  ActivityCenter.tsx  "Workspace activity" panel opened by the rail bell and toolbar button (bottom sheet on phones)
  PushNotificationsToggle.tsx "Notify this device" switch: permission, pushManager.subscribe, /api/push*; per-device event checkboxes while on
  MobileAccessDialog.tsx Settings-embedded LAN/Tailscale URL picker, copy action, and QR code
  SessionSidebar.tsx  session tree + FileExplorer
  ChatWindow.tsx      chat composition + completion sound wrapper
  ChatInput.tsx       input bar + model/thinking/tools/compact controls
  MessageView.tsx     renders one message (user/assistant/toolCall/toolResult)
  ProductBrand.tsx    TianForge wordmark with smaller pi foundation mark
  BranchNavigator.tsx in-session branch switcher
  ChatMinimap.tsx     scroll minimap alongside the message list
  MarkdownBody.tsx    markdown renderer
  SettingsPanel.tsx   single settings shell for appearance, models, skills, plugins, and status help
  ProductStatus.tsx   shared semantic status indicator and settings guide
  ModelsConfig.tsx    models.json editor (standalone or embedded in Settings)
  PluginsConfig.tsx   package plugin manager (standalone or embedded in Settings)
  SkillsConfig.tsx    loaded/search/installable skills (standalone or embedded in Settings)
  FileExplorer.tsx    file tree inside sidebar
  FileIcons.tsx       file icon helpers
  FileViewer.tsx      file content in a tab
  TabBar.tsx          shared tab strip for center and right-panel tabs (close/lock/context menu)
  workspace/
    tab-views.tsx     view renderers for each tab kind
    CenterWorkspace.tsx keeps mounted Terminal/Codex tabs alive (Pi tab rendered by AppShell)
    SidePanel.tsx     renders the active right-panel tab or the "No file open" placeholder
    WorkspaceActions.tsx useWorkspaceActions hook for opening tabs
    TopBar.tsx        Pi session top bar (history, auto-name, branches, system prompt, stats)

hooks/
  useAgentSession.ts  messages + streaming + SSE + fork/navigate/reconciliation logic
  useWorkspaceStatus.ts shared EventSource for /api/agent/running/events; feeds workspace-status-store
  useWorkspaceActivity.ts per-workspace activity computed once in AppShell, shared by the rail and the activity center
  useAudio.ts         completion sound + browser AudioContext unlock
  useDragDrop.ts      shared drag/drop state
  useIsMobile.ts      responsive breakpoint hook
  useMobileOverlayHistory.ts mobile back-button history for overlays
  usePanelResize.ts   drag-resizable panel widths + persistence
  useProjectWorkspaces.ts project rail workspace list + active project (localStorage)
  useSessionMeta.ts   top-bar session stats, context usage, copy feedback, auto-name
  useTheme.ts         theme state
```

---

## Key Design Decisions & Traps

### AgentSession lifecycle (`lib/rpc-manager.ts`)
- One `AgentSessionWrapper` per session id, keyed in `globalThis.__piSessions`
- `globalThis` survives Next.js hot-reload; plain module-level Map does not
- Idle timeout: 10 minutes. Concurrent `startRpcSession()` calls share a single start Promise (`globalThis.__piStartLocks`)
- `destroy()` must call the SDK's `inner.dispose()`: it aborts in-flight prompts/bash/compaction and detaches the agent. Without it a destroyed wrapper keeps streaming and appending to its session file, which recreates a file the user just deleted.
- `onDestroy(cb)` supports multiple listeners, returns an unsubscribe function, and fires immediately if the wrapper is already dead. The registry uses it to drop the entry; `/api/agent/[id]/events` uses it to send `{ type: "session_closed" }` and end the SSE stream. The client closes its `EventSource` on that event instead of letting it auto-reconnect (which would immediately restart the idle session); the next prompt reconnects via `ensureEventsConnected`.

### Fork creates the branch from a separate SessionManager
`send("fork")` builds the new session file with a fresh `SessionManager` (`SessionManager.create` or `SessionManager.open(...).createBranchedSession`), so the wrapper's own `inner` session is never mutated. Older code called `AgentSession.fork()`, which mutated `inner` in place and forced an immediate `destroy()`; do not reintroduce it.

After forking, an idle source wrapper is destroyed so the next request reloads it cleanly. A wrapper that is still running is kept alive — destroying it would abort the running prompt — and its idle timer disposes it once the run finishes.

### Two kinds of branching — don't confuse them
- **Fork** (Fork button on user message): creates a new independent `.jsonl` file. Shown as a child in the sidebar tree via `parentSession` header field.
- **In-session branch** (Continue button / BranchNavigator): calls `navigate_tree` within the same file. Multiple entries share the same `parentId`. Switching between them calls `/api/sessions/[id]/context?leafId=`.

### Session files can be fully rewritten
`parentSession` in the header is **display metadata only** — has zero effect on chat content. Safe to `writeFileSync` the entire file (pi does this itself during migrations). Used when cascade-reparenting children on delete.

### ToolCall field normalization
Pi stores toolCall blocks as `{type:"toolCall", id, name, arguments}` but `ToolCallContent` uses `{toolCallId, toolName, input}`. `normalizeToolCalls()` in `lib/normalize.ts` handles this — called in both `session-reader.ts` (file load) and `ChatWindow.handleAgentEvent()` (streaming).

### New session tool preset
Tool names are passed at session creation (`POST /api/agent/new` → `toolNames[]`). For existing sessions, the active preset is inferred on mount via `get_tools` → `getPresetFromTools()`. When tools are fully disabled (`toolNames = []`), `rpc-manager.ts` passes an empty tool allow-list and forces `agent.state.systemPrompt = ""` after startup/reload/resource discovery.

### Model defaults for new sessions
`GET /api/models` returns `defaultModel` read from `~/.pi/agent/settings.json`. `ChatWindow` pre-selects this on mount for new sessions.

### SSE reconnect on page refresh mid-stream
On `ChatWindow` mount, `GET /api/agent/[id]` is called. If `state.isStreaming === true`, SSE is reconnected automatically. `thinkingLevel` and `isCompacting` are also synced from this response.

### Compaction SSE events
Newer pi emits `compaction_start` / `compaction_end`; older versions emitted `auto_compaction_start` / `auto_compaction_end`. `handleAgentEvent` accepts both sets to keep `isCompacting` in sync. Manual compact is a blocking POST — the button stays disabled until the response returns.

### Cross-process session sync (terminal `pi` ↔ TianForge pi)
The same `.jsonl` can be edited by the terminal `pi` while it sits idle in the browser. There is no shared live channel, so:
- **Read**: when the tab regains focus/visibility *and* on a low-frequency poll (`IDLE_SESSION_POLL_MS`, visible + idle only), `useAgentSession` hits `GET /api/sessions/[id]/meta` (a single `stat()`, no parse). Only if `modified` differs from the last-loaded value does it do a full `loadSession` to the current tip. This keeps refreshes flicker-free when nothing changed. `lastLoadedModifiedRef` tracks the loaded mtime; `loadSession` sets it from the `modified` field the detail route already returns.
- **AppShell external refresh**: git panel + file tree + open-file diffs (`explorerRefreshKey`) and the session list (`refreshKey`) are bumped on tab focus and on a 20s visible-only poll, throttled to 1.5s. The file-content viewer already live-syncs via its own `fs.watch` SSE, so it is excluded.
- **Write**: `AgentSessionWrapper` caches `lastKnownMtimeMs` (captured on `start`/`agent_end`/`reload`). Before a `prompt`, `reloadIfChangedExternally()` reloads the in-process session if the on-disk mtime jumped >500ms past our last write — otherwise a stale in-memory tip would fork the tree and make external messages look "lost" in the linear view.
- **Hard limit**: pi session files are single-writer. Simultaneous prompts from both sides can still fork; the guards only cover "edit one side, then switch".

### Failure turns surface as assistant `errorMessage`, not a rejected prompt
Provider/API errors (e.g. a 400) do **not** reject `AgentSession.prompt()`. pi's `handleRunFailure` emits a normal assistant message with empty content, `stopReason: "error"`, and `errorMessage`, then resolves — so `rpc-manager` emits `prompt_done`, never `prompt_error`. The error lives on the message. `MessageView` renders a red "Request failed" banner (via `formatErrorMessage()`), and both the `blocks.length === 0` null-guard and `ChatWindow`'s group/final-answer split are relaxed so an empty-content error message is never folded away.

### Running state SSE + reconciliation
- The sidebar listens to `/api/agent/running/events`, backed by `subscribeRunningSessions()` and `subscribeRpcSessionEvents()` in `lib/rpc-manager.ts`, so running badges and inactive-session snapshots update without polling.
- `useAgentSession` still treats per-session SSE as primary for chat events, but while a run is active it periodically calls `GET /api/agent/[id]` and also reconciles on `visibilitychange`/`online`. This fixes missed `agent_end` events from background tabs or half-open connections.
- Prompt runs use a monotonic run id; late SSE or slow reconciliation responses from an old run must be ignored so they cannot resurrect stale streaming bubbles.
- Pi's `isBashRunning` only covers user `!command` execution, not model tool calls. `AgentSessionWrapper` therefore tracks `tool_execution_start`/`tool_execution_update`/`tool_execution_end` and exposes `activeTools` so reopening a running conversation restores the command, bounded output tail, elapsed time, timeout, and last-output activity instead of showing only a generic tool name. Keep command/output snapshots bounded through `lib/tool-progress.ts`.
- The running SSE also carries `terminals`, `codex_runtimes` and `claude_runtimes` snapshots from `server/workspace-status.cjs`. State owners call `workspaceStatus.notify(kind)` on every change (throttled for output-driven changes). Browsers share one connection via `hooks/useWorkspaceStatus.ts`, which reopens it with backoff (1–30 s) when an HTTP error closes it. Do not add polling for terminal, Codex or Claude Chat run state. `CodexChatPanel` keeps its per-thread SSE primary and, while working, reconciles via `GET /api/codex/chat/<threadId>` once on start, when this thread's pushed `codex_runtimes` state changes (read with `useWorkspaceStatusSelector` so unrelated pushes don't re-render it), on `visibilitychange`/`online`, and on a 15 s fallback — not on a short poll. The Codex session catalog (disk state) keeps a 30 s poll and refreshes once when a terminal or Codex runtime starts, ends, or changes run state — not on output-driven pushes.
- Codex fork (`codex-app-server.cjs` `fork`) runs `thread/fork` in its own short-lived app-server process and waits for it to exit. An app-server stays the writer of every thread it has loaded, forks included, even after `thread/unsubscribe`; forking inside the source's runtime makes the fork's own runtime fail with "already has an active writer". Chat forks always open a new tab; forking from a user message passes the previous turn id as `lastTurnId` (inclusive) and drafts the message in the fork. The panel's `turnOrder` (saved turn ids plus `turn/started`) decides which user message starts which turn, so turns without a user message (compact, review) don't shift it.
- A chat event stream the server refuses (non-200) closes the EventSource without exposing the response. Both chat panels then call `streamFailure` (`lib/agents/stream-failure.ts`): one `fetch` of the same events URL, reading its JSON `error`/`code`, aborting at once if the stream opens. The error banner shows that reason next to "Reconnect". Keep refusals as JSON errors (not an opened-then-ended stream), or the browser retries forever and no reason reaches the user.
- Codex `turn/plan/updated` is not saved in the thread, so the Tasks card only exists while the runtime's event buffer has it; the idle reconcile in `CodexChatPanel` rebuilds items from the saved turns and must keep the todo items it already has (`keepTodos`). Claude task lists come from `TaskCreate`/`TaskUpdate` (Claude Code 2.x) or `TodoWrite` in `lib/agents/claude-conversation.ts`; a `TaskUpdate` for a task created on an unloaded history page is ignored.
- `server/agents/codex-sessions.cjs` runs synchronously inside the one server process, and Codex session files reach hundreds of MB. Never read a whole session file: read only the first line (metadata) or a bounded tail, and reuse the per-file cache keyed on size + mtime. `requireSession` runs on every Codex chat request.
- `server/agents/claude-sessions.cjs` lists Claude Code sessions from `$CLAUDE_CONFIG_DIR` (default `~/.claude`) `/projects/<cwd with non-alphanumerics as "-">/<uuid>.jsonl`. The same rules apply: read the head only up to the first real prompt (max 4 MiB, lines over 1 MiB skipped) and a 256 KiB tail for titles. The tail is cached on size + mtime; a head that found its prompt is kept while the file only grows. Tests get a temp `CLAUDE_CONFIG_DIR` (and notifications file) per test-file process from `server/test-env.cjs` — shared ones made parallel files see each other's notifications; never point them at the real `~/.claude`. Deleting refuses while a `resume` terminal owns the session or any earlier-started Claude terminal in the folder may be writing it (`/clear` and `/resume` switch sessions inside any terminal).
- Claude Chat (`server/agents/claude-chat-runtime.cjs`, `claude-chat-api.cjs`, UI `components/agents/claude/`, item mapping `lib/agents/claude-conversation.ts`) runs one `claude --print` stream-json process per session; see the PRD section "Claude 聊天运行时". Keep these rules:
  - `--permission-prompt-tool stdio` is required, or Claude auto-denies permission prompts. Answers are `control_response` `{behavior:"allow", updatedInput, updatedPermissions?}` / `{behavior:"deny", message}`; `allowSession` passes Claude's `permission_suggestions` as `updatedPermissions`.
  - The process starts on the first send, not on open, and stops 30 s after the last viewer leaves while idle (`idleMs`, tests shorten it). A send whose model or permission mode differs from the process restarts it; compare against `launchModel` (the alias we passed), not `model` (the full name Claude reports), or every send restarts.
  - Only one sender at a time: a send while running, or while a send restarts the process (`starting`, also counted by `isBusy` so idle shutdown waits), is 409 `session_busy`, so the client queues (`canSteer={false}`).
  - Keep the `child.stdin` `error` listener (also in `codex-app-server.cjs`): an EPIPE from a process that just exited is otherwise an uncaught error that takes the server down.
  - The event buffer keeps 2000 events. A client resuming (`after`) from before the dropped ones gets `pi/reset` and reloads the snapshot; so does a client whose known `runtimeId` differs from `pi/connected`. The panel's `running` follows events only, never a successful POST, or it can outlive the turn's `result`.
  - Ownership: a `resume` terminal of the session makes send 409 `terminal_owns_session` (`claim` stops it); creating a `resume` terminal stops an idle chat process and refuses a busy one. Terminals of unknown sessions (`new`/`fork`, `/resume` inside them) and folders reached through symlinks (no realpath) are not detected.
  - Images: the API takes Codex-style data URLs and the runtime writes `image` blocks (base64 `source`) before the text; events sent to browsers carry only `{type:"image"}` so the event buffer and SSE replays never hold image data. Each image is capped at 5,000,000 base64 characters (the API's 5 MB limit): an oversized image saved in a session fails every later `--resume`.
  - Fork: `POST /api/claude/chat` with `fork: {sessionId, at?}` opens the new session with `fork` set; `spawnChild` adds `--resume <source> --fork-session [--resume-session-at <message before prompt at>] --session-id <new>` until the new session file exists. `--session-id` does apply with `--fork-session` (checked on Claude Code 2.1.273), so the new id is known up front. `catalog.forkPoint` resolves `at` to the nearest earlier `user`/`assistant` message (Claude only resumes at a message; `system`/`attachment` entries in between are skipped) and refuses a prompt followed by a `compact_boundary`; it relies on Claude keeping the uuid we send with each prompt. A first process that exits before writing the fork emits `pi/closed` with `code: "fork_failed"`. `GET` reports `session.created` until the file exists, and the panel reloads after the first `result`.
  - `readHistory` in `claude-sessions.cjs` pages the transcript backwards in 512 KiB windows; a window with no whole line widens (up to 32 MiB lines, larger ones skipped). Do not go back to a fixed window: a line longer than the window made it loop forever.
  - Slash commands: `commandsFor(cwd)` probes with `claude --print` + stream-json and no session flags, sending only an `initialize` control request (answers in ~0.2 s, writes no session). Every chat spawn also sends `initialize` before the first user message and emits `pi/commands`. The list drops `__*`, terminal-only commands (`terminal_slash_commands` from `system/init`) and `/clear` with its aliases: `/clear` emits `conversation_reset` and continues under a new session id, so `send` refuses `/clear`, `/reset` and `/new`. Probe processes are killed on server exit; a failed probe answers `[]` and is cached for a minute. `/clear`-like commands we don't know about are caught by `system/init` reporting another `session_id`: the process is stopped with `pi/closed` `code: "session_changed"`.
  - Local commands and compaction: `/context` output arrives as a synthetic `assistant` (random `message.id`) but is saved as `system/local_command` with the same uuid; `compactRecord` (also applied to live records) gives both `message.id = uuid` and `piBlockIndex: 0`, so they are one item. `compactRecord` skips `isSynthetic`/`isCompactSummary` summaries and keeps `compact_boundary`; the runtime turns `system/status` into `{compacting}` and only emits it when that or the permission mode changes (Claude sends a status with every request).
  - Sub-agents: live records carry `parent_tool_use_id` → `parentToolUseId` (no `piBlockIndex`; their `stream_event`s are dropped) and `task_*` system events carry `tool_use_id`. Saved steps live in `<session>/subagents/agent-<agentId>.jsonl`, found through the `toolUseId` in `agent-<agentId>.meta.json` (`catalog.agentTranscript`); forks don't copy that directory. Sub-agent records are one block per record, so `ClaudeAgentSteps` keys them by uuid.
  - Tests use `server/agents/fixtures/fake-claude.cjs` via `configure({command, args})`; never spawn the real `claude` from tests.
- Read-only session loads in request handlers go through `openSessionForRead()` / `readSessionFileEntries()` (`lib/session-file-cache.ts`), not `SessionManager.open()`. The cache keeps parsed entries per file (LRU, 6 files / 128 MB of file data) and parses only appended bytes. The browser reloads the open session after every turn, so a full parse of a long session would block the server each time. The cache falls back to a full parse when a file was replaced, shrunk, or its first/last-read bytes changed. Never append through the returned manager; writes still use `SessionManager.open()`.

### Model Bash watchdog
- Pi's built-in Bash schema accepts an optional timeout but intentionally has no default. TianForge injects the hidden inline extension from `lib/bash-watchdog.ts`, which fills in a 300-second timeout only when the model omitted one.
- The built-in Pi Bash backend remains responsible for aborting and killing the detached process group. Explicit model timeouts win. `TIANFORGE_BASH_TIMEOUT_SECONDS=<seconds>` changes the default; `0` disables the host safeguard.
- Steering remains Pi-native: a steer waits until the current assistant turn finishes its tool calls. The queue UI must explain this and point users to Stop when a tool is stuck.

### Bounded streaming and background session snapshots
- Dedicated `/api/agent/[id]/events` streams coalesce `message_update` frames to at most one every 75ms and keep only the latest pending frame under backpressure. State transitions clear superseded progress frames; completion events remain lossless.
- The app-wide running stream sends only events projected by `projectBackgroundSessionEvent()`. It never broadcasts token-level updates. Completed messages larger than 128 KiB become `session_refresh` hints so a slow browser cannot accumulate unbounded serialized responses.
- `lib/session-snapshot-cache.ts` retains an LRU of 5 desktop or 3 mobile sessions in memory and IndexedDB. Persisted snapshots are trimmed to 160/80 recent messages; reopening always reconciles with live state and disk.
- `SessionSidebar` applies background events even when a project's chat component is unmounted. This keeps running work warm without mounting every conversation and duplicating its full resources.

### Paginated session context
- Session detail/context routes accept `limit` and `beforeEntryId`. Initial loads request 80 messages on desktop and 40 on mobile; scrolling to the top prepends older pages while preserving scroll position.
- `SessionContext.page` carries `{ hasMore, beforeEntryId, totalMessages }`, while `SessionContext.stats` covers the full session so UI totals do not shrink to the rendered page.
- Thinking and media-heavy blocks can stay deferred on paged reads. Do not restore eager full-file context loading in the client; large linear JSONL files previously pushed the dev server past the V8 heap limit.

### Session sidebar views
- The Pi session pane supports a fork tree and a flat recent view. Desktop defaults to the tree; a mobile browser with no saved preference defaults to recent. The choice persists as `pi-web:session-view`.
- Recent view sorts every session by `modified` descending instead of grouping children beneath old roots. Each row shows its direct fork source and known lineage depth; the tooltip carries the original or earliest available ancestor. Missing/deleted parents must remain explicit rather than making the fork look like an original session.
- Resolve lineage against `allSessions`, not only the currently selected project, because a fork can retain a parent outside the filtered set.

### Worktrees and project grouping
- `lib/worktree.ts` resolves linked worktree top-levels back to the main repo `projectRoot`; `listAllSessions()` attaches that to each `SessionInfo` so all worktrees for one repo are grouped together in the sidebar.
- Worktree operations are served by `/api/worktrees` and guarded by the same allowed-root rules as `/api/files`.
- New worktrees are created under `<repoRoot>-worktrees/<sanitized-branch>`. Existing branches are reused; otherwise `git worktree add -b` creates the branch.
- Removing a dirty worktree returns `409` with `{ dirty: true }` so the UI can ask before retrying with `force`.
- Sessions whose cwd points at a removed worktree are inferred back into the main project instead of becoming a phantom project row.
- Git dirtiness is a per-project status, unrelated to agent activity. Expanded project rows and the mobile project menu show `<count> Git changes` only on the affected project. The yellow dot is reserved for the collapsed rail where text cannot fit; never show a global dirty legend that could be mistaken for the active project's state.

### Unified settings and product statuses
- The `TianForge pi` brand in the session sidebar opens the application menu containing global Settings and app/Pi versions. The project rail header also exposes a visible gear shortcut beside search and activity; both entries open the same Settings shell. Project and session/file sidebars have no Settings row because that adds visual weight and implies module-local scope. `SettingsPanel` keeps Appearance, Remote access, Models, Skills, Plugins, and Status & indicators as peer navigation items and renders their content in one persistent shell; do not reintroduce separate footer buttons or nested configuration modals.
- `ModelsConfig`, `SkillsConfig`, and `PluginsConfig` support an `embedded` mode for the settings shell while preserving standalone mode for reuse. Embedded views must fill the settings content area and omit their own backdrop/close controls.
- `lib/product-status.ts` is the authoritative registry for semantic status ids, labels, descriptions, colors, and guide grouping. Tabs, projects, files, sessions, and agent activity use `ProductStatusDot` or values derived from `getProductStatus()` instead of redefining status colors locally.
- Status explanations live under `Settings → Status & indicators`; do not add isolated help/legend buttons to individual modules. Color remains supplemental to visible text, accessible labels, or tooltips.

### File access allow-list
- The allow-list is a UX scope, not an isolation boundary: an authenticated user already has the server user's full access through terminals and agents. Do not rely on it to protect data, and do not add friction (e.g. refusing `/` or `$HOME`) in its name without a matching boundary on terminals and agents.
- `/api/files` is intentionally not a general filesystem browser. Allowed roots come from session cwds, their resolved project roots, `~/pi-cwd-*`, and roots explicitly added with `allowFileRoot()`.
- Explicit roots are persisted in `~/.pi-web/allowed-roots.json`, not only held in `globalThis`: Next.js route handlers can execute in separate workers, and restored workspaces must remain authorized across workers and server restarts.
- Claude/Codex terminals carry `activity` (`working` / `waiting` / `approval`, null when unknown) in the terminal snapshot; see the PRD section "Terminal 活动状态". Claude gets it from hooks passed with `--settings` (never edit the user's `~/.claude` settings); Codex from its OSC 0/2 window title (spinner = working, "Action Required" = approval). Do not use Codex `-c notify=…`: it replaces the user's own `notify` setting. Codex title parsing must survive sequences split across PTY chunks (`titleTail`). Tests use a fake node-pty and fake `claude`/`codex` scripts (`server/agents/terminal-activity.test.cjs`); `claude-sessions.test.cjs` strips the leading `--settings` pair from spawn args. The hook token is in the environment of everything Claude runs, so treat hook detail as untrusted text (it is capped at 300 chars and only affects that terminal). Count "busy" terminals with `terminalIsBusy` (lib/rail-activity.ts), not `state === "running"`, wherever the count means work in progress.
- Terminal/Codex authorization (`server/agents/terminal-api.cjs` `authorizedCwd`) caches the realpath'd granted roots: keyed on the grants file's mtime/size/inode (revocations apply as soon as the file changes) plus a 5 s TTL for the `~/pi-cwd-*` scan and realpath results. A cached miss is rechecked uncached before denying, so fresh grants work immediately. Do not go back to realpathing every root per request — roots on a sleeping external drive stall the whole server.
- `/api/cwd/validate`, `/api/default-cwd`, and `/api/worktrees` call `allowFileRoot()` when they make a new location browsable.
- Project restoration and rail polling revalidate saved roots before protected File/Git requests. Do not treat a browser-side "authorized" flag as durable proof: the Next.js worker may have restarted.

### Explorer, tabs, and nested repositories
- Explorer hides dotfiles plus generated/dependency directories by default. Its visibility toggle reveals these entries and includes them in non-Git walking search; `.git`, `node_modules`, and macOS `._*` metadata remain bounded/filtered as appropriate.
- File tabs support wheel-to-horizontal scrolling and a context menu for reveal, path copy, lock/unlock, and close-left/right/others/all. Locked tabs survive bulk-close actions and are persisted with the project panel state.
- `GET /api/git/repositories` discovers a root repository and nested repositories under the allowed workspace. `GitReviewPanel` scopes all status/diff/history/write operations to the selected repository and persists that choice per workspace.

### Workspace panels and tab kinds
- Center tabs (Pi, Terminal, Codex Chat, terminal split) persist per **cwd**; right-panel tabs (File, Git Review) persist per **project**. State lives in `lib/workspace/panel-state.ts` (pure reducers) and `lib/workspace/panel-storage.ts` (localStorage, legacy-compatible keys/shapes — never change them without a migration).
- To add a tab kind: (a) add its type to `lib/workspace/tabs.ts` and include it in `CenterTab` or `SideTab`; (b) add an entry with `slot` and `parse` in `lib/workspace/tab-kinds.ts`; (c) add a reducer action to open it in `lib/workspace/panel-state.ts` (the side reducer only opens tabs via `openFile`/`openGitReview`; the center `open` action is typed `TerminalTab | CodexChatTab | ClaudeChatTab`, so a new center kind needs its own action or that union widened) plus reducer tests; (d) add a view component in `components/workspace/tab-views.tsx`; (e) add the kind branch in the matching `CenterWorkspace`/`SidePanel` `renderTab` callback in AppShell (and extend `CenterWorkspace`'s `renderTab` parameter type for new center kinds); (f) add an opener on `WorkspaceActions` if other components need to open it; (g) add the icon branch in `components/TabBar.tsx`.
- Components open tabs with `useWorkspaceActions()` (`components/workspace/WorkspaceActions.tsx`) instead of callback props. New entry points (status center, command palette) should use it too.
- An effect that depends on the tabs must dispatch only when something changes. A no-op `update` still schedules a render, and while other tab updates are pending React replays them from the base state into a new `tabs` array, re-running the effect without end ("Maximum update depth exceeded", seen with the terminal "ended" effect in AppShell).

### Native terminal runtime
- `node-pty` launches Unix terminals through its packaged `spawn-helper`. Some npm/package extraction paths leave that Mach-O/ELF helper at mode `0644`, which surfaces only as `posix_spawnp failed` even when the configured shell and cwd are valid.
- The package `postinstall` and `getPty()` both call `ensureNodePtySpawnHelper()` to restore execute bits on the exact regular helper file. Keep the runtime check: it repairs existing installations without requiring a reinstall.

### Mobile access links
- Settings → Remote access embeds `MobileAccessDialog`, which loads `/api/access` and lists current LAN/Tailscale addresses without exposing `PI_WEB_PASSWORD`. Remote access is kept out of the workspace toolbar because it is a low-frequency application setting.
- For password-protected servers, authenticated desktop browsers `POST /api/auth/pair` to create a five-minute, single-use bearer token. The QR targets `/pair?token=...`; redemption deletes the token before issuing the normal signed session cookie. Password login remains the fallback.
- `server/pi-web-server.js` passes its actual bind host, port, and protocol to the route through `PI_WEB_RUNTIME_*`; addresses remain visible while a loopback bind is clearly marked as requiring restart.
- Every HTTP request and WebSocket upgrade must carry an allowed `Host` header, or the server answers `421`. Allowed: loopback names, the bind host, the machine hostname and `<hostname>.local`, any current interface address (snapshotted every 30 s), and `PI_WEB_ALLOWED_HOSTS` (comma-separated, `*.` prefix matches subdomains, default `*.ts.net`). This blocks DNS rebinding, which same-origin checks alone cannot: a rebound page sends matching `Origin` and `Host`.
- Secrets never live in `process.env` after startup, because the agent's bash tool and spawned CLIs inherit it. `server/auth.cjs` moves `PI_WEB_PASSWORD` into `global.__piWebAuthState` and signs sessions with a key derived from it; the internal terminal token lives on `global.__piWebInternalTerminalToken`. Next route handlers run in the same process and read these globals — use `auth.configured()`, never `process.env.PI_WEB_PASSWORD`.
- Request bodies read by the custom server (login, terminal and Codex APIs) go through `server/http-body.cjs`, which stops buffering once the limit is exceeded. Login rate limiting keys on the socket address; `X-Forwarded-For` is client-controlled when the server is exposed directly.
- Session cookies are stateless signed tokens, so logout is recorded in `~/.pi-web/revoked-sessions.json` (override with `PI_WEB_REVOKED_SESSIONS_FILE`) until each token's own expiry, and survives restarts. Only SHA-256 hashes of tokens are stored, with mode `0600`.
- Without a session, only `/_next/static/` is public — not all of `/_next/`, because other Next endpoints such as the image optimizer can fetch protected local routes.
- The server warns at startup when bound to a non-loopback host without TLS, since the password and cookie would cross the network in plain text.
- Session export HTML (`/api/sessions/[id]/export`) is served with `Content-Security-Policy: sandbox allow-scripts …` (no `allow-same-origin`). It renders model output, so its scripts must run in an opaque origin that cannot use the app's cookies or APIs. Workspace files from `/api/files` get the same treatment via `untrustedFileHeaders` (PDFs excepted, because sandboxing disables the built-in viewer).
- `npm run dev:https` regenerates its mkcert certificate when a newly assigned IPv4 address is missing from the SAN list. `next.config.ts` also allows the machine's current interface addresses for development HMR.
- For Android/PWA access over Tailscale, prefer persistent Tailscale Serve: `tailscale serve --bg https+insecure://127.0.0.1:30141`. Direct `100.x` access still presents the local mkcert certificate. Next development origins must use `**.ts.net`; `*.ts.net` does not match `<device>.<tailnet>.ts.net`.
- Next's lazy upgrade listener owns `/_next/webpack-hmr`; TianForge's server listener must return immediately for non-terminal upgrade paths and only own `/api/terminals/:id/stream`. Manually forwarding HMR through `app.getUpgradeHandler()` duplicates the handshake after Next installs its own listener, while suppressing Next's listener prevents hydration entirely.
- Client bundles target Safari/iOS 14 and newer through `package.json#browserslist`. `server/patch-mobile-compat.cjs` replaces the current GFM email-autolink lookbehind during `postinstall`; keep this check because unsupported regex literals prevent older Safari from parsing the entire chunk before React starts.
- `MobileFullscreenPrompt` always exposes the PWA installation path on mobile: Android uses the captured `beforeinstallprompt` event when available, while iOS shows Share → Add to Home Screen instructions. `requestFullscreen()` is a separate optional action when supported, never a replacement for the install prompt.
- `AgentationDevTools` waits for client hydration and stays unmounted for narrow screens, installed PWA display mode, and coarse-pointer touch devices, so its development toolbar and portal overlays cannot cover phone controls. Desktop development keeps Agentation enabled.
- `MobileDevToolsGuard` injects a narrowly scoped style into Next.js's open `nextjs-portal` shadow root under the same phone/PWA/touch conditions. It hides only the floating N/devtools indicator, not Next error dialogs, and removes the style again when returning to a desktop environment.
- The manifest, service worker, and PWA icons are public authentication-layer assets only. Project pages, APIs, sessions, and terminals remain protected.

### Plugins and skills
- `/api/plugins` uses pi's `SettingsManager` + `DefaultPackageManager` for global/project package install, remove, update, enable, and disable. Disabling writes empty `extensions/skills/prompts/themes` arrays for that package entry.
- Long-lived AgentSessions fingerprint global/project Pi settings, npm package locks, and resource directories. Opening the slash palette or sending a slash command reloads changed resources while idle, so packages installed after the web server started become available without restarting active work.
- `/api/skills` uses `DefaultResourceLoader` so settings paths, package skills, and project `.agents/skills` are listed the same way the runtime sees them.
- Skill toggling edits only the `disable-model-invocation` frontmatter key on the target `SKILL.md`; keep that surgical so user formatting survives.
- `/api/skills/install` shells through `npx skills add ... --agent pi`; project installs run with the selected cwd.

### Auth and model config
- `ModelsConfig` combines models from `~/.pi/agent/models.json` with provider auth status from pi's `AuthStorage`/`ModelRegistry`.
- OAuth/device-code/manual-code flows are streamed by `GET /api/auth/login/[provider]`; manual code responses POST back with a short-lived token stored in `globalThis.__piLoginCallbacks`.
- API-key routes store and remove keys through `AuthStorage`. Status endpoints must never return the raw key.
- `GET /api/models-config` returns `models.json` with literal `apiKey` and header values replaced by `REDACTED_SECRET` (`lib/models-config-secrets.ts`). `$ENV` and `!command` references are configuration, not secrets, and stay visible. `PUT` and the model test route restore placeholders from the saved file, so the settings UI can edit and test providers without ever receiving keys. `models.json` is written with mode `0600`.
- The model test route is `app/api/models-config/test/route.ts`; `app/api/models/test/` is not a real route.
- `lib/model-compat.ts` applies Opus 5.5's required adaptive-thinking metadata to custom Anthropic models when testing, saving, listing, loading a session, and switching models. Thinking `off` is unsupported. Model tests explicitly request `low` reasoning with a sufficient output budget; omitting reasoning makes Pi send `thinking.type.disabled`.

### Completion sound
- Settings → Appearance owns the completion-sound preference. `hooks/useAudio.ts` stores it in `localStorage` as `pi-sound-enabled`, synchronizes mounted consumers with a same-tab event, and reuses one `AudioContext` per hook instance.
- Browser autoplay policy means sound must be unlocked from a user gesture; `ChatInput` calls the unlock hook from interactive controls, and `ChatWindow` plays the tone from `onAgentEnd`.

### Exported session HTML
- `/api/sessions/[id]/export` delegates to pi's export helper, then patches recursive tree helpers in the generated HTML to iterative versions so very deep linear sessions do not overflow the browser call stack.

## Pi Session File Format

Location: `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"provider":"zenmux","modelId":"claude-sonnet-4-6","timestamp":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"assistant","content":[...],...}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":N}
{"type":"session_info","id":"...","parentId":"...","name":"user-defined name"}
```

`entryIds[]` in `SessionContext` is a parallel array to `messages[]` — maps each displayed message back to its `.jsonl` entry id, used for fork and navigate_tree calls.

---

## CSS Variables (`app/globals.css`)

```
--bg --bg-panel --bg-hover --bg-selected --border
--text --text-muted --text-dim
--accent --user-bg --tool-bg
--font-mono
```

### Resizable panels
- `AppShell` makes the sidebar and right panel drag-resizable. Widths live in React state and are pushed to the layout root as `--sidebar-w` / `--right-panel-w`; `app/globals.css` reads them via `width: var(--sidebar-w, 260px)` / `var(--right-panel-w, 42vw)` so an unset value keeps the original default.
- Drag handles are `.resize-handle` flex siblings between panels (desktop only). While dragging, the root gets `.layout-resizing` to disable the width transition so it tracks the cursor; final widths persist to `localStorage` (`pi-sidebar-w`, `pi-right-panel-w`).
- The collapsed states still use the `.sidebar-closed` / `.right-panel-closed` classes (explicit `width: 0`), which override the variable, so open/close animations are unaffected.
- The center chat column can also be collapsed (a "focus the panel" mode) with the chevron button in the right-panel header. `chatHidden = chatCollapsed && rightPanelOpen && !isMobile` hides the center (`display:none`) and adds `.right-panel-full` so the panel fills the row; a sidebar-toggle button appears in the panel header while collapsed since the center top bar is hidden. Closing the right panel resets `chatCollapsed`.
- Inside `GitReviewPanel`, the Changes and History views (file list ↔ diff / commit list ↔ detail) and the commit-detail file-list height are also drag-resizable via the `useSplit(storageKey, default, min, max, axis)` hook. It stores each pane size in `localStorage` and reuses the same `.resize-handle` (vertical, `col-resize`) / `.resize-handle--h` (horizontal, `row-resize`) grips.
