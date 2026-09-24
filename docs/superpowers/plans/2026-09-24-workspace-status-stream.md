# Workspace Status Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push terminal and Codex runtime status over the existing `/api/agent/running/events` SSE and replace the 5 s polls in ProjectRail and useWorkspaceTerminals with one shared connection.

**Architecture:** A `global`-backed status bus (`server/workspace-status.cjs`) lets the terminal and Codex modules register snapshot providers and signal changes; the SSE route forwards coalesced snapshots. In the browser, a framework-free store (`lib/workspace-status-store.ts`) holds the latest snapshots, and `hooks/useWorkspaceStatus.ts` owns the single shared `EventSource`.

**Tech Stack:** Node custom server (CJS), Next.js 16 route handlers, React 19 (`useSyncExternalStore`), `node --test` (+ `jiti` for TS), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-24-workspace-status-stream-design.md`

## Global Constraints

- One status SSE connection per tab; do not add new SSE endpoints.
- Existing `running` and `session_event` messages keep their exact shape and behavior.
- State changes publish within ~100 ms (`COALESCE_MS = 100`); output-driven terminal changes (buffer size, command history) at most every 5 s (`THROTTLE_MS = 5000`); identical snapshots are not re-sent.
- Codex session catalog (`/api/codex/sessions`) keeps polling, slowed to 30 s, plus an immediate (debounced) refresh when terminals or Codex runtimes change.
- The ProjectRail 20 s Git status poll and terminal output WebSockets are out of scope.
- No new dependencies. Every task ends green on `npx tsc --noEmit -p .`, `npx eslint <touched files>`, `npm test`; UI tasks also `npx playwright test`.

## Facts the implementer needs

- The custom server (`server/pi-web-server.js`) and Next route handlers run in one Node process. Next may load its own copy of a `server/*.cjs` module (e.g. `lib/agents/terminal.ts` requires `terminal-manager.cjs`), so shared state must live on `global`. Terminal state is already `global.__piWebTerminalState`; Codex's `sessions` Map in `codex-app-server.cjs` is module-local and only loaded by the custom server — hence providers register themselves on the global bus.
- `GET /api/terminals?cwd=` canonicalizes `cwd` (`authorizedCwd` → realpath), so terminals carry canonical paths (e.g. `/private/tmp` for `/tmp` on macOS). Client code filtering pushed terminals by cwd must use the canonical cwd returned by that endpoint.
- Terminal payloads come from `publicSession()` in `terminal-manager.cjs` (includes `bufferBytes`, `history`, `state`, `endedAt`, `exitCode`). Codex runtimes come from `listRuntimes()` in `codex-app-server.cjs`: `{ threadId, cwd, owner: "chat", state: "idle" | "running" | "approval", connected }`.

---

### Task 1: Status bus

**Files:**
- Create: `server/workspace-status.cjs`
- Test: `server/agents/workspace-status.test.cjs`

**Interfaces:**
- Produces: `registerProvider(kind, getSnapshot)`, `notify(kind, { throttled }?)`, `subscribe(listener) → unsubscribe`, `snapshot(kind) → { type: kind, ... }`, `COALESCE_MS`, `THROTTLE_MS`, `_resetForTests()`. Kinds: `"terminals"` (`{ terminals, limits }`), `"codex_runtimes"` (`{ runtimes }`).

- [ ] **Step 1: Write the failing test** — `server/agents/workspace-status.test.cjs`

```js
"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const test = require("node:test");
const assert = require("node:assert/strict");
const status = require("../workspace-status.cjs");

function setup(t) {
  status._resetForTests();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const messages = [];
  const unsubscribe = status.subscribe((message) => messages.push(message));
  t.after(() => { unsubscribe(); status._resetForTests(); });
  return messages;
}

test("unregistered kinds report empty snapshots", () => {
  status._resetForTests();
  assert.deepEqual(status.snapshot("terminals"), { type: "terminals", terminals: [], limits: null });
  assert.deepEqual(status.snapshot("codex_runtimes"), { type: "codex_runtimes", runtimes: [] });
});

test("coalesces bursts into one publish after COALESCE_MS", (t) => {
  const messages = setup(t);
  let calls = 0;
  status.registerProvider("codex_runtimes", () => ({ runtimes: [{ threadId: "t", n: ++calls }] }));
  status.notify("codex_runtimes");
  status.notify("codex_runtimes");
  t.mock.timers.tick(status.COALESCE_MS - 1);
  assert.equal(messages.length, 0);
  t.mock.timers.tick(1);
  assert.equal(messages.length, 1);
  assert.equal(calls, 1);
  assert.equal(messages[0].type, "codex_runtimes");
});

test("throttled notifications publish at most once per THROTTLE_MS; an urgent one upgrades them", (t) => {
  const messages = setup(t);
  let n = 0;
  status.registerProvider("terminals", () => ({ terminals: [{ id: String(++n) }], limits: null }));
  status.notify("terminals", { throttled: true });
  status.notify("terminals", { throttled: true });
  t.mock.timers.tick(status.COALESCE_MS);
  assert.equal(messages.length, 0);
  t.mock.timers.tick(status.THROTTLE_MS - status.COALESCE_MS);
  assert.equal(messages.length, 1);
  status.notify("terminals", { throttled: true });
  status.notify("terminals");
  t.mock.timers.tick(status.COALESCE_MS);
  assert.equal(messages.length, 2);
});

test("identical snapshots are not re-sent", (t) => {
  const messages = setup(t);
  status.registerProvider("codex_runtimes", () => ({ runtimes: [] }));
  status.notify("codex_runtimes");
  t.mock.timers.tick(status.COALESCE_MS);
  status.notify("codex_runtimes");
  t.mock.timers.tick(status.COALESCE_MS);
  assert.equal(messages.length, 1);
});

test("a throwing provider does not break other kinds or listeners", (t) => {
  const messages = setup(t);
  t.mock.method(console, "error", () => {});
  status.registerProvider("terminals", () => { throw new Error("boom"); });
  status.registerProvider("codex_runtimes", () => ({ runtimes: [{ threadId: "ok" }] }));
  status.notify("terminals");
  status.notify("codex_runtimes");
  t.mock.timers.tick(status.COALESCE_MS);
  assert.deepEqual(messages.map((message) => message.type), ["codex_runtimes"]);
});
```

- [ ] **Step 2: Run to verify it fails** — `node --test server/agents/workspace-status.test.cjs` → FAIL (cannot find module).

- [ ] **Step 3: Implement `server/workspace-status.cjs`**

```js
"use strict";

/**
 * Process-wide bus for workspace run status (terminals, Codex runtimes).
 * Next route handlers and the custom server can load separate copies of a
 * module, so all state lives on `global`. Owners register a snapshot provider
 * and call notify() when state changes; the running-status SSE forwards the
 * coalesced snapshots to browsers.
 */
