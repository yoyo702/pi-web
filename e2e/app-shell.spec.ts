import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The real server also pushes terminal/session/Codex status over
// **/api/agent/running/events. Routes that mock **/api/terminals?* (or rely on
// /api/codex/runtime) must also fulfill this stream themselves, or the live
// snapshot (with no terminals) would arrive and overwrite the mocked list.
async function mockStatusStream(page: Page, frames: Array<Record<string, unknown>>) {
  await page.route("**/api/agent/running/events", (route) => route.fulfill({
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    body: frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""),
  }));
}

test("shares workspace authorization across the proxy, Files, Git, and terminals", async ({ request }, testInfo) => {
  const workspace = mkdtempSync(join(tmpdir(), `pi-web-e2e-workspace-${testInfo.project.name}-`));
  mkdirSync(workspace, { recursive: true });
  mkdirSync(`${workspace}/dist`, { recursive: true });
  mkdirSync(`${workspace}/service-a`, { recursive: true });
  mkdirSync(`${workspace}/service-b`, { recursive: true });
  execFileSync("git", ["init", "-q", `${workspace}/service-a`]);
  execFileSync("git", ["init", "-q", `${workspace}/service-b`]);
  writeFileSync(`${workspace}/dist/bundle.js`, "generated");
  writeFileSync(`${workspace}/._bundle.js`, "macOS metadata");

  const validation = await request.post("/api/cwd/validate", { data: { cwd: workspace } });
  expect(validation.status()).toBe(200);
  await expect(validation.json()).resolves.toMatchObject({ success: true, cwd: workspace });

  const encodedPath = workspace.split("/").map(encodeURIComponent).join("/");
  const files = await request.get(`/api/files/${encodedPath}?type=list&hideHidden=1`);
  expect(files.status()).toBe(200);
  await expect(files.json()).resolves.toMatchObject({
    path: workspace,
    entries: [
      expect.objectContaining({ name: "service-a", isDir: true }),
      expect.objectContaining({ name: "service-b", isDir: true }),
    ],
  });

  const visibleFiles = await request.get(`/api/files/${encodedPath}?type=list`);
  expect(visibleFiles.status()).toBe(200);
  const visibleFileData = await visibleFiles.json();
  expect(visibleFileData.path).toBe(workspace);
  expect(visibleFileData.entries).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "dist", isDir: true }),
    expect.objectContaining({ name: "service-a", isDir: true }),
    expect.objectContaining({ name: "service-b", isDir: true }),
  ]));
  expect(visibleFileData.entries).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "._bundle.js" }),
  ]));

  const generatedSearch = await request.get(`/api/file-index?${new URLSearchParams({ cwd: workspace, q: "bundle", includeIgnored: "1" })}`);
  expect(generatedSearch.status()).toBe(200);
  await expect(generatedSearch.json()).resolves.toMatchObject({
    matches: [expect.objectContaining({ path: "dist/bundle.js", isDir: false })],
  });

  const macMetadataSearch = await request.get(`/api/file-index?${new URLSearchParams({ cwd: workspace, q: "._bundle", includeIgnored: "1" })}`);
  expect(macMetadataSearch.status()).toBe(200);
  await expect(macMetadataSearch.json()).resolves.toMatchObject({ matches: [] });

  const repositories = await request.get(`/api/git/repositories?${new URLSearchParams({ cwd: workspace })}`);
  expect(repositories.status()).toBe(200);
  await expect(repositories.json()).resolves.toMatchObject({
    repositories: [
      expect.objectContaining({ path: `${workspace}/service-a`, label: "service-a", relativePath: "service-a" }),
      expect.objectContaining({ path: `${workspace}/service-b`, label: "service-b", relativePath: "service-b" }),
    ],
  });

  const git = await request.get(`/api/git/status?${new URLSearchParams({ cwd: workspace })}`);
  expect(git.status()).toBe(200);
  const terminals = await request.get(`/api/terminals?${new URLSearchParams({ cwd: workspace })}`);
  expect(terminals.status()).toBe(200);
});

test("loads the TianForge workspace shell without authentication on loopback", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/TianForge pi/);
  await expect(page.getByText("Pi", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Get Started")).toBeVisible();
  await expect(page.locator(".center-workspace").getByRole("tab", { name: "TianForge pi" })).toBeHidden();
  await expect(page.locator(".center-workspace").getByRole("button", { name: /^(Show|Hide) sidebar$/ })).toBeVisible();
  await expect(page.locator(".center-workspace").getByRole("button", { name: "Workspace activity" })).toBeVisible();
});

test("clears the global text-selection lock when a resize loses window focus", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop resize regression test");
  await page.goto("/");

  const handle = page.locator(".resize-handle--panel").first();
  await expect(handle).toBeVisible();
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await expect.poll(() => page.evaluate(() => document.body.style.userSelect)).toBe("none");

  // A mouse released outside the browser produces blur rather than mouseup.
  // The old implementation left body.userSelect="none" permanently.
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect.poll(() => page.evaluate(() => document.body.style.userSelect)).toBe("");
  await page.mouse.up();
});

test("restores the current tip when returning to a running session", async ({ page }, testInfo) => {
  const expectedPageSize = testInfo.project.name.startsWith("mobile") ? "40" : "80";
  const session = {
    id: "running-session",
    path: "/tmp/pi-web-running/session.jsonl",
    cwd: "/tmp/pi-web-running",
    projectRoot: "/tmp/pi-web-running",
    created: "2026-08-03T00:00:00.000Z",
    modified: "2026-08-03T00:01:00.000Z",
    messageCount: 2,
    firstMessage: "Start the task",
  };
  const detailRequests: string[] = [];

  await page.addInitScript(() => {
    localStorage.setItem("pi-web:active-leaf:running-session", "leaf-before-run");
  });
  await page.route("**/api/sessions/running-session/state", async (route) => route.fulfill({ json: {
    running: true,
    state: { isStreaming: true, isPromptRunning: true, isBashRunning: false, isCompacting: false },
  } }));
  await page.route("**/api/sessions/running-session?*", async (route) => {
    detailRequests.push(route.request().url());
    await route.fulfill({ json: {
      sessionId: session.id,
      filePath: session.path,
      info: session,
      leafId: "current-running-tip",
      tree: [],
      context: {
        messages: [
          { role: "user", content: "Start the task", timestamp: 1 },
          { role: "assistant", content: [{ type: "text", text: "Background progress is already persisted" }], stopReason: "stop", timestamp: 2 },
        ],
        entryIds: ["user-1", "current-running-tip"],
        thinkingLevel: "medium",
        model: { provider: "openai-codex", modelId: "gpt-5.6-sol" },
      },
    } });
  });
  await page.route("**/api/sessions", async (route) => route.fulfill({ json: { sessions: [session], runningSessionIds: [session.id] } }));
  await page.route("**/api/cwd/validate", async (route) => route.fulfill({ json: { success: true, cwd: session.cwd } }));
  await page.route("**/api/agent/running-session/events", async (route) => route.fulfill({
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    body: `data: ${JSON.stringify({ type: "connected", sessionId: session.id })}\n\n`,
  }));
  await page.route("**/api/agent/running-session", async (route) => {
    if (route.request().method() === "POST") return route.fulfill({ json: { success: true, data: [] } });
    return route.fulfill({ json: { running: true, state: { isStreaming: true, isPromptRunning: true } } });
  });

  await page.goto("/?session=running-session");
  await expect.poll(() => detailRequests.length).toBeGreaterThan(0);
  const initialDetailParams = new URL(detailRequests[0]).searchParams;
  expect(initialDetailParams.has("leafId")).toBe(false);
  expect(initialDetailParams.get("limit")).toBe(expectedPageSize);
  await expect(page.getByText("Background progress is already persisted", { exact: true })).toBeVisible();
  const selected = await page.getByText("Background progress is already persisted", { exact: true }).evaluate((element) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
    return selection?.toString();
  });
  expect(selected).toBe("Background progress is already persisted");
});

test("shows a persisted session snapshot before background refresh completes", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop persistent cache test");
  const session = {
    id: "cached-session",
    path: "/tmp/pi-web-cached/session.jsonl",
    cwd: "/tmp/pi-web-cached",
    projectRoot: "/tmp/pi-web-cached",
    created: "2026-08-03T00:00:00.000Z",
    modified: "2026-08-03T00:01:00.000Z",
    messageCount: 2,
    firstMessage: "Cached prompt",
  };
  let detailRequestCount = 0;
  let releaseRefresh = () => {};
  const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });

  await page.route("**/api/sessions/cached-session/state", async (route) => route.fulfill({ json: { running: false } }));
  await page.route("**/api/sessions/cached-session?*", async (route) => {
    detailRequestCount += 1;
    if (detailRequestCount > 1) {
      await refreshGate;
    }
    await route.fulfill({ json: {
      sessionId: session.id,
      filePath: session.path,
      modified: session.modified,
      info: session,
      leafId: "cached-tip",
      tree: [],
      context: {
        messages: [
          { role: "user", content: "Cached prompt", timestamp: 1 },
          { role: "assistant", content: [{ type: "text", text: "Instant cached answer" }], stopReason: "stop", timestamp: 2 },
        ],
        entryIds: ["cached-user", "cached-tip"],
        thinkingLevel: "medium",
        model: { provider: "openai-codex", modelId: "gpt-5.6-sol" },
        page: { hasMore: false, beforeEntryId: null, totalMessages: 2 },
      },
    } });
  });
  await page.route("**/api/sessions", async (route) => route.fulfill({ json: { sessions: [session], runningSessionIds: [] } }));
  await page.route("**/api/cwd/validate", async (route) => route.fulfill({ json: { success: true, cwd: session.cwd } }));

  await page.goto("/?session=cached-session");
  await expect(page.getByText("Instant cached answer", { exact: true })).toBeVisible();
  await page.waitForTimeout(700);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect.poll(() => detailRequestCount).toBe(2);
  // The second network response is deliberately blocked. Visibility here
  // proves the page restored its IndexedDB snapshot instead of waiting for it.
  await expect(page.getByText("Instant cached answer", { exact: true })).toBeVisible({ timeout: 1000 });
  releaseRefresh();
});

test("keeps a running session snapshot synchronized while another session is open", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop background session sync test");
  const cwd = "/tmp/pi-web-background-sync";
  const sessions = [
    { id: "background-a", name: "Session A", path: `${cwd}/a.jsonl`, cwd, projectRoot: cwd, created: "2026-08-03T00:00:00.000Z", modified: "2026-08-03T00:01:00.000Z", messageCount: 1, firstMessage: "Prompt A" },
    { id: "background-b", name: "Session B", path: `${cwd}/b.jsonl`, cwd, projectRoot: cwd, created: "2026-08-03T00:00:00.000Z", modified: "2026-08-03T00:02:00.000Z", messageCount: 1, firstMessage: "Prompt B" },
  ];
  const detail = (session: typeof sessions[number], prompt: string) => ({
    sessionId: session.id,
    filePath: session.path,
    modified: session.modified,
    info: session,
    leafId: `${session.id}-tip`,
    tree: [],
    context: {
      messages: [{ role: "user", content: prompt, timestamp: 1 }],
      entryIds: [`${session.id}-tip`],
      thinkingLevel: "medium",
      model: { provider: "openai-codex", modelId: "gpt-5.6-sol" },
      page: { hasMore: false, beforeEntryId: null, totalMessages: 1 },
    },
  });
  let blockARefresh = false;
  let releaseARefresh = () => {};
  const aRefreshGate = new Promise<void>((resolve) => { releaseARefresh = resolve; });
  let releaseBackgroundEvent = () => {};
  const backgroundEventGate = new Promise<void>((resolve) => { releaseBackgroundEvent = resolve; });

  await page.route("**/api/sessions/background-a/state", async (route) => route.fulfill({ json: {
    running: true,
    state: { isStreaming: true, isPromptRunning: true, isBashRunning: false, isCompacting: false },
  } }));
  await page.route("**/api/sessions/background-b/state", async (route) => route.fulfill({ json: { running: false } }));
  await page.route("**/api/sessions/background-a?*", async (route) => {
    if (blockARefresh) await aRefreshGate;
    await route.fulfill({ json: detail(sessions[0], "Prompt A") });
  });
  await page.route("**/api/sessions/background-b?*", async (route) => route.fulfill({ json: detail(sessions[1], "Prompt B") }));
  await page.route("**/api/sessions", async (route) => route.fulfill({ json: { sessions, runningSessionIds: ["background-a"] } }));
  await page.route("**/api/cwd/validate", async (route) => route.fulfill({ json: { success: true, cwd } }));
  await page.route("**/api/agent/running/events", async (route) => {
    await backgroundEventGate;
    await route.fulfill({
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      body: [
        `data: ${JSON.stringify({ type: "running", runningSessionIds: ["background-a"] })}`,
        `data: ${JSON.stringify({
          type: "session_event",
          sessionId: "background-a",
          event: {
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text: "Background synced answer" }], stopReason: "stop", timestamp: 2 },
          },
        })}`,
        `data: ${JSON.stringify({ type: "terminals", terminals: [], limits: { running: 20, records: 100 } })}`,
        `data: ${JSON.stringify({ type: "codex_runtimes", runtimes: [] })}`,
        "",
      ].join("\n\n"),
    });
  });
  await page.route("**/api/agent/background-a/events", async (route) => route.fulfill({
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    body: `data: ${JSON.stringify({ type: "connected", sessionId: "background-a" })}\n\n`,
  }));
  await page.route("**/api/agent/background-a", async (route) => {
    if (route.request().method() === "POST") return route.fulfill({ json: { success: true, data: [] } });
    return route.fulfill({ json: { running: true, state: { isStreaming: true, isPromptRunning: true } } });
  });

  await page.goto("/?session=background-a");
  await expect(page.getByText("Prompt A", { exact: true })).toBeVisible();
  await page.waitForTimeout(300);
  await page.getByText("Session B", { exact: true }).click();
  await expect(page.getByText("Prompt B", { exact: true })).toBeVisible();
  releaseBackgroundEvent();
  await page.waitForTimeout(300);
  blockARefresh = true;
  await page.getByText("Session A", { exact: true }).click();

  // The network refresh for A is blocked. This answer can only come from the
  // snapshot kept current by the global running-session event stream.
  await expect(page.getByText("Background synced answer", { exact: true })).toBeVisible({ timeout: 1000 });
  releaseARefresh();
});

