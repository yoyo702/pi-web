# Background Approval Entry Points Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make work that runs in the background (Codex/Claude chats, terminals, Pi sessions) reachable and safe. A notification always opens its target, closing a project or a chat tab says what is still running, the browser tab title shows what is waiting, dangerous chat permissions are confirmed, and a chat reopened from a notification keeps its model and permission.

**Architecture:** Each decision is a small pure helper in `lib/*.ts`, covered by `node --test`. `components/AppShell.tsx`, `components/ProjectRail.tsx`, `components/RecentNotifications.tsx` and the chat composer call these helpers. The server change is limited to the runtime lists that the status stream already pushes (`codex_runtimes`, `claude_runtimes`), which now include each runtime's settings. Browser behavior is covered by one new Playwright file, `e2e/background-approval.spec.ts`, which mocks the API the same way `e2e/app-shell.spec.ts` does.

**Tech Stack:** Next.js 16, React 19, the custom Node server (`server/pi-web-server.js` + `server/agents/*.cjs`), `node --test` (TS loaded through `jiti`), Playwright.

**Spec:** There is no separate spec document. The six problems come from the product audit. The **Problem** line in each task is the requirement. Every item was checked against the code on `feat/audit-followups`:

- **Kept as written:** items 1 (a notification for a closed project), 3 (closing a busy chat tab), 4 (tab title) and 5 (dangerous chat permissions). The code has each of these problems.
- **Reshaped, item 2 (close-project confirmation):** the rail counts only busy terminals, through `runningByCwd[workspace.cwd]`. That count also misses terminals in the project root when a worktree is active. The fix counts from `activityById[workspace.id]`, the same per-workspace grouping the rail badges use. The warning therefore also lists busy Pi sessions, and it covers the project root and every worktree.
- **Reshaped, item 6 (restore model and permission):** a saved chat tab already keeps its model and permission (`lib/workspace/tab-kinds.ts` restores the whole tab). The gap is only when no tab exists. The Codex reopen hard-codes `approvalPolicy: "untrusted"` with no model (`AppShell.tsx:959`), and the Claude reopen passes neither (`AppShell.tsx:951`). Nothing in the browser remembers those settings, so the source of truth is the live runtime. The server adds the settings to the runtime lists, and the reopen reads them.
- **Dropped:** none.

## Global Constraints

- No new dependencies.
- UI copy is English. PRD edits (`docs/prd/*.md`) are Chinese, and they are made in the same commit as the behavior change.
- Every task ends green on `npx tsc --noEmit -p .`, `npx eslint <touched files>` and `npm test`. Tasks that touch UI also run `npx playwright test e2e/background-approval.spec.ts`.
- Work on the existing branch `feat/audit-followups`. Do not create a branch.

## Facts the implementer needs

**Unit tests**
- `npm test` runs `server/agents/*.test.cjs`, `lib/*.test.mjs`, `lib/workspace/*.test.mjs` and `components/*.test.mjs`.
- To run one file: `node --require ./server/test-env.cjs --test <file>`.
- New lib tests import TS through `createJiti(import.meta.url)` and `await jiti.import("./x.ts")`, as `lib/activity-center.test.mjs` does.

**E2E server and status stream**
- The e2e server runs on `http://127.0.0.1:30142` with no password.
- The status stream `**/api/agent/running/events` is mocked as SSE frames (`data: <json>\n\n`) of these types:
  - `running`
  - `terminals`
  - `codex_runtimes`
  - `claude_runtimes`
  - `notifications` (`{notifications, unread}`)

**E2E local storage**
- Project workspaces are seeded in `localStorage["pi-web:project-workspaces:v1"]` as `{activeId, workspaces}`.
- Center tabs of a cwd are seeded in ``localStorage[`pi-web:workspace-tabs:${encodeURIComponent(cwd)}`]`` as `{tabs, activeId, split}`.
  - The Pi tab is added on load.
  - A chat tab needs `id`, `label`, `kind` and `cwd` equal to that cwd.
  - Restored chat tabs always get `status: "idle"` (`lib/workspace/tab-kinds.ts:33,40`). **Do not use a tab's `status` to decide whether a chat is busy.** Use the runtime lists on the status stream.
- A tab's panel mounts only when the tab is active. If `activeId` is `"pi"`, a seeded chat tab makes no chat requests.

**E2E UI facts**
- The center tab close button is `aria-label="Close <tab label>"` (`components/TabBar.tsx:261`).
- The rail close button is `aria-label="Close <workspace label>"` (desktop `ProjectRail.tsx:233`, mobile `:288`).
- `window.confirm` is handled with `page.once("dialog", ...)`.
- A system notification click opens `/?notification=<id>`. The effect at `AppShell.tsx:996-1006` handles it.
- `fakeCodexStreams` is not exported from `e2e/app-shell.spec.ts:1528-1553`. The new spec file carries its own copy.

**Runtime lifetimes (server)**
- Codex (`server/agents/codex-app-server.cjs:46-58`):
  - A runtime with an active turn or a pending approval stays up with no viewer.
  - `idleMs` (30 s) after the turn ends, with no listener, it shuts down.
  - `start()` returns an existing runtime unchanged and ignores the settings passed to it (`:156-158`).
- Claude (`server/agents/claude-chat-runtime.cjs`): the same rule applies (PRD `agent-workspace.md:120`).
- Interrupt endpoints:
  - Codex: `POST /api/codex/chat/:id/interrupt` with body `{}`.
  - Claude: `POST /api/claude/chat/:id/interrupt` with body `{cwd}`.
  - Both answer `409 {code: "no_active_turn"}` when nothing is running.

---

### Task 1: A notification for a closed project opens that project and its target

**Problem:** Clicking a notification whose project is not open does nothing useful:
- In the "Recent" list it only marks the notification read (`components/RecentNotifications.tsx:32-36`).
- A system notification click opens the activity center instead (`components/AppShell.tsx:1003-1004`).

The user has to find and reopen the project by hand, then find the chat, terminal or session in it. It should reopen the project and focus the target.

**Files:**
- Modify: `lib/activity-notifications.ts:1-13` (add `notificationOpenWorkspace`)
- Modify: `lib/activity-notifications.test.mjs`
- Modify: `components/RecentNotifications.tsx:7,32-36,43-52`
- Modify: `components/AppShell.tsx:47,1001-1005`
- Create: `e2e/background-approval.spec.ts`
- Modify: `docs/prd/agent-workspace.md:185,197`

**Interfaces:**
- Consumes: `projectLabel(path)` from `lib/project-workspaces.ts:32`; `handleOpenActivityItem(workspace, target)` at `AppShell.tsx:884-903`. That handler already activates a workspace that is not current. Activation upserts it (`AppShell.tsx:457`), which re-adds a closed project to the rail.
- Produces: `notificationOpenWorkspace(notification: Pick<ActivityNotification, "cwd" | "projectRoot">, workspaces: ProjectWorkspace[]): { workspace: ProjectWorkspace; closed: boolean }`
- Produces (e2e helpers, reused by later tasks): the constants `ROOT_A` and `ROOT_B`, and these functions in `e2e/background-approval.spec.ts`:
  - `mockStatusStream(page, frames)`
  - `mockBackgroundWorkspaces(page, options)`, which returns `{ readRequests }`
  - `fakeCodexStreams(page)`
  - `mockCodexChat(page, id)`, which returns `{ reads }`

- [ ] **Step 1: Write the failing unit test.** Append to `lib/activity-notifications.test.mjs`. Also add `notificationOpenWorkspace` to the destructured import on line 6.

```js
test("a notification opens its open workspace, or reopens its closed project", () => {
  assert.deepEqual(notificationOpenWorkspace(notification({ cwd: "/repo/a/wt" }), workspaces), { workspace: workspaces[1], closed: false });
  const closed = notificationOpenWorkspace(notification({ cwd: "/repo/b/wt", projectRoot: "/repo/b" }), workspaces);
  assert.equal(closed.closed, true);
  assert.deepEqual({ ...closed.workspace, lastActive: 0 }, { id: "/repo/b", projectRoot: "/repo/b", cwd: "/repo/b/wt", label: "b", sessionId: null, lastActive: 0 });
  // Without a project root the cwd is the project.
  const bare = notificationOpenWorkspace(notification({ cwd: "/elsewhere/x" }), workspaces).workspace;
  assert.deepEqual([bare.id, bare.projectRoot, bare.cwd, bare.label], ["/elsewhere/x", "/elsewhere/x", "/elsewhere/x", "x"]);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --require ./server/test-env.cjs --test lib/activity-notifications.test.mjs`
Expected: FAIL. `notificationOpenWorkspace is not a function`.

- [ ] **Step 3: Implement.** In `lib/activity-notifications.ts`, change the first import to a value import and add the helper under `notificationWorkspace`.

```ts
import { projectLabel, type ProjectWorkspace } from "./project-workspaces";
```

```ts
/**
 * Where a notification opens: its workspace when the project is open, else a
 * workspace for its closed project. Activating that workspace adds the
 * project back to the rail (as when it was first opened).
 */
export function notificationOpenWorkspace(notification: Pick<ActivityNotification, "cwd" | "projectRoot">, workspaces: ProjectWorkspace[]): { workspace: ProjectWorkspace; closed: boolean } {
  const open = notificationWorkspace(notification, workspaces);
  if (open) return { workspace: open, closed: false };
  const root = notification.projectRoot || notification.cwd;
  return { workspace: { id: root, projectRoot: root, cwd: notification.cwd, label: projectLabel(root), sessionId: null, lastActive: Date.now() }, closed: true };
}
```

`lib/project-workspaces.ts` has no browser or React imports, so the value import is safe in node tests.

- [ ] **Step 4: Run the unit test and confirm it passes**

Run: `node --require ./server/test-env.cjs --test lib/activity-notifications.test.mjs`
Expected: PASS.

- [ ] **Step 5: Use the helper in "Recent".** In `components/RecentNotifications.tsx`:
  - Replace `notificationWorkspace` with `notificationOpenWorkspace` in the import on line 7.
  - Replace `open` (lines 32-36) with:

```tsx
  const open = (notification: ActivityNotification) => {
    if (!notification.read) void markNotificationsRead({ ids: [notification.id] });
    // A closed project is opened again, then the entry's target in it.
    onOpen(notificationOpenWorkspace(notification, workspaces).workspace, notificationTarget(notification));
  };
```

In the `entries.map` body (lines 43-52), replace the `workspace` lookup, the `meta` line and the `title` attribute:

```tsx
      const { workspace, closed } = notificationOpenWorkspace(notification, workspaces);
      const Icon = notification.kind === "terminal" ? TerminalSquare : Bot;
      const meta = [workspace.label, notificationKindLabel(notification), notificationEventLabel(notification), notificationAge(notification.createdAt, now)].filter(Boolean).join(" · ");
```