const COALESCE_MS = 100;
const THROTTLE_MS = 5_000;
const EMPTY = {
  terminals: () => ({ terminals: [], limits: null }),
  codex_runtimes: () => ({ runtimes: [] }),
};

function freshState() {
  return { providers: new Map(), listeners: new Set(), pending: new Map(), lastPublished: new Map() };
}
const state = global.__piWebWorkspaceStatus || freshState();
global.__piWebWorkspaceStatus = state;

function registerProvider(kind, getSnapshot) {
  state.providers.set(kind, getSnapshot);
}

function snapshot(kind) {
  const provider = state.providers.get(kind);
  return { type: kind, ...(provider ? provider() : EMPTY[kind]()) };
}

function publish(kind) {
  state.pending.delete(kind);
  let message;
  try {
    message = snapshot(kind);
  } catch (error) {
    console.error(`[workspace-status] ${kind} snapshot failed:`, error);
    return;
  }
  const serialized = JSON.stringify(message);
  if (state.lastPublished.get(kind) === serialized) return;
  state.lastPublished.set(kind, serialized);
  for (const listener of state.listeners) {
    try { listener(message); } catch { /* a closed stream must not affect others */ }
  }
}

/** Schedule a publish. `throttled` changes (terminal output) wait up to THROTTLE_MS; any urgent change upgrades a pending throttled one. */
function notify(kind, { throttled = false } = {}) {
  const pending = state.pending.get(kind);
  if (pending) {
    if (throttled || !pending.throttled) return;
    clearTimeout(pending.timer);
  }
  const timer = setTimeout(() => publish(kind), throttled ? THROTTLE_MS : COALESCE_MS);
  timer.unref?.();
  state.pending.set(kind, { timer, throttled });
}

function subscribe(listener) {
  state.listeners.add(listener);
  return () => { state.listeners.delete(listener); };
}

function _resetForTests() {
  for (const pending of state.pending.values()) clearTimeout(pending.timer);
  const fresh = freshState();
  state.providers = fresh.providers;
  state.listeners = fresh.listeners;
  state.pending = fresh.pending;
  state.lastPublished = fresh.lastPublished;
}