test("loads older session history only after scrolling to the top", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop history paging test");
  const session = {
    id: "paged-session",
    path: "/tmp/pi-web-paged/session.jsonl",
    cwd: "/tmp/pi-web-paged",
    projectRoot: "/tmp/pi-web-paged",
    created: "2026-08-03T00:00:00.000Z",
    modified: "2026-08-03T00:01:00.000Z",
    messageCount: 82,
    firstMessage: "Oldest prompt",
  };
  const tailMessages = Array.from({ length: 40 }, (_, index) => [
    { role: "user", content: `Recent prompt ${index}`, timestamp: index * 2 + 10 },
    { role: "assistant", content: [{ type: "text", text: `Recent answer ${index}` }], stopReason: "stop", timestamp: index * 2 + 11 },
  ]).flat();
  const tailEntryIds = tailMessages.map((_, index) => `tail-${index}`);
  let olderRequests = 0;

  await page.route("**/api/sessions/paged-session/state", async (route) => route.fulfill({ json: { running: false } }));
  await page.route("**/api/sessions/paged-session?*", async (route) => route.fulfill({ json: {
    sessionId: session.id,
    filePath: session.path,
    modified: session.modified,
    info: session,
    leafId: "tail-79",
    tree: [],
    context: {
      messages: tailMessages,
      entryIds: tailEntryIds,
      thinkingLevel: "medium",
      model: { provider: "openai-codex", modelId: "gpt-5.6-sol" },
      page: { hasMore: true, beforeEntryId: "tail-0", totalMessages: 82 },
    },
  } }));
  await page.route("**/api/sessions/paged-session/context?*", async (route) => {
    olderRequests += 1;
    const params = new URL(route.request().url()).searchParams;
    expect(params.get("beforeEntryId")).toBe("tail-0");
    await route.fulfill({ json: { context: {
      messages: [
        { role: "user", content: "Oldest prompt", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "Oldest answer" }], stopReason: "stop", timestamp: 2 },
      ],
      entryIds: ["old-user", "old-answer"],
      thinkingLevel: "medium",
      model: { provider: "openai-codex", modelId: "gpt-5.6-sol" },
      page: { hasMore: false, beforeEntryId: null, totalMessages: 82 },
    } } });
  });
  await page.route("**/api/sessions", async (route) => route.fulfill({ json: { sessions: [session], runningSessionIds: [] } }));
  await page.route("**/api/cwd/validate", async (route) => route.fulfill({ json: { success: true, cwd: session.cwd } }));

  await page.goto("/?session=paged-session");
  await expect(page.getByText("Recent answer 39", { exact: true })).toBeVisible();
  expect(olderRequests).toBe(0);
  const scrollContainer = page.locator('[class*="overflow-y-auto"][class*="pt-4"]').first();
  await scrollContainer.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(page.getByText("Oldest answer", { exact: true })).toBeVisible();
  expect(olderRequests).toBe(1);
});

test("renders math in chat messages after KaTeX loads on demand", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop chat rendering test");
  const session = {
    id: "math-session",
    path: "/tmp/pi-web-math/session.jsonl",
    cwd: "/tmp/pi-web-math",
    projectRoot: "/tmp/pi-web-math",
    created: "2026-08-03T00:00:00.000Z",
    modified: "2026-08-03T00:01:00.000Z",
    messageCount: 2,
    firstMessage: "Show some math",
  };
  await page.route("**/api/sessions/math-session/state", async (route) => route.fulfill({ json: { running: false } }));
  await page.route("**/api/sessions/math-session?*", async (route) => route.fulfill({ json: {
    sessionId: session.id,
    filePath: session.path,
    modified: session.modified,
    info: session,
    leafId: "answer",
    tree: [],
    context: {
      messages: [
        { role: "user", content: "Show some math", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "Euler: $e^{i\\pi}+1=0$\n\n$$\n\\int_0^1 x\\,dx\n$$" }], stopReason: "stop", timestamp: 2 },
      ],
      entryIds: ["prompt", "answer"],
      thinkingLevel: "medium",
      model: { provider: "openai-codex", modelId: "gpt-5.6-sol" },
      page: { hasMore: false, beforeEntryId: null, totalMessages: 2 },
    },
  } }));
  await page.route("**/api/sessions", async (route) => route.fulfill({ json: { sessions: [session], runningSessionIds: [] } }));
  await page.route("**/api/cwd/validate", async (route) => route.fulfill({ json: { success: true, cwd: session.cwd } }));

  await page.goto("/?session=math-session");
  await expect(page.locator(".markdown-body .katex").first()).toBeVisible();
  await expect(page.locator(".markdown-body .katex-display")).toBeVisible();
  // The lazily loaded KaTeX stylesheet must be applied, not just the markup.
  await expect.poll(() => page.locator(".markdown-body .katex").first().evaluate((element) => getComputedStyle(element).fontFamily)).toContain("KaTeX_Main");
});

test("loads the system prompt on demand for a session that is not running", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop top bar test");
  const session = {
    id: "prompt-session",
    path: "/tmp/pi-web-prompt/session.jsonl",
    cwd: "/tmp/pi-web-prompt",
    projectRoot: "/tmp/pi-web-prompt",
    created: "2026-08-03T00:00:00.000Z",
    modified: "2026-08-03T00:01:00.000Z",
    messageCount: 2,
    firstMessage: "Hello",
  };
  let stateRequests = 0;
  await page.route("**/api/sessions/prompt-session/state", async (route) => route.fulfill({ json: { running: false } }));
  await page.route("**/api/sessions/prompt-session?*", async (route) => route.fulfill({ json: {
    sessionId: session.id,
    filePath: session.path,
    modified: session.modified,
    info: session,
    leafId: "answer",
    tree: [],
    context: {
      messages: [
        { role: "user", content: "Hello", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "Hi" }], stopReason: "stop", timestamp: 2 },
      ],
      entryIds: ["prompt", "answer"],
      thinkingLevel: "medium",
      model: { provider: "openai-codex", modelId: "gpt-5.6-sol" },
      page: { hasMore: false, beforeEntryId: null, totalMessages: 2 },
    },
  } }));
  await page.route("**/api/agent/prompt-session", async (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: { running: false } });
    expect(route.request().postDataJSON()).toEqual({ type: "get_state" });
    stateRequests += 1;
    return route.fulfill({ json: { success: true, data: { systemPrompt: "You are a careful coding agent." } } });
  });
  await page.route("**/api/sessions", async (route) => route.fulfill({ json: { sessions: [session], runningSessionIds: [] } }));
  await page.route("**/api/cwd/validate", async (route) => route.fulfill({ json: { success: true, cwd: session.cwd } }));

  await page.goto("/?session=prompt-session");
  await expect(page.getByText("Hi", { exact: true })).toBeVisible();
  expect(stateRequests).toBe(0);
  await page.getByRole("button", { name: "System prompt" }).click();
  await expect(page.getByText("You are a careful coding agent.")).toBeVisible();
  expect(stateRequests).toBe(1);
});

test("renders a usable mobile shell", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("mobile"), "mobile project only");
  await page.goto("/");
  await expect(page.getByText("Pi", { exact: true }).first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const navigation = page.getByRole("navigation", { name: "Mobile navigation" });
  await navigation.getByRole("button", { name: "Agents" }).click();
  await expect(page.getByRole("navigation", { name: "Sidebar modules" }).getByRole("button", { name: "Agents" })).toHaveAttribute("aria-pressed", "true");
  await navigation.getByRole("button", { name: "Files" }).click();
  await expect(page.getByRole("navigation", { name: "Sidebar modules" }).getByRole("button", { name: "Agents" })).toHaveAttribute("aria-pressed", "true");
  await page.goBack();
  await expect(navigation.getByRole("button", { name: "Workspace" })).toHaveAttribute("aria-pressed", "true");
  await navigation.getByRole("button", { name: "Agents" }).click();
  await navigation.getByRole("button", { name: "Workspace" }).click();
  await expect(navigation.getByRole("button", { name: "Workspace" })).toHaveAttribute("aria-pressed", "true");
});

test("fullscreen right panel covers mobile navigation", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("mobile"), "mobile project only");
  await page.route("**/api/sessions", async (route) => route.fulfill({ json: { sessions: [{
    id: "pi-session", path: "/tmp/pi-web-e2e/session.jsonl", cwd: "/tmp/pi-web-e2e", projectRoot: "/tmp/pi-web-e2e",
    created: "2026-08-03T00:00:00.000Z", modified: "2026-08-03T00:00:00.000Z", messageCount: 1, firstMessage: "test",
  }], runningSessionIds: [] } }));
  await page.route("**/api/git/status?*", async (route) => route.fulfill({ json: { isGitRepository: false, files: [] } }));
  // The mocked project path does not exist on disk; without this, workspace
  // activation fails validation and no project is selected.
  await page.route("**/api/cwd/validate", async (route) => route.fulfill({ json: { success: true, cwd: "/tmp/pi-web-e2e" } }));
  await page.goto("/");
  const navigation = page.getByRole("navigation", { name: "Mobile navigation" });
  await navigation.getByRole("button", { name: "Git" }).click();
  await page.getByRole("button", { name: "Fullscreen" }).click();
  await expect(page.locator(".right-panel-container")).toHaveClass(/right-panel-fullscreen/);
  await expect(navigation).toBeHidden();
  await expect.poll(() => page.locator(".right-panel-container").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return Math.abs(rect.left) < 2 && Math.abs(rect.top) < 2 && Math.abs(rect.width - window.innerWidth) < 2 && Math.abs(rect.height - window.innerHeight) < 2;
  })).toBe(true);
});

test("switches and remembers the sidebar module", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop sidebar test");
  await page.goto("/");
  const modules = page.getByRole("navigation", { name: "Sidebar modules" });
  await expect(modules.getByRole("button", { name: "Files" })).toHaveCount(0);
  await expect(modules.getByRole("button", { name: "All" })).toHaveCount(0);
  await modules.getByRole("button", { name: "Agents" }).click();
  await expect(modules.getByRole("button", { name: "Agents" })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("pi-sidebar-module"))).toBe("agents");
  await page.reload();
  await expect(page.getByRole("navigation", { name: "Sidebar modules" }).getByRole("button", { name: "Agents" })).toHaveAttribute("aria-pressed", "true");
});

