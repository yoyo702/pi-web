import { expect, test, type Page } from "@playwright/test";
import { mockRunningSession, session } from "./support/mock-running-session";

function assertPostedTypes(agentPosts: Array<Record<string, unknown>>, expected: string[]) {
  expect(agentPosts.map((post) => post.type)).toEqual(expected);
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

test("Esc closes a context menu without stopping the running agent", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "the TianForge app menu is desktop-only");
  const { agentPosts } = await mockRunningSession(page);
  await page.getByRole("button", { name: "TianForge app menu" }).click();
  const menu = page.getByRole("menu", { name: "TianForge menu" });
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(page.getByText("Working on it", { exact: true })).toBeVisible();
  // Mount also fires a `get_tools` lookup for the running session; ignore it here.
  assertPostedTypes(agentPosts.filter((post) => post.type !== "get_tools"), []);
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

test("switching settings sections warns about unsaved Models changes", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "the project rail Settings button is desktop-only");
  await page.route("**/api/models-config", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: { providers: { openai: { api: "openai-completions" } } } })
    : route.fulfill({ json: { success: true } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("button", { name: "Models" }).click();
  await dialog.getByPlaceholder("provider-name").fill("openai-renamed");
  await dialog.getByRole("button", { name: "Rename" }).click();
  let confirmShown = false;
  page.once("dialog", (d) => { confirmShown = true; void d.dismiss(); });
  await dialog.getByRole("button", { name: "Appearance" }).click();
  expect(confirmShown).toBe(true);
  await expect(dialog.getByRole("button", { name: "Models" })).toHaveClass(/is-active/);
});

test("deleting a provider asks for confirmation first", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "the project rail Settings button is desktop-only");
  await page.route("**/api/models-config", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: { providers: { openai: { api: "openai-completions" } } } })
    : route.fulfill({ json: { success: true } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("button", { name: "Models" }).click();
  await expect(dialog.getByPlaceholder("provider-name")).toHaveValue("openai");
  page.once("dialog", (d) => void d.dismiss());
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(dialog.getByPlaceholder("provider-name")).toHaveValue("openai");
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
  await expect(notice).toBeFocused();
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

/** On mobile, Stop and the reasoning-level control live behind a collapsed
 * "More controls" menu; open it first so the same test steps work on both. */
async function openMobileControlsIfNeeded(page: Page, testInfo: { project: { name: string } }) {
  if (!testInfo.project.name.startsWith("mobile")) return;
  await page.getByRole("button", { name: "More controls" }).click();
}

test("a failed Stop shows why and leaves the agent running", async ({ page }, testInfo) => {
  // The mobile "Install TianForge" prompt sits fixed over the "More controls"
  // toggle; dismiss it up front like a returning user would.
  await page.addInitScript(() => window.sessionStorage.setItem("tianforge-mobile-install-prompt-dismissed-v2", "1"));
  const { agentPosts } = await mockRunningSession(page, (body) => {
    if (body.type === "abort") return { status: 500, json: { error: "agent runtime unreachable" } };
    return null;
  });
  await openMobileControlsIfNeeded(page, testInfo);
  await page.getByTitle("Stop agent").click();
  await expect(page.getByText("Could not stop the agent: agent runtime unreachable")).toBeVisible();
  // Mount also fires a `get_tools` lookup for the running session; ignore it here.
  assertPostedTypes(agentPosts.filter((post) => post.type !== "get_tools"), ["abort"]);
});

test("a failed Fork shows why", async ({ page }) => {
  const messages = [
    { role: "user", content: "Start the task", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "Working on it" }], stopReason: "stop", timestamp: 2 },
    { role: "user", content: "Second question", timestamp: 3 },
    { role: "assistant", content: [{ type: "text", text: "Second answer" }], stopReason: "stop", timestamp: 4 },
  ];
  const entryIds = ["user-1", "assistant-1", "user-2", "tip"];
  await mockRunningSession(page, (body) => {
    if (body.type === "fork") return { status: 500, json: { error: "disk full" } };
    return null;
  }, { busy: false, messages, entryIds });
  // Forking the very first user message is not offered, so hover the second one.
  await page.getByText("Second question").first().hover();
  await page.getByTitle("New session — creates an independent copy from here").click();
  await expect(page.getByText("Could not create a new session: disk full")).toBeVisible();
});