module.exports = { registerProvider, notify, subscribe, snapshot, COALESCE_MS, THROTTLE_MS, _resetForTests };
```

- [ ] **Step 4: Run to verify it passes** — `node --test server/agents/workspace-status.test.cjs` → PASS. Then `npm test`, `npx eslint server`.

- [ ] **Step 5: Commit** — `git add server/workspace-status.cjs server/agents/workspace-status.test.cjs && git commit -m "feat: add process-wide workspace status bus"`

---

### Task 2: Terminal and Codex providers

**Files:**
- Modify: `server/agents/terminal-manager.cjs`, `server/agents/codex-app-server.cjs`, `server/agents/terminal-api.cjs` (GET `/api/terminals` response), `lib/agents/terminal.ts` (only if its types need the new `cwd` field)
- Test: `server/agents/workspace-status-providers.test.cjs`

**Interfaces:**
- Consumes: Task 1 bus.
- Produces: `terminals` messages `{ type: "terminals", terminals: TerminalSession[] /* all cwds */, limits: { running, records } }`; `codex_runtimes` messages `{ type: "codex_runtimes", runtimes }`. `GET /api/terminals?cwd=` additionally returns `cwd` (the canonical path it filtered by; omitted when no cwd was given).

Rules (call the bus as `workspaceStatus.notify(...)`, property access, so tests can spy with `t.mock.method(workspaceStatus, "notify")`):

- `terminal-manager.cjs`: `const workspaceStatus = require("../workspace-status.cjs");`. At module end: `workspaceStatus.registerProvider("terminals", () => ({ terminals: listTerminals(), limits: terminalStats().limits }));`. Call `workspaceStatus.notify("terminals")` after: `state.sessions.set` in `createTerminal`; the `onExit` handler; `stopTerminal` (after `session.state = "stopped"`); `renameTerminal` (after setting title); `removeTerminal` (after delete); `clearEndedTerminals` when `removedIds.length > 0`. Call `workspaceStatus.notify("terminals", { throttled: true })` in `appendOutput` (buffer size) and in `recordTerminalInput` when `session.history` changes. Then `git grep -n "state.sessions\.\(set\|delete\)\|session.state =\|session.title =\|session.history =" server/agents/terminal-manager.cjs` and confirm every hit is covered.
- `codex-app-server.cjs`: `const workspaceStatus = require("../workspace-status.cjs");`. At module end: `workspaceStatus.registerProvider("codex_runtimes", () => ({ runtimes: listRuntimes() }));`. Call `workspaceStatus.notify("codex_runtimes")` in: `start` (only when a new session is created), `stop` (when it deleted a session), `failState` (after deleting), `handleProtocolMessage` when the message changed `activeTurnId` or `incoming` (the `turn/started`, `turn/completed`, `serverRequest/resolved`, and server-request branches), `prompt` (after setting `activeTurnId`), `respond` (after `incoming.delete`).
- `terminal-api.cjs` GET `/api/terminals`: return `{ terminals, stats, ...(cwd ? { cwd } : {}) }`.

- [ ] **Step 1: Write the failing test** — `server/agents/workspace-status-providers.test.cjs`

```js
"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const workspaceStatus = require("../workspace-status.cjs");

function loadTerminalManagerWithFakePty(t) {
  const modulePath = require.resolve("./terminal-manager.cjs");
  const previousState = global.__piWebTerminalState;
  const previousLoad = Module._load;
  const handlers = {};
  const fakePty = { pid: 7, onData(fn) { handlers.data = fn; }, onExit(fn) { handlers.exit = fn; }, write() {}, resize() {}, kill() {} };
  global.__piWebTerminalState = { sessions: new Map() };
  Module._load = function (request, parent, isMain) {
    if (request === "node-pty") return { spawn() { return fakePty; } };
    return previousLoad.call(this, request, parent, isMain);
  };
  delete require.cache[modulePath];
  const manager = require("./terminal-manager.cjs");
  t.after(() => {
    Module._load = previousLoad;
    delete require.cache[modulePath];
    if (previousState === undefined) delete global.__piWebTerminalState;
    else global.__piWebTerminalState = previousState;
  });
  return { manager, handlers };
}