test("switches between persisted project workspaces", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop project rail test");
  test.setTimeout(60_000);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const sessions = [
    { id: "session-a", path: "/tmp/project-a/session.jsonl", cwd: "/tmp/project-a", projectRoot: "/tmp/project-a", created: "2026-08-03T00:00:00.000Z", modified: "2026-08-03T00:00:00.000Z", messageCount: 1, firstMessage: "A" },
    { id: "session-b", path: "/tmp/project-b/session.jsonl", cwd: "/tmp/project-b", projectRoot: "/tmp/project-b", created: "2026-08-03T00:00:00.000Z", modified: "2026-08-03T00:01:00.000Z", messageCount: 1, firstMessage: "B" },
  ];
  const authorizedCwds = new Set<string>();
  let deniedWorkspaceRequests = 0;
  await page.addInitScript((snapshot) => {
    if (!localStorage.getItem("pi-web:project-workspaces:v1")) localStorage.setItem("pi-web:project-workspaces:v1", JSON.stringify(snapshot));
  }, {
    activeId: "/tmp/project-a",
    workspaces: [
      { id: "/tmp/project-a", projectRoot: "/tmp/project-a", cwd: "/tmp/project-a", label: "project-a", sessionId: "session-a", lastActive: 2 },
      { id: "/tmp/project-b", projectRoot: "/tmp/project-b", cwd: "/tmp/project-b", label: "project-b", sessionId: "session-b", lastActive: 1 },
    ],
  });
  await page.route("**/api/sessions", async (route) => route.fulfill({ json: { sessions, runningSessionIds: [] } }));
  await page.route("**/api/cwd/validate", async (route) => {
    const body = route.request().postDataJSON() as { cwd?: string };
    if (!body.cwd) return route.fulfill({ status: 400, json: { error: "cwd required" } });
    authorizedCwds.add(body.cwd);
    return route.fulfill({ json: { success: true, cwd: body.cwd } });
  });
  await page.route("**/api/terminals?*", async (route) => {
    const cwd = new URL(route.request().url()).searchParams.get("cwd") ?? "";
    return route.fulfill({ json: { cwd, terminals: [], stats: null } });
  });
  await mockStatusStream(page, [
    { type: "running", runningSessionIds: [] },
    { type: "terminals", terminals: [], limits: { running: 20, records: 100 } },
    { type: "codex_runtimes", runtimes: [] },
  ]);
  await page.route("**/api/worktrees?*", async (route) => route.fulfill({ json: { projectRoot: new URL(route.request().url()).searchParams.get("cwd"), isGit: false, isTopLevel: true, worktrees: [] } }));
  await page.route("**/api/git/status?*", async (route) => {
    const cwd = new URL(route.request().url()).searchParams.get("cwd");
    if (!cwd || !authorizedCwds.has(cwd)) {
      deniedWorkspaceRequests += 1;
      return route.fulfill({ status: 403, json: { error: "Access denied" } });
    }
    await route.fulfill({ json: cwd === "/tmp/project-a"
      ? { isGitRepository: true, branch: "feature/a", files: [{ filePath: "README.md", status: "modified", code: "M", indexStatus: " ", worktreeStatus: "M" }] }
      : { isGitRepository: true, branch: "main", files: [] } });
  });
  await page.route("**/api/files/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const cwd = pathname.includes("project-a") ? "/tmp/project-a" : pathname.includes("project-b") ? "/tmp/project-b" : null;
    if (cwd && !authorizedCwds.has(cwd)) {
      deniedWorkspaceRequests += 1;
      return route.fulfill({ status: 403, json: { error: "Access denied" } });
    }
    return route.fulfill({ json: { entries: [] } });
  });
  await page.goto("/");
  const rail = page.getByRole("navigation", { name: "Project workspaces" });
  await expect(rail.getByText("project-a", { exact: true })).toBeVisible();
  await expect(rail.getByText("project-b", { exact: true })).toBeVisible();
  await expect(rail.getByTitle("/tmp/project-a")).toHaveAttribute("aria-current", "page");
  await expect(rail.getByText("feature/a", { exact: true })).toBeVisible();
  await expect(rail.getByText("1 Git changes", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Copy project path: /tmp/project-a" }).click();
  await expect(page.getByRole("button", { name: "Project path copied" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("/tmp/project-a");
  await expect(page.getByRole("button", { name: "Use default directory" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Custom path…" })).toHaveCount(0);
  expect(deniedWorkspaceRequests).toBe(0);

  // Model a backend restart while the React tree and its workspace state stay
  // alive. Re-activating the current project must validate it again instead of
  // trusting a stale client-side "authorized" flag.
  authorizedCwds.clear();
  await rail.getByTitle("/tmp/project-a").click();
  await expect.poll(() => authorizedCwds.has("/tmp/project-a")).toBe(true);
  expect(deniedWorkspaceRequests).toBe(0);
  await rail.getByRole("button", { name: "Workspace activity" }).click();
  const activityDialog = page.getByRole("dialog", { name: "Workspace activity" });
  await expect(activityDialog).toBeVisible();
  await activityDialog.getByRole("button", { name: "Close workspace activity" }).click();
  await rail.getByRole("button", { name: "Search projects" }).click();
  const projectSearch = page.getByRole("dialog", { name: "Search projects" });
  await projectSearch.getByRole("textbox", { name: "Search projects" }).fill("project-b");
  await expect(projectSearch.getByRole("option", { name: /project-b/ })).toBeVisible();
  await projectSearch.getByRole("textbox", { name: "Search projects" }).press("Enter");
  await expect(rail.getByTitle("/tmp/project-b")).toHaveAttribute("aria-current", "page");
  await rail.getByTitle("/tmp/project-a").click();
  await rail.getByTitle("/tmp/project-a").click({ button: "right" });
  await expect(page.getByRole("menu", { name: "project-a actions" })).toBeVisible();
  await page.getByRole("menu", { name: "project-a actions" }).getByRole("menuitem", { name: "Rename" }).click();
  const renameDialog = page.getByRole("dialog", { name: "Rename project" });
  await renameDialog.getByRole("textbox", { name: "Project name" }).fill("Project Alpha");
  await renameDialog.getByRole("button", { name: "Rename" }).click();
  await expect(rail.getByText("Project Alpha", { exact: true })).toBeVisible();
  await rail.getByTitle("/tmp/project-a").click({ button: "right" });
  await page.getByRole("menu", { name: "Project Alpha actions" }).getByRole("menuitem", { name: "Pin project" }).click();
  await rail.getByTitle("/tmp/project-a").click({ button: "right" });
  await expect(page.getByRole("menu", { name: "Project Alpha actions" }).getByRole("menuitem", { name: "Unpin project" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+2");
  await expect(rail.getByTitle("/tmp/project-b")).toHaveAttribute("aria-current", "page");
  await page.keyboard.press("Meta+1");
  await expect(rail.getByTitle("/tmp/project-a")).toHaveAttribute("aria-current", "page");
  await rail.getByTitle("/tmp/project-b").click({ button: "right" });
  await page.getByRole("menu", { name: "project-b actions" }).getByRole("menuitem", { name: "New terminal" }).click();
  const terminalDialog = page.getByRole("dialog", { name: "New terminal" });
  await expect(terminalDialog.locator("input[readonly]")).toHaveValue("/tmp/project-b");
  await terminalDialog.getByRole("button", { name: "Cancel" }).click();
  await rail.getByTitle("/tmp/project-a").click();
  await page.getByRole("button", { name: "Show file panel" }).click();
  await expect(page.getByRole("button", { name: "Hide file panel" })).toBeVisible();
  await page.getByRole("button", { name: "Hide file panel" }).click();
  await expect(page.locator(".right-panel-container")).toHaveClass(/right-panel-closed/);
  await page.getByRole("button", { name: "Show file panel" }).click();
  await page.getByRole("button", { name: "Open Git Review" }).click();
  await expect(page.locator(".right-panel-container")).toHaveClass(/right-panel-open/);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem(`pi-web:right-panel-tabs:${encodeURIComponent("/tmp/project-a")}`) || "null")?.open)).toBe(true);
  await rail.getByTitle("/tmp/project-b").click();
  await expect(rail.getByTitle("/tmp/project-b")).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".right-panel-container")).toHaveClass(/right-panel-closed/);
  await expect.poll(() => page.evaluate(() => document.title)).toContain("project-b");
  await rail.getByTitle("/tmp/project-a").click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem(`pi-web:right-panel-tabs:${encodeURIComponent("/tmp/project-a")}`) || "null")?.open)).toBe(true);
  await expect(page.locator(".right-panel-container")).toHaveClass(/right-panel-open/);
  await rail.getByTitle("/tmp/project-b").click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("pi-web:project-workspaces:v1") || "null")?.activeId)).toBe("/tmp/project-b");
  await expect.poll(() => new URL(page.url()).searchParams.get("session")).toBe("session-b");
  await page.reload();
  await expect(page.getByRole("navigation", { name: "Project workspaces" }).getByTitle("/tmp/project-b")).toHaveAttribute("aria-current", "page");
  await page.getByRole("navigation", { name: "Project workspaces" }).getByTitle("/tmp/project-b").click({ button: "right" });
  await page.getByRole("menu", { name: "project-b actions" }).getByRole("menuitem", { name: "Close project" }).click();
  const closedNotice = page.getByRole("status");
  await expect(closedNotice).toContainText("Closed project-b");
  await page.keyboard.press("Meta+Shift+T");
  await expect(page.getByRole("navigation", { name: "Project workspaces" }).getByTitle("/tmp/project-b")).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "Collapse project bar" }).click();
  await expect.poll(() => page.getByRole("navigation", { name: "Project workspaces" }).evaluate((element) => element.getBoundingClientRect().width)).toBeLessThan(60);
  await page.reload();
  await expect(page.getByRole("button", { name: "Expand project bar" })).toBeVisible();
});

test("drives project rail activity from pushed terminal status without polling", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop project rail push test");
  const cwd = "/tmp/pi-web-push-rail";
  await page.addInitScript((snapshot) => {
    if (!localStorage.getItem("pi-web:project-workspaces:v1")) localStorage.setItem("pi-web:project-workspaces:v1", JSON.stringify(snapshot));
  }, {
    activeId: cwd,
    workspaces: [{ id: cwd, projectRoot: cwd, cwd, label: "push-rail", sessionId: null, lastActive: 1 }],
  });
  const terminal = {
    id: "push-terminal", title: "Dev server", provider: "shell", state: "running", exitCode: null, cwd,
    pid: 111, permissionMode: "confirm", launchMode: "new", noAltScreen: false, cols: 80, rows: 24,
    createdAt: "2026-08-03T00:00:00.000Z", endedAt: null, signal: null, bufferBytes: 0, bufferTruncated: false, history: [],
  };
  let terminalRequests = 0;
  let codexRuntimeRequests = 0;
  await page.route("**/api/sessions", async (route) => route.fulfill({ json: { sessions: [], runningSessionIds: [] } }));
  await page.route("**/api/cwd/validate", async (route) => route.fulfill({ json: { success: true, cwd } }));
  await page.route("**/api/git/status?*", async (route) => route.fulfill({ json: { isGitRepository: false, files: [] } }));
  await page.route("**/api/worktrees?*", async (route) => route.fulfill({ json: { projectRoot: cwd, isGit: false, isTopLevel: true, worktrees: [] } }));
  // `**` (not `?*`) so a query-less /api/terminals poll would be counted too.
  // The GET reports no terminals: only the pushed frame knows about one.
  await page.route("**/api/terminals**", async (route) => {
    terminalRequests += 1;
    return route.fulfill({ json: {
      cwd,
      terminals: [],
      stats: { workspace: { running: 0, records: 0, bufferBytes: 0 }, global: { running: 0, records: 0, bufferBytes: 0 }, limits: { running: 20, records: 100 } },
    } });
  });
  await page.route("**/api/codex/runtime", async (route) => { codexRuntimeRequests += 1; return route.fulfill({ json: { runtimes: [] } }); });
  // Hold the status stream until the GET has been served, so the pushed frame
  // is applied after (and not overwritten by) the GET's empty list.
  let releaseStream!: () => void;
  const streamReleased = new Promise<void>((resolve) => { releaseStream = resolve; });
  await page.route("**/api/agent/running/events", async (route) => {
    await streamReleased;
    return route.fulfill({
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      body: [
        { type: "running", runningSessionIds: [] },
        { type: "terminals", terminals: [terminal], limits: { running: 20, records: 100 } },
        { type: "codex_runtimes", runtimes: [] },
      ].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""),
    });
  });

  const terminalsServed = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/terminals");
  await page.goto("/");
  const rail = page.getByRole("navigation", { name: "Project workspaces" });
  await terminalsServed;
  await expect.poll(() => terminalRequests).toBe(1);
  // The dot on the project tab reports its counts through its aria-label. The
  // GET returned no terminals, so "Running: 1 working" can only come from the
  // pushed "terminals" frame.
  await expect(rail.getByLabel("Running: 1 working")).toHaveCount(0);
  releaseStream();
  await expect(rail.getByLabel("Running: 1 working")).toBeVisible();

  // No 5 s poll should follow: neither /api/terminals nor /api/codex/runtime
  // should be requested again while the pushed status stays the same.
  await page.waitForTimeout(11_000);
  expect(terminalRequests).toBe(1);
  expect(codexRuntimeRequests).toBe(0);
});