test("a failed reasoning-level change rolls back to the previous level", async ({ page }, testInfo) => {
  // The mobile "Install TianForge" prompt sits fixed over the "More controls"
  // toggle; dismiss it up front like a returning user would.
  await page.addInitScript(() => window.sessionStorage.setItem("tianforge-mobile-install-prompt-dismissed-v2", "1"));
  await mockRunningSession(page, (body) => {
    if (body.type === "set_thinking_level") return { status: 500, json: { error: "session busy" } };
    return null;
  }, { busy: false });
  await openMobileControlsIfNeeded(page, testInfo);
  await page.getByRole("button", { name: "Change reasoning level" }).click();
  await page.getByRole("button", { name: /^high/i }).click();
  await expect(page.getByText("Could not change the reasoning level: session busy")).toBeVisible();
  await expect(page.getByRole("button", { name: "Change reasoning level" })).toHaveAttribute("title", "Change reasoning level: medium");
});

test("a stale reasoning-level failure does not roll back a newer, already-applied change", async ({ page }, testInfo) => {
  // The mobile "Install TianForge" prompt sits fixed over the "More controls"
  // toggle; dismiss it up front like a returning user would.
  await page.addInitScript(() => window.sessionStorage.setItem("tianforge-mobile-install-prompt-dismissed-v2", "1"));
  await mockRunningSession(page, undefined, { busy: false });
  // Override the agent-command route (registered after the fixture's own, so
  // it runs first): the first `set_thinking_level` call is held open until the
  // test releases it, then fails; every later call succeeds immediately. This
  // simulates a slow request for an earlier change losing the race to a
  // faster, newer one.
  let releaseFirstFailure = () => {};
  const firstFailureGate = new Promise<void>((resolve) => { releaseFirstFailure = () => resolve(); });
  let setThinkingLevelCalls = 0;
  await page.route(`**/api/agent/${session.id}`, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (body.type !== "set_thinking_level") return route.fallback();
    setThinkingLevelCalls += 1;
    if (setThinkingLevelCalls === 1) {
      await firstFailureGate;
      return route.fulfill({ status: 500, json: { error: "stale failure" } });
    }
    return route.fulfill({ json: { success: true, data: [] } });
  });
  await openMobileControlsIfNeeded(page, testInfo);
  await page.getByRole("button", { name: "Change reasoning level" }).click();
  await page.getByRole("button", { name: /^high/i }).click();
  // The "high" request is now pending (gated); switch again before it resolves.
  await page.getByRole("button", { name: "Change reasoning level" }).click();
  await page.getByRole("button", { name: /^low/i }).click();
  await expect(page.getByRole("button", { name: "Change reasoning level" })).toHaveAttribute("title", "Change reasoning level: low");

  // Now let the stale "high" request fail; it must not roll back the newer "low" value.
  releaseFirstFailure();
  await expect(page.getByText("Could not change the reasoning level: stale failure")).toBeVisible();
  await expect(page.getByRole("button", { name: "Change reasoning level" })).toHaveAttribute("title", "Change reasoning level: low");
});