```tsx
        title={`${notification.title}${notification.detail ? `\n${notification.detail}` : ""}\n${notification.cwd}${closed ? "\nThis project is closed. Opening this entry reopens it." : ""}`}
```

Update the `onOpen` doc comment to say that a closed project is reopened.

- [ ] **Step 6: Use it for system notification clicks.** In `components/AppShell.tsx`:
  - Line 47: import `notificationOpenWorkspace` instead of `notificationWorkspace`.
  - Replace lines 1001-1005 with:

```tsx
    const notification = notificationLog.find((entry) => entry.id === pendingNotificationId);
    if (notification && !notification.read) void markNotificationsRead({ ids: [notification.id] });
    // Pruned from the log: the activity center lists what is left.
    if (!notification) { openActivityCenter(); return; }
    // A closed project is reopened (activation adds it back to the rail).
    handleOpenActivityItem(notificationOpenWorkspace(notification, projectWorkspaces).workspace, notificationTarget(notification));
```

If the path is no longer authorized, activation fails and the intent is dropped (`AppShell.tsx:896-899`). That is the same as clicking a stale rail item.

- [ ] **Step 7: Write the e2e test.** Create `e2e/background-approval.spec.ts`.

```ts
import { expect, test, type Page } from "@playwright/test";

const ROOT_A = "/tmp/pi-web-bg-a";
const ROOT_B = "/tmp/pi-web-bg-b";
const WORKSPACES_KEY = "pi-web:project-workspaces:v1";

async function mockStatusStream(page: Page, frames: Array<Record<string, unknown>>) {
  await page.route("**/api/agent/running/events", (route) => route.fulfill({
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    body: frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""),
  }));
}

type Rec = Record<string, unknown>;

/**
 * Open projects (the first is active), per-cwd terminals, the status stream,
 * and optional seeded center tabs for ROOT_A. Records notification reads.
 */
async function mockBackgroundWorkspaces(page: Page, options: { open?: string[]; terminals?: Rec[]; codexRuntimes?: Rec[]; claudeRuntimes?: Rec[]; notifications?: Rec[]; unread?: number; tabs?: { tabs: Rec[]; activeId: string } } = {}) {
  const { open = [ROOT_A], terminals = [], codexRuntimes = [], claudeRuntimes = [], notifications = [], tabs } = options;
  await page.addInitScript(({ key, snapshot }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(snapshot));
  }, { key: WORKSPACES_KEY, snapshot: {
    activeId: open[0],
    workspaces: open.map((cwd, index) => ({ id: cwd, projectRoot: cwd, cwd, label: cwd.split("/").pop(), sessionId: null, lastActive: open.length - index })),
  } });
  if (tabs) await page.addInitScript(({ key, value }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(value));
  }, { key: `pi-web:workspace-tabs:${encodeURIComponent(ROOT_A)}`, value: { ...tabs, split: null } });
  await page.route("**/api/sessions", (route) => route.fulfill({ json: { sessions: [], runningSessionIds: [] } }));
  await page.route("**/api/cwd/validate", (route) => {
    const body = route.request().postDataJSON() as { cwd?: string };
    return route.fulfill({ json: { success: true, cwd: body.cwd } });
  });
  await page.route("**/api/git/status?*", (route) => route.fulfill({ json: { isGitRepository: false, files: [] } }));
  await page.route("**/api/worktrees?*", (route) => route.fulfill({ json: { projectRoot: new URL(route.request().url()).searchParams.get("cwd"), isGit: false, isTopLevel: true, worktrees: [] } }));
  await page.route("**/api/terminals**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/api/terminals") return route.fulfill({ status: 404, json: { error: "not found" } });
    const cwd = url.searchParams.get("cwd") ?? "";
    const own = terminals.filter((item) => item.cwd === cwd);
    return route.fulfill({ json: { cwd, terminals: own, stats: { workspace: { running: 0, records: own.length, bufferBytes: 0 }, global: { running: 0, records: terminals.length, bufferBytes: 0 }, limits: { running: 20, records: 100 } } } });
  });
  const readRequests: unknown[] = [];
  await page.route("**/api/notifications/read", (route) => {
    readRequests.push(route.request().postDataJSON());
    return route.fulfill({ json: { changed: 1 } });
  });
  await mockStatusStream(page, [
    { type: "running", runningSessionIds: [] },
    { type: "terminals", terminals, limits: { running: 20, records: 100 } },
    { type: "codex_runtimes", runtimes: codexRuntimes },
    { type: "claude_runtimes", runtimes: claudeRuntimes },
    { type: "notifications", notifications, unread: options.unread ?? notifications.filter((item) => !item.read).length },
  ]);
  return { readRequests };
}

const failedTerminal = {
  id: "bg-terminal", title: "Nightly build", provider: "shell", state: "exited", exitCode: 1, cwd: ROOT_B,
  pid: 111, permissionMode: "confirm", launchMode: "new", noAltScreen: true, cols: 80, rows: 24,
  createdAt: "2026-09-27T00:00:00.000Z", endedAt: "2026-09-27T00:05:00.000Z", signal: null, bufferBytes: 0, bufferTruncated: false, history: [],
};
const failedNotification = () => ({ id: "n-closed", kind: "terminal", event: "failed", targetId: failedTerminal.id, cwd: ROOT_B, title: "Nightly build", detail: "Exited with code 1", createdAt: Date.now() - 60_000, read: false });

async function expectTerminalOpenInB(page: Page, mobile: boolean) {
  await expect(page.locator('.center-workspace [role="tab"][data-tab-id="terminal:bg-terminal"]')).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "null")?.workspaces?.map((workspace: { id: string }) => workspace.id), WORKSPACES_KEY)).toContain(ROOT_B);
  if (!mobile) await expect(page.getByRole("navigation", { name: "Project workspaces" }).getByTitle(ROOT_B)).toHaveAttribute("aria-current", "page");
}

test("a Recent notification for a closed project reopens it and opens its terminal", async ({ page }, testInfo) => {
  const mobile = testInfo.project.name.startsWith("mobile");
  const { readRequests } = await mockBackgroundWorkspaces(page, { terminals: [failedTerminal], notifications: [failedNotification()] });
  await page.goto("/");
  await page.locator(".center-workspace").getByRole("button", { name: "Workspace activity" }).click();
  const recent = page.getByRole("dialog", { name: "Workspace activity" }).getByRole("region", { name: "Recent notifications" });
  const entry = recent.getByRole("button", { name: "Nightly build · Terminal · Failed · unread" });
  await expect(entry).toContainText("pi-web-bg-b · Terminal · Failed");
  await entry.click();
  await expect.poll(() => readRequests.at(-1)).toEqual({ ids: ["n-closed"] });
  await expectTerminalOpenInB(page, mobile);
});

test("a system notification for a closed project reopens it instead of only opening the activity center", async ({ page }, testInfo) => {
  const mobile = testInfo.project.name.startsWith("mobile");
  await mockBackgroundWorkspaces(page, { terminals: [failedTerminal], notifications: [failedNotification()] });
  await page.goto("/?notification=n-closed");
  await expectTerminalOpenInB(page, mobile);
  await expect(page.getByRole("dialog", { name: "Workspace activity" })).toHaveCount(0);
});
```

Also add the chat helpers now. Tasks 5 and 6 use them.

```ts
// Codex and Claude chat event streams are replaced by inert fakes (copied from e2e/app-shell.spec.ts).
async function fakeCodexStreams(page: Page) {
  await page.addInitScript(() => {
    const RealEventSource = window.EventSource;
    class FakeEventSource extends EventTarget {
      static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
      readyState = 0; url: string;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      constructor(url: string) {
        super();
        this.url = url;
        setTimeout(() => { this.readyState = 1; this.onopen?.(new Event("open")); }, 0);
      }
      close() { this.readyState = 2; }
    }
    window.EventSource = function (url: string | URL, init?: EventSourceInit) {
      return /\/api\/(codex|claude)\/chat\//.test(String(url)) ? new FakeEventSource(String(url)) : new RealEventSource(url, init);
    } as unknown as typeof EventSource;
    Object.assign(window.EventSource, { CONNECTING: 0, OPEN: 1, CLOSED: 2 });
  });
}

/** An idle Codex thread `id` in ROOT_A; records the URL of every history read. */
async function mockCodexChat(page: Page, id: string) {
  await fakeCodexStreams(page);
  await page.route("**/api/project-scripts?*", (route) => route.fulfill({ json: { scripts: [], runner: "npm" } }));
  await page.route("**/api/codex/models?*", (route) => route.fulfill({ json: { result: { data: [] } } }));
  await page.route("**/api/codex/sessions?*", (route) => route.fulfill({ json: { sessions: [], nextCursor: null } }));
  const reads: URL[] = [];
  await page.route(`**/api/codex/chat/${id}*`, (route) => {
    if (route.request().method() === "GET") reads.push(new URL(route.request().url()));
    return route.fulfill({ json: { thread: { thread: { id, turns: [] } }, history: [], events: [] } });
  });
  return { reads };
}
```

Run: `npx playwright test e2e/background-approval.spec.ts`
Expected: PASS on chromium and mobile-chromium. Before Step 6, the second test fails because the activity center opens. Before Step 5, the first test fails because no terminal tab opens.

If ESLint reports `fakeCodexStreams`/`mockCodexChat` as unused until Task 5, add them in Task 5 Step 7 instead.

- [ ] **Step 8: Update the PRD** (`docs/prd/agent-workspace.md`).
  - Line 185: replace `（项目未打开时只标已读；终端记录只在内存中` with:

    > （项目已关闭时重新打开该项目（加回项目栏）再打开目标；终端记录只在内存中

  - Line 197: replace `找不到通知或项目未打开时打开活动中心。` with:

    > 项目已关闭时重新打开该项目再打开目标；通知已被清理（找不到）时打开活动中心。

- [ ] **Step 9: Checks and commit**

Run: `npx tsc --noEmit -p . && npx eslint lib/activity-notifications.ts components/RecentNotifications.tsx components/AppShell.tsx e2e/background-approval.spec.ts && npm test && npx playwright test e2e/background-approval.spec.ts`

```bash
git add lib/activity-notifications.ts lib/activity-notifications.test.mjs components/RecentNotifications.tsx components/AppShell.tsx e2e/background-approval.spec.ts docs/prd/agent-workspace.md
git commit -m "feat: open a closed project from its notification and focus the target"
```

---

### Task 2: The close-project confirmation counts running and waiting chats

**Problem:** Closing a project asks for confirmation only when a terminal in that exact cwd is busy (`components/ProjectRail.tsx:188-193`, using `runningByCwd[workspace.cwd]`). Three cases slip through:
- A Codex or Claude chat that is running or waiting for approval.
- A running Pi session.
- A terminal in the project root while a worktree is active.

These all close with no warning, and the user loses track of an approval that is blocking work.