test("opens the specific terminal behind a project rail activity item", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop project rail test");
  const cwdA = "/tmp/pi-web-rail-open-a";
  const cwdB = "/tmp/pi-web-rail-open-b";
  // Project C is open on a worktree; its terminal runs in the main checkout.
  const rootC = "/tmp/pi-web-rail-open-c";
  const worktreeC = "/tmp/pi-web-rail-open-c-worktrees/feat";
  await page.addInitScript((snapshot) => {
    if (!localStorage.getItem("pi-web:project-workspaces:v1")) localStorage.setItem("pi-web:project-workspaces:v1", JSON.stringify(snapshot));
  }, {
    activeId: cwdA,
    workspaces: [
      { id: cwdA, projectRoot: cwdA, cwd: cwdA, label: "rail-open-a", sessionId: null, lastActive: 2 },
      { id: cwdB, projectRoot: cwdB, cwd: cwdB, label: "rail-open-b", sessionId: null, lastActive: 1 },
      { id: rootC, projectRoot: rootC, cwd: worktreeC, label: "rail-open-c", sessionId: null, lastActive: 0 },
    ],
  });
  const terminal = (id: string, title: string, cwd: string) => ({
    id, title, provider: "shell", state: "running", exitCode: null, cwd,
    pid: 111, permissionMode: "confirm", launchMode: "new", noAltScreen: false, cols: 80, rows: 24,
    createdAt: "2026-08-03T00:00:00.000Z", endedAt: null, signal: null, bufferBytes: 0, bufferTruncated: false, history: [],
  });
  const terminals = [terminal("rail-terminal-a", "Dev server", cwdA), terminal("rail-terminal-b", "Build watcher", cwdB), terminal("rail-terminal-c", "Root server", rootC)];
  await page.route("**/api/sessions", async (route) => route.fulfill({ json: { sessions: [], runningSessionIds: [] } }));
  await page.route("**/api/cwd/validate", async (route) => {
    const body = route.request().postDataJSON() as { cwd?: string };
    return body.cwd ? route.fulfill({ json: { success: true, cwd: body.cwd } }) : route.fulfill({ status: 400, json: { error: "cwd required" } });
  });
  await page.route("**/api/git/status?*", async (route) => route.fulfill({ json: { isGitRepository: false, files: [] } }));
  await page.route("**/api/worktrees?*", async (route) => route.fulfill({ json: { projectRoot: new URL(route.request().url()).searchParams.get("cwd"), isGit: false, isTopLevel: true, worktrees: [] } }));
  await page.route("**/api/terminals**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/api/terminals") return route.fulfill({ status: 404, json: { error: "not found" } });
    const cwd = url.searchParams.get("cwd") ?? "";
    const own = terminals.filter((item) => item.cwd === cwd);
    return route.fulfill({ json: {
      cwd,
      terminals: own,
      stats: { workspace: { running: own.length, records: own.length, bufferBytes: 0 }, global: { running: 2, records: 2, bufferBytes: 0 }, limits: { running: 20, records: 100 } },
    } });
  });
  await mockStatusStream(page, [
    { type: "running", runningSessionIds: [] },
    { type: "terminals", terminals, limits: { running: 20, records: 100 } },
    { type: "codex_runtimes", runtimes: [] },
  ]);

  await page.goto("/");
  const rail = page.getByRole("navigation", { name: "Project workspaces" });
  const workspaceTabs = page.locator(".center-workspace").getByRole("tablist").first();
  await expect(rail.getByTitle(cwdA)).toHaveAttribute("aria-current", "page");

  // Active project: the badge menu lists the terminal itself and opens its tab.
  await rail.getByTitle(cwdA).getByLabel("Running: 1 working").click();
  const menu = page.getByRole("dialog", { name: "rail-open-a activity" });
  const devServer = menu.getByRole("button", { name: /^Dev server · Terminal · Running$/ });
  await expect(devServer).toBeVisible();
  await expect(menu.getByRole("button", { name: "Open workspace" })).toBeVisible();
  await devServer.click();
  await expect(menu).toBeHidden();
  const devServerTab = page.locator('.center-workspace [role="tab"][data-tab-id="terminal:rail-terminal-a"]');
  await expect(devServerTab).toHaveAttribute("aria-label", "Dev server");
  await expect(devServerTab).toHaveAttribute("aria-selected", "true");
  // A desktop pointer keeps the touch-key bar hidden (the panel loads lazily;
  // wait for it so the check and the touch below hit the mounted terminal).
  const terminalHeader = page.locator(".agent-terminal-header");
  await expect(terminalHeader).toBeVisible();
  const touchKeys = page.getByLabel("Terminal shortcuts");
  await expect(touchKeys).toHaveCount(1);
  await expect(touchKeys).toBeHidden();
  // Touch input on a device that reports a fine pointer (a tablet with a
  // trackpad or stylus) shows the keys; the More menu can force them off/on.
  await page.evaluate(() => window.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "touch" })));
  await expect(touchKeys).toBeVisible();
  await terminalHeader.getByRole("button", { name: "More ▾" }).click();
  await terminalHeader.getByRole("button", { name: "Hide touch keys" }).click();
  await expect(touchKeys).toBeHidden();
  await terminalHeader.getByRole("button", { name: "More ▾" }).click();
  await terminalHeader.getByRole("button", { name: "Show touch keys" }).click();
  await expect(touchKeys).toBeVisible();

  // Another project: the activity center switches to it first, then opens the
  // terminal on top of that project's restored tabs.
  await rail.getByRole("button", { name: "Workspace activity" }).click();
  const center = page.getByRole("dialog", { name: "Workspace activity" });
  await center.getByRole("group", { name: "rail-open-b activity items" }).getByRole("button", { name: /^Build watcher · Terminal/ }).click();
  await expect(center).toBeHidden();
  await expect(rail.getByTitle(cwdB)).toHaveAttribute("aria-current", "page");
  const buildWatcherTab = page.locator('.center-workspace [role="tab"][data-tab-id="terminal:rail-terminal-b"]');
  await expect(buildWatcherTab).toHaveAttribute("aria-selected", "true");
  await expect(workspaceTabs.getByRole("tab", { name: "Build watcher" })).toBeVisible();
  await expect(devServerTab).toHaveCount(0);

  // Each project kept its own opened tab.
  await rail.getByTitle(cwdA).click();
  await expect(rail.getByTitle(cwdA)).toHaveAttribute("aria-current", "page");
  await expect(devServerTab).toBeVisible();
  await expect(buildWatcherTab).toHaveCount(0);

  // A terminal matched by project root, not by the workspace's worktree cwd,
  // opens with the workspace switched to the terminal's own directory, so the
  // tab is backed by a live record instead of "Terminal process is unavailable".
  await rail.getByRole("button", { name: "Workspace activity" }).click();
  await center.getByRole("group", { name: "rail-open-c activity items" }).getByRole("button", { name: /^Root server · Terminal/ }).click();
  await expect(rail.getByTitle(rootC)).toHaveAttribute("aria-current", "page");
  const rootServerTab = page.locator('.center-workspace [role="tab"][data-tab-id="terminal:rail-terminal-c"]');
  await expect(rootServerTab).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("pi-web:project-workspaces:v1") || "null")?.workspaces?.find((workspace: { id: string }) => workspace.id === "/tmp/pi-web-rail-open-c")?.cwd)).toBe(rootC);
  await expect(page.getByText("Terminal process is unavailable")).toHaveCount(0);
});

test("lists recent notifications, marks them read on the server, and opens their target", async ({ page }, testInfo) => {
  const mobile = testInfo.project.name.startsWith("mobile");
  const cwdA = "/tmp/pi-web-notify-a";
  const cwdB = "/tmp/pi-web-notify-b";
  await page.addInitScript((snapshot) => {
    if (!localStorage.getItem("pi-web:project-workspaces:v1")) localStorage.setItem("pi-web:project-workspaces:v1", JSON.stringify(snapshot));
  }, {
    activeId: cwdA,
    workspaces: [
      { id: cwdA, projectRoot: cwdA, cwd: cwdA, label: "notify-a", sessionId: null, lastActive: 2 },
      { id: cwdB, projectRoot: cwdB, cwd: cwdB, label: "notify-b", sessionId: null, lastActive: 1 },
    ],
  });
  const terminal = {
    id: "notify-terminal", title: "Nightly build", provider: "codex", state: "exited", exitCode: 1, cwd: cwdB,
    pid: 111, permissionMode: "confirm", launchMode: "new", noAltScreen: true, cols: 80, rows: 24,
    createdAt: "2026-08-03T00:00:00.000Z", endedAt: "2026-08-03T00:05:00.000Z", signal: null, bufferBytes: 0, bufferTruncated: false, history: [],
  };
  const now = Date.now();
  const notifications = [
    { id: "n2", kind: "terminal", event: "failed", targetId: terminal.id, cwd: cwdB, title: "Nightly build", detail: "Exited with code 1", createdAt: now - 5 * 60_000, read: false },
    { id: "n1", kind: "codex", event: "completed", targetId: "notify-thread", cwd: cwdA, title: "Refactor rail", createdAt: now - 2 * 60 * 60_000, read: true },
  ];
  await page.route("**/api/sessions", async (route) => route.fulfill({ json: { sessions: [], runningSessionIds: [] } }));
  await page.route("**/api/cwd/validate", async (route) => {
    const body = route.request().postDataJSON() as { cwd?: string };
    return body.cwd ? route.fulfill({ json: { success: true, cwd: body.cwd } }) : route.fulfill({ status: 400, json: { error: "cwd required" } });
  });
  await page.route("**/api/git/status?*", async (route) => route.fulfill({ json: { isGitRepository: false, files: [] } }));
  await page.route("**/api/worktrees?*", async (route) => route.fulfill({ json: { projectRoot: new URL(route.request().url()).searchParams.get("cwd"), isGit: false, isTopLevel: true, worktrees: [] } }));
  await page.route("**/api/terminals**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/api/terminals") return route.fulfill({ status: 404, json: { error: "not found" } });
    const cwd = url.searchParams.get("cwd") ?? "";
    const own = cwd === cwdB ? [terminal] : [];
    return route.fulfill({ json: {
      cwd,
      terminals: own,
      stats: { workspace: { running: 0, records: own.length, bufferBytes: 0 }, global: { running: 0, records: 1, bufferBytes: 0 }, limits: { running: 20, records: 100 } },
    } });
  });
  const readRequests: unknown[] = [];
  await page.route("**/api/notifications/read", async (route) => {
    readRequests.push(route.request().postDataJSON());
    return route.fulfill({ json: { changed: 1 } });
  });
  await mockStatusStream(page, [
    { type: "running", runningSessionIds: [] },
    { type: "terminals", terminals: [terminal], limits: { running: 20, records: 100 } },
    { type: "codex_runtimes", runtimes: [] },
    { type: "notifications", notifications, unread: 1 },
  ]);

  await page.goto("/");
  const activityButton = page.locator(".center-workspace").getByRole("button", { name: "Workspace activity" });
  await expect(activityButton.getByTestId("activity-unread-count")).toHaveText("1");
  if (!mobile) await expect(page.getByRole("navigation", { name: "Project workspaces" }).getByTestId("activity-unread-badge")).toHaveText("1");

  await activityButton.click();
  const recent = page.getByRole("dialog", { name: "Workspace activity" }).getByRole("region", { name: "Recent notifications" });
  await expect(recent.getByText("Recent · 1 unread")).toBeVisible();
  const unread = recent.getByRole("button", { name: "Nightly build · Terminal · Failed · unread" });
  await expect(unread).toHaveAttribute("data-unread", "true");
  await expect(unread).toContainText("notify-b · Terminal · Failed · 5m ago · Exited with code 1");
  await expect(recent.getByRole("button", { name: "Refactor rail · Codex chat · Completed" })).not.toHaveAttribute("data-unread", "true");

  await recent.getByRole("button", { name: "Mark all read" }).click();
  await expect.poll(() => readRequests).toEqual([{ all: true }]);

  // Opening an entry marks it read and switches to its workspace and terminal.
  await unread.click();
  await expect.poll(() => readRequests.at(-1)).toEqual({ ids: ["n2"] });
  await expect(recent).toBeHidden();
  await expect(page.locator('.center-workspace [role="tab"][data-tab-id="terminal:notify-terminal"]')).toHaveAttribute("aria-selected", "true");
});

test("opens the Pi session behind a rail activity item with a fresh session lookup", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop project rail test");
  const cwd = "/tmp/pi-web-rail-pi";
  await page.addInitScript((snapshot) => {
    if (!localStorage.getItem("pi-web:project-workspaces:v1")) localStorage.setItem("pi-web:project-workspaces:v1", JSON.stringify(snapshot));
  }, { activeId: cwd, workspaces: [{ id: cwd, projectRoot: cwd, cwd, label: "rail-pi", sessionId: null, lastActive: 1 }] });
  const session = { id: "rail-pi-session", name: "Rail Pi session", path: `${cwd}/s.jsonl`, cwd, projectRoot: cwd, created: "2026-08-03T00:00:00.000Z", modified: "2026-08-03T00:01:00.000Z", messageCount: 1, firstMessage: "Rail prompt" };
  let sessionListRequests = 0;
  let failSessionList = false;
  await page.route("**/api/sessions", async (route) => {
    sessionListRequests += 1;
    if (failSessionList) return route.fulfill({ status: 500, json: { error: "unavailable" } });
    return route.fulfill({ json: { sessions: [session], runningSessionIds: [session.id] } });
  });
  await page.route(`**/api/sessions/${session.id}?*`, async (route) => route.fulfill({ json: {
    sessionId: session.id, filePath: session.path, modified: session.modified, info: session, leafId: "rail-tip", tree: [],
    context: { messages: [{ role: "user", content: "Rail prompt", timestamp: 1 }], entryIds: ["rail-tip"], thinkingLevel: "medium", model: { provider: "openai-codex", modelId: "gpt-5.6-sol" }, page: { hasMore: false, beforeEntryId: null, totalMessages: 1 } },
  } }));
  await page.route(`**/api/sessions/${session.id}/state`, async (route) => route.fulfill({ json: { running: true, state: { isStreaming: true, isPromptRunning: true, isBashRunning: false, isCompacting: false } } }));
  await page.route(`**/api/agent/${session.id}/events`, async (route) => route.fulfill({
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    body: `data: ${JSON.stringify({ type: "connected", sessionId: session.id })}\n\n`,
  }));
  await page.route(`**/api/agent/${session.id}`, async (route) => route.fulfill({ json: { running: true, state: { isStreaming: true, isPromptRunning: true } } }));
  await page.route("**/api/cwd/validate", async (route) => route.fulfill({ json: { success: true, cwd } }));
  await page.route("**/api/git/status?*", async (route) => route.fulfill({ json: { isGitRepository: false, files: [] } }));
  await mockStatusStream(page, [
    { type: "running", runningSessionIds: [session.id] },
    { type: "terminals", terminals: [], limits: { running: 20, records: 100 } },
    { type: "codex_runtimes", runtimes: [] },
  ]);

  await page.goto("/");
  const rail = page.getByRole("navigation", { name: "Project workspaces" });
  await rail.getByTitle(cwd).getByLabel("Running: 1 working").click();
  const item = page.getByRole("dialog", { name: "rail-pi activity" }).getByRole("button", { name: /^Rail Pi session · / });
  await expect(item).toBeVisible();
  // The lookup made on open fails; the item still opens its cached record.
  failSessionList = true;
  const requestsBeforeOpen = sessionListRequests;
  await item.click();
  await expect(page).toHaveURL(new RegExp(`[?&]session=${session.id}`));
  await expect(page.getByText("Rail prompt", { exact: true }).first()).toBeVisible();
  expect(sessionListRequests).toBeGreaterThan(requestsBeforeOpen);
});

