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

test("a notification for a project whose cwd no longer validates falls back to the activity center", async ({ page }) => {
  await mockBackgroundWorkspaces(page, { terminals: [failedTerminal], notifications: [failedNotification()] });
  // Registered after mockBackgroundWorkspaces's own /api/cwd/validate route, so
  // it takes over: the closed project's directory (e.g. a deleted worktree) no
  // longer validates, while other lookups keep succeeding.
  await page.route("**/api/cwd/validate", (route) => {
    const body = route.request().postDataJSON() as { cwd?: string };
    return body.cwd === ROOT_B ? route.fulfill({ status: 403, json: { error: "not authorized" } }) : route.fulfill({ json: { success: true, cwd: body.cwd } });
  });
  await page.goto("/?notification=n-closed");
  await expect(page.getByRole("dialog", { name: "Workspace activity" })).toBeVisible();
});

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