**Files:**
- Modify: `lib/activity-center.ts` (add `workspaceCloseWarning`)
- Modify: `lib/activity-center.test.mjs`
- Modify: `components/ProjectRail.tsx:13,188-193`
- Modify: `hooks/useWorkspaceActivity.ts:15` (doc comment only)
- Modify: `e2e/background-approval.spec.ts`
- Modify: `docs/prd/multi-project-workspaces.md:24,65`

**Interfaces:**
- Consumes: `WorkspaceActivity.items` (`lib/rail-activity.ts:49`). Each item has `kind: "pi" | "terminal" | "codex" | "claude"` and `state: "approval" | "failed" | "working" | "completed"`. Items are grouped by `cwd === workspace.cwd || cwd === workspace.projectRoot`.
- Produces: `workspaceCloseWarning(label: string, activity: Pick<WorkspaceActivity, "items"> | undefined): string | null`

- [ ] **Step 1: Write the failing unit test.** Append to `lib/activity-center.test.mjs`. Also add `workspaceCloseWarning` to the destructured import on line 6.

```js
test("closing a workspace warns about every busy terminal, chat and Pi session", () => {
  const item = (kind, state) => ({ key: `${kind}:${state}:${Math.random()}`, kind, id: "x", label: "x", state, cwd: "/a" });
  assert.equal(workspaceCloseWarning("acme", undefined), null);
  assert.equal(workspaceCloseWarning("acme", { items: [item("terminal", "completed"), item("codex", "failed")] }), null);
  assert.equal(workspaceCloseWarning("acme", { items: [item("terminal", "working")] }), "1 terminal is still running in acme. Close the workspace tab and keep it running?");
  assert.equal(
    workspaceCloseWarning("acme", { items: [item("terminal", "working"), item("terminal", "approval"), item("codex", "approval"), item("claude", "working")] }),
    "2 terminals and 2 chats are still running in acme (2 waiting for approval). Close the workspace tab and keep them running?",
  );
  assert.equal(
    workspaceCloseWarning("acme", { items: [item("claude", "approval"), item("pi", "working"), item("terminal", "working")] }),
    "1 terminal, 1 chat and 1 Pi session are still running in acme (1 waiting for approval). Close the workspace tab and keep them running?",
  );
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --require ./server/test-env.cjs --test lib/activity-center.test.mjs`
Expected: FAIL. `workspaceCloseWarning is not a function`.

- [ ] **Step 3: Implement.** Append to `lib/activity-center.ts`:

```ts
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * The confirmation shown before closing a workspace, or null when nothing in
 * it is running or waiting. Closing never stops anything, so it lists what
 * keeps running: terminals, Codex/Claude chats and Pi sessions, in the
 * project root and in its worktrees.
 */
export function workspaceCloseWarning(label: string, activity: Pick<WorkspaceActivity, "items"> | undefined): string | null {
  const busy = (activity?.items ?? []).filter((item) => item.state === "working" || item.state === "approval");
  if (busy.length === 0) return null;
  const terminals = busy.filter((item) => item.kind === "terminal").length;
  const chats = busy.filter((item) => item.kind === "codex" || item.kind === "claude").length;
  const sessions = busy.filter((item) => item.kind === "pi").length;
  const waiting = busy.filter((item) => item.state === "approval").length;
  const parts = [terminals && plural(terminals, "terminal"), chats && plural(chats, "chat"), sessions && plural(sessions, "Pi session")].filter((part): part is string => Boolean(part));
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
  return `${list} ${busy.length === 1 ? "is" : "are"} still running in ${label}${waiting ? ` (${waiting} waiting for approval)` : ""}. Close the workspace tab and keep ${busy.length === 1 ? "it" : "them"} running?`;
}
```

- [ ] **Step 4: Run the unit test and confirm it passes**

Run: `node --require ./server/test-env.cjs --test lib/activity-center.test.mjs`
Expected: PASS.

- [ ] **Step 5: Use it in the rail.** In `components/ProjectRail.tsx`:
  - Line 13: add `workspaceCloseWarning` to the `@/lib/activity-center` import.
  - Replace `closeWorkspace` (lines 188-193) with:

```tsx
  const closeWorkspace = (workspace: ProjectWorkspace) => {
    // Counted like the rail badges: the project root and its worktrees, every kind of run.
    const warning = workspaceCloseWarning(workspace.label, activityById[workspace.id]);
    if (warning && !window.confirm(warning)) return;
    onClose(workspace);
    setRecentlyClosed(workspace);
  };
```

`runningByCwd` is still used by the mobile badge (`ProjectRail.tsx:287`). In `hooks/useWorkspaceActivity.ts:15`, change its comment to `/** Running terminals per cwd, for the mobile project badge. */`.

- [ ] **Step 6: Write the e2e test.** Append to `e2e/background-approval.spec.ts`:

```ts
test("closing a project warns about its running and waiting chats", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop rail test");
  await mockBackgroundWorkspaces(page, {
    open: [ROOT_A, ROOT_B],
    codexRuntimes: [{ threadId: "bg-codex", cwd: ROOT_B, owner: "chat", state: "running", connected: false }],
    claudeRuntimes: [{ sessionId: "bg-claude", cwd: ROOT_B, title: "Review", owner: "chat", state: "approval", connected: false }],
  });
  await page.goto("/");
  const rail = page.getByRole("navigation", { name: "Project workspaces" });
  await expect(rail.getByTitle(ROOT_B)).toBeVisible();
  const messages: string[] = [];
  page.once("dialog", (dialog) => { messages.push(dialog.message()); void dialog.dismiss(); });
  await rail.getByRole("button", { name: "Close pi-web-bg-b" }).click();
  await expect.poll(() => messages).toEqual(["2 chats are still running in pi-web-bg-b (1 waiting for approval). Close the workspace tab and keep them running?"]);
  await expect(rail.getByTitle(ROOT_B)).toBeVisible();

  page.once("dialog", (dialog) => void dialog.accept());
  await rail.getByRole("button", { name: "Close pi-web-bg-b" }).click();
  await expect(rail.getByTitle(ROOT_B)).toHaveCount(0);
});
```

Run: `npx playwright test e2e/background-approval.spec.ts`
Expected: PASS. Before Step 5, no dialog appears and the project closes at once.

- [ ] **Step 7: Update the PRD** (`docs/prd/multi-project-workspaces.md`).
  - Line 24: replace `- 关闭运行中 Terminal 的项目时先确认，但不强制停止进程。` with:

    > - 关闭项目时，如果项目（含项目根目录和各 worktree）中有运行中或等待审批的 Terminal、Codex/Claude 聊天或 Pi 会话，先确认。确认框列出各类数量和等待审批的数量，例如 “2 terminals and 1 chat are still running in acme (1 waiting for approval)”。关闭不停止任何进程。

  - Line 65: append `等待审批的聊天在关闭项目后仍保持等待，可从活动中心或通知回到它。` to the end of the line.

- [ ] **Step 8: Checks and commit**

Run: `npx tsc --noEmit -p . && npx eslint lib/activity-center.ts components/ProjectRail.tsx hooks/useWorkspaceActivity.ts e2e/background-approval.spec.ts && npm test && npx playwright test e2e/background-approval.spec.ts`

```bash
git add lib/activity-center.ts lib/activity-center.test.mjs components/ProjectRail.tsx hooks/useWorkspaceActivity.ts e2e/background-approval.spec.ts docs/prd/multi-project-workspaces.md
git commit -m "feat: count running and waiting chats when closing a project"
```

---

### Task 3: Closing a running or waiting Chat tab asks first

**Problem:** A Codex or Claude chat tab closes at once, even while its turn runs or waits for approval. `handleCloseWorkspaceTab` (`components/AppShell.tsx:661-670`) asks only for running terminals. The user gets no choice between leaving the turn running in the background and stopping it, and a pending approval disappears from view.

**What happens to the runtime.** State this in the dialog and the PRD:
- **Keep running** closes only the tab.
  - The server runtime keeps the turn going with no viewer (`codex-app-server.cjs:46-58`; Claude works the same way).
  - A pending approval stays pending and keeps the runtime alive until someone answers it. The user can answer by reopening the chat from Workspace activity, a notification or Agents.
  - After the turn ends, the runtime shuts down 30 s later if nobody is watching.
- **Stop and close** interrupts the turn, which is the same request as the chat's Stop button, and then closes the tab.
  - An interrupt that finds no active turn (`no_active_turn`) counts as success.
  - The runtime is now idle with no viewer, so it shuts down 30 s later.
- **Cancel** keeps the tab.

**Files:**
- Create: `lib/chat-tab-close.ts`
- Create: `lib/chat-tab-close.test.mjs`
- Modify: `components/AppShell.tsx`
  - `:232-234`: state
  - `:661-687`: close handlers
  - `:1553`: dialog render
  - `:1567-1577`: dialog component
- Modify: `e2e/background-approval.spec.ts`
- Modify: `docs/prd/agent-workspace.md:88,120`, `docs/prd/responsive-workspace.md:16`

**Interfaces:**
- Consumes:
  - `CodexRuntimeStatus` and `ClaudeRuntimeStatus` (`lib/workspace-status-store.ts:3-19`).
  - `useWorkspaceStatusSelector`, which AppShell already imports at line 45.
  - `CenterTab` (`lib/workspace/tabs.ts`).
- Produces:
  - `interface BusyChat { kind: "codex" | "claude"; id: string; cwd: string; state: "running" | "approval" }`
  - `busyChatForTab(tab: CenterTab, codexRuntimes: CodexRuntimeStatus[], claudeRuntimes: ClaudeRuntimeStatus[]): BusyChat | null`
  - The AppShell locals `codexRuntimes` and `claudeRuntimes`, which Task 6 reuses.

- [ ] **Step 1: Write the failing unit test** — `lib/chat-tab-close.test.mjs`

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { busyChatForTab } = await jiti.import("./chat-tab-close.ts");

const codexTab = { id: "codex-chat:t1", label: "Fix", kind: "codex-chat", sourceSessionId: "t1", cwd: "/r" };
const claudeTab = { id: "claude-chat:s1", label: "Review", kind: "claude-chat", sourceSessionId: "s1", cwd: "/r" };
const codex = (state) => [{ threadId: "t1", cwd: "/r", owner: "chat", state }];
const claude = (state) => [{ sessionId: "s1", cwd: "/r", owner: "chat", state }];

test("a chat tab is busy while its runtime runs or waits for approval", () => {
  assert.deepEqual(busyChatForTab(codexTab, codex("running"), []), { kind: "codex", id: "t1", cwd: "/r", state: "running" });
  assert.deepEqual(busyChatForTab(claudeTab, [], claude("approval")), { kind: "claude", id: "s1", cwd: "/r", state: "approval" });
});

