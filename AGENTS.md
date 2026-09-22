# TianForge pi - Development Notes

## Quick Start

```bash
npm run dev   # port 30141
```

Typecheck: `node_modules/.bin/tsc --noEmit`  
Lint: `npm run lint`  
**Never run `next build` during dev** — pollutes `.next/` and breaks `npm run dev`.

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
  session-snapshot-cache.ts bounded recent-session memory + IndexedDB cache
  session-background-sync.ts reduces background events into cached snapshots
  background-session-event.ts bounds events broadcast to inactive sessions
  git-repositories.ts discovers nested Git repositories within an allowed workspace
  tool-presets.ts     PRESET_NONE/DEFAULT/FULL + getPresetFromTools()
  types.ts            shared TypeScript types
  normalize.ts        normalizeToolCalls() — field name mismatch between file format and our types
  worktree.ts         project/worktree resolution and git worktree operations

components/
  AppShell.tsx        layout + URL state + tab management
  MobileAccessDialog.tsx LAN/Tailscale URL picker, copy action, and QR code
  SessionSidebar.tsx  session tree + FileExplorer
  ChatWindow.tsx      chat composition + completion sound wrapper
  ChatInput.tsx       input bar + model/thinking/tools/compact controls
  MessageView.tsx     renders one message (user/assistant/toolCall/toolResult)
  ProductBrand.tsx    TianForge wordmark with smaller pi foundation mark
  BranchNavigator.tsx in-session branch switcher
  ChatMinimap.tsx     scroll minimap alongside the message list
  MarkdownBody.tsx    markdown renderer
  ModelsConfig.tsx    modal for editing models.json (opened from sidebar bottom)
  PluginsConfig.tsx   modal for installed package plugins
  SkillsConfig.tsx    modal for loaded/search/installable skills
  FileExplorer.tsx    file tree inside sidebar
  FileIcons.tsx       file icon helpers
  FileViewer.tsx      file content in a tab
  TabBar.tsx          tab bar (Chat + open file tabs)

hooks/
  useAgentSession.ts  messages + streaming + SSE + fork/navigate/reconciliation logic
  useAudio.ts         completion sound + browser AudioContext unlock
  useDragDrop.ts      shared drag/drop state
  useIsMobile.ts      responsive breakpoint hook
  useTheme.ts         theme state
