import { expect, test, type Page } from "@playwright/test";

const session = {
  id: "reliability-session",
  path: "/tmp/pi-web-reliability/session.jsonl",
  cwd: "/tmp/pi-web-reliability",
  projectRoot: "/tmp/pi-web-reliability",
  created: "2026-09-27T00:00:00.000Z",
  modified: "2026-09-27T00:01:00.000Z",
  messageCount: 2,
  firstMessage: "Start the task",
};

/** A Pi session that is running; records every POST to /api/agent/<id>. */
async function mockRunningSession(page: Page, respond?: (body: Record<string, unknown>) => { status: number; json: unknown } | null) {
  const agentPosts: Array<Record<string, unknown>> = [];
  await page.route(`**/api/sessions/${session.id}/state`, (route) => route.fulfill({ json: {
    running: true,
    state: { isStreaming: true, isPromptRunning: true, isBashRunning: false, isCompacting: false },
  } }));
  await page.route(`**/api/sessions/${session.id}?*`, (route) => route.fulfill({ json: {
    sessionId: session.id,
    filePath: session.path,
    info: session,
    leafId: "tip",
    tree: [],
    context: {
      messages: [
        { role: "user", content: "Start the task", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "Working on it" }], stopReason: "stop", timestamp: 2 },
      ],
      entryIds: ["user-1", "tip"],
      thinkingLevel: "medium",
      model: { provider: "openai-codex", modelId: "gpt-5.6-sol" },
    },
  } }));
  await page.route("**/api/sessions", (route) => route.fulfill({ json: { sessions: [session], runningSessionIds: [session.id] } }));
  await page.route("**/api/cwd/validate", (route) => route.fulfill({ json: { success: true, cwd: session.cwd } }));
  await page.route(`**/api/agent/${session.id}/events`, (route) => route.fulfill({
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    body: `data: ${JSON.stringify({ type: "connected", sessionId: session.id })}\n\n`,
  }));
  await page.route(`**/api/agent/${session.id}`, async (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: { running: true, state: { isStreaming: true, isPromptRunning: true } } });
    const body = route.request().postDataJSON() as Record<string, unknown>;
    agentPosts.push(body);
    const custom = respond?.(body);
    if (custom) return route.fulfill({ status: custom.status, json: custom.json });
    return route.fulfill({ json: { success: true, data: [] } });
  });
  await page.goto(`/?session=${session.id}`);
  await expect(page.getByText("Working on it", { exact: true })).toBeVisible();
  return { agentPosts };
}

test("Esc closes Settings without stopping the running agent", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "the project rail Settings button is desktop-only");
  const { agentPosts } = await mockRunningSession(page);
  await page.getByRole("button", { name: "Settings" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Status & indicators" }).click();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.waitForTimeout(300);
  expect(agentPosts.filter((body) => body.type === "abort")).toEqual([]);
});