test("shows terminal touch keys on a landscape tablet wider than the mobile breakpoint", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "touch tablet emulation runs once, from the desktop project");
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL, viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const cwd = "/tmp/pi-web-touch-keys";
  await page.addInitScript((snapshot) => {
    if (!localStorage.getItem("pi-web:project-workspaces:v1")) localStorage.setItem("pi-web:project-workspaces:v1", JSON.stringify(snapshot));
  }, { activeId: cwd, workspaces: [{ id: cwd, projectRoot: cwd, cwd, label: "touch-keys", sessionId: null, lastActive: 1 }] });
  const terminals = [{
    id: "touch-terminal", title: "Claude", provider: "shell", state: "running", exitCode: null, cwd,
    pid: 111, permissionMode: "confirm", launchMode: "new", noAltScreen: false, cols: 80, rows: 24,
    createdAt: "2026-08-03T00:00:00.000Z", endedAt: null, signal: null, bufferBytes: 0, bufferTruncated: false, history: [],
  }];
  await page.route("**/api/sessions", async (route) => route.fulfill({ json: { sessions: [], runningSessionIds: [] } }));
  await page.route("**/api/cwd/validate", async (route) => route.fulfill({ json: { success: true, cwd } }));
  await page.route("**/api/git/status?*", async (route) => route.fulfill({ json: { isGitRepository: false, files: [] } }));
  await page.route("**/api/worktrees?*", async (route) => route.fulfill({ json: { projectRoot: cwd, isGit: false, isTopLevel: true, worktrees: [] } }));
  await page.route("**/api/terminals**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/api/terminals") return route.fulfill({ status: 404, json: { error: "not found" } });
    return route.fulfill({ json: { cwd, terminals, stats: { workspace: { running: 1, records: 1, bufferBytes: 0 }, global: { running: 1, records: 1, bufferBytes: 0 }, limits: { running: 20, records: 100 } } } });
  });
  await mockStatusStream(page, [
    { type: "running", runningSessionIds: [] },
    { type: "terminals", terminals, limits: { running: 20, records: 100 } },
    { type: "codex_runtimes", runtimes: [] },
  ]);

  try {
    await page.goto("/");
    const rail = page.getByRole("navigation", { name: "Project workspaces" });
    await rail.getByTitle(cwd).getByLabel("Running: 1 working").click();
    await page.getByRole("dialog", { name: "touch-keys activity" }).getByRole("button", { name: /^Claude · Terminal/ }).click();
    const keys = page.getByLabel("Terminal shortcuts");
    await expect(keys).toBeVisible();
    for (const name of ["Esc", "Tab", "Shift+Tab", "Ctrl+C", "Ctrl", "Alt", "Enter"]) await expect(keys.getByRole("button", { name, exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("switches project workspaces from the mobile picker", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("mobile"), "mobile project picker test");
  const sessions = [
    { id: "mobile-a", path: "/tmp/mobile-a/session.jsonl", cwd: "/tmp/mobile-a", projectRoot: "/tmp/mobile-a", created: "2026-08-03T00:00:00.000Z", modified: "2026-08-03T00:00:00.000Z", messageCount: 1, firstMessage: "A" },
    { id: "mobile-b", path: "/tmp/mobile-b/session.jsonl", cwd: "/tmp/mobile-b", projectRoot: "/tmp/mobile-b", created: "2026-08-03T00:00:00.000Z", modified: "2026-08-03T00:01:00.000Z", messageCount: 1, firstMessage: "B" },
  ];
  await page.addInitScript((snapshot) => { if (!localStorage.getItem("pi-web:project-workspaces:v1")) localStorage.setItem("pi-web:project-workspaces:v1", JSON.stringify(snapshot)); }, {
    activeId: "/tmp/mobile-a",
    workspaces: [
      { id: "/tmp/mobile-a", projectRoot: "/tmp/mobile-a", cwd: "/tmp/mobile-a", label: "mobile-a", sessionId: "mobile-a", lastActive: 2 },
      { id: "/tmp/mobile-b", projectRoot: "/tmp/mobile-b", cwd: "/tmp/mobile-b", label: "mobile-b", sessionId: "mobile-b", lastActive: 1 },
    ],
  });
  await page.route("**/api/sessions", async (route) => route.fulfill({ json: { sessions, runningSessionIds: [] } }));
  await page.route("**/api/cwd/validate", async (route) => {
    const body = route.request().postDataJSON() as { cwd?: string };
    return body.cwd
      ? route.fulfill({ json: { success: true, cwd: body.cwd } })
      : route.fulfill({ status: 400, json: { error: "cwd required" } });
  });
  await page.route("**/api/terminals?*", async (route) => {
    const cwd = new URL(route.request().url()).searchParams.get("cwd") ?? "";
    return route.fulfill({ json: { cwd, terminals: [], stats: null } });
  });
  await mockStatusStream(page, [
    { type: "running", runningSessionIds: [] },
    { type: "terminals", terminals: [], limits: { running: 20, records: 100 } },
    { type: "codex_runtimes", runtimes: [] },
  ]);
  await page.route("**/api/worktrees?*", async (route) => route.fulfill({ json: { projectRoot: new URL(route.request().url()).searchParams.get("cwd"), isGit: false, isTopLevel: true, worktrees: [] } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Switch project" }).click();
  const menu = page.getByRole("menu", { name: "Project workspaces" });
  await menu.getByRole("menuitem", { name: "mobile-b" }).click();
  await expect(page.getByRole("button", { name: "Switch project" })).toContainText("mobile-b");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("summarizes collapsed agent groups and keeps completed tasks reachable", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop agent sidebar test");
  const terminal = (id: string, title: string, provider: "shell" | "codex", state: "running" | "ended", exitCode: number | null) => ({
    id, title, provider, state, exitCode, cwd: "/tmp/pi-web-e2e", pid: 123, permissionMode: "confirm", launchMode: "new", noAltScreen: false,
    cols: 80, rows: 24, createdAt: "2026-08-03T00:00:00.000Z", endedAt: state === "ended" ? "2026-08-03T00:01:00.000Z" : null,
    signal: null, bufferBytes: 12, bufferTruncated: false, history: [],
  });
  const terminals = [
    terminal("task-ended", "Task: test", "shell", "ended", 0),
    terminal("shell-live", "Dev server", "shell", "running", null),
    terminal("codex-live", "Codex terminal", "codex", "running", null),
  ];
  await page.route("**/api/sessions", async (route) => route.fulfill({ json: { sessions: [{
    id: "pi-session", path: "/tmp/pi-web-e2e/session.jsonl", cwd: "/tmp/pi-web-e2e", projectRoot: "/tmp/pi-web-e2e",
    created: "2026-08-03T00:00:00.000Z", modified: "2026-08-03T00:00:00.000Z", messageCount: 1, firstMessage: "test",
  }], runningSessionIds: [] } }));
  await page.route("**/api/cwd/validate", async (route) => route.fulfill({ json: { success: true, cwd: "/tmp/pi-web-e2e" } }));
  await page.route("**/api/terminals?*", async (route) => route.fulfill({ json: {
    cwd: "/tmp/pi-web-e2e",
    terminals,
    stats: { workspace: { running: 2, records: 3, bufferBytes: 36 }, global: { running: 2, records: 3, bufferBytes: 36 }, limits: { running: 20, records: 100 } },
  } }));
  await mockStatusStream(page, [
    { type: "running", runningSessionIds: [] },
    { type: "terminals", terminals, limits: { running: 20, records: 100 } },
    { type: "codex_runtimes", runtimes: [] },
  ]);
  await page.route("**/api/project-scripts?*", async (route) => route.fulfill({ json: { scripts: [], runner: "npm" } }));
  await page.route("**/api/codex/sessions?*", async (route) => route.fulfill({ json: { sessions: [] } }));

  await page.goto("/");
  await page.getByRole("navigation", { name: "Sidebar modules" }).getByRole("button", { name: "Agents" }).click();
  const providerButtons = page.locator("button[aria-expanded]");
  const terminalGroup = providerButtons.filter({ hasText: "Terminal" }).last();
  const codexGroup = providerButtons.filter({ hasText: "Codex" }).last();
  await expect(terminalGroup).toContainText("2");
  await expect(terminalGroup).toContainText("1");
  await expect(codexGroup).toContainText("1");
  await terminalGroup.click();
  await expect(page.getByText("Previous tasks", { exact: true })).toBeVisible();
  await expect(page.getByText("Task: test", { exact: true })).toBeVisible();
});

test("pages Codex sessions and shows fork source, model and busy errors", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop agent sidebar test");
  const session = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id, name, cwd: "/tmp/pi-web-e2e", updatedAt: "2026-08-03T00:00:00.000Z", lastUserMessage: `${name} prompt`, archived: false, runtime: null, ...extra,
  });
  const parentId = "11111111-1111-1111-1111-111111111111";
  const cursors: (string | null)[] = [];
  const deleted = new Set<string>();
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
  await page.route("**/api/codex/sessions?*", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    cursors.push(params.get("cursor"));
    const second = [session("22222222-2222-2222-2222-222222222222", "Forked work", { forkedFromId: parentId, model: "gpt-5.5" })].filter((item) => !deleted.has(item.id));
    return params.get("cursor") === "page-2"
      ? route.fulfill({ json: { sessions: second, nextCursor: null } })
      : route.fulfill({ json: { sessions: [session(parentId, "Parent work")], nextCursor: "page-2" } });
  });
  await page.route("**/api/codex/sessions/*/delete", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[4];
    deleted.add(id);
    return route.fulfill({ json: { session: session(id, "Forked work") } });
  });
  await page.route("**/api/codex/sessions/*/archive", async (route) => route.fulfill({ status: 409, json: { error: "This Codex session is running. Stop the chat turn or terminal first.", code: "session_busy" } }));

  await page.goto("/");
  await page.getByRole("navigation", { name: "Sidebar modules" }).getByRole("button", { name: "Agents" }).click();
  await page.locator("button[aria-expanded]").filter({ hasText: "Codex" }).last().click();
  await expect(page.getByText("Parent work", { exact: true })).toBeVisible();
  expect(cursors.every((cursor) => cursor === null)).toBe(true);
  await page.getByRole("button", { name: "Load more sessions" }).click();
  await expect(page.getByText("Forked work", { exact: true })).toBeVisible();
  await expect(page.getByText("Fork of Parent work · gpt-5.5", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Load more sessions" })).toHaveCount(0);
  expect(cursors).toContain("page-2");

  await page.getByRole("button", { name: "Manage Parent work" }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await page.getByRole("dialog", { name: "Archive Codex session" }).getByRole("button", { name: "Archive" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "This Codex session is running" })).toBeVisible();

  // A refresh re-reads every loaded page, so a row deleted from page 2 goes away.
  await page.getByRole("button", { name: "Manage Forked work" }).click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await page.getByRole("dialog", { name: "Delete Codex session" }).getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("Forked work", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Parent work", { exact: true })).toBeVisible();
});

test("lists Claude sessions, resumes one in a terminal and shows delete conflicts", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop agent sidebar test");
  const session = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
    id, title, firstMessage: `${title} prompt`, cwd: "/tmp/pi-web-e2e", gitBranch: "main", createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z", size: 2048, runtime: null, ...extra,
  });
  const firstId = "11111111-1111-4111-8111-111111111111";
  const secondId = "22222222-2222-4222-8222-222222222222";
  const queries: string[] = [];
  const launches: Record<string, unknown>[] = [];
  const deleted = new Set<string>();
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
  await page.route("**/api/claude/sessions?*", async (route) => {
    const query = new URL(route.request().url()).searchParams.get("q") || "";
    queries.push(query);
    const all = [session(firstId, "Refactor login"), session(secondId, "Write docs")].filter((item) => !deleted.has(item.id));
    return route.fulfill({ json: { sessions: all.filter((item) => item.title.toLowerCase().includes(query.toLowerCase())), nextCursor: null } });
  });
  await page.route("**/api/claude/sessions/*/delete", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[4];
    if (id === firstId) return route.fulfill({ status: 409, json: { error: "A running Claude terminal in this workspace may be writing this session. Stop it first.", code: "session_busy" } });
    deleted.add(id);
    return route.fulfill({ json: { session: session(id, "Write docs") } });
  });
  await page.route("**/api/terminals", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    launches.push(body);
    return route.fulfill({ status: 201, json: { terminal: {
      id: "claude-term", provider: "claude", cwd: "/tmp/pi-web-e2e", state: "running", createdAt: new Date().toISOString(),
      launchMode: body.launchMode, sourceSessionId: body.sourceSessionId, permissionMode: body.permissionMode, label: "Claude",
    } } });
  });

  await page.goto("/");
  await page.getByRole("navigation", { name: "Sidebar modules" }).getByRole("button", { name: "Agents" }).click();
  await page.locator("button[aria-expanded]").filter({ hasText: "Claude" }).last().click();
  await expect(page.getByText("Refactor login", { exact: true })).toBeVisible();
  await expect(page.getByText("Refactor login prompt · 2.0 KB", { exact: true })).toBeVisible();

  await page.getByRole("textbox", { name: "Search Claude sessions" }).fill("docs");
  await expect(page.getByText("Refactor login", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Write docs", { exact: true })).toBeVisible();
  expect(queries).toContain("docs");
  await page.getByRole("button", { name: "Clear Claude session search" }).click();
  await expect(page.getByText("Refactor login", { exact: true })).toBeVisible();
  await expect(page.getByText("Write docs", { exact: true })).toBeVisible();

  // The action menu closes on scroll; bring the rows into view before opening it.
  const openMenu = async (title: string) => {
    const trigger = page.getByRole("button", { name: `Manage ${title}` });
    await trigger.hover();
    await trigger.click();
  };
  await openMenu("Refactor login");
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await page.getByRole("dialog", { name: "Delete Claude session" }).getByRole("button", { name: "Remove" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "may be writing this session" })).toBeVisible();

  await openMenu("Write docs");
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await page.getByRole("dialog", { name: "Delete Claude session" }).getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("Write docs", { exact: true })).toHaveCount(0);

  await openMenu("Refactor login");
  await page.getByRole("menuitem", { name: "Fork to Terminal…" }).click();
  const dialog = page.getByRole("dialog", { name: "Start Claude session" });
  await expect(dialog.getByRole("combobox", { name: "Action" })).toHaveValue("fork");
  await dialog.getByRole("combobox", { name: "Action" }).selectOption("resume");
  await dialog.getByRole("button", { name: "Resume in Terminal" }).click();
  await expect(dialog).toHaveCount(0);
  expect(launches).toEqual([{ provider: "claude", cwd: "/tmp/pi-web-e2e", permissionMode: "confirm", launchMode: "resume", sourceSessionId: firstId }]);
});

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
      // The server refused the stream: the browser gives up without retrying.
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