```

---

## Key Design Decisions & Traps

### AgentSession lifecycle (`lib/rpc-manager.ts`)
- One `AgentSessionWrapper` per session id, keyed in `globalThis.__piSessions`
- `globalThis` survives Next.js hot-reload; plain module-level Map does not
- Idle timeout: 10 minutes. Concurrent `startRpcSession()` calls share a single start Promise (`globalThis.__piStartLocks`)

### Fork must destroy the wrapper immediately
`AgentSession.fork()` **mutates the wrapper's inner state in-place** — after fork, `inner.sessionId` is the *new* session's id. If the wrapper stays alive in the registry under the old id, the next request gets the already-forked state and subsequent forks produce a corrupt `parentSession` chain.

**Fix**: `send("fork")` captures `newSessionId`, then calls `this.destroy()` before returning. The next request for the original session reloads a clean AgentSession from the original file.

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

### Worktrees and project grouping
- `lib/worktree.ts` resolves linked worktree top-levels back to the main repo `projectRoot`; `listAllSessions()` attaches that to each `SessionInfo` so all worktrees for one repo are grouped together in the sidebar.
- Worktree operations are served by `/api/worktrees` and guarded by the same allowed-root rules as `/api/files`.
- New worktrees are created under `<repoRoot>-worktrees/<sanitized-branch>`. Existing branches are reused; otherwise `git worktree add -b` creates the branch.
- Removing a dirty worktree returns `409` with `{ dirty: true }` so the UI can ask before retrying with `force`.
- Sessions whose cwd points at a removed worktree are inferred back into the main project instead of becoming a phantom project row.

### File access allow-list
- `/api/files` is intentionally not a general filesystem browser. Allowed roots come from session cwds, their resolved project roots, `~/pi-cwd-*`, and roots explicitly added with `allowFileRoot()`.
- Explicit roots are persisted in `~/.pi-web/allowed-roots.json`, not only held in `globalThis`: Next.js route handlers can execute in separate workers, and restored workspaces must remain authorized across workers and server restarts.
- `/api/cwd/validate`, `/api/default-cwd`, and `/api/worktrees` call `allowFileRoot()` when they make a new location browsable.
- Project restoration and rail polling revalidate saved roots before protected File/Git requests. Do not treat a browser-side "authorized" flag as durable proof: the Next.js worker may have restarted.

### Explorer, tabs, and nested repositories
- Explorer hides dotfiles plus generated/dependency directories by default. Its visibility toggle reveals these entries and includes them in non-Git walking search; `.git`, `node_modules`, and macOS `._*` metadata remain bounded/filtered as appropriate.
- File tabs support wheel-to-horizontal scrolling and a context menu for reveal, path copy, lock/unlock, and close-left/right/others/all. Locked tabs survive bulk-close actions and are persisted with the project panel state.
- `GET /api/git/repositories` discovers a root repository and nested repositories under the allowed workspace. `GitReviewPanel` scopes all status/diff/history/write operations to the selected repository and persists that choice per workspace.

### Native terminal runtime
- `node-pty` launches Unix terminals through its packaged `spawn-helper`. Some npm/package extraction paths leave that Mach-O/ELF helper at mode `0644`, which surfaces only as `posix_spawnp failed` even when the configured shell and cwd are valid.
- The package `postinstall` and `getPty()` both call `ensureNodePtySpawnHelper()` to restore execute bits on the exact regular helper file. Keep the runtime check: it repairs existing installations without requiring a reinstall.

### Mobile access links
- The QR button in the top-right opens `MobileAccessDialog`, which loads `/api/access` and lists current LAN/Tailscale addresses without exposing `PI_WEB_PASSWORD`.
- For password-protected servers, authenticated desktop browsers `POST /api/auth/pair` to create a five-minute, single-use bearer token. The QR targets `/pair?token=...`; redemption deletes the token before issuing the normal signed session cookie. Password login remains the fallback.
- `server/pi-web-server.js` passes its actual bind host, port, and protocol to the route through `PI_WEB_RUNTIME_*`; addresses remain visible while a loopback bind is clearly marked as requiring restart.
- `npm run dev:https` regenerates its mkcert certificate when a newly assigned IPv4 address is missing from the SAN list. `next.config.ts` also allows the machine's current interface addresses for development HMR.
- For Android/PWA access over Tailscale, prefer persistent Tailscale Serve: `tailscale serve --bg https+insecure://127.0.0.1:30141`. Direct `100.x` access still presents the local mkcert certificate. Next development origins must use `**.ts.net`; `*.ts.net` does not match `<device>.<tailnet>.ts.net`.
- Next's lazy upgrade listener owns `/_next/webpack-hmr`; TianForge's server listener must return immediately for non-terminal upgrade paths and only own `/api/terminals/:id/stream`. Manually forwarding HMR through `app.getUpgradeHandler()` duplicates the handshake after Next installs its own listener, while suppressing Next's listener prevents hydration entirely.
- Client bundles target Safari/iOS 14 and newer through `package.json#browserslist`. `server/patch-mobile-compat.cjs` replaces the current GFM email-autolink lookbehind during `postinstall`; keep this check because unsupported regex literals prevent older Safari from parsing the entire chunk before React starts.
- `MobileFullscreenPrompt` always exposes the PWA installation path on mobile: Android uses the captured `beforeinstallprompt` event when available, while iOS shows Share → Add to Home Screen instructions. `requestFullscreen()` is a separate optional action when supported, never a replacement for the install prompt.
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
- The model test route is `app/api/models-config/test/route.ts`; `app/api/models/test/` is not a real route.

### Completion sound
- `hooks/useAudio.ts` stores the toggle in `localStorage` as `pi-sound-enabled` and reuses one `AudioContext`.
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