test("terminal lifecycle changes notify the status bus; output is throttled", (t) => {
  const previousShell = process.env.SHELL;
  process.env.SHELL = "/bin/sh";
  t.after(() => { process.env.SHELL = previousShell; });
  const notify = t.mock.method(workspaceStatus, "notify", () => {});
  const { manager, handlers } = loadTerminalManagerWithFakePty(t);
  const calls = () => notify.mock.calls.map((call) => [call.arguments[0], call.arguments[1]?.throttled === true]);

  const terminal = manager.createTerminal({ provider: "shell", cwd: "/tmp", cols: 80, rows: 24 });
  assert.deepEqual(calls().at(-1), ["terminals", false]);
  handlers.data("hello");
  assert.deepEqual(calls().at(-1), ["terminals", true]);
  manager.renameTerminal(terminal.id, "Logs");
  assert.deepEqual(calls().at(-1), ["terminals", false]);
  handlers.exit({ exitCode: 0, signal: 0 });
  assert.deepEqual(calls().at(-1), ["terminals", false]);
  const before = notify.mock.callCount();
  manager.removeTerminal(terminal.id);
  assert.equal(notify.mock.callCount(), before + 1);
});

test("the terminals provider snapshot lists every terminal with limits", (t) => {
  const previousShell = process.env.SHELL;
  process.env.SHELL = "/bin/sh";
  t.after(() => { process.env.SHELL = previousShell; });
  t.mock.method(workspaceStatus, "notify", () => {});
  const { manager } = loadTerminalManagerWithFakePty(t);
  manager.createTerminal({ provider: "shell", cwd: "/tmp", cols: 80, rows: 24 });
  const message = workspaceStatus.snapshot("terminals");
  assert.equal(message.type, "terminals");
  assert.equal(message.terminals.length, 1);
  assert.deepEqual(Object.keys(message.limits).sort(), ["records", "running"]);
});