test("shows Codex chat retries, turn failures, the terminal conflict prompt, question cards and steering", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop agent sidebar test");
  const id = "33333333-3333-3333-3333-333333333333";
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
    id, name: "Phone work", cwd: "/tmp/pi-web-e2e", updatedAt: "2026-08-03T00:00:00.000Z", lastUserMessage: "hi", archived: false, runtime: null,
  }], nextCursor: null } }));
  const sent: Array<Record<string, unknown>> = [];
  await page.route(`**/api/codex/chat/${id}*`, async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { thread: { thread: { id, turns: [] } }, history: [], events: [] } });
    const body = route.request().postDataJSON() as Record<string, unknown>;
    sent.push(body);
    return body.terminals === "ignore"
      ? route.fulfill({ status: 202, json: { turn: { turn: { id: "turn-2" } } } })
      : route.fulfill({ status: 409, json: { error: "A Codex terminal is running in this folder.", code: "terminal_conflict", terminals: [{ id: "term-1", title: "codex", launchMode: "new" }] } });
  });
  // The first steer lands in the running turn; the second finds the turn over and is queued.
  const actions: Array<{ action: string; body: Record<string, unknown> }> = [];
  await page.route(`**/api/codex/chat/${id}/*`, async (route) => {
    const action = new URL(route.request().url()).pathname.split("/").at(-1) ?? "";
    actions.push({ action, body: route.request().postDataJSON() as Record<string, unknown> });
    if (action === "approve") return route.fulfill({ status: 204, body: "" });
    if (action === "steer") return actions.filter((entry) => entry.action === "steer").length === 1
      ? route.fulfill({ status: 202, json: { turn: { turnId: "turn-2" } } })
      : route.fulfill({ status: 409, json: { error: "This turn can no longer take new input", code: "no_active_turn" } });
    return route.fallback();
  });

  await page.goto("/");
  await page.getByRole("navigation", { name: "Sidebar modules" }).getByRole("button", { name: "Agents" }).click();
  await page.locator("button[aria-expanded]").filter({ hasText: "Codex" }).last().click();
  // The action menu closes on scroll; settle the list first.
  const manage = page.getByRole("button", { name: "Manage Phone work" });
  await manage.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await manage.click();
  await page.getByRole("menuitem", { name: "Open in Chat…" }).click();
  await page.getByRole("button", { name: "Resume in Chat" }).click();
  await expect(page.getByText("Codex Chat · Phone work")).toBeVisible();
  const chat = page.locator("section").filter({ hasText: "Codex Chat · Phone work" });
  const alert = chat.getByRole("alert");
  const composer = chat.getByPlaceholder("Message… Type / for commands", { exact: true });
  await expect(composer).toBeVisible();

  const emit = (event: Record<string, unknown>) => emitCodexEvent(page, event);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __codexStreams?: unknown[] }).__codexStreams?.length ?? 0)).toBeGreaterThan(0);
  await emit({ method: "turn/started", params: { turn: { id: "turn-1" } }, piSeq: 1, piRuntime: "run1" });
  await emit({ method: "error", params: { error: { message: "stream disconnected" }, willRetry: true }, piSeq: 2, piRuntime: "run1" });
  await expect(alert).toHaveText("Codex is retrying: stream disconnected");
  await emit({ method: "turn/completed", params: { turn: { id: "turn-1", status: "failed", error: { message: "usage limit reached" } } }, piSeq: 3, piRuntime: "run1" });
  await expect(alert).toHaveText("Turn failed: usage limit reached");

  // An unknown Codex terminal in the folder: ask, keep the draft, resend on "Continue anyway".
  await composer.fill("continue from my phone");
  await composer.press("Enter");
  const prompt = alert.filter({ hasText: "A Codex terminal is running in this folder." });
  await expect(prompt.getByRole("button", { name: "Stop terminal" })).toBeVisible();
  await prompt.getByRole("button", { name: "Continue anyway" }).click();
  await expect(alert).toHaveText("Send your message again to continue.");
  await expect(composer).toHaveValue("continue from my phone");
  await composer.press("Enter");
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[0].terminals).toBeUndefined();
  expect(sent[1]).toMatchObject({ text: "continue from my phone", terminals: "ignore" });

  // Codex asks a question; the answer goes back keyed by question id.
  await emit({ method: "turn/started", params: { turn: { id: "turn-2" } }, piSeq: 4, piRuntime: "run1" });
  await emit({ id: 902, method: "item/tool/requestUserInput", params: { questions: [{ id: "color", header: "Color", question: "Pick one", isOther: true, isSecret: false, options: [{ label: "Red", description: "" }] }] }, piSeq: 5, piRuntime: "run1" });
  const card = chat.getByRole("alert", { name: "Codex has a question" });
  await expect(card.getByRole("button", { name: "Submit" })).toBeDisabled();
  await card.getByLabel("Red").check();
  await card.getByRole("button", { name: "Submit" }).click();
  await expect.poll(() => actions.find((entry) => entry.action === "approve")?.body).toEqual({ requestId: "902", answers: { color: ["Red"] } });
  await expect(card).toHaveCount(0);

  // A request Codex Chat cannot show is reported, not left hanging.
  await emit({ method: "codex/unsupportedRequest", params: { method: "item/tool/call" }, piSeq: 6, piRuntime: "run1" });
  await expect(chat.getByText("Codex asked for item/tool/call, which Codex Chat does not support; it was declined.")).toBeVisible();

  // While running, Enter steers the current turn; a turn that already ended queues the message.
  const running = chat.getByPlaceholder("Add to this turn, or queue for the next…");
  await running.fill("also run the tests");
  await running.press("Enter");
  await expect.poll(() => actions.filter((entry) => entry.action === "steer").length).toBe(1);
  expect(actions.find((entry) => entry.action === "steer")?.body).toMatchObject({ text: "also run the tests" });
  await expect(chat.getByText("also run the tests")).toBeVisible();
  await running.fill("then summarize");
  await running.press("Enter");
  await expect(chat.getByText("1 queued")).toBeVisible();
  await emit({ method: "turn/completed", params: { turn: { id: "turn-2", status: "completed", error: null } }, piSeq: 7, piRuntime: "run1" });
  await expect.poll(() => sent.length).toBe(3);
  expect(sent[2]).toMatchObject({ text: "then summarize", terminals: "ignore" });

  // A refused stream shows the server's reason, not just "disconnected".
  await page.route(`**/api/codex/chat/${id}/events*`, async (route) => route.fulfill({ status: 409, json: { error: "This session is open in another Codex client.", code: "writer_conflict" } }));
  await page.evaluate(() => (window as unknown as { __codexStreams: Array<{ fail(): void }> }).__codexStreams.at(-1)?.fail());
  await expect(alert).toContainText("Codex chat disconnected: This session is open in another Codex client.");
  await expect(alert.getByRole("button", { name: "Reconnect" })).toBeVisible();
});

test("starts a new Codex chat whose first message creates the session", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop agent sidebar test");
  const id = "44444444-4444-4444-4444-444444444444";
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
  let listed = false;
  await page.route("**/api/codex/sessions?*", async (route) => route.fulfill({ json: { sessions: listed ? [{
    id, name: "", cwd: "/tmp/pi-web-e2e", updatedAt: "2026-08-03T00:00:00.000Z", lastUserMessage: "fix the flaky test", archived: false, runtime: null,
  }] : [], nextCursor: null } }));
  const created: Array<Record<string, unknown>> = [];
  await page.route("**/api/codex/chat", async (route) => {
    created.push(route.request().postDataJSON() as Record<string, unknown>);
    listed = true;
    return route.fulfill({ status: 201, json: { threadId: id, turn: { turn: { id: "turn-1" } } } });
  });
  let loads = 0;
  await page.route(`**/api/codex/chat/${id}*`, async (route) => { loads += 1; return route.fulfill({ json: { thread: { thread: { id, turns: [] } }, history: [], events: [] } }); });

  await page.goto("/");
  await page.getByRole("navigation", { name: "Sidebar modules" }).getByRole("button", { name: "Agents" }).click();
  await page.getByRole("button", { name: "New Codex chat" }).click();
  const chat = page.locator("section").filter({ hasText: "Codex Chat · New chat" });
  await expect(chat).toBeVisible();
  // Nothing exists yet: no history request, no event stream.
  expect(loads).toBe(0);
  const composer = chat.getByPlaceholder("Message… Type / for commands", { exact: true });
  await composer.fill("fix the flaky test");
  await composer.press("Enter");
  await expect.poll(() => created.length).toBe(1);
  expect(created[0]).toMatchObject({ cwd: "/tmp/pi-web-e2e", text: "fix the flaky test", approvalPolicy: "untrusted" });
  await expect.poll(() => page.evaluate((threadId) => (window as unknown as { __codexStreams?: { url: string }[] }).__codexStreams?.some((stream) => stream.url.includes(threadId)) ?? false, id)).toBe(true);
  await expect(page.getByText("fix the flaky test").first()).toBeVisible();
  const tab = page.getByRole("tab", { name: /fix the flaky test/ });
  await expect(tab).toHaveCount(1);

  // After a reload the tab still belongs to the session, and opening the session from the list goes back to it.
  await page.reload();
  const codexGroup = page.locator("button[aria-expanded]").filter({ hasText: "Codex" }).last();
  if (await codexGroup.getAttribute("aria-expanded") !== "true") await codexGroup.click();
  const manage = page.getByRole("button", { name: "Manage", exact: true });
  await manage.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await manage.click();
  await page.getByRole("menuitem", { name: "Open in Chat…" }).click();
  await page.getByRole("button", { name: "Resume in Chat" }).click();
  await expect(page.getByRole("tab", { name: /fix the flaky test/ })).toHaveCount(1);
  await expect(page.getByRole("tab", { name: /Codex Chat/ })).toHaveCount(0);
});