test("a failed branch switch rolls back to the previous branch", async ({ page }, testInfo) => {
  // On mobile, the fixed project switcher pill overlaps the "Branches" button
  // for this narrow session header layout and intercepts the click; this is a
  // pre-existing mobile layout quirk unrelated to the rollback behavior under
  // test here (which is exercised on desktop instead).
  test.skip(testInfo.project.name.startsWith("mobile"), "the Branches button sits under the mobile project switcher pill");
  const tree = [{
    entry: { id: "user-1", parentId: null, timestamp: "2026-09-27T00:00:00.000Z", type: "message", message: { role: "user", content: "Start the task" } },
    children: [
      { entry: { id: "branch-a", parentId: "user-1", timestamp: "2026-09-27T00:00:10.000Z", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Branch A reply" }] } }, children: [] },
      { entry: { id: "tip", parentId: "user-1", timestamp: "2026-09-27T00:00:20.000Z", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Working on it" }] } }, children: [] },
    ],
  }];
  await mockRunningSession(page, (body) => {
    if (body.type === "navigate_tree") return { status: 500, json: { error: "session busy" } };
    return null;
  }, { tree, leafId: "tip" });
  await page.getByRole("button", { name: "Branches" }).click();
  await page.getByText("Branch A reply").click();
  await expect(page.getByText("Could not switch branch: session busy")).toBeVisible();
  // Close the branch dropdown so its own "Working on it" list entry doesn't
  // make the message-pane text ambiguous.
  await page.getByRole("button", { name: "Branches" }).click();
  await expect(page.getByText("Working on it")).toBeVisible();
});

test("a stale branch-switch failure does not roll back a newer, already-applied branch", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "the Branches button sits under the mobile project switcher pill");
  const tree = [{
    entry: { id: "user-1", parentId: null, timestamp: "2026-09-27T00:00:00.000Z", type: "message", message: { role: "user", content: "Start the task" } },
    children: [
      { entry: { id: "branch-a", parentId: "user-1", timestamp: "2026-09-27T00:00:10.000Z", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Branch A reply" }] } }, children: [] },
      { entry: { id: "branch-b", parentId: "user-1", timestamp: "2026-09-27T00:00:15.000Z", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Branch B reply" }] } }, children: [] },
      { entry: { id: "tip", parentId: "user-1", timestamp: "2026-09-27T00:00:20.000Z", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Working on it" }] } }, children: [] },
    ],
  }];
  await mockRunningSession(page, undefined, {
    tree, leafId: "tip",
    contextRespond: (url) => url.searchParams.get("leafId") === "branch-b" ? { status: 200, json: { context: {
      messages: [
        { role: "user", content: "Start the task", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "Branch B reply" }], stopReason: "stop", timestamp: 2 },
      ],
      entryIds: ["user-1", "branch-b"],
      thinkingLevel: "medium",
      model: { provider: "openai-codex", modelId: "gpt-5.6-sol" },
    } } } : null,
  });
  // Override the agent-command route (registered after the fixture's own, so
  // it runs first): the first `navigate_tree` call (for branch-a) is held
  // open until the test releases it, then fails; every later call succeeds
  // immediately. Simulates a slow branch switch losing the race to a faster,
  // newer one.
  let releaseFirstFailure = () => {};
  const firstFailureGate = new Promise<void>((resolve) => { releaseFirstFailure = () => resolve(); });
  let navigateCalls = 0;
  await page.route(`**/api/agent/${session.id}`, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (body.type !== "navigate_tree") return route.fallback();
    navigateCalls += 1;
    if (navigateCalls === 1) {
      await firstFailureGate;
      return route.fulfill({ status: 500, json: { error: "stale failure" } });
    }
    return route.fulfill({ json: { success: true, data: [] } });
  });

  await page.getByRole("button", { name: "Branches" }).click();
  await page.getByText("Branch A reply").click();
  // branch-a's navigate_tree request is now pending (gated); the dropdown
  // stays open after a selection, so pick branch-b before it resolves.
  await page.getByText("Branch B reply").click();
  await expect(page.getByText("Branch B reply").first()).toBeVisible();

  // Now let the stale branch-a navigate_tree call fail; it must not roll back
  // the newer branch-b switch.
  releaseFirstFailure();
  await expect(page.getByText("Could not switch branch: stale failure")).toBeVisible();
  // Close the branch dropdown so its own list entries don't make the
  // message-pane text ambiguous.
  await page.getByRole("button", { name: "Branches" }).click();
  await expect(page.getByText("Branch B reply").first()).toBeVisible();
});

test("a failed 'load earlier messages' shows one notice and does not auto-retry", async ({ page }) => {
  let olderRequestCount = 0;
  await mockRunningSession(page, undefined, {
    page: { hasMore: true, beforeEntryId: "user-1" },
    contextRespond: (url) => {
      if (!url.searchParams.has("beforeEntryId")) return null;
      olderRequestCount += 1;
      return { status: 500, json: { error: "disk read failed" } };
    },
  });
  // The chat auto-scrolls to the bottom on mount, so the "load earlier" sentinel
  // starts out of view; scroll the message pane to the top to bring it into
  // view and fire the IntersectionObserver, the same way a user scrolling up
  // through history would.
  const sentinel = page.getByText("Scroll up to load earlier messages");
  await expect(sentinel).toBeVisible();
  await page.evaluate(() => {
    document.querySelector(".flex-1.overflow-y-auto.pt-4")?.scrollTo({ top: 0 });
  });
  await expect(page.getByText("Could not load earlier messages: disk read failed")).toBeVisible();
  // The sentinel stays in view the whole time (the failure doesn't change the
  // list), but the observer must not keep re-firing the same failing request;
  // it now offers an explicit retry instead.
  const retryButton = page.getByRole("button", { name: "Retry loading earlier messages" });
  await expect(retryButton).toBeVisible();
  await page.waitForTimeout(500);
  expect(olderRequestCount).toBe(1);
  expect(await page.getByText("Could not load earlier messages: disk read failed").count()).toBe(1);

  // The user can still retry explicitly, which does fire a new request.
  await retryButton.click();
  await expect.poll(() => olderRequestCount).toBe(2);
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

/** A resumable Codex session "Queue test"; records every POST to its chat endpoint. */
async function mockResumableCodexChat(page: Page, id: string) {
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
  const control = { failNextSend: false };
  await page.route(`**/api/codex/chat/${id}*`, async (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: { thread: { thread: { id, turns: [] } }, history: [], events: [] } });
    const body = route.request().postDataJSON() as Record<string, unknown>;
    sent.push(body);
    if (control.failNextSend) { control.failNextSend = false; return route.fulfill({ status: 500, json: { error: "internal error" } }); }
    return route.fulfill({ status: 202, json: { turn: { turn: { id: "turn-2" } } } });
  });
  await page.goto("/");
  await page.getByRole("navigation", { name: "Sidebar modules" }).getByRole("button", { name: "Agents" }).click();
  await page.locator("button[aria-expanded]").filter({ hasText: "Codex" }).last().click();
  const chat = page.locator("section").filter({ hasText: "Codex Chat · Queue test" });
  const open = async () => {
    const manage = page.getByRole("button", { name: "Manage Queue test" });
    await manage.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await manage.click();
    await page.getByRole("menuitem", { name: "Open in Chat…" }).click();
    await page.getByRole("button", { name: "Resume in Chat" }).click();
    await expect(page.getByText("Codex Chat · Queue test")).toBeVisible();
    await expect(chat.getByPlaceholder("Message… Type / for commands", { exact: true })).toBeVisible();
  };
  return { sent, control, chat, open };
}

test("a queued Codex chat message survives a failed send and retries", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop agent sidebar test");
  const { sent, control, chat, open } = await mockResumableCodexChat(page, "66666666-6666-6666-6666-666666666666");
  await open();

  await expect.poll(() => page.evaluate(() => (window as unknown as { __codexStreams?: unknown[] }).__codexStreams?.length ?? 0)).toBeGreaterThan(0);
  await emitCodexEvent(page, { method: "turn/started", params: { turn: { id: "turn-1" } }, piSeq: 1, piRuntime: "run1" });

  // 1. Queue a message while the turn runs.
  const running = chat.getByPlaceholder("Add to this turn, or queue for the next…");
  await running.fill("second task");
  await chat.getByRole("button", { name: "Queue" }).click();
  await expect(chat.getByText("1 queued")).toBeVisible();

  // 2. The turn ends; the queued send fails.
  control.failNextSend = true;
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

test("a queue left in a closed Codex chat is paused when the chat is reopened", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop agent sidebar test");
  const { sent, chat, open } = await mockResumableCodexChat(page, "88888888-8888-8888-8888-888888888888");
  await open();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __codexStreams?: unknown[] }).__codexStreams?.length ?? 0)).toBeGreaterThan(0);
  await emitCodexEvent(page, { method: "turn/started", params: { turn: { id: "turn-1" } }, piSeq: 1, piRuntime: "run1" });
  await chat.getByPlaceholder("Add to this turn, or queue for the next…").fill("stale task");
  await chat.getByRole("button", { name: "Queue" }).click();
  await expect(chat.getByText("1 queued")).toBeVisible();

  // Close the chat mid-turn, then reopen it with no turn running.
  await page.getByRole("button", { name: "Close Queue test" }).click();
  await expect(chat).toHaveCount(0);
  await open();
  await expect(chat.locator(".codex-aui-queue")).toContainText("1 queued · paused");
  await page.waitForTimeout(500);
  expect(sent).toHaveLength(0);

  // Nothing is sent until Retry.
  await chat.getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => sent.map((body) => body.text)).toEqual(["stale task"]);
  await expect(chat.locator(".codex-aui-queue")).toHaveCount(0);
});