test("codex protocol state changes notify the status bus", (t) => {
  const notify = t.mock.method(workspaceStatus, "notify", () => {});
  const appServer = require("./codex-app-server.cjs");
  const state = { threadId: "th", activeTurnId: null, incoming: new Map(), pending: new Map(), events: [], listeners: new Set(), nextEventSeq: 1 };
  appServer.handleProtocolMessage(state, { method: "turn/started", params: { turn: { id: "turn-1" } } });
  appServer.handleProtocolMessage(state, { method: "item/agentMessage/delta", params: {} });
  appServer.handleProtocolMessage(state, { method: "turn/completed", params: {} });
  const kinds = notify.mock.calls.map((call) => call.arguments[0]);
  assert.deepEqual(kinds, ["codex_runtimes", "codex_runtimes"]);
});
```

- [ ] **Step 2: Run to verify it fails** — `node --test server/agents/workspace-status-providers.test.cjs` → FAIL (no notify calls).
- [ ] **Step 3: Implement the rules above.** For `handleProtocolMessage`, compute `const changed = (message.method === "turn/started" || message.method === "turn/completed" || message.method === "serverRequest/resolved" || (message.id != null && message.method));` and call `workspaceStatus.notify("codex_runtimes")` when true.
- [ ] **Step 4: Verify** — `node --test server/agents/workspace-status-providers.test.cjs` → PASS; `npm test`; `npx eslint server`; `npx tsc --noEmit -p .`.
- [ ] **Step 5: Commit** — `git commit -m "feat: publish terminal and Codex runtime status changes"` (add the touched files).

---

### Task 3: Stream status snapshots over the running-status SSE

**Files:**
- Modify: `app/api/agent/running/events/route.ts`

**Interfaces:**
- Consumes: Task 1 bus via `require("@/server/workspace-status.cjs")` (typed inline like `app/api/auth/login/route.ts` does for `auth.cjs`).
- Produces: the SSE also emits `{ type: "terminals", ... }` and `{ type: "codex_runtimes", ... }`: one snapshot of each right after connecting (after subscribing), then every bus publish.

- [ ] **Step 1: Implement.** In `start(controller)`:
  - Subscribe to the bus next to the existing subscriptions: `const unsubscribeStatus = workspaceStatus.subscribe((message) => sendSnapshot(message));`
  - `sendSnapshot(message)`: if `controller.desiredSize !== null && controller.desiredSize <= 0`, store it in `pendingSnapshots` (a `Map<string, unknown>` keyed by `message.type`, so only the latest per kind is kept) and return; otherwise `encode(message)`.
  - Add `pull()` to the `ReadableStream` that flushes `pendingSnapshots` (delete each after encoding).
  - After the existing initial `running` frame, send `workspaceStatus.snapshot("terminals")` and `workspaceStatus.snapshot("codex_runtimes")` through `sendSnapshot`.
  - In `cleanup`, call `unsubscribeStatus()` and clear `pendingSnapshots`.
  - Keep `running` and `session_event` handling byte-for-byte unchanged.
- [ ] **Step 2: Verify end to end on a scratch server** (does not touch the user's data or port 30141):

```bash
AG=$(mktemp -d /tmp/pi-agent-XXXX); mkdir -p /tmp/ws-status
(PI_CODING_AGENT_DIR="$AG" PI_WEB_E2E=1 PI_WEB_NEXT_DIST_DIR=.next-e2e NEXT_PUBLIC_DISABLE_AGENTATION=1 node server/pi-web-server.js dev -H 127.0.0.1 -p 30142 > /tmp/ws-srv.log 2>&1 &)
for i in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:30142/api/auth/session && break; sleep 1; done
curl -s -X POST -H "Content-Type: application/json" -d '{"cwd":"/tmp/ws-status"}' http://127.0.0.1:30142/api/cwd/validate >/dev/null
(curl -s -N http://127.0.0.1:30142/api/agent/running/events > /tmp/ws-sse.txt &); sleep 2
curl -s -X POST -H "Content-Type: application/json" -H "Origin: http://127.0.0.1:30142" -d '{"provider":"shell","cwd":"/tmp/ws-status","cols":80,"rows":24}' http://127.0.0.1:30142/api/terminals >/dev/null; sleep 1
grep -o '"type":"[a-z_]*"' /tmp/ws-sse.txt | sort | uniq -c
pkill -f "curl -s -N http://127.0.0.1:30142"; pkill -f "pi-web-server.js dev -H 127.0.0.1 -p 30142"; rm -rf "$AG" /tmp/ws-status /tmp/ws-sse.txt /tmp/ws-srv.log
```

Expected: `running` ≥1, `codex_runtimes` 1, `terminals` 2 (initial empty snapshot + the created shell). Stop any leftover terminal process if the script is interrupted.
- [ ] **Step 3:** `npx tsc --noEmit -p .`, `npx eslint app/api/agent`, `npm test`, `npx playwright test` → green.
- [ ] **Step 4: Commit** — `git commit -m "feat: stream terminal and Codex runtime status over the running SSE"`.

---

### Task 4: Client status store

**Files:**
- Create: `lib/workspace-status-store.ts`
- Test: `lib/workspace-status-store.test.mjs`

**Interfaces:**
- Produces:

```ts
export interface CodexRuntimeStatus { threadId: string; cwd: string; owner?: string; state: "idle" | "running" | "approval"; connected?: boolean }
export interface WorkspaceStatusSnapshot {
  /** null until the first message of that kind arrives */
  runningSessionIds: string[] | null;
  terminals: TerminalSession[] | null;
  terminalLimits: TerminalStats["limits"] | null;
  codexRuntimes: CodexRuntimeStatus[] | null;
}
export interface WorkspaceStatusStore {
  getSnapshot(): WorkspaceStatusSnapshot;
  subscribe(listener: () => void): () => void;
  /** Apply an SSE message; ignores unknown types. */
  apply(message: unknown): void;
  /** Replace the terminals of one canonical cwd (from GET /api/terminals). */
  replaceTerminalsForCwd(cwd: string, terminals: TerminalSession[], limits: TerminalStats["limits"] | null): void;
  /** Optimistic local edit of one cwd's terminals; the next pushed snapshot wins. */
  updateTerminalsForCwd(cwd: string, update: (terminals: TerminalSession[]) => TerminalSession[]): void;
}
export function createWorkspaceStatusStore(): WorkspaceStatusStore;
export function terminalsForCwd(snapshot: WorkspaceStatusSnapshot, cwd: string): TerminalSession[];
export function terminalStatsForCwd(snapshot: WorkspaceStatusSnapshot, cwd: string): TerminalStats | null;
```

- [ ] **Step 1: Write the failing test** — `lib/workspace-status-store.test.mjs`

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createWorkspaceStatusStore, terminalsForCwd, terminalStatsForCwd } = await jiti.import("./workspace-status-store.ts");

const term = (id, cwd, extra = {}) => ({ id, cwd, provider: "shell", state: "running", bufferBytes: 10, ...extra });
const limits = { running: 20, records: 100 };

test("starts empty and applies known messages only", () => {
  const store = createWorkspaceStatusStore();
  assert.deepEqual(store.getSnapshot(), { runningSessionIds: null, terminals: null, terminalLimits: null, codexRuntimes: null });
  store.apply({ type: "running", runningSessionIds: ["s1"] });
  store.apply({ type: "codex_runtimes", runtimes: [{ threadId: "t", cwd: "/a", state: "running" }] });
  store.apply({ type: "terminals", terminals: [term("1", "/a")], limits });
  store.apply({ type: "session_event", sessionId: "s1", event: {} });
  store.apply("garbage");
  const snapshot = store.getSnapshot();
  assert.deepEqual(snapshot.runningSessionIds, ["s1"]);
  assert.equal(snapshot.codexRuntimes.length, 1);
  assert.equal(snapshot.terminals.length, 1);
  assert.deepEqual(snapshot.terminalLimits, limits);
});

test("notifies subscribers and keeps the snapshot identity when nothing changed", () => {
  const store = createWorkspaceStatusStore();
  let calls = 0;
  const unsubscribe = store.subscribe(() => { calls += 1; });
  store.apply({ type: "running", runningSessionIds: [] });
  const first = store.getSnapshot();
  assert.equal(calls, 1);
  assert.equal(store.getSnapshot(), first);
  unsubscribe();
  store.apply({ type: "running", runningSessionIds: ["x"] });
  assert.equal(calls, 1);
});

test("filters terminals and computes stats per cwd", () => {
  const store = createWorkspaceStatusStore();
  store.apply({ type: "terminals", terminals: [term("1", "/a"), term("2", "/a", { state: "ended", bufferBytes: 5 }), term("3", "/b")], limits });
  const snapshot = store.getSnapshot();
  assert.deepEqual(terminalsForCwd(snapshot, "/a").map((t) => t.id), ["1", "2"]);
  assert.deepEqual(terminalStatsForCwd(snapshot, "/a"), {
    workspace: { running: 1, records: 2, bufferBytes: 15 },
    global: { running: 2, records: 3, bufferBytes: 25 },
    limits,
  });
  assert.equal(terminalStatsForCwd(createWorkspaceStatusStore().getSnapshot(), "/a"), null);
});

test("per-cwd replacement and optimistic updates leave other cwds alone; pushes win", () => {
  const store = createWorkspaceStatusStore();
  store.apply({ type: "terminals", terminals: [term("1", "/a"), term("3", "/b")], limits });
  store.replaceTerminalsForCwd("/a", [term("9", "/a")], limits);
  assert.deepEqual(store.getSnapshot().terminals.map((t) => t.id).sort(), ["3", "9"]);
  store.updateTerminalsForCwd("/b", (current) => [...current, term("4", "/b")]);
  assert.deepEqual(terminalsForCwd(store.getSnapshot(), "/b").map((t) => t.id), ["3", "4"]);
  store.apply({ type: "terminals", terminals: [term("3", "/b")], limits });
  assert.deepEqual(store.getSnapshot().terminals.map((t) => t.id), ["3"]);
});

test("replacing before any push initializes the list", () => {
  const store = createWorkspaceStatusStore();
  store.replaceTerminalsForCwd("/a", [term("1", "/a")], null);
  assert.deepEqual(store.getSnapshot().terminals.map((t) => t.id), ["1"]);
});
```

- [ ] **Step 2: Run to verify it fails** — `node --test lib/workspace-status-store.test.mjs`.
- [ ] **Step 3: Implement** `lib/workspace-status-store.ts` (relative imports only: `import type { TerminalSession, TerminalStats } from "./agents/terminal";`). Every mutation builds a new snapshot object and notifies listeners; `apply` ignores anything that is not an object with a known `type` and array payload. Stats: `workspace` over `terminalsForCwd`, `global` over all terminals, `running` counts `state === "running"`, `bufferBytes` sums `bufferBytes ?? 0`; return `null` when `terminals` is null. `limits` falls back to `{ running: 0, records: 0 }` only when non-null terminals exist but no limits were received.
- [ ] **Step 4: Verify** — test passes; `npm test`; `npx tsc --noEmit -p .`; `npx eslint lib`.
- [ ] **Step 5: Commit** — `git commit -m "feat: add client workspace status store"`.

---

### Task 5: Shared status connection; migrate SessionSidebar

**Files:**
- Create: `hooks/useWorkspaceStatus.ts`
- Modify: `components/SessionSidebar.tsx` (the `new EventSource("/api/agent/running/events")` effect)

**Interfaces:**
- Consumes: Task 4 store.
- Produces:

```ts
export const workspaceStatusStore: WorkspaceStatusStore; // module singleton
/** Subscribes to the store and keeps the shared connection open while mounted. */
export function useWorkspaceStatus(): WorkspaceStatusSnapshot;
/** Receive every raw SSE message (e.g. session_event) while mounted; also keeps the connection open. */
export function useWorkspaceStatusMessages(listener: (message: { type?: string; [key: string]: unknown }) => void): void;
```

- [ ] **Step 1: Implement `hooks/useWorkspaceStatus.ts`** ("use client"):
  - Module state: `let source: EventSource | null`, `let users = 0`, `const messageListeners = new Set<Listener>()`.
  - `retain()`: `users += 1`; if no `source`, create `new EventSource("/api/agent/running/events")`, `onmessage` parses JSON (ignore malformed), calls `workspaceStatusStore.apply(data)` and every `messageListeners` entry. `release()`: `users -= 1`; when 0, close and null the source.
  - `useWorkspaceStatus()`: `useEffect(() => { retain(); return release; }, [])` plus `useSyncExternalStore(workspaceStatusStore.subscribe, workspaceStatusStore.getSnapshot, workspaceStatusStore.getSnapshot)`.
  - `useWorkspaceStatusMessages(listener)`: keep the latest listener in a ref; effect registers a stable wrapper in `messageListeners`, calls `retain()`, and cleans up both.
- [ ] **Step 2: Migrate SessionSidebar.** Replace the effect that opens `running/events` with `useWorkspaceStatusMessages((data) => { … })` containing the same `running` / `session_event` handling (`sseAuthoritativeRef.current = true; setRunningSessionIds(new Set(...))` and `applyBackgroundSessionEvent(...)`). Behavior must be identical.
- [ ] **Step 3: Verify** — `npx tsc --noEmit -p .`, `npx eslint components/SessionSidebar.tsx hooks/useWorkspaceStatus.ts`, `npm test`, `npx playwright test` (tests "keeps a running session snapshot synchronized while another session is open" and "restores the current tip…" exercise this stream).
- [ ] **Step 4: Commit** — `git commit -m "refactor: share one running-status connection per tab"`.

---

### Task 6: Push-driven terminals and project rail

**Files:**
- Modify: `hooks/useWorkspaceTerminals.ts`, `components/ProjectRail.tsx`, `e2e/app-shell.spec.ts`

**Interfaces:**
- Consumes: Tasks 4–5 (`workspaceStatusStore`, `useWorkspaceStatus`, `terminalsForCwd`, `terminalStatsForCwd`); `GET /api/terminals?cwd=` now returns `cwd` (canonical).
- Produces: `useWorkspaceTerminals(cwd, refreshKey?)` keeps its return shape `{ terminals, stats, loaded, update, refresh }`; `refreshWorkspaceTerminals(cwd)` and `updateWorkspaceTerminals(cwd, update)` keep their exported signatures.

- [ ] **Step 1: Rewrite `hooks/useWorkspaceTerminals.ts`:**
  - Keep a module map `canonicalCwd: Map<string, string>` (requested cwd → canonical).
  - `refreshWorkspaceTerminals(cwd)`: `GET /api/terminals?cwd=`; on success record `canonicalCwd.set(cwd, data.cwd ?? cwd)` and call `workspaceStatusStore.replaceTerminalsForCwd(canonical, data.terminals ?? [], data.stats?.limits ?? null)`. De-duplicate concurrent calls per cwd as today.
  - `updateWorkspaceTerminals(cwd, update)`: `workspaceStatusStore.updateTerminalsForCwd(canonicalCwd.get(cwd) ?? cwd, update)`.
  - Hook: `const status = useWorkspaceStatus();` resolve `canonical = canonicalCwd.get(cwd) ?? cwd` (hold it in state updated after refresh resolves so a re-render occurs); `terminals = terminalsForCwd(status, canonical)`, `stats = terminalStatsForCwd(status, canonical)`, `loaded = status.terminals !== null && canonicalCwd.has(cwd)`. Call `refreshWorkspaceTerminals(cwd)` on mount and when `refreshKey` changes. Delete the `setInterval`.
- [ ] **Step 2: Migrate ProjectRail's 5 s effect (the one fetching `/api/terminals`, `/api/sessions?running=1`, `/api/codex/runtime`):**
  - Read `terminals`, `runningSessionIds`, `codexRuntimes` from `useWorkspaceStatus()`; recompute `runningByCwd` and `activityById` in an effect depending on those plus `workspaces` (same logic as today; treat null as empty).
  - Keep the throttled `/api/sessions` fetch for unknown running Pi session ids (`sessionRootByIdRef`, 30 s), run it from this effect.
  - Time-based states previously refreshed by the poll must still expire: after computing, schedule one `setTimeout` for the earliest of (`completedUntilRef` expiries, terminal `Date.parse(endedAt) + 5 * 60_000` for ended terminals still inside the window) that bumps a local `tick` state included in the effect dependencies. Clear it on cleanup.
  - Delete the 5 s `setInterval`. Leave the separate 20 s Git status effect untouched.
- [ ] **Step 3: Update e2e mocks.** Tests that mock `**/api/terminals?*` (and ProjectRail tests relying on `/api/codex/runtime`) now also receive live pushes from the real server, whose snapshot (no terminals) would overwrite the mocked list. Add a helper at the top of `e2e/app-shell.spec.ts`:

```ts
async function mockStatusStream(page: Page, frames: Array<Record<string, unknown>>) {
  await page.route("**/api/agent/running/events", (route) => route.fulfill({
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    body: frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""),
  }));
}
```

  Call it in each test that mocks terminals, with `{ type: "running", runningSessionIds: [] }`, `{ type: "terminals", terminals: <the same list the test mocks>, limits: { running: 20, records: 100 } }`, `{ type: "codex_runtimes", runtimes: [] }`. Tests that already fulfill `running/events` themselves keep their frames and add the two new ones. Make the terminal mock also return `cwd` equal to the test's cwd.
- [ ] **Step 4: Add an e2e test** asserting push-driven updates and no polling: mock the status stream with a running shell terminal in the project cwd, open the page, expect the project rail badge (the `.project-rail-badge` / running count element used in existing tests) to show `1`; count requests to `**/api/terminals**` and `**/api/codex/runtime` over an 11 s window after load and expect at most the initial per-cwd `/api/terminals?cwd=` fetch (no repeated 5 s requests).
- [ ] **Step 5: Verify** — `npx tsc --noEmit -p .`, `npx eslint components hooks e2e`, `npm test`, `npx playwright test` → 0 unexpected failures.
- [ ] **Step 6: Commit** — `git commit -m "feat: drive terminals and project rail status from pushed snapshots"`.

---

### Task 7: Codex catalog refresh and docs

**Files:**
- Modify: `components/agents/AgentsPanel.tsx`, `AGENTS.md`, `docs/prd/multi-project-workspaces.md`, `docs/prd/session-reliability.md`

- [ ] **Step 1: AgentsPanel.** Change the `/api/codex/sessions` poll from 5000 to 30000 ms. Add: `const status = useWorkspaceStatus();` and an effect keyed on `status.terminals` and `status.codexRuntimes` that, after a 1 s debounce (clear on change/unmount), calls `loadSessions(true)` — skip the very first run (initial load already happens).
- [ ] **Step 2: AGENTS.md.** Under "Running state SSE + reconciliation", add a bullet: the running SSE also carries `terminals` and `codex_runtimes` snapshots from `server/workspace-status.cjs`; state owners call `workspaceStatus.notify(kind)` on every change (throttled for output); browsers share one connection via `hooks/useWorkspaceStatus.ts`; do not add polling for terminal or Codex run state. Add File Map lines for `server/workspace-status.cjs`, `lib/workspace-status-store.ts`, `hooks/useWorkspaceStatus.ts`.
- [ ] **Step 3: PRDs.** In `docs/prd/multi-project-workspaces.md` 后续计划, remove “统一 SSE 状态通道，减少周期查询” and add to 已实现范围: “终端、Codex 运行时和 Pi 会话的运行状态通过同一条 SSE 推送，项目栏和终端列表不再周期轮询；Codex 会话目录保留 30 秒兜底刷新。” In `docs/prd/session-reliability.md` 后续计划, update the item “将 Pi、Codex 和 Terminal 的状态进一步统一为同一活动协议” to note run status now shares one stream and what remains (a unified activity/event protocol).
- [ ] **Step 4: Verify** — `npx tsc --noEmit -p .`, `npx eslint components/agents`, `npm test`, `npx playwright test`.
- [ ] **Step 5: Commit** — `git commit -m "feat: slow Codex catalog polling and document the status stream"`.