test("idle runtimes, new chats, other tabs and other sessions are not busy", () => {
  assert.equal(busyChatForTab(codexTab, codex("idle"), []), null);
  assert.equal(busyChatForTab(codexTab, [], claude("running")), null);
  assert.equal(busyChatForTab({ ...codexTab, sourceSessionId: undefined, newChat: true }, codex("running"), []), null);
  assert.equal(busyChatForTab({ id: "pi", label: "Pi", kind: "pi" }, codex("running"), claude("running")), null);
  assert.equal(busyChatForTab({ ...claudeTab, sourceSessionId: "other" }, [], claude("running")), null);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --require ./server/test-env.cjs --test lib/chat-tab-close.test.mjs`
Expected: FAIL. Cannot find module `./chat-tab-close.ts`.

- [ ] **Step 3: Implement** — `lib/chat-tab-close.ts`

```ts
import type { ClaudeRuntimeStatus, CodexRuntimeStatus } from "./workspace-status-store";
import type { CenterTab } from "./workspace/tabs";

export interface BusyChat {
  kind: "codex" | "claude";
  /** Codex thread id or Claude session id. */
  id: string;
  cwd: string;
  state: "running" | "approval";
}

/**
 * The server runtime a chat tab would leave running if it closed, or null.
 * Decided from the pushed runtime lists, not the tab's status: a restored tab
 * is always "idle" until its panel reconnects.
 */
export function busyChatForTab(tab: CenterTab, codexRuntimes: CodexRuntimeStatus[], claudeRuntimes: ClaudeRuntimeStatus[]): BusyChat | null {
  if (tab.kind === "codex-chat" && tab.sourceSessionId) {
    const runtime = codexRuntimes.find((item) => item.threadId === tab.sourceSessionId);
    if (runtime && runtime.state !== "idle") return { kind: "codex", id: runtime.threadId, cwd: runtime.cwd, state: runtime.state };
  }
  if (tab.kind === "claude-chat" && tab.sourceSessionId) {
    const runtime = claudeRuntimes.find((item) => item.sessionId === tab.sourceSessionId);
    if (runtime && runtime.state !== "idle") return { kind: "claude", id: runtime.sessionId, cwd: runtime.cwd, state: runtime.state };
  }
  return null;
}
```

- [ ] **Step 4: Run the unit test and confirm it passes**

Run: `node --require ./server/test-env.cjs --test lib/chat-tab-close.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Ask before closing in AppShell.** In `components/AppShell.tsx`:

Add the import:

```tsx
import { busyChatForTab, type BusyChat } from "@/lib/chat-tab-close";
```

After the terminal-close state (line 234), add:

```tsx
  const codexRuntimes = useWorkspaceStatusSelector((snapshot) => snapshot.codexRuntimes);
  const claudeRuntimes = useWorkspaceStatusSelector((snapshot) => snapshot.claudeRuntimes);
  const [pendingChatClose, setPendingChatClose] = useState<{ tabId: string; label: string; chat: BusyChat } | null>(null);
```

Replace `handleCloseWorkspaceTab` (lines 661-670) with:

```tsx
  const handleCloseWorkspaceTab = useCallback((tabId: string) => {
    const tab = workspaceTabs.find((item) => item.id === tabId);
    const terminal = tab && "terminalId" in tab && tab.terminalId ? terminals[tab.terminalId] : null;
    if (terminal?.state === "running") {
      setTerminalCloseError(null);
      setPendingTerminalClose({ tabId, terminal });
      return;
    }
    const chat = tab ? busyChatForTab(tab, codexRuntimes ?? [], claudeRuntimes ?? []) : null;
    if (tab && chat) {
      setTerminalCloseError(null);
      setPendingChatClose({ tabId, label: tab.label, chat });
      return;
    }
    removeWorkspaceTab(tabId);
  }, [claudeRuntimes, codexRuntimes, removeWorkspaceTab, terminals, workspaceTabs]);
```

After `closeTerminalTab` (line 687), add:

```tsx
  // Keep running: the server runtime finishes the turn (or holds the approval)
  // with no viewer. Stop: the same interrupt as the chat's Stop button.
  const closeChatTab = useCallback(async (stop: boolean) => {
    const target = pendingChatClose;
    if (!target) return;
    if (!stop) { setPendingChatClose(null); removeWorkspaceTab(target.tabId); return; }
    setTerminalCloseBusy(true);
    setTerminalCloseError(null);
    try {
      const { chat } = target;
      const response = await fetch(`/api/${chat.kind}/chat/${encodeURIComponent(chat.id)}/interrupt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(chat.kind === "claude" ? { cwd: chat.cwd } : {}),
      });
      const data = await response.json().catch(() => ({})) as { error?: string; code?: string };
      // The turn ended meanwhile: there is nothing left to stop.
      if (!response.ok && data.code !== "no_active_turn") throw new Error(data.error || "Unable to stop the chat");
      setPendingChatClose(null);
      removeWorkspaceTab(target.tabId);
    } catch (cause) { setTerminalCloseError(cause instanceof Error ? cause.message : "Unable to stop the chat"); }
    finally { setTerminalCloseBusy(false); }
  }, [pendingChatClose, removeWorkspaceTab]);
```

- [ ] **Step 6: Share one dialog for terminals and chats.** Replace `TerminalCloseDialog` (lines 1567-1575) with `RunningCloseDialog`. The markup, the Esc handling and the styles stay the same; the label, title and description become props.

```tsx
function RunningCloseDialog({ label, title, description, busy, error, onCancel, onKeepRunning, onStop }: { label: string; title: string; description: string; busy: boolean; error: string | null; onCancel: () => void; onKeepRunning: () => void; onStop: () => void }) {
  useEffect(() => {
    if (busy) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, onCancel]);
  return <div role="dialog" aria-modal="true" aria-label={label} onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }} style={{ position: "fixed", inset: 0, zIndex: 1000, display: "grid", placeItems: "center", padding: 20, background: "rgb(0 0 0 / 55%)" }}><section style={{ width: "min(100%, 420px)", padding: 18, border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-panel)", color: "var(--text)", boxShadow: "0 20px 60px rgb(0 0 0 / 45%)" }}><strong>{title}</strong><p style={{ margin: "8px 0 0", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>{description}</p>{error && <p role="alert" style={{ color: "#f87171", fontSize: 12 }}>{error}</p>}<div style={{ display: "flex", justifyContent: "flex-end", flexWrap: "wrap", gap: 8, marginTop: 18 }}><button type="button" disabled={busy} onClick={onCancel} style={terminalCloseButtonStyle}>Cancel</button><button type="button" disabled={busy} onClick={onKeepRunning} style={terminalCloseButtonStyle}>Keep running</button><button type="button" disabled={busy} onClick={onStop} style={{ ...terminalCloseButtonStyle, color: "#ef4444", borderColor: "rgb(239 68 68 / 45%)", background: "rgb(239 68 68 / 10%)" }}>{busy ? "Stopping…" : "Stop and close"}</button></div></section></div>;
}

function chatCloseText(label: string, chat: BusyChat): { title: string; description: string } {
  const provider = chat.kind === "codex" ? "Codex" : "Claude";
  return chat.state === "approval"
    ? { title: `Close ${provider} chat?`, description: `“${label}” is waiting for your approval in ${chat.cwd}. If you keep it running, the request stays open until you answer it from the chat, which you can reopen from Workspace activity. Stop cancels the turn.` }
    : { title: `Close ${provider} chat?`, description: `“${label}” is still working in ${chat.cwd}. If you keep it running, the turn finishes in the background and you can reopen the chat from Workspace activity. Stop interrupts the turn now.` };
}
```

Replace the render at line 1553 with these two lines:

```tsx
    {pendingTerminalClose && <RunningCloseDialog label="Close terminal" title={`Close ${pendingTerminalClose.terminal.provider} terminal?`} description={`The process is still running in ${pendingTerminalClose.terminal.cwd}. You can keep it running and reopen it from Agents, or stop it now.`} busy={terminalCloseBusy} error={terminalCloseError} onCancel={() => { if (!terminalCloseBusy) setPendingTerminalClose(null); }} onKeepRunning={() => void closeTerminalTab(false)} onStop={() => void closeTerminalTab(true)} />}
    {pendingChatClose && <RunningCloseDialog label="Close chat" {...chatCloseText(pendingChatClose.label, pendingChatClose.chat)} busy={terminalCloseBusy} error={terminalCloseError} onCancel={() => { if (!terminalCloseBusy) setPendingChatClose(null); }} onKeepRunning={() => void closeChatTab(false)} onStop={() => void closeChatTab(true)} />}