test("a message queued while a new Codex chat is being created is sent after its first turn", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop agent sidebar test");
  const id = "77777777-7777-7777-7777-777777777777";
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
  await page.route("**/api/codex/sessions?*", async (route) => route.fulfill({ json: { sessions: [], nextCursor: null } }));
  // Creating the chat hangs until the test has queued a message.
  let finishCreate: () => void = () => undefined;
  const createHeld = new Promise<void>((resolve) => { finishCreate = resolve; });
  await page.route("**/api/codex/chat", async (route) => {
    await createHeld;
    return route.fulfill({ status: 201, json: { threadId: id, turn: { turn: { id: "turn-1" } } } });
  });
  const sent: Array<Record<string, unknown>> = [];
  await page.route(`**/api/codex/chat/${id}*`, async (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: { thread: { thread: { id, turns: [] } }, history: [], events: [] } });
    sent.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ status: 202, json: { turn: { turn: { id: "turn-2" } } } });
  });

  await page.goto("/");
  await page.getByRole("navigation", { name: "Sidebar modules" }).getByRole("button", { name: "Agents" }).click();
  await page.getByRole("button", { name: "New Codex chat" }).click();
  const chat = page.locator("section").filter({ hasText: "Codex Chat" });
  const composer = chat.getByPlaceholder("Message… Type / for commands", { exact: true });
  await composer.fill("first task");
  await composer.press("Enter");

  // 1. While the chat is being created, queue a follow-up.
  const running = chat.getByPlaceholder("Add to this turn, or queue for the next…");
  await running.fill("second task");
  await chat.getByRole("button", { name: "Queue" }).click();
  await expect(chat.getByText("1 queued")).toBeVisible();

  // 2. The chat gets its thread id; the queue follows it.
  finishCreate();
  await expect.poll(() => page.evaluate((threadId) => (window as unknown as { __codexStreams?: { url: string }[] }).__codexStreams?.some((stream) => stream.url.includes(threadId)) ?? false, id)).toBe(true);
  await expect(chat.getByText("1 queued")).toBeVisible();
  expect(sent).toHaveLength(0);

  // 3. The first turn ends; the queued message is sent to the new thread.
  await emitCodexEvent(page, { method: "turn/completed", params: { turn: { id: "turn-1", status: "completed", error: null } }, piSeq: 1, piRuntime: "run1" });
  await expect.poll(() => sent.map((body) => body.text)).toEqual(["second task"]);
  await expect(chat.locator(".codex-aui-queue")).toHaveCount(0);
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