test("shows Codex file diffs and task lists, and forks a chat from a message into a new tab", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop agent sidebar test");
  const id = "55555555-5555-5555-5555-555555555555";
  const forkId = "66666666-6666-6666-6666-666666666666";
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
    id, name: "Diff work", cwd: "/tmp/pi-web-e2e", updatedAt: "2026-08-03T00:00:00.000Z", lastUserMessage: "rename b", archived: false, runtime: null,
  }], nextCursor: null } }));
  const turns = [
    { id: "turn-1", status: "completed", items: [
      { type: "userMessage", id: "u1", content: [{ type: "text", text: "add a file" }] },
      { type: "fileChange", id: "f1", status: "completed", changes: [{ path: "/tmp/pi-web-e2e/notes.txt", kind: { type: "update", move_path: null }, diff: "@@ -1,2 +1,2 @@\n a\n-old line\n+new line\n" }] },
    ] },
    { id: "turn-2", status: "completed", items: [
      { type: "userMessage", id: "u2", content: [{ type: "text", text: "rename b" }] },
      { type: "agentMessage", id: "a2", text: "Renamed." },
    ] },
  ];
  await page.route(`**/api/codex/chat/${id}*`, async (route) => route.fulfill({ json: { thread: { thread: { id, turns } }, history: [], events: [] } }));
  await page.route(`**/api/codex/chat/${forkId}*`, async (route) => route.fulfill({ json: { thread: { thread: { id: forkId, turns: turns.slice(0, 1) } }, history: [], events: [] } }));
  const forks: Array<Record<string, unknown>> = [];
  await page.route(`**/api/codex/chat/${id}/fork`, async (route) => {
    forks.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ json: { result: { thread: { id: forkId } } } });
  });

  await page.goto("/");
  await page.getByRole("navigation", { name: "Sidebar modules" }).getByRole("button", { name: "Agents" }).click();
  await page.locator("button[aria-expanded]").filter({ hasText: "Codex" }).last().click();
  const manage = page.getByRole("button", { name: "Manage Diff work" });
  await manage.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await manage.click();
  await page.getByRole("menuitem", { name: "Open in Chat…" }).click();
  await page.getByRole("button", { name: "Resume in Chat" }).click();
  const chat = page.locator("section").filter({ hasText: "Codex Chat · Diff work" });
  await expect(chat.getByText("Renamed.")).toBeVisible();
  // The file change shows its diff lines.
  await chat.getByRole("button", { name: "edit /tmp/pi-web-e2e/notes.txt" }).click();
  await expect(chat.getByText("new line").first()).toBeVisible();
  await expect(chat.getByText("old line").first()).toBeVisible();

  // A live plan update shows as a task list.
  await expect.poll(() => page.evaluate(() => (window as unknown as { __codexStreams?: unknown[] }).__codexStreams?.length ?? 0)).toBeGreaterThan(0);
  await emitCodexEvent(page, { method: "turn/plan/updated", params: { turnId: "turn-2", explanation: null, plan: [{ step: "Read the code", status: "completed" }, { step: "Rename b", status: "inProgress" }] }, piSeq: 1, piRuntime: "run1" });
  const tasks = chat.getByRole("region", { name: "Tasks" });
  await expect(tasks.getByText("1/2 done")).toBeVisible();
  await expect(tasks.getByRole("listitem", { name: "Rename b (in progress)" })).toBeVisible();

  // The first message has nothing before it to keep, so only the second can fork, keeping the turns before it.
  await expect(chat.getByRole("button", { name: "New session" })).toHaveCount(1);
  await chat.getByText("rename b", { exact: true }).hover();
  await chat.getByRole("button", { name: "New session" }).click();
  await expect.poll(() => forks).toEqual([{ lastTurnId: "turn-1" }]);
  const forkChat = page.locator("section").filter({ hasText: "Codex Chat · Diff work (fork)" });
  await expect(forkChat.getByPlaceholder("Message… Type / for commands", { exact: true })).toHaveValue("rename b");
});

async function mockClaudeWorkspace(page: Page, sessions: Array<Record<string, unknown>>) {
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
    { type: "claude_runtimes", runtimes: [] },
  ]);
  await page.route("**/api/project-scripts?*", async (route) => route.fulfill({ json: { scripts: [], runner: "npm" } }));
  await page.route("**/api/claude/sessions?*", async (route) => route.fulfill({ json: { sessions, nextCursor: null } }));
}

test("opens a Claude session in Claude Chat, answers permissions and stops a terminal that owns it", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop agent sidebar test");
  const id = "55555555-5555-4555-8555-555555555555";
  await fakeCodexStreams(page);
  await mockClaudeWorkspace(page, [{ id, title: "Refactor login", firstMessage: "Refactor login", cwd: "/tmp/pi-web-e2e", gitBranch: null, createdAt: null, updatedAt: "2026-08-03T00:00:00.000Z", size: 2048, runtime: null }]);
  let terminalOwns = true;
  await page.route(`**/api/claude/chat/${id}?*`, async (route) => route.fulfill({ json: {
    session: { id, title: "Refactor login" },
    history: [
      { type: "user", uuid: "h1", message: { role: "user", content: "Refactor login" } },
      { type: "assistant", uuid: "h2", piBlockIndex: 0, message: { id: "m0", role: "assistant", content: [{ type: "text", text: "Done refactoring." }] } },
    ],
    cursor: null, events: [], runtime: null, terminal: terminalOwns ? { terminalId: "term-1" } : null,
  } }));
  const actions: Array<{ action: string; body: Record<string, unknown> }> = [];
  await page.route(`**/api/claude/chat/${id}/*`, async (route) => {
    const action = new URL(route.request().url()).pathname.split("/").at(-1) ?? "";
    if (action === "events") return route.fallback();
    actions.push({ action, body: route.request().postDataJSON() as Record<string, unknown> });
    if (action === "claim") terminalOwns = false;
    return route.fulfill({ status: action === "send" ? 202 : 200, json: { ok: true } });
  });

  await page.goto("/");
  await page.getByRole("navigation", { name: "Sidebar modules" }).getByRole("button", { name: "Agents" }).click();
  await page.locator("button[aria-expanded]").filter({ hasText: "Claude" }).last().click();
  await page.getByText("Refactor login", { exact: true }).click();
  const chat = page.locator("section").filter({ hasText: "Claude Chat · Refactor login" });
  await expect(chat.getByText("Done refactoring.")).toBeVisible();

  // A terminal resuming the session owns it until the user stops it here.
  await chat.getByRole("alert").filter({ hasText: "open in a Claude terminal" }).getByRole("button", { name: "Stop terminal" }).click();
  await expect.poll(() => actions.map((entry) => entry.action)).toEqual(["claim"]);
  await expect(chat.getByText("open in a Claude terminal")).toHaveCount(0);

  await chat.locator("button[title=\"Chat configuration\"]").click();
  await chat.getByLabel("Permissions").selectOption("plan");
  const composer = chat.getByPlaceholder("Message…", { exact: true });
  await composer.fill("run the tests");
  await composer.press("Enter");
  await expect.poll(() => actions.find((entry) => entry.action === "send")?.body).toMatchObject({ cwd: "/tmp/pi-web-e2e", text: "run the tests", permissionMode: "plan", model: "" });
  const uuid = actions.find((entry) => entry.action === "send")?.body.uuid;
  await expect(chat.getByText("run the tests")).toBeVisible();

  const emit = (event: Record<string, unknown>) => emitCodexEvent(page, event);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __codexStreams?: unknown[] }).__codexStreams?.length ?? 0)).toBeGreaterThan(0);
  await emit({ type: "pi/connected", sessionId: id, runtimeId: "r1" });
  await emit({ type: "user", uuid, message: { role: "user", content: "run the tests" }, piSeq: 1, piRuntime: "r1" });
  await emit({ type: "control_request", request_id: "req-1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "npm test", description: "Run tests" }, permission_suggestions: [{ type: "addRules" }] }, piSeq: 2, piRuntime: "r1" });
  const card = chat.getByRole("alert", { name: "Permission required" });
  await expect(card.getByText("npm test")).toBeVisible();
  // While a turn runs, messages are queued for the next one.
  await expect(chat.getByPlaceholder("Queue a message for the next turn…")).toBeVisible();
  await card.getByRole("button", { name: "Allow for session" }).click();
  await expect.poll(() => actions.find((entry) => entry.action === "respond")?.body).toEqual({ cwd: "/tmp/pi-web-e2e", requestId: "req-1", decision: "allowSession" });
  await expect(card).toHaveCount(0);

  await emit({ type: "assistant", uuid: "a1", piBlockIndex: 0, message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "npm test" } }] }, piSeq: 3, piRuntime: "r1" });
  await emit({ type: "user", uuid: "a2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "12 passing" }] }, piSeq: 4, piRuntime: "r1" });
  await emit({ type: "assistant", uuid: "a3", piBlockIndex: 1, message: { id: "m1", role: "assistant", content: [{ type: "text", text: "All tests pass." }] }, piSeq: 5, piRuntime: "r1" });
  // A replayed event is ignored.
  await emit({ type: "assistant", uuid: "a3", piBlockIndex: 1, message: { id: "m1", role: "assistant", content: [{ type: "text", text: "replayed" }] }, piSeq: 5, piRuntime: "r1" });
  await emit({ type: "result", subtype: "success", is_error: false, piSeq: 6, piRuntime: "r1" });
  await expect(chat.getByText("All tests pass.")).toBeVisible();
  await expect(chat.getByText("replayed")).toHaveCount(0);
  await expect(chat.getByPlaceholder("Message…", { exact: true })).toBeVisible();
});

test("starts a new Claude chat whose first message creates the session", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop agent sidebar test");
  const id = "66666666-6666-4666-8666-666666666666";
  await fakeCodexStreams(page);
  await mockClaudeWorkspace(page, []);
  const created: Array<Record<string, unknown>> = [];
  await page.route("**/api/claude/chat", async (route) => {
    created.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ status: 201, json: { sessionId: id } });
  });
  let loads = 0;
  await page.route(`**/api/claude/chat/${id}?*`, async (route) => { loads += 1; return route.fulfill({ json: { session: { id, title: null }, history: [], cursor: null, events: [], runtime: { runtimeId: "r1", running: true, model: null, launchModel: null, permissionMode: "default", process: true, requests: [] }, terminal: null } }); });

  await page.goto("/");
  await page.getByRole("navigation", { name: "Sidebar modules" }).getByRole("button", { name: "Agents" }).click();
  await page.getByRole("button", { name: "New Claude chat" }).click();
  const chat = page.locator("section").filter({ hasText: "Claude Chat · New chat" });
  await expect(chat).toBeVisible();
  expect(loads).toBe(0);
  const composer = chat.getByPlaceholder("Message…", { exact: true });
  await composer.fill("explain the build");
  await composer.press("Enter");
  await expect.poll(() => created.length).toBe(1);
  expect(created[0]).toMatchObject({ cwd: "/tmp/pi-web-e2e", text: "explain the build", permissionMode: "default", model: "" });
  await expect.poll(() => page.evaluate((sessionId) => (window as unknown as { __codexStreams?: { url: string }[] }).__codexStreams?.some((stream) => stream.url.includes(sessionId)) ?? false, id)).toBe(true);
  await expect(page.getByRole("tab", { name: /explain the build/ })).toHaveCount(1);
  await expect(page.getByText("explain the build").first()).toBeVisible();
});