```

The terminal dialog keeps its exact label and copy, so existing terminal-close tests still pass. The existing reliability test "a queue left in a closed Codex chat is paused when the chat is reopened" closes a chat mid-turn, but its status stream lists no Codex runtime, so it still closes without a dialog.

- [ ] **Step 7: Write the e2e test.** Append to `e2e/background-approval.spec.ts`:

```ts
test("closing a running or waiting chat tab asks, and Stop interrupts the turn", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop tab bar test");
  const running = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
  const waiting = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
  await mockBackgroundWorkspaces(page, {
    codexRuntimes: [
      { threadId: running, cwd: ROOT_A, owner: "chat", state: "running", connected: false },
      { threadId: waiting, cwd: ROOT_A, owner: "chat", state: "approval", connected: false },
    ],
    // Pi stays active, so no chat panel mounts and every request below comes from closing.
    tabs: { activeId: "pi", tabs: [
      { id: `codex-chat:${running}`, label: "Bg build", kind: "codex-chat", sourceSessionId: running, cwd: ROOT_A, approvalPolicy: "untrusted" },
      { id: `codex-chat:${waiting}`, label: "Bg review", kind: "codex-chat", sourceSessionId: waiting, cwd: ROOT_A, approvalPolicy: "untrusted" },
    ] },
  });
  const interrupts: string[] = [];
  await page.route("**/api/codex/chat/*/interrupt", (route) => {
    interrupts.push(new URL(route.request().url()).pathname.split("/")[4]);
    return route.fulfill({ json: { result: {} } });
  });
  await page.goto("/");
  const tabs = page.locator(".center-workspace");
  const dialog = page.getByRole("dialog", { name: "Close chat" });

  // Cancel keeps the tab.
  await tabs.getByRole("button", { name: "Close Bg build" }).click();
  await expect(dialog).toContainText("“Bg build” is still working in /tmp/pi-web-bg-a");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(tabs.getByRole("tab", { name: /Bg build/ })).toBeVisible();

  // Keep running closes the tab and stops nothing.
  await tabs.getByRole("button", { name: "Close Bg build" }).click();
  await dialog.getByRole("button", { name: "Keep running" }).click();
  await expect(tabs.getByRole("tab", { name: /Bg build/ })).toHaveCount(0);
  expect(interrupts).toEqual([]);

  // Stop and close interrupts the waiting turn first.
  await tabs.getByRole("button", { name: "Close Bg review" }).click();
  await expect(dialog).toContainText("waiting for your approval");
  await dialog.getByRole("button", { name: "Stop and close" }).click();
  await expect.poll(() => interrupts).toEqual([waiting]);
  await expect(tabs.getByRole("tab", { name: /Bg review/ })).toHaveCount(0);
});
```

Run: `npx playwright test e2e/background-approval.spec.ts`
Expected: PASS. Before Step 5, the tab closes without a dialog.

- [ ] **Step 8: Update the PRDs**
  - `docs/prd/agent-workspace.md:88` (Codex runtime): append to the end of the line:

    > 关闭运行中或等待审批的聊天标签时先确认（对话框 “Close chat”）：Cancel 保留标签；Keep running 只关标签，这一轮在后台继续，审批保持等待并让运行时一直保留，可从活动中心、通知或 Agents 重新打开聊天来回复，一轮结束后无人查看时 30 秒关闭运行时；Stop and close 先中断这一轮（与聊天里的 Stop 相同，已没有进行中的一轮也算成功）再关标签，之后运行时空闲 30 秒关闭。是否运行按状态流中的运行时判断，不看标签状态。

  - `docs/prd/agent-workspace.md:120` (Claude idle): append `关闭运行中或等待审批的 Claude 聊天标签时与 Codex 聊天相同，先确认 Keep running / Stop and close。`
  - `docs/prd/responsive-workspace.md:16`: append `关闭运行中的终端标签或运行中、等待审批的聊天标签前先确认，可选择保持运行或停止。`

- [ ] **Step 9: Checks and commit**

Run: `npx tsc --noEmit -p . && npx eslint lib/chat-tab-close.ts components/AppShell.tsx e2e/background-approval.spec.ts && npm test && npx playwright test e2e/background-approval.spec.ts`

```bash
git add lib/chat-tab-close.ts lib/chat-tab-close.test.mjs components/AppShell.tsx e2e/background-approval.spec.ts docs/prd/agent-workspace.md docs/prd/responsive-workspace.md
git commit -m "feat: confirm before closing a running or waiting chat tab"
```

---

### Task 4: The browser tab title shows waiting approvals or unread notifications

**Problem:** The browser tab title is always `<project> - TianForge pi` (`components/AppShell.tsx:1064-1065`). A user working in another browser tab cannot see that a chat is waiting for approval, even though `approvalCount` is already computed at `AppShell.tsx:1056`.

**Files:**
- Create: `lib/window-title.ts`
- Create: `lib/window-title.test.mjs`
- Modify: `components/AppShell.tsx:1064-1076`
- Modify: `e2e/background-approval.spec.ts`
- Modify: `docs/prd/agent-workspace.md:184`

**Interfaces:**
- Consumes:
  - `approvalCount` (`AppShell.tsx:1056`), which counts across every open workspace.
  - `snapshot.unreadNotifications: number` (`lib/workspace-status-store.ts:48`).
- Produces: `windowTitle(input: { cwdName: string | null; approvals: number; unread: number }): string`

- [ ] **Step 1: Write the failing unit test** — `lib/window-title.test.mjs`

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { windowTitle } = await jiti.import("./window-title.ts");

test("the title is the project, then the product", () => {
  assert.equal(windowTitle({ cwdName: "acme", approvals: 0, unread: 0 }), "acme - TianForge pi");
  assert.equal(windowTitle({ cwdName: null, approvals: 0, unread: 0 }), "TianForge pi");
});

test("waiting approvals come first, else unread notifications", () => {
  assert.equal(windowTitle({ cwdName: "acme", approvals: 2, unread: 5 }), "(2 waiting) acme - TianForge pi");
  assert.equal(windowTitle({ cwdName: "acme", approvals: 0, unread: 3 }), "(3) acme - TianForge pi");
  assert.equal(windowTitle({ cwdName: null, approvals: 1, unread: 0 }), "(1 waiting) TianForge pi");
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --require ./server/test-env.cjs --test lib/window-title.test.mjs`
Expected: FAIL. Cannot find module `./window-title.ts`.

- [ ] **Step 3: Implement** — `lib/window-title.ts`

```ts
/**
 * The browser tab title. Approvals waiting in any workspace come first because
 * they block work; otherwise the unread notification count.
 */
export function windowTitle({ cwdName, approvals, unread }: { cwdName: string | null; approvals: number; unread: number }): string {
  const base = cwdName ? `${cwdName} - TianForge pi` : "TianForge pi";
  if (approvals > 0) return `(${approvals} waiting) ${base}`;
  if (unread > 0) return `(${unread}) ${base}`;
  return base;
}
```

- [ ] **Step 4: Run the unit test and confirm it passes**