test("a failed session rename keeps the typed name and can retry", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "row actions appear on hover");
  const idle = { ...session, id: "idle-session", firstMessage: "Refactor the parser" };
  let patchCalls = 0;
  // Reflect the PATCH result back through the list endpoint (like the real
  // server) so a successful retry actually shows the saved name.
  await page.route("**/api/sessions", (route) => route.fulfill({ json: {
    sessions: [patchCalls > 1 ? { ...idle, name: "New name" } : idle],
    runningSessionIds: [],
  } }));
  await page.route("**/api/cwd/validate", (route) => route.fulfill({ json: { success: true, cwd: idle.cwd } }));
  await page.route(`**/api/sessions/${idle.id}`, (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    patchCalls += 1;
    return patchCalls === 1
      ? route.fulfill({ status: 500, json: { error: "disk full" } })
      : route.fulfill({ json: { success: true } });
  });
  await page.goto(`/?session=${idle.id}`);
  const row = page.getByText("Refactor the parser").first();
  await expect(row).toBeVisible();

  await row.hover();
  await page.getByTitle("Rename").first().click();
  await page.keyboard.type("New name");
  await page.keyboard.press("Enter");
  const alert = page.getByRole("alert").filter({ hasText: "Rename failed: disk full" });
  await expect(alert).toBeVisible();
  const input = alert.locator("..").locator("input");
  await expect(input).toHaveValue("New name");

  // Retry: the same input (still holding "New name") is resubmitted, and this
  // time the PATCH succeeds.
  await input.evaluate((element) => element.setAttribute("data-rename-input", ""));
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-rename-input]")).toHaveCount(0);
  await expect(page.getByText("New name").first()).toBeVisible();
  expect(patchCalls).toBe(2);
});