test("forks a Claude chat from a message into a new tab whose first message, with an image, starts the fork", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop agent sidebar test");
  const id = "77777777-7777-4777-8777-777777777777";
  const forkId = "88888888-8888-4888-8888-888888888888";
  const first = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const second = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  await fakeCodexStreams(page);
  await mockClaudeWorkspace(page, [{ id, title: "Plan work", firstMessage: "first step", cwd: "/tmp/pi-web-e2e", gitBranch: null, createdAt: null, updatedAt: "2026-08-03T00:00:00.000Z", size: 2048, runtime: null }]);
  await page.route(`**/api/claude/chat/${id}?*`, async (route) => route.fulfill({ json: {
    session: { id, title: "Plan work" },
    history: [
      { type: "user", uuid: first, message: { role: "user", content: "first step" } },
      { type: "assistant", uuid: "h2", piBlockIndex: 0, message: { id: "m0", role: "assistant", content: [{ type: "text", text: "First done." }] } },
      { type: "user", uuid: second, message: { role: "user", content: "second step" } },
      { type: "assistant", uuid: "h4", piBlockIndex: 0, message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Second done." }] } },
    ],
    cursor: null, events: [], runtime: null, terminal: null,
  } }));
  const created: Array<Record<string, unknown>> = [];
  await page.route("**/api/claude/chat", async (route) => {
    created.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ status: 201, json: { sessionId: forkId } });
  });
  // Claude has not written the fork yet; after the first turn it holds the copy.
  let forkReads = 0;
  await page.route(`**/api/claude/chat/${forkId}?*`, async (route) => {
    forkReads += 1;
    return route.fulfill({ json: forkReads === 1
      ? { session: { id: forkId, title: "Plan work", created: true }, history: [], cursor: null, events: [], runtime: { runtimeId: "r1", running: true, model: null, launchModel: null, permissionMode: "default", process: true, requests: [] }, terminal: null }
      : { session: { id: forkId, title: "Plan work" }, history: [
        { type: "user", uuid: first, message: { role: "user", content: "first step" } },
        { type: "assistant", uuid: "h2", piBlockIndex: 0, message: { id: "m0", role: "assistant", content: [{ type: "text", text: "First done." }] } },
      ], cursor: null, events: [{ type: "user", uuid: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", piSeq: 1, message: { role: "user", content: [{ type: "image" }, { type: "text", text: "second step" }] } }, { type: "result", piSeq: 2 }], runtime: { runtimeId: "r1", running: false, model: null, launchModel: null, permissionMode: "default", process: true, requests: [] }, terminal: null } });
  });

  await page.goto("/");
  await page.getByRole("navigation", { name: "Sidebar modules" }).getByRole("button", { name: "Agents" }).click();
  await page.locator("button[aria-expanded]").filter({ hasText: "Claude" }).last().click();
  await page.getByText("Plan work", { exact: true }).click();
  const chat = page.locator("section").filter({ hasText: "Claude Chat · Plan work" });
  await expect(chat.getByText("Second done.")).toBeVisible();
  await chat.getByText("More", { exact: true }).click();
  await expect(chat.getByRole("button", { name: "Fork chat" })).toBeEnabled();

  // The first prompt has nothing before it, so only the second can fork.
  await expect(chat.getByRole("button", { name: "New session" })).toHaveCount(1);
  await chat.getByText("second step", { exact: true }).hover();
  await chat.getByRole("button", { name: "New session" }).click();
  const fork = page.locator("section").filter({ hasText: "Claude Chat · Plan work (fork)" });
  await expect(fork.getByText("Your first message starts a fork with the conversation before the chosen message.")).toBeVisible();
  const composer = fork.getByPlaceholder("Message…", { exact: true });
  await expect(composer).toHaveValue("second step");
  expect(created).toEqual([]);

  await fork.locator("input[type=file]").setInputFiles({ name: "dot.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgo=", "base64") });
  await expect(fork.getByRole("img", { name: "Attachment 1" })).toBeVisible();
  await composer.press("Enter");
  await expect.poll(() => created.length).toBe(1);
  expect(created[0]).toMatchObject({ cwd: "/tmp/pi-web-e2e", text: "second step", images: ["data:image/png;base64,iVBORw0KGgo="], fork: { sessionId: id, at: second } });
  await expect(page.getByRole("tab", { name: /Plan work \(fork\)/ })).toHaveCount(1);
  await expect(fork.getByText("[Image]", { exact: false })).toBeVisible();
  await expect(fork.getByText("Your first message starts a fork")).toHaveCount(0);
  await expect.poll(() => forkReads).toBe(1);
  await emitCodexEvent(page, { type: "result", piSeq: 2, piRuntime: "r1" });
  await expect(fork.getByText("First done.")).toBeVisible();
  expect(forkReads).toBe(2);
});

test("searches and manages files from Explorer", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop Explorer test");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const gitStatusCwds: string[] = [];
  await page.route("**/api/sessions", async (route) => route.fulfill({ json: { sessions: [{
    id: "pi-session", path: "/tmp/pi-web-e2e/session.jsonl", cwd: "/tmp/pi-web-e2e", projectRoot: "/tmp/pi-web-e2e",
    created: "2026-08-03T00:00:00.000Z", modified: "2026-08-03T00:00:00.000Z", messageCount: 1, firstMessage: "test",
  }], runningSessionIds: [] } }));
  await page.route("**/api/files/**", async (route) => {
    if (route.request().url().includes("type=list")) {
      const pathname = new URL(route.request().url()).pathname;
      return pathname.endsWith("/src")
        ? route.fulfill({ json: { entries: [{ name: "App.tsx", isDir: false, size: 10, modified: "" }] } })
        : route.fulfill({ json: { entries: [{ name: "src", isDir: true, size: 0, modified: "" }, { name: "README.md", isDir: false, size: 10, modified: "" }] } });
    }
    return route.continue();
  });
  await page.route("**/api/file-index?*", async (route) => route.fulfill({ json: { matches: [{ path: "src/App.tsx", isDir: false }, { path: "src/utils.ts", isDir: false }] } }));
  await page.route("**/api/git/repositories?*", async (route) => route.fulfill({ json: { repositories: [
    { path: "/tmp/pi-web-e2e/service-a", repositoryRoot: "/tmp/pi-web-e2e/service-a", label: "service-a", relativePath: "service-a" },
    { path: "/tmp/pi-web-e2e/service-b", repositoryRoot: "/tmp/pi-web-e2e/service-b", label: "service-b", relativePath: "service-b" },
  ] } }));
  await page.route("**/api/git/status?*", async (route) => {
    const cwd = new URL(route.request().url()).searchParams.get("cwd") ?? "";
    gitStatusCwds.push(cwd);
    return route.fulfill({ json: cwd.includes("service-")
      ? { isGitRepository: true, repositoryRoot: cwd, branch: cwd.endsWith("service-a") ? "main" : "develop", files: [], remotes: [] }
      : { isGitRepository: false, repositoryRoot: null, branch: null, files: [] } });
  });
  await page.route("**/api/workspace-files", async (route) => route.fulfill({ json: { path: "README-renamed.md" } }));
  await page.route("**/api/cwd/validate", async (route) => route.fulfill({ json: { success: true, cwd: "/tmp/pi-web-e2e" } }));

  await page.goto("/");
  const search = page.getByRole("combobox", { name: "Search files" });
  await expect(search).toBeVisible();
  await expect(page.getByRole("button", { name: "New file" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Show hidden and generated files" })).toBeVisible();
  await search.fill("App");
  const appResult = page.getByRole("option", { name: "src/App.tsx" });
  const utilsResult = page.getByRole("option", { name: "src/utils.ts" });
  await expect(appResult).toHaveAttribute("aria-selected", "true");
  await search.press("ArrowDown");
  await expect(utilsResult).toHaveAttribute("aria-selected", "true");
  await search.press("ArrowUp");
  await expect(appResult).toHaveAttribute("aria-selected", "true");
  await search.press("Enter");
  await expect(search).toHaveValue("");
  await search.fill("App");
  await expect(appResult).toBeVisible();
  await search.press("Escape");
  await expect(search).toHaveValue("");
  const sourceRow = page.locator('[data-file-path="/tmp/pi-web-e2e/src"]');
  const readmeRow = page.locator('[data-file-path="/tmp/pi-web-e2e/README.md"]');
  await readmeRow.focus();
  await readmeRow.press("ArrowUp");
  await expect(sourceRow).toBeFocused();
  await sourceRow.press("ArrowDown");
  await expect(readmeRow).toBeFocused();
  await readmeRow.press("F2");
  await expect(page.getByRole("textbox", { name: "Explorer item name" })).toHaveValue("README.md");
  await page.getByRole("button", { name: "Cancel" }).click();
  await sourceRow.click();
  await expect(sourceRow).toHaveAttribute("aria-expanded", "true");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("pi-web:explorer:%2Ftmp%2Fpi-web-e2e"))).toContain("src");
  await readmeRow.click();
  await readmeRow.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Delete…" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const renameInput = page.getByRole("textbox", { name: "Explorer item name" });
  await renameInput.fill("README-renamed.md");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator('[title="/tmp/pi-web-e2e/README-renamed.md"]')).toBeVisible();
  await page.getByRole("button", { name: "Hide workspace" }).click();
  await page.getByRole("button", { name: "Fullscreen" }).click();
  await expect(page.locator(".right-panel-container")).toHaveClass(/right-panel-fullscreen/);
  await expect(page.getByRole("button", { name: "Exit fullscreen" })).toBeVisible();
  await expect.poll(() => page.locator(".right-panel-container").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return Math.abs(rect.left) < 2 && Math.abs(rect.top) < 2 && Math.abs(rect.width - window.innerWidth) < 2 && Math.abs(rect.height - window.innerHeight) < 2;
  })).toBe(true);
  await page.getByRole("button", { name: "Exit fullscreen" }).click();
  await expect(page.locator(".right-panel-container")).not.toHaveClass(/right-panel-fullscreen/);
  await page.getByRole("button", { name: "Open workspace tool" }).click();
  await expect(page.getByRole("menu", { name: "Workspace tools" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Terminal", exact: true })).toBeVisible();
  await page.getByRole("menuitem", { name: "Git Review" }).click();
  await expect(page.locator(".right-panel-container")).toHaveClass(/right-panel-open/);
  await page.getByRole("button", { name: "Open workspace tool" }).click();
  await page.getByRole("menuitem", { name: "Git Review" }).click();
  await expect(page.locator(".right-panel-container")).toHaveClass(/right-panel-open/);
  const repositorySelect = page.getByRole("combobox", { name: "Git repository" });
  await expect(repositorySelect).toHaveValue("/tmp/pi-web-e2e/service-a");
  await expect.poll(() => gitStatusCwds.includes("/tmp/pi-web-e2e/service-a")).toBe(true);
  await repositorySelect.selectOption("/tmp/pi-web-e2e/service-b");
  await expect.poll(() => gitStatusCwds.includes("/tmp/pi-web-e2e/service-b")).toBe(true);
  await expect(page.getByText("develop", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem(`pi-web:git-repository:${encodeURIComponent("/tmp/pi-web-e2e")}`))).toBe("/tmp/pi-web-e2e/service-b");

  const rightPanel = page.locator(".right-panel-container");
  const tabList = rightPanel.getByRole("tablist", { name: "File and tool tabs" });
  const appTab = tabList.getByRole("tab", { name: "App.tsx" });
  const readmeTab = tabList.getByRole("tab", { name: "README-renamed.md" });
  const gitTab = tabList.getByRole("tab", { name: "Git Review" });
  await expect(appTab).toBeVisible();
  await expect(readmeTab).toBeVisible();
  await expect(gitTab).toBeVisible();

  await sourceRow.click();
  await expect(sourceRow).toHaveAttribute("aria-expanded", "false");
  await appTab.click({ button: "right" });
  const appTabMenu = page.getByRole("menu", { name: "App.tsx tab actions" });
  await appTabMenu.getByRole("menuitem", { name: "Copy File Path" }).click();
  await expect(appTabMenu.getByRole("menuitem", { name: "File Path Copied" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("/tmp/pi-web-e2e/src/App.tsx");
  await appTabMenu.getByRole("menuitem", { name: "Reveal in File Explorer" }).click();
  await expect(sourceRow).toHaveAttribute("aria-expanded", "true");
  const revealedAppRow = page.locator('[data-file-path="/tmp/pi-web-e2e/src/App.tsx"]');
  await expect(revealedAppRow).toBeVisible();
  await expect(revealedAppRow).toHaveAttribute("aria-selected", "true");

  const wheelScrollLeft = await tabList.evaluate((element) => {
    element.style.width = "120px";
    element.scrollLeft = 0;
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: 90, bubbles: true, cancelable: true }));
    return element.scrollLeft;
  });
  expect(wheelScrollLeft).toBeGreaterThan(0);

  await readmeTab.click({ button: "right" });
  const tabMenu = page.getByRole("menu", { name: "README-renamed.md tab actions" });
  await expect(tabMenu.getByRole("menuitem", { name: "Close Tabs to the Left" })).toBeEnabled();
  await expect(tabMenu.getByRole("menuitem", { name: "Close Tabs to the Right" })).toBeEnabled();
  await expect(tabMenu.getByRole("menuitem", { name: "Close All Tabs" })).toBeEnabled();
  await tabMenu.getByRole("menuitem", { name: "Lock Tab" }).click();
  await expect(readmeTab).toHaveAttribute("data-locked", "true");
  await expect(readmeTab.getByRole("button", { name: "Close README-renamed.md" })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem(`pi-web:right-panel-tabs:${encodeURIComponent("/tmp/pi-web-e2e")}`) || "null");
    return stored?.tabs?.find((tab: { label?: string }) => tab.label === "README-renamed.md")?.locked;
  })).toBe(true);

  await readmeTab.click({ button: "right" });
  await page.getByRole("menu", { name: "README-renamed.md tab actions" }).getByRole("menuitem", { name: "Close All Tabs" }).click();
  await expect(appTab).toHaveCount(0);
  await expect(gitTab).toHaveCount(0);
  await expect(readmeTab).toBeVisible();
  await expect(rightPanel).toHaveClass(/right-panel-open/);

  await readmeTab.click({ button: "right" });
  await page.getByRole("menu", { name: "README-renamed.md tab actions" }).getByRole("menuitem", { name: "Unlock Tab" }).click();
  await readmeTab.click({ button: "right" });
  await page.getByRole("menu", { name: "README-renamed.md tab actions" }).getByRole("menuitem", { name: "Close All Tabs" }).click();
  await expect(rightPanel).toHaveClass(/right-panel-closed/);
});
