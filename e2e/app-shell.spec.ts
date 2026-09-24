import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  await page.route("**/api/terminals?*", async (route) => route.fulfill({ json: { terminals: [], stats: null } }));
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
  await page.route("**/api/terminals?*", async (route) => route.fulfill({ json: { terminals: [], stats: null } }));
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
    terminals,
    stats: { workspace: { running: 2, records: 3, bufferBytes: 36 }, global: { running: 2, records: 3, bufferBytes: 36 }, limits: { running: 20, records: 100 } },
  } }));
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
