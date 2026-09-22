# TianForge pi

[中文文档](./README.zh-CN.md) | [日本語](./README.ja.md)

TianForge is a local development workspace built on the [pi coding agent](https://github.com/badlogic/pi-mono); the smaller `pi` in the product wordmark identifies that foundation. It reads local pi session files and brings multi-project sessions, live chat, agent terminals, Git review, and project files into one browser workspace.

![TianForge pi shows the same pi session with structured Markdown, tool calls, and project navigation beside the CLI](https://raw.githubusercontent.com/agegr/pi-web/main/docs/screenshot2.png)

The same pi session in the CLI and TianForge pi: structured tool calls, readable Markdown, session browsing, and cleaner results.

## Quick Start

TianForge pi requires Node.js 22.19.0 or newer. Check your version with `node --version`.

**Run without installing:**

```bash
npx @agegr/pi-web@latest
```

**Or install globally:**

```bash
npm install -g @agegr/pi-web
pi-web
```

Then open [http://127.0.0.1:30141](http://127.0.0.1:30141). The CLI will try to open the browser automatically after the server is ready. TianForge pi listens on `127.0.0.1` by default.

**Options:**

```bash
pi-web --port 8080              # custom port
pi-web --hostname 0.0.0.0       # expose on a trusted network
pi-web -p 8080 -H 0.0.0.0       # combine options
pi-web --no-open                # do not open the browser automatically

PORT=8080 pi-web                # environment variable is also supported
PI_WEB_HOSTNAME=0.0.0.0 pi-web  # explicit network exposure
PI_WEB_NO_OPEN=1 pi-web         # useful when running as a background service
```

TianForge pi can be password protected with `PI_WEB_PASSWORD`. Password authentication is required for any non-loopback binding, and it protects the entire app (chat, files, Git, settings, and terminals):

```bash
PI_WEB_PASSWORD='use-a-strong-password' pi-web --hostname 0.0.0.0
```

A signed-in browser has the same local privileges as the TianForge pi server user. Do not expose it directly to the internet; use HTTPS and a trusted network.

## HTTP Proxy

TianForge pi reads the standard `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` environment variables for server-side model and API requests.

On macOS or Linux:

```bash
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
npx @agegr/pi-web@latest
```

On Windows PowerShell:

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:7890"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:NO_PROXY = "localhost,127.0.0.1"
npx @agegr/pi-web@latest
```

## Features

- **Work across projects in parallel**: each project keeps its own session, file tabs, and agents. Switching projects does not stop background work, and completion events continue to update its snapshot.
- **Switch long conversations quickly**: recent sessions are cached in memory and IndexedDB, restored immediately, and reconciled with disk. Older messages load in pages instead of all at once.
- **Pick work back up**: browse previous pi conversations by project without digging through terminal history or session paths.
- **Try different directions safely**: continue from an earlier message or fork a session into a separate route.
- **Work across branches**: switch Git worktrees from the sidebar so new sessions and the Explorer follow the checkout you choose.
- **Chat beside the project**: browse files on the left and preview source, docs, images, audio, and PDFs on the right. File tabs support wheel scrolling, locking, bulk close actions, path copying, and reveal in Explorer.
- **Reveal generated files on demand**: Explorer hides `.git`, `node_modules`, `dist`, and similar generated content by default, with a toolbar toggle to reveal it. macOS `._*` metadata remains filtered.
- **Review multiple repositories**: Git Review discovers nested repositories inside a workspace and remembers the selected repository.
- **See session state clearly**: context usage, cost, compaction state, and system prompt details are visible from the top bar.
- **Interactive AI CLI terminals**: launch and reconnect to local Codex or Claude terminals from the right panel. Pi can inspect, send text to, or stop them only when you explicitly ask.
- **Configure less from the terminal**: manage models, login/API keys, model tests, and skill switches from the web UI.

## Notes

- **Data directory**: TianForge pi reads `~/.pi/agent/sessions` by default. Set `PI_CODING_AGENT_DIR` to point at another pi agent directory.
- **Session files**: files are stored as `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`.
- **Model config**: the Models panel reads and writes `models.json` in the pi agent directory. Model lists and defaults come from pi's config.
- **Bash watchdog**: model-initiated Bash calls default to a 300-second timeout so a stalled child process cannot block the session and its steer queue forever. Set `TIANFORGE_BASH_TIMEOUT_SECONDS` to another positive number, or `0` to restore pi's unlimited behavior. A timeout explicitly supplied by the model takes precedence.
- **File access**: file browsing and preview are scoped to the selected project directory and working directories that appear in sessions. Explicit roots persist in `~/.pi-web/allowed-roots.json`, including across server restarts.
- **Git worktrees**: see [Worktrees in TianForge pi](./docs/worktrees.md) for when the switcher appears, how new worktrees are created, and what removal does.
- **Forks vs in-session branches**: Fork creates a new `.jsonl` file. "Edit from here" creates another branch inside the same session file.
- **Staying in sync**: TianForge pi and the terminal `pi` share the same session files. See [Staying in Sync](./docs/sync.md) for background updates, browser caching, pagination, and the concurrent-write boundary.

## Development

```bash
npm install
npm run dev
```

The default dev server runs over HTTP at [http://127.0.0.1:30141](http://127.0.0.1:30141). It is loopback-only and requires no password, certificate, or `mkcert`. For HTTPS access from another device on your LAN, run `npm run dev:https` explicitly.

Mobile browser bundles target Safari/iOS 14 and newer. The install step also applies a compatibility-safe GFM autolink expression so an older Safari engine can parse the initial JavaScript bundle.

Use the QR button in the top-right to choose a current LAN or Tailscale address, copy its access link, or scan it from a phone. When password protection is enabled, an already signed-in browser puts a five-minute, single-use pairing token in the QR code so the phone can sign in without typing the server password. The password itself is never included. The dialog reports when the server is still loopback-only; restart with `npm run dev:https` to make those addresses reachable.

For durable access through Tailscale, prefer Tailscale Serve so the phone receives a browser-trusted `*.ts.net` certificate instead of the local `mkcert` certificate. Keep `npm run dev:https` running and configure the proxy once:

```bash
tailscale serve --bg https+insecure://127.0.0.1:30141
tailscale serve status
```

Open the `https://<device>.<tailnet>.ts.net/` URL printed by `serve status`. The `--bg` configuration persists across Tailscale and machine restarts; only the TianForge server still needs to be running. Development mode allows `**.ts.net` origins so the Next.js HMR WebSocket works through the two-label tailnet hostname. Direct access to `https://100.x.y.z:30141` still presents the local `mkcert` certificate and requires installing that CA on the phone.

On mobile, TianForge always shows how to install the PWA: Android uses the browser install prompt when available, while iOS shows Share → Add to Home Screen instructions. A separate one-tap full-screen action is also shown when the browser supports the Fullscreen API. Launching the installed app removes the browser address bar.

Development mode targets a maximum of 1536 MB for Turbopack's in-memory cache so a server kept alive through days of hot reloads does not exhaust Node's heap. Set `PI_WEB_TURBOPACK_MEMORY_MB` before startup to tune it (minimum 512), for example `PI_WEB_TURBOPACK_MEMORY_MB=2048 npm run dev`. Restart the development server after changing it.

Interactive terminals use the native `node-pty` module. TianForge pi verifies the executable permission of its `spawn-helper` after installation and repairs it again at runtime. If your package manager blocks native dependency installation entirely, approve the install script or run `npm exec -- node-gyp rebuild --directory=node_modules/node-pty` with a working native build toolchain.

Common checks:

```bash
node_modules/.bin/tsc --noEmit
npm run lint
```

Avoid running `next build` / `npm run build` during local development. It writes to `.next/` and can interfere with the dev server; leave builds for release work.

## Project Structure

```text
app/
  api/
    agent/          # creates/drives AgentSession and exposes SSE events
    auth/           # OAuth and API key management
    cwd/browse/     # browsable server directory listing
    cwd/validate/   # custom working directory validation
    default-cwd/    # pi default working directory lookup
    files/          # file listing, reading, preview, and watching
    git/            # Git status, diffs, history, and nested repository discovery
    home/           # current user home directory
    models/         # available models, default model, thinking levels
    models-config/  # read/write models.json and test models
    sessions/       # session reads, rename, delete, context, HTML export
    skills/         # skill listing, search, install, enable/disable
components/
  AppShell.tsx        # main layout, URL state, top panels, file tabs
  ProductBrand.tsx    # TianForge wordmark with the smaller pi foundation mark
  SessionSidebar.tsx  # project selector, session tree, Explorer
  DirectoryPicker.tsx # browsable and editable working-directory picker
  ChatWindow.tsx      # messages, SSE, image drag/drop, minimap
  ChatInput.tsx       # input bar, model/tools/thinking/compact/slash controls
  MessageView.tsx     # message, thinking, tool call/result rendering
  ModelsConfig.tsx    # model and auth configuration panel
  SkillsConfig.tsx    # skill management panel
  FileExplorer.tsx    # file tree
  FileViewer.tsx      # source, diff, image, audio, PDF, DOCX preview
lib/
  directory-browser.ts # directory normalization and safe listing helpers
  http-dispatcher.ts  # HTTP(S) proxy setup for server-side fetch
  rpc-manager.ts      # AgentSessionWrapper lifecycle and global registry
  session-reader.ts   # parses .jsonl session files and branch contexts
  session-snapshot-cache.ts # recent-session memory/IndexedDB snapshots
  session-background-sync.ts # background event reduction and cache updates
  git-repositories.ts # discovers Git repositories inside a workspace
  normalize.ts        # normalizes toolCall field names
  file-access.ts      # file read safety boundary
  file-paths.ts       # path encoding and relative path helpers
  markdown.ts         # Markdown/Mermaid/KaTeX plugin configuration
  pi-types.ts         # pi-related types
hooks/
  useAgentSession.ts  # session loading, command sending, SSE state machine
  useAudio.ts         # completion sound
  useDragDrop.ts      # image drag/drop
  useTheme.ts         # theme switching
bin/
  pi-web.js           # npm CLI entrypoint
instrumentation.ts    # initializes the server HTTP dispatcher
```