test("a failed models.json load shows the error and never saves an empty config", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "the project rail Settings button is desktop-only");
  const puts: string[] = [];
  await page.route("**/api/models-config", (route) => {
    if (route.request().method() === "PUT") { puts.push(route.request().postData() ?? ""); return route.fulfill({ json: { success: true } }); }
    return route.fulfill({ status: 500, json: { error: "/home/u/.pi/agent/models.json is not valid JSON (Unexpected end of JSON input). Fix or remove it, then reload." } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("button", { name: "Models" }).click();
  await expect(dialog.getByRole("alert")).toContainText("is not valid JSON");
  await expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(puts).toEqual([]);
});

test("shows a sign-in prompt when the login expires and clears it after signing in", async ({ page }) => {
  let authenticated = true;
  await page.route("**/api/auth/session", (route) => route.fulfill({ json: { authenticated, passwordRequired: true } }));
  await page.goto("/");
  await expect(page.getByText("Get Started")).toBeVisible();

  authenticated = false;
  await page.evaluate(() => fetch("/api/sessions?probe=1"));
  // Next serves this route; force the 401 an expired cookie would get.
  await page.route("**/api/sessions?probe=2", (route) => route.fulfill({ status: 401, json: { error: "authentication required" } }));
  await page.evaluate(() => fetch("/api/sessions?probe=2"));
  const notice = page.getByRole("alertdialog", { name: "Signed out" });
  await expect(notice).toBeVisible();
  await expect(notice.getByRole("link", { name: "Sign in" })).toHaveAttribute("target", "_blank");

  authenticated = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(notice).toBeHidden();
});

test("a 401 while still signed in does not show the sign-in prompt", async ({ page }) => {
  await page.route("**/api/auth/session", (route) => route.fulfill({ json: { authenticated: true, passwordRequired: true } }));
  await page.route("**/api/skills/updates*", (route) => route.fulfill({ status: 401, json: { error: "GitHub token rejected" } }));
  await page.goto("/");
  await page.evaluate(() => fetch("/api/skills/updates?x=1"));
  await page.waitForTimeout(300);
  await expect(page.getByRole("alertdialog", { name: "Signed out" })).toHaveCount(0);
});

test("a failed steer keeps the message and shows why", async ({ page }) => {
  // The mobile "Install TianForge" prompt sits fixed over the chat input's
  // Steer/Follow-up buttons; dismiss it up front like a returning user would.
  await page.addInitScript(() => window.sessionStorage.setItem("tianforge-mobile-install-prompt-dismissed-v2", "1"));
  let failSteer = true;
  const { agentPosts } = await mockRunningSession(page, (body) => (
    body.type === "steer" && failSteer ? { status: 409, json: { error: "agent is compacting" } } : null
  ));
  const input = page.getByPlaceholder("Steer now / queue follow-up...");
  await input.fill("use the staging database instead");
  await page.getByRole("button", { name: "Steer" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Not sent: agent is compacting" })).toBeVisible();
  await expect(input).toHaveValue("use the staging database instead");

  failSteer = false;
  await page.getByRole("button", { name: "Steer" }).click();
  await expect(input).toHaveValue("");
  await expect(page.getByText("Not sent: agent is compacting")).toBeHidden();
  expect(agentPosts.filter((body) => body.type === "steer")).toHaveLength(2);
});

/** Mocks used by e2e/app-shell.spec.ts's Codex chat test to drive a running thread. */
async function mockStatusStream(page: Page, frames: Array<Record<string, unknown>>) {
  await page.route("**/api/agent/running/events", (route) => route.fulfill({
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    body: frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""),
  }));
}

// Codex and Claude chat event streams are driven from the test through window.__codexStreams.
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
        ((window as unknown as { __codexStreams: FakeEventSource[] }).__codexStreams ??= []).push(this);
        setTimeout(() => { this.readyState = 1; this.onopen?.(new Event("open")); }, 0);
      }
      emit(data: unknown) { this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) })); }
      close() { this.readyState = 2; }
      fail() { this.readyState = 2; this.onerror?.(new Event("error")); }
    }
    window.EventSource = function (url: string | URL, init?: EventSourceInit) {
      return /\/api\/(codex|claude)\/chat\//.test(String(url)) ? new FakeEventSource(String(url)) : new RealEventSource(url, init);
    } as unknown as typeof EventSource;
    Object.assign(window.EventSource, { CONNECTING: 0, OPEN: 1, CLOSED: 2 });
  });
}
async function emitCodexEvent(page: Page, event: Record<string, unknown>) {
  await page.evaluate((data) => {
    const streams = (window as unknown as { __codexStreams: Array<{ emit(data: unknown): void }> }).__codexStreams;
    streams.at(-1)?.emit(data);
  }, event);
}