Run: `node --require ./server/test-env.cjs --test lib/window-title.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Use it in AppShell.** Add `import { windowTitle } from "@/lib/window-title";`. Replace line 1065 and the effect below it (lines 1065-1076); the local is renamed so it does not shadow the import.

```tsx
  const unreadNotifications = useWorkspaceStatusSelector((snapshot) => snapshot.unreadNotifications);
  const documentTitle = windowTitle({ cwdName: activeCwdName, approvals: approvalCount, unread: unreadNotifications });

  useEffect(() => {
    const syncWindowTitle = () => {
      if (document.title !== documentTitle) document.title = documentTitle;
    };

    syncWindowTitle();
    const observer = new MutationObserver(syncWindowTitle);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [documentTitle]);
```

The hook call sits among the other top-level hooks of the component, before any early return. Check that no `return` comes before line 1064; there is none today.

- [ ] **Step 6: Write the e2e test.** Append to `e2e/background-approval.spec.ts`:

```ts
test("the browser tab title shows waiting approvals, else unread notifications", async ({ page }) => {
  await mockBackgroundWorkspaces(page, {
    open: [ROOT_A, ROOT_B],
    codexRuntimes: [{ threadId: "bg-waiting", cwd: ROOT_B, owner: "chat", state: "approval", connected: false }],
    unread: 4,
  });
  await page.goto("/");
  await expect(page).toHaveTitle("(1 waiting) pi-web-bg-a - TianForge pi");
});

test("the browser tab title shows unread notifications when nothing is waiting", async ({ page }) => {
  await mockBackgroundWorkspaces(page, { unread: 3 });
  await page.goto("/");
  await expect(page).toHaveTitle("(3) pi-web-bg-a - TianForge pi");
});
```

`e2e/app-shell.spec.ts:84` checks `toHaveTitle(/TianForge pi/)`, which still matches.

Run: `npx playwright test e2e/background-approval.spec.ts`
Expected: PASS.

- [ ] **Step 7: Update the PRD** (`docs/prd/agent-workspace.md:184`). Append to the end of the line:

  > 浏览器标签标题：有等待审批的任务时为 “(N waiting) <项目> - TianForge pi”（N 为所有项目的等待数），否则有未读通知时为 “(N) <项目> - TianForge pi”，都没有时为 “<项目> - TianForge pi”。

- [ ] **Step 8: Checks and commit**

Run: `npx tsc --noEmit -p . && npx eslint lib/window-title.ts components/AppShell.tsx e2e/background-approval.spec.ts && npm test && npx playwright test e2e/background-approval.spec.ts`

```bash
git add lib/window-title.ts lib/window-title.test.mjs components/AppShell.tsx e2e/background-approval.spec.ts docs/prd/agent-workspace.md
git commit -m "feat: show waiting approvals and unread notifications in the browser tab title"
```

---

### Task 5: Switching a Chat to Full access or Bypass permissions uses the dangerous-permission confirmation

**Problem:** In a chat's "Next turn settings" menu, choosing Codex "Full access" (`never`) or Claude "Bypass permissions" takes effect at once (`components/agents/codex/CodexAssistantThread.tsx:206`). Running a dangerous-bypass template from Agents asks first (`components/agents/AgentsPanel.tsx:880-882`, "Run anyway"). The same risk in a chat should get the same confirmation, with the same wording and dialog.

**Files:**
- Create: `lib/chat-permissions.ts`
- Create: `lib/chat-permissions.test.mjs`
- Create: `components/agents/ConfirmDialog.tsx`, the dialog extracted from `AgentActionDialog` (`AgentsPanel.tsx:845-862`)
- Modify: `components/agents/AgentsPanel.tsx:845-862,880-882,1152-1161`
- Modify: `components/agents/codex/CodexAssistantThread.tsx:5,128-130,137-145,203-208`
- Modify: `components/agents/claude/ClaudeChatPanel.tsx:10,20`
- Modify: `e2e/background-approval.spec.ts`
- Modify: `docs/prd/agent-workspace.md:90,136`

**Interfaces:**
- Consumes: `useDialogEscape(onCancel, disabled)` (`components/agents/use-dialog-escape.ts`). It handles Esc in the capture phase and stops propagation, so the composer's own Esc handler never also fires. Every dialog sets `aria-modal`, so the global Esc-to-abort skips it (P0 Task 1).
- Produces:
  - In `lib/chat-permissions.ts`:
    - `type PermissionOption = { value: string; label: string; danger?: string }`
    - `dangerousPermissionWarning(provider: "codex" | "claude", where: "terminal" | "chat"): string`
    - `CODEX_CHAT_PERMISSION_OPTIONS`
    - `CLAUDE_CHAT_PERMISSION_OPTIONS`
  - In `components/agents/ConfirmDialog.tsx`:
    - `ConfirmDialog(props: { title: string; description: string; confirmLabel: string; destructive?: boolean; busy?: boolean; confirmDisabled?: boolean; onCancel: () => void; onConfirm: () => void; children?: ReactNode })`
    - `dialogOverlayStyle`, `dialogStyle`, `dialogButtonStyle`

- [ ] **Step 1: Write the failing unit test** — `lib/chat-permissions.test.mjs`

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { CLAUDE_CHAT_PERMISSION_OPTIONS, CODEX_CHAT_PERMISSION_OPTIONS, dangerousPermissionWarning } = await jiti.import("./chat-permissions.ts");

test("the terminal warnings keep the template-run wording", () => {
  assert.equal(dangerousPermissionWarning("codex", "terminal"), "Codex skips all approval and sandboxing in this terminal, so it may edit files and run commands without asking.");
  assert.equal(dangerousPermissionWarning("claude", "terminal"), "Claude skips its permission confirmations in this terminal, so it may edit files and run commands without asking.");
});

test("only Full access and Bypass permissions are dangerous in a chat", () => {
  assert.deepEqual(CODEX_CHAT_PERMISSION_OPTIONS.filter((option) => option.danger).map((option) => option.value), ["never"]);
  assert.deepEqual(CLAUDE_CHAT_PERMISSION_OPTIONS.filter((option) => option.danger).map((option) => option.value), ["bypassPermissions"]);
  assert.equal(CODEX_CHAT_PERMISSION_OPTIONS.find((option) => option.value === "never").danger, "Codex stops asking for approval in this chat, so it may edit files and run commands without asking.");
  assert.equal(CLAUDE_CHAT_PERMISSION_OPTIONS.find((option) => option.value === "bypassPermissions").danger, dangerousPermissionWarning("claude", "chat"));
  // Labels and order are unchanged.
  assert.deepEqual(CODEX_CHAT_PERMISSION_OPTIONS.map((option) => option.label), ["Restricted", "Ask when needed", "Full access"]);
  assert.deepEqual(CLAUDE_CHAT_PERMISSION_OPTIONS.map((option) => option.label), ["Ask before edits", "Accept edits", "Plan mode", "Bypass permissions"]);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --require ./server/test-env.cjs --test lib/chat-permissions.test.mjs`
Expected: FAIL. Cannot find module `./chat-permissions.ts`.

- [ ] **Step 3: Implement** — `lib/chat-permissions.ts`

```ts
/** A chat permission choice; `danger` is the confirmation text shown before switching to it. */
export type PermissionOption = { value: string; label: string; danger?: string };

/**
 * One wording for every dangerous permission: bypass templates in terminals
 * (Agents "Run anyway") and Full access / Bypass permissions in chats.
 */
export function dangerousPermissionWarning(provider: "codex" | "claude", where: "terminal" | "chat"): string {
  if (provider === "claude") return `Claude skips its permission confirmations in this ${where}, so it may edit files and run commands without asking.`;
  // A Codex chat keeps its sandbox; only the approval prompts stop.
  return where === "terminal"
    ? "Codex skips all approval and sandboxing in this terminal, so it may edit files and run commands without asking."
    : "Codex stops asking for approval in this chat, so it may edit files and run commands without asking.";
}

export const CODEX_CHAT_PERMISSION_OPTIONS: PermissionOption[] = [
  { value: "untrusted", label: "Restricted" },
  { value: "on-request", label: "Ask when needed" },
  { value: "never", label: "Full access", danger: dangerousPermissionWarning("codex", "chat") },
];

export const CLAUDE_CHAT_PERMISSION_OPTIONS: PermissionOption[] = [
  { value: "default", label: "Ask before edits" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "plan", label: "Plan mode" },
  { value: "bypassPermissions", label: "Bypass permissions", danger: dangerousPermissionWarning("claude", "chat") },
];
```

- [ ] **Step 4: Run the unit test and confirm it passes**

Run: `node --require ./server/test-env.cjs --test lib/chat-permissions.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Extract the dialog.** Create `components/agents/ConfirmDialog.tsx`. It contains the markup of `AgentActionDialog` (`AgentsPanel.tsx:851-861`) and the three styles moved from `AgentsPanel.tsx:1152,1153,1161`.

```tsx
"use client";

import type { CSSProperties, ReactNode } from "react";
import { useDialogEscape } from "./use-dialog-escape";

export const dialogOverlayStyle: CSSProperties = { position: "fixed", inset: 0, zIndex: 1000, display: "grid", placeItems: "center", padding: 20, background: "rgb(0 0 0 / 55%)" };
export const dialogStyle: CSSProperties = { width: "min(100%, 460px)", maxHeight: "min(720px, 90vh)", overflowY: "auto", padding: 18, border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-panel)", color: "var(--text)", boxShadow: "0 20px 60px rgb(0 0 0 / 45%)" };
export const dialogButtonStyle: CSSProperties = { padding: "6px 9px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-hover)", color: "var(--text)", cursor: "pointer", font: "11.5px/1.3 inherit" };

/** A modal yes/no question; destructive confirms are red. Esc and a click outside cancel. */
export function ConfirmDialog({ title, description, confirmLabel, destructive = false, busy = false, confirmDisabled = busy, onCancel, onConfirm, children }: { title: string; description: string; confirmLabel: string; destructive?: boolean; busy?: boolean; confirmDisabled?: boolean; onCancel: () => void; onConfirm: () => void; children?: ReactNode }) {
  useDialogEscape(onCancel, busy);
  return <div role="dialog" aria-modal="true" aria-label={title} style={dialogOverlayStyle} onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
    <section style={{ ...dialogStyle, width: "min(100%, 400px)" }}>
      <strong style={{ display: "block", fontSize: 14 }}>{title}</strong>
      <p style={{ margin: "8px 0 0", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>{description}</p>
      {children}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <button type="button" disabled={busy} onClick={onCancel} style={dialogButtonStyle}>Cancel</button>
        <button type="button" disabled={confirmDisabled} onClick={onConfirm} style={{ ...dialogButtonStyle, borderColor: destructive ? "rgb(239 68 68 / 45%)" : "var(--accent)", background: destructive ? "rgb(239 68 68 / 10%)" : "var(--accent)", color: destructive ? "#ef4444" : "white", opacity: confirmDisabled ? .5 : 1 }}>{busy ? "Working…" : confirmLabel}</button>
      </div>
    </section>
  </div>;
}
```

Check the three style lines against the current `AgentsPanel.tsx:1152,1153,1161`. Copy those lines exactly if they differ from the above.

In `components/agents/AgentsPanel.tsx`:
- Delete the three style constants at lines 1152, 1153 and 1161.
- Add these imports:

```tsx
import { ConfirmDialog, dialogButtonStyle, dialogOverlayStyle, dialogStyle } from "./ConfirmDialog";
import { dangerousPermissionWarning } from "@/lib/chat-permissions";
```

- Replace `AgentActionDialog` (lines 845-862) with:

```tsx
function AgentActionDialog({ action, renameValue, busy, onRenameChange, onCancel, onConfirm }: { action: PendingAction; renameValue: string; busy: boolean; onRenameChange: (value: string) => void; onCancel: () => void; onConfirm: () => void }) {
  const rename = action.kind === "session" && action.action === "rename";
  const destructive = action.kind === "session" && action.action === "delete" || action.kind === "claude-session" || action.kind === "terminal" || action.kind === "clear" || action.kind === "template";
  const { title, description, confirmLabel } = actionDialogText(action);
  const confirmDisabled = busy || rename && (!renameValue.trim() || renameValue.trim() === action.session.name);
  return <ConfirmDialog title={title} description={description} confirmLabel={confirmLabel} destructive={destructive} busy={busy} confirmDisabled={confirmDisabled} onCancel={onCancel} onConfirm={onConfirm}>
    {rename && <input autoFocus value={renameValue} maxLength={120} onChange={(event) => onRenameChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !confirmDisabled) onConfirm(); }} style={{ ...inputStyle, marginTop: 14 }} />}
  </ConfirmDialog>;
}
```

- In `actionDialogText`, change the template-run description (line 881) to:

```tsx
        ? { title: `Run “${action.template.name}” with dangerous bypass`, description: dangerousPermissionWarning(action.template.provider === "codex" ? "codex" : "claude", "terminal"), confirmLabel: "Run anyway" }
```

The text is unchanged; the unit test pins it. `useDialogEscape` is still used by `ClaudeLaunchDialog` and the Codex launch dialog (`:896,:935`), so keep its import.

- [ ] **Step 6: Confirm in the composer.** In `components/agents/codex/CodexAssistantThread.tsx`:
  - Add the imports:

```tsx
import { createPortal } from "react-dom";
import { CODEX_CHAT_PERMISSION_OPTIONS, type PermissionOption } from "@/lib/chat-permissions";
import { ConfirmDialog } from "../ConfirmDialog";
```

  - Replace lines 128-129 (the local `PermissionOption` type and `CODEX_PERMISSION_OPTIONS`) with:

```tsx
export type { PermissionOption };
```

  - At line 219, change the default `permissionOptions = CODEX_PERMISSION_OPTIONS` to `permissionOptions = CODEX_CHAT_PERMISSION_OPTIONS`.
  - In `DraftComposer`, after `const [configMenuOpen, setConfigMenuOpen] = useState(false);` (line 138), add:

```tsx
  // A dangerous permission waits here until confirmed; the select stays on the current value.
  const [pendingPermission, setPendingPermission] = useState<PermissionOption | null>(null);
  const choosePermission = (value: string) => {
    const option = permissionOptions.find((candidate) => candidate.value === value);
    if (!option?.danger) { onApprovalPolicyChange(value); return; }
    setConfigMenuOpen(false);
    setPendingPermission(option);
  };
```

  - In the Permissions select (line 206), change `onChange={(event) => onApprovalPolicyChange(event.target.value)}` to `onChange={(event) => choosePermission(event.target.value)}`.
  - Just before the closing `</form>` of `DraftComposer`'s return (line 217), add:

```tsx
    {pendingPermission && createPortal(<ConfirmDialog
      title={`Switch to ${pendingPermission.label}?`}
      description={pendingPermission.danger ?? ""}
      confirmLabel="Switch anyway"
      destructive
      onCancel={() => setPendingPermission(null)}
      onConfirm={() => { onApprovalPolicyChange(pendingPermission.value); setPendingPermission(null); }}
    />, document.body)}
```

The portal keeps the fixed overlay out of the composer's layout and its `overflow`. The select is controlled by `approvalPolicy`, so Cancel leaves it unchanged.

In `components/agents/claude/ClaudeChatPanel.tsx`:
- Line 10: drop `type PermissionOption` from the Codex thread import.
- Line 20: replace the local list with `const PERMISSION_OPTIONS = CLAUDE_CHAT_PERMISSION_OPTIONS;`.
- Add `import { CLAUDE_CHAT_PERMISSION_OPTIONS } from "@/lib/chat-permissions";`.

`isPermissionMode` and `approvalLabel` keep working because the values and labels are the same.

- [ ] **Step 7: Write the e2e test.** Append to `e2e/background-approval.spec.ts`:

```ts
test("switching a chat to Full access asks with the dangerous-permission confirmation", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop chat test");
  const id = "cccccccc-3333-4333-8333-cccccccccccc";
  await mockBackgroundWorkspaces(page, { tabs: { activeId: `codex-chat:${id}`, tabs: [
    { id: `codex-chat:${id}`, label: "Perm chat", kind: "codex-chat", sourceSessionId: id, cwd: ROOT_A, approvalPolicy: "untrusted" },
  ] } });
  await mockCodexChat(page, id);
  await page.goto("/");
  await expect(page.getByPlaceholder("Message… Type / for commands", { exact: true })).toBeVisible();
  const config = page.locator('button[title="Chat configuration"]');
  const dialog = page.getByRole("dialog", { name: "Switch to Full access?" });

  // Cancel keeps Restricted.
  await config.click();
  await page.getByLabel("Permissions").selectOption("never");
  await expect(dialog).toContainText("Codex stops asking for approval in this chat");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(config).toHaveText("Restricted");

  // Switch anyway applies it.
  await config.click();
  await page.getByLabel("Permissions").selectOption("never");
  await dialog.getByRole("button", { name: "Switch anyway" }).click();
  await expect(config).toHaveText("Full access");

  // Safer choices need no confirmation.
  await config.click();
  await page.getByLabel("Permissions").selectOption("on-request");
  await expect(page.getByRole("dialog", { name: /^Switch to/ })).toHaveCount(0);
  await expect(config).toHaveText("Ask when needed");
});
```

The existing Claude chat e2e (`e2e/app-shell.spec.ts:1859-1860`) selects `plan`, which is not dangerous, so it is unaffected. Also run `npx playwright test e2e/app-shell.spec.ts -g "Run anyway|template"` to check the template-run dialog, which now renders through `ConfirmDialog`.

Run: `npx playwright test e2e/background-approval.spec.ts e2e/app-shell.spec.ts`
Expected: PASS.

- [ ] **Step 8: Update the PRD** (`docs/prd/agent-workspace.md`).
  - After line 90 (the Codex new-chat bullet), add a new bullet:

    > - 聊天设置（输入框下方 “Chat configuration” 菜单，“Next turn settings”）的权限：Restricted（`untrusted`）/ Ask when needed（`on-request`）/ Full access（`never`），作用于下一轮。选 Full access 前弹出与危险模板运行相同的确认框（“Switch to Full access?”，说明 “Codex stops asking for approval in this chat, so it may edit files and run commands without asking.”，确认按钮 “Switch anyway”）；取消则保持原设置。

  - Line 136: append `选 Bypass permissions 前同样先确认（“Switch to Bypass permissions?”，说明 Claude 在此聊天中跳过权限确认）。`

- [ ] **Step 9: Checks and commit**

Run: `npx tsc --noEmit -p . && npx eslint lib/chat-permissions.ts components/agents/ConfirmDialog.tsx components/agents/AgentsPanel.tsx components/agents/codex/CodexAssistantThread.tsx components/agents/claude/ClaudeChatPanel.tsx e2e/background-approval.spec.ts && npm test && npx playwright test e2e/background-approval.spec.ts e2e/app-shell.spec.ts`

```bash
git add lib/chat-permissions.ts lib/chat-permissions.test.mjs components/agents/ConfirmDialog.tsx components/agents/AgentsPanel.tsx components/agents/codex/CodexAssistantThread.tsx components/agents/claude/ClaudeChatPanel.tsx e2e/background-approval.spec.ts docs/prd/agent-workspace.md
git commit -m "feat: confirm dangerous permissions in chats with the bypass dialog"
```

---

### Task 6: A chat reopened from a notification keeps its model and permission

**Problem:** When a notification or activity item opens a chat that has no tab, the settings it opens with are wrong:
- Codex opens with `approvalPolicy: "untrusted"` and no model (`components/AppShell.tsx:959`). A chat running with Full access and a chosen model comes back as Restricted on the default model, and its next turn is sent with those settings.
- Claude opens with neither setting (`AppShell.tsx:951`). The panel adopts the permission mode once it loads (`ClaudeChatPanel.tsx:173-174`) but not the model, so the next message restarts Claude on the default model.

A saved tab already keeps its settings, so this task covers only reopening without a tab. The browser does not keep those settings, so they come from the live runtime on the status stream.

**Files:**
- Modify: `server/agents/codex-app-server.cjs:156-167,169-184,185,252-258`
- Modify: `server/agents/codex-chat-runtime.test.cjs`
- Modify: `server/agents/claude-chat-runtime.cjs:231-235,498-500`
- Modify: `server/agents/claude-chat.test.cjs:231-240`
- Modify: `lib/workspace-status-store.ts:3-19`
- Create: `lib/chat-reopen.ts`
- Create: `lib/chat-reopen.test.mjs`
- Modify: `components/AppShell.tsx:949-961`
- Modify: `e2e/background-approval.spec.ts`
- Modify: `docs/prd/agent-workspace.md:88,154,155`

**Interfaces:**
- Consumes: the `codexRuntimes` and `claudeRuntimes` locals added to AppShell in Task 3; `CodexChatTarget` and `ClaudeChatTarget` (`components/workspace/WorkspaceActions.tsx:7-24`).
- Produces:
  - Each `codex_runtimes` entry gains `settings: { model: string | null; reasoningEffort: string | null; serviceTier: string | null; approvalPolicy: string }`.
  - Each `claude_runtimes` entry gains `model: string | null` (the alias Claude was launched with, e.g. `"haiku"`; null means default) and `permissionMode: string | null`.
  - `codexReopenSettings(runtime?: Pick<CodexRuntimeStatus, "settings"> | null): { approvalPolicy: CodexApprovalPolicy; model?: string; reasoningEffort?: string; serviceTier?: string }`
  - `claudeReopenSettings(runtime?: Pick<ClaudeRuntimeStatus, "model" | "permissionMode"> | null): { permissionMode: ClaudePermissionMode; model?: string }`

- [ ] **Step 1: Write the failing server tests.**

In `server/agents/codex-chat-runtime.test.cjs`, add after the test "a new chat starts a thread…" (line 125):

```js
test("the runtime list carries the settings the chat last used", async (t) => {
  const { dir } = useFakeRuntime(t);
  const runtime = appServer.start({ threadId: ID, cwd: dir, model: "gpt-a", approvalPolicy: "on-request" });
  await runtime.ready;
  assert.deepEqual(appServer.listRuntimes().find((entry) => entry.threadId === ID).settings, { model: "gpt-a", reasoningEffort: null, serviceTier: null, approvalPolicy: "on-request" });
  // A turn's non-empty settings replace them; empty ones keep the last value.
  await appServer.prompt(runtime, "long task", "gpt-b", "never", [], null, "high", null);
  assert.deepEqual(appServer.listRuntimes().find((entry) => entry.threadId === ID).settings, { model: "gpt-b", reasoningEffort: "high", serviceTier: null, approvalPolicy: "never" });
  // Reading again with other settings does not change a running runtime.
  appServer.start({ threadId: ID, cwd: dir, approvalPolicy: "untrusted" });
  assert.equal(appServer.listRuntimes().find((entry) => entry.threadId === ID).settings.approvalPolicy, "never");
  await appServer.interrupt(runtime);
});