test("a failed diff request shows the real error and can retry", async ({ page }) => {
  await mockRunningSession(page);

  let diffCalls = 0;
  await page.route("**/api/git/repositories*", (route) => route.fulfill({ json: { repositories: [
    { path: session.cwd, repositoryRoot: session.cwd, label: "pi-web-reliability", relativePath: "" },
  ] } }));
  await page.route("**/api/git/status*", (route) => route.fulfill({ json: {
    isGitRepository: true,
    repositoryRoot: session.cwd,
    branch: "main",
    files: [{ filePath: "src/app.ts", status: "modified", code: "M", indexStatus: " ", worktreeStatus: "M" }],
  } }));
  await page.route("**/api/git/diff*", (route) => {
    diffCalls += 1;
    return diffCalls === 1
      ? route.fulfill({ status: 401, json: { error: "authentication required" } })
      : route.fulfill({ json: { supported: true, patch: "@@ -1 +1 @@\n-a\n+b\n" } });
  });

  await page.getByRole("button", { name: "Show file panel" }).click();
  await page.getByRole("button", { name: "Open Git Review" }).click();
  await page.getByText("app.ts").click();
  await expect(page.getByText("Could not load diff")).toBeVisible();
  await expect(page.getByText("authentication required")).toBeVisible();
  await page.getByTitle("Try loading again").click();
  await expect(page.getByText("authentication required")).toHaveCount(0);
});

test("deleting a Claude session closes its open Chat tab", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop agent sidebar test");
  const id = "99999999-9999-4999-8999-999999999999";
  const title = "Refactor the parser";
  await fakeCodexStreams(page);
  await page.route("**/api/sessions", async (route) => route.fulfill({ json: { sessions: [{
    id: "pi-session", path: "/tmp/pi-web-reliability/session.jsonl", cwd: "/tmp/pi-web-reliability", projectRoot: "/tmp/pi-web-reliability",
    created: "2026-08-03T00:00:00.000Z", modified: "2026-08-03T00:00:00.000Z", messageCount: 1, firstMessage: "test",
  }], runningSessionIds: [] } }));
  await page.route("**/api/cwd/validate", async (route) => route.fulfill({ json: { success: true, cwd: "/tmp/pi-web-reliability" } }));
  await page.route("**/api/terminals?*", async (route) => route.fulfill({ json: { cwd: "/tmp/pi-web-reliability", terminals: [], stats: null } }));
  await mockStatusStream(page, [
    { type: "running", runningSessionIds: [] },
    { type: "terminals", terminals: [], limits: { running: 20, records: 100 } },
    { type: "codex_runtimes", runtimes: [] },
    { type: "claude_runtimes", runtimes: [] },
  ]);
  await page.route("**/api/project-scripts?*", async (route) => route.fulfill({ json: { scripts: [], runner: "npm" } }));
  await page.route("**/api/claude/sessions?*", async (route) => route.fulfill({ json: { sessions: [{
    id, title, firstMessage: title, cwd: "/tmp/pi-web-reliability", gitBranch: null, createdAt: null, updatedAt: "2026-08-03T00:00:00.000Z", size: 2048, runtime: null,
  }], nextCursor: null } }));
  await page.route("**/api/claude/chat/commands?*", async (route) => route.fulfill({ json: { commands: [] } }));
  await page.route(`**/api/claude/chat/${id}?*`, async (route) => route.fulfill({ json: {
    session: { id, title }, history: [], cursor: null, events: [], runtime: null, terminal: null,
  } }));
  await page.route(`**/api/claude/sessions/${id}/delete`, async (route) => route.fulfill({ json: { session: { id, title } } }));

  await page.goto("/");
  await page.getByRole("navigation", { name: "Sidebar modules" }).getByRole("button", { name: "Agents" }).click();
  await page.locator("button[aria-expanded]").filter({ hasText: "Claude" }).last().click();
  await page.getByText(title, { exact: true }).click();
  const chat = page.locator("section").filter({ hasText: `Claude Chat · ${title}` });
  await expect(chat).toBeVisible();
  await expect(page.getByRole("tab", { name: new RegExp(title) })).toHaveCount(1);

  const manage = page.getByRole("button", { name: `Manage ${title}` });
  await manage.scrollIntoViewIfNeeded();
  await expect(manage).toBeVisible();
  await manage.click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await page.getByRole("dialog", { name: "Delete Claude session" }).getByRole("button", { name: "Remove" }).click();

  await expect(chat).toHaveCount(0);
  await expect(page.getByRole("tab", { name: new RegExp(title) })).toHaveCount(0);
});