test("a queued Codex chat message survives a failed send and retries", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop agent sidebar test");
  const id = "66666666-6666-6666-6666-666666666666";
  await fakeCodexStreams(page);
  await page.route("**/api/sessions", async (route) => route.fulfill({ json: { sessions: [{
    id: "pi-session", path: "/tmp/pi-web-e2e/session.jsonl", cwd: "/tmp/pi-web-e2e", projectRoot: "/tmp/pi-web-e2e",
    created: "2026-08-03T00:00:00.000Z", modified: "2026-08-03T00:00:00.000Z", messageCount: 1, firstMessage: "test",
  }], runningSessionIds: [] } }));
  await page.route("**/api/cwd/validate", async (route) => route.fulfill({ json: { success: true, cwd: "/tmp/pi-web-e2e" } }));
  await page.route("**/api/terminals?*", async (route) => route.fulfill({ json: { cwd: "/tmp/pi-web-e2e", terminals: [], stats: null } }));
  await mockStatusStream(page, [
    { type: "running", runningSessionIds: [] },
    { type: "terminals", terminals: [], limits: { running: 20, records: 100 } },
    { type: "codex_runtimes", runtimes: [] },
  ]);
  await page.route("**/api/project-scripts?*", async (route) => route.fulfill({ json: { scripts: [], runner: "npm" } }));
  await page.route("**/api/codex/models?*", async (route) => route.fulfill({ json: { result: { data: [] } } }));
  await page.route("**/api/codex/sessions?*", async (route) => route.fulfill({ json: { sessions: [{
    id, name: "Queue test", cwd: "/tmp/pi-web-e2e", updatedAt: "2026-08-03T00:00:00.000Z", lastUserMessage: "hi", archived: false, runtime: null,
  }], nextCursor: null } }));
  const sent: Array<Record<string, unknown>> = [];
  let failNextSend = false;
  await page.route(`**/api/codex/chat/${id}*`, async (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: { thread: { thread: { id, turns: [] } }, history: [], events: [] } });
    const body = route.request().postDataJSON() as Record<string, unknown>;
    sent.push(body);
    if (failNextSend) { failNextSend = false; return route.fulfill({ status: 500, json: { error: "internal error" } }); }
    return route.fulfill({ status: 202, json: { turn: { turn: { id: "turn-2" } } } });
  });

  await page.goto("/");
  await page.getByRole("navigation", { name: "Sidebar modules" }).getByRole("button", { name: "Agents" }).click();
  await page.locator("button[aria-expanded]").filter({ hasText: "Codex" }).last().click();
  const manage = page.getByRole("button", { name: "Manage Queue test" });
  await manage.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await manage.click();
  await page.getByRole("menuitem", { name: "Open in Chat…" }).click();
  await page.getByRole("button", { name: "Resume in Chat" }).click();
  await expect(page.getByText("Codex Chat · Queue test")).toBeVisible();
  const chat = page.locator("section").filter({ hasText: "Codex Chat · Queue test" });
  const composer = chat.getByPlaceholder("Message… Type / for commands", { exact: true });
  await expect(composer).toBeVisible();

  await expect.poll(() => page.evaluate(() => (window as unknown as { __codexStreams?: unknown[] }).__codexStreams?.length ?? 0)).toBeGreaterThan(0);
  await emitCodexEvent(page, { method: "turn/started", params: { turn: { id: "turn-1" } }, piSeq: 1, piRuntime: "run1" });

  // 1. Queue a message while the turn runs.
  const running = chat.getByPlaceholder("Add to this turn, or queue for the next…");
  await running.fill("second task");
  await chat.getByRole("button", { name: "Queue" }).click();
  await expect(chat.getByText("1 queued")).toBeVisible();

  // 2. The turn ends; the queued send fails.
  failNextSend = true;
  await emitCodexEvent(page, { method: "turn/completed", params: { turn: { id: "turn-1", status: "completed", error: null } }, piSeq: 2, piRuntime: "run1" });
  await expect(chat.getByRole("alert").filter({ hasText: "sending failed" })).toBeVisible();
  await expect(chat.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect.poll(() => sent.length).toBe(1);

  // 3. Retry with a succeeding endpoint clears the queue.
  await chat.getByRole("button", { name: "Retry" }).click();
  await expect(chat.locator(".codex-aui-queue")).toHaveCount(0);
  await expect.poll(() => sent.length).toBe(2);
  expect(sent.map((body) => body.text)).toEqual(["second task", "second task"]);
});

test("a failed session delete keeps the session and says why", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "row actions appear on hover");
  const idle = { ...session, id: "idle-session", firstMessage: "Refactor the parser" };
  await page.route("**/api/sessions", (route) => route.fulfill({ json: { sessions: [idle], runningSessionIds: [] } }));
  await page.route("**/api/cwd/validate", (route) => route.fulfill({ json: { success: true, cwd: idle.cwd } }));
  await page.route(`**/api/sessions/${idle.id}`, (route) => {
    if (route.request().method() === "DELETE") return route.fulfill({ status: 409, json: { error: "session is running in another window" } });
    if (route.request().method() === "PATCH") return route.fulfill({ status: 500, json: { error: "disk full" } });
    return route.fallback();
  });
  await page.goto(`/?session=${idle.id}`);
  const row = page.getByText("Refactor the parser").first();
  await expect(row).toBeVisible();

  await row.hover();
  await page.getByTitle("Delete").first().click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Delete failed: session is running in another window" })).toBeVisible();
  await expect(page.getByText("Refactor the parser").first()).toBeVisible();

  await row.hover();
  await page.getByTitle("Rename").first().click();
  await page.keyboard.type("New name");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: "Rename failed: disk full" })).toBeVisible();
});