test("a new chat's runtime lists the settings it was created with", async (t) => {
  const { dir } = useFakeRuntime(t);
  const runtime = await appServer.create({ cwd: dir, model: "gpt-test", serviceTier: "flex", approvalPolicy: "never" });
  t.after(() => appServer.stopAndWait(runtime.threadId));
  assert.deepEqual(appServer.listRuntimes().find((entry) => entry.threadId === runtime.threadId).settings, { model: "gpt-test", reasoningEffort: null, serviceTier: "flex", approvalPolicy: "never" });
});
```

In `server/agents/claude-chat.test.cjs`, change the expectation at line 239 to:

```js
  assert.deepEqual(workspaceStatus.snapshot("claude_runtimes"), { type: "claude_runtimes", runtimes: [{ sessionId: ID, cwd, title: "hello", owner: "chat", state: "idle", connected: true, model: null, permissionMode: "default" }] });
```

Then add this test after it:

```js
test("the status stream lists the model and permission a chat runs with", async (t) => {
  const { cwd } = useFakeClaude(t);
  const state = chat.open(ID, cwd);
  const { events, off } = collect(state);
  t.after(off);
  await chat.send(state, { text: "hello", model: "haiku", permissionMode: "plan" });
  await waitFor(() => events.some((event) => event.type === "result"));
  const [runtime] = workspaceStatus.snapshot("claude_runtimes").runtimes;
  assert.deepEqual([runtime.model, runtime.permissionMode], ["haiku", "plan"]);
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `node --require ./server/test-env.cjs --test server/agents/codex-chat-runtime.test.cjs server/agents/claude-chat.test.cjs`
Expected: FAIL.
- In the Codex tests, `settings` is `undefined`.
- In the Claude tests, the deepEqual is missing `model` and `permissionMode`.

- [ ] **Step 3: Implement on the server.**

`server/agents/codex-app-server.cjs`:

1. In `start` (line 159-160), record the settings on a new runtime before it is announced. Replace `const state = spawnRuntime(threadId, cwd);` with:

```js
  const state = spawnRuntime(threadId, cwd);
  // What a chat reopened without its tab should show (listed on codex_runtimes).
  state.settings = { model: model || null, reasoningEffort: null, serviceTier: serviceTier || null, approvalPolicy };
```

2. In `create`, right after `const state = spawnRuntime(null, cwd);` (line 170), add:

```js
  state.settings = { model: model || null, reasoningEffort: null, serviceTier: serviceTier || null, approvalPolicy };
```

3. In `prompt` (line 185), insert this right after `if (!state.title && text) state.title = text;`. It must come before the `workspaceStatus.notify("codex_runtimes")` that `prompt` already makes.

```js
 if (state.settings) { if (model) state.settings.model = model; if (effort) state.settings.reasoningEffort = effort; if (serviceTier) state.settings.serviceTier = serviceTier; if (approvalPolicy) state.settings.approvalPolicy = approvalPolicy; }
```

4. In `listRuntimes` (lines 252-258), add `settings: state.settings ?? null,` after `cwd: state.cwd,`.

`turnOptions` (`codex-app-api.cjs:79-85`) turns an empty model into `null`. Choosing "Default" after a named model therefore keeps listing the named model until the runtime restarts. Accept that; the chat itself still sends what it shows.

`server/agents/claude-chat-runtime.cjs`:

1. `listRuntimes` (lines 498-500):

```js
function listRuntimes() {
  // model: the alias the process was launched with (null = default), so a chat reopened without its tab keeps it.
  return [...sessions.values()].filter((state) => state.child).map((state) => ({ sessionId: state.sessionId, cwd: state.cwd, title: state.title || null, ...runtimeForSession(state.sessionId), model: state.launchModel || null, permissionMode: state.permissionMode || null }));
}
```

2. In the `status` branch (line 234), push a permission mode change that Claude reports (e.g. after `ExitPlanMode`). Replace `if (mode) state.permissionMode = mode;` with:

```js
      if (mode) { state.permissionMode = mode; workspaceStatus.notify("claude_runtimes"); }
```

- [ ] **Step 4: Run the server tests and confirm they pass**

Run: `node --require ./server/test-env.cjs --test server/agents/codex-chat-runtime.test.cjs server/agents/claude-chat.test.cjs`
Expected: PASS.

- [ ] **Step 5: Extend the status types.** In `lib/workspace-status-store.ts`:
  - Add to `CodexRuntimeStatus` (after `connected?`):

```ts
  /** The settings the chat last ran with; missing from older servers. */
  settings?: { model: string | null; reasoningEffort: string | null; serviceTier: string | null; approvalPolicy: string } | null;
```

  - Add to `ClaudeRuntimeStatus`:

```ts
  /** The model alias the process was launched with; null = default. */
  model?: string | null;
  permissionMode?: string | null;
```

- [ ] **Step 6: Write the failing unit test** — `lib/chat-reopen.test.mjs`

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { claudeReopenSettings, codexReopenSettings } = await jiti.import("./chat-reopen.ts");

test("a Codex chat reopens with its runtime's settings, else Restricted and the default model", () => {
  assert.deepEqual(codexReopenSettings({ settings: { model: "gpt-5.5", reasoningEffort: "high", serviceTier: null, approvalPolicy: "never" } }), { approvalPolicy: "never", model: "gpt-5.5", reasoningEffort: "high" });
  assert.deepEqual(codexReopenSettings(undefined), { approvalPolicy: "untrusted" });
  assert.deepEqual(codexReopenSettings({ settings: null }), { approvalPolicy: "untrusted" });
  // The status stream is not validated: an unknown policy falls back.
  assert.deepEqual(codexReopenSettings({ settings: { model: null, reasoningEffort: null, serviceTier: "flex", approvalPolicy: "yolo" } }), { approvalPolicy: "untrusted", serviceTier: "flex" });
});

test("a Claude chat reopens with its runtime's model and permission, else the defaults", () => {
  assert.deepEqual(claudeReopenSettings({ model: "opus", permissionMode: "bypassPermissions" }), { permissionMode: "bypassPermissions", model: "opus" });
  assert.deepEqual(claudeReopenSettings({ model: null, permissionMode: "plan" }), { permissionMode: "plan" });
  assert.deepEqual(claudeReopenSettings(null), { permissionMode: "default" });
  assert.deepEqual(claudeReopenSettings({ model: "", permissionMode: "yolo" }), { permissionMode: "default" });
});
```

Run: `node --require ./server/test-env.cjs --test lib/chat-reopen.test.mjs`
Expected: FAIL. Cannot find module `./chat-reopen.ts`.

- [ ] **Step 7: Implement** — `lib/chat-reopen.ts`

```ts
import type { ClaudeRuntimeStatus, CodexRuntimeStatus } from "./workspace-status-store";
import type { ClaudePermissionMode, CodexApprovalPolicy } from "./workspace/tabs";

const CODEX_POLICIES: readonly string[] = ["untrusted", "on-request", "never"] satisfies CodexApprovalPolicy[];
const CLAUDE_MODES: readonly string[] = ["default", "acceptEdits", "plan", "bypassPermissions"] satisfies ClaudePermissionMode[];

/** Settings for a Codex chat opened without a tab: its live runtime's, else a new chat's defaults. */
export function codexReopenSettings(runtime?: Pick<CodexRuntimeStatus, "settings"> | null): { approvalPolicy: CodexApprovalPolicy; model?: string; reasoningEffort?: string; serviceTier?: string } {
  const settings = runtime?.settings;
  const approvalPolicy = settings && CODEX_POLICIES.includes(settings.approvalPolicy) ? settings.approvalPolicy as CodexApprovalPolicy : "untrusted";
  return {
    approvalPolicy,
    ...(settings?.model ? { model: settings.model } : {}),
    ...(settings?.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
    ...(settings?.serviceTier ? { serviceTier: settings.serviceTier } : {}),
  };
}

/** Settings for a Claude chat opened without a tab: its live process's, else a new chat's defaults. */
export function claudeReopenSettings(runtime?: Pick<ClaudeRuntimeStatus, "model" | "permissionMode"> | null): { permissionMode: ClaudePermissionMode; model?: string } {
  const permissionMode = runtime?.permissionMode && CLAUDE_MODES.includes(runtime.permissionMode) ? runtime.permissionMode as ClaudePermissionMode : "default";
  return { permissionMode, ...(runtime?.model ? { model: runtime.model } : {}) };
}
```

Run: `node --require ./server/test-env.cjs --test lib/chat-reopen.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 8: Use it when reopening.** In `components/AppShell.tsx`, add `import { claudeReopenSettings, codexReopenSettings } from "@/lib/chat-reopen";`. Then replace the Claude and Codex branches of the intent effect (lines 948-960):

```tsx
    } else if (item.kind === "claude") {
      const existing = workspaceTabs.find((tab) => tab.kind === "claude-chat" && (tab.id === claudeChatTabId(item.id) || tab.sourceSessionId === item.id));
      if (existing) activateWorkspaceTab(existing.id);
      // No tab: take the model and permission its process runs with.
      else handleOpenClaudeSessionChat({ sessionId: item.id, sessionName: "", cwd: item.cwd, ...claudeReopenSettings(claudeRuntimes?.find((runtime) => runtime.sessionId === item.id)) });
    } else {
      const threadId = item.id;
      const existing = workspaceTabs.find((tab) => tab.kind === "codex-chat" && (tab.id === codexChatTabId(threadId) || tab.sourceSessionId === threadId));
      if (existing) activateWorkspaceTab(existing.id);
      // A running runtime was started from a chat tab; reopen it with the
      // settings that runtime uses (new-chat defaults if it has gone). No
      // session name, so the panel shows the thread's own name.
      else handleOpenCodexSessionChat({ sessionId: threadId, sessionName: "", cwd: item.cwd, ...codexReopenSettings(codexRuntimes?.find((runtime) => runtime.threadId === threadId)) });
    }
  }, [activateWorkspaceTab, activeCwd, activityOpenIntent, centerHydratedCwd, claudeRuntimes, closeMobileOverlays, codexRuntimes, handleOpenClaudeSessionChat, handleOpenCodexSessionChat, handleSelectSession, isMobile, openTerminalTab, terminals, terminalsLoaded, workspaceTabs]);
```

The effect clears its intent before it opens anything (`setActivityOpenIntent(null)` at line 925), so reruns caused by the new dependencies do nothing.

- [ ] **Step 9: Write the e2e test.** Append to `e2e/background-approval.spec.ts`:

```ts
test("a Codex chat opened from a notification keeps the runtime's model and Full access", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop chat test");
  const id = "dddddddd-4444-4444-8444-dddddddddddd";
  await mockBackgroundWorkspaces(page, {
    codexRuntimes: [{ threadId: id, cwd: ROOT_A, owner: "chat", state: "approval", connected: false, settings: { model: "gpt-5.5", reasoningEffort: null, serviceTier: null, approvalPolicy: "never" } }],
    notifications: [{ id: "n-codex", kind: "codex", event: "approval", targetId: id, cwd: ROOT_A, title: "Deploy", createdAt: Date.now() - 60_000, read: false }],
  });
  const { reads } = await mockCodexChat(page, id);
  await page.goto("/?notification=n-codex");
  await expect.poll(() => reads.length).toBeGreaterThan(0);
  expect(reads[0].searchParams.get("approvalPolicy")).toBe("never");
  expect(reads[0].searchParams.get("model")).toBe("gpt-5.5");
  await expect(page.locator('button[title="Chat configuration"]')).toHaveText("Full access");
});
```

Run: `npx playwright test e2e/background-approval.spec.ts`
Expected: PASS. Before Step 8, the read asks for `approvalPolicy=untrusted` and sends no model.

- [ ] **Step 10: Update the PRD** (`docs/prd/agent-workspace.md`).
  - Line 88: append:

    > 状态流 `codex_runtimes` 的每个运行时带 `settings`（`model`、`reasoningEffort`、`serviceTier`、`approvalPolicy`：启动或新建时的设置，之后每轮非空的设置覆盖）。

  - Line 154: replace `项目栏和通知中的 Claude 聊天条目打开对应标签。` with:

    > 项目栏、活动中心和通知中的 Claude/Codex 聊天条目打开对应标签；没有标签时新开的标签沿用运行时当前的模型和权限（Codex 为模型、推理、服务等级和审批策略），运行时已结束时用新聊天的默认值（Codex `untrusted`，Claude `default`）。

  - Line 155: after `（`idle` / `running` / `approval`）`, insert:

    > ，并带进程启动时的模型别名 `model`（默认模型为 null）和当前权限模式 `permissionMode`（Claude 回报权限模式变化时也推送）

- [ ] **Step 11: Checks and commit**

Run: `npx tsc --noEmit -p . && npx eslint server/agents/codex-app-server.cjs server/agents/claude-chat-runtime.cjs server/agents/codex-chat-runtime.test.cjs server/agents/claude-chat.test.cjs lib/workspace-status-store.ts lib/chat-reopen.ts components/AppShell.tsx e2e/background-approval.spec.ts && npm test && npx playwright test e2e/background-approval.spec.ts`

```bash
git add server/agents/codex-app-server.cjs server/agents/claude-chat-runtime.cjs server/agents/codex-chat-runtime.test.cjs server/agents/claude-chat.test.cjs lib/workspace-status-store.ts lib/chat-reopen.ts lib/chat-reopen.test.mjs components/AppShell.tsx e2e/background-approval.spec.ts docs/prd/agent-workspace.md
git commit -m "feat: reopen a chat from a notification with its runtime's model and permission"
```

---

## Finish

- [ ] Run the full gate: `npx tsc --noEmit -p . && npm run lint && npm test && npx playwright test`
- [ ] Use superpowers:finishing-a-development-branch to finish `feat/audit-followups`. The repo merges feature branches into `main` with a merge commit; see `git log`.

## Self-review

**Spec coverage**

| Audit item | Task |
|---|---|
| 1. Notification for a closed project | Task 1. The Recent list and system clicks both reopen the project and open the target. |
| 2. Close-project confirmation counts chats | Task 2 (reshaped: counts every busy item of the workspace, including Pi sessions and project root/worktrees) |
| 3. Confirm closing a busy chat tab; runtime fate | Task 3. The dialog and the PRD state what Keep running and Stop do to the runtime. |
| 4. Tab title uses `approvalCount` | Task 4. Unread notifications are shown when nothing is waiting. |
| 5. Dangerous permission confirmation in chat | Task 5. It shares `ConfirmDialog` and the warning text with the template "Run anyway" dialog. |
| 6. Restore model and permission on reopen | Task 6 (reshaped: only without a saved tab; source is the live runtime) |

**Placeholder scan:** Every step has concrete code, commands and expected output. There are two deliberate check-and-copy instructions:
- The three dialog styles in Task 5 Step 5 are copied from exact current line numbers.
- Task 4 Step 5 checks that no early return comes before the new hook.

**Type consistency**
- `BusyChat` is defined in `lib/chat-tab-close.ts` and used only by AppShell.
- `PermissionOption` moves to `lib/chat-permissions.ts`. `CodexAssistantThread` re-exports it for existing importers, and `ClaudeChatPanel` stops importing it.
- `CodexRuntimeStatus.settings` and `ClaudeRuntimeStatus.model`/`permissionMode` are optional. Older frames and the existing tests' runtime fixtures still type-check.
- `codexReopenSettings`/`claudeReopenSettings` return `CodexChatTarget`/`ClaudeChatTarget` fields with matching types (`CodexApprovalPolicy`, `ClaudePermissionMode`, optional strings).
- `codexRuntimes`/`claudeRuntimes` in AppShell are `T[] | null` from the selector. Every use applies `?? []` or `?.find`.

**Cross-task effects**
- Task 3 renames `TerminalCloseDialog` to `RunningCloseDialog`, keeping the "Close terminal" label and copy.
- Task 4 renames the local `windowTitle` to `documentTitle`.
- Task 6 depends on Task 3's selectors. Run the tasks in order.
