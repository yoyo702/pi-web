import { expect, test } from "@playwright/test";

test("loads the Pi workspace shell without authentication on loopback", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Pi Web/);
  await expect(page.getByText("Pi", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Get Started")).toBeVisible();
  await expect(page.locator(".center-workspace").getByText("Pi", { exact: true })).toBeHidden();
  await expect(page.locator(".center-workspace").getByRole("button", { name: /^(Show|Hide) sidebar$/ })).toBeVisible();
  await expect(page.locator(".center-workspace").getByRole("button", { name: "Workspace activity" })).toBeVisible();
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
  await page.route("**/api/sessions", async (route) => route.fulfill({ json: { sessions: [{
    id: "pi-session", path: "/tmp/pi-web-e2e/session.jsonl", cwd: "/tmp/pi-web-e2e", projectRoot: "/tmp/pi-web-e2e",
    created: "2026-08-03T00:00:00.000Z", modified: "2026-08-03T00:00:00.000Z", messageCount: 1, firstMessage: "test",
  }], runningSessionIds: [] } }));
  await page.route("**/api/files/**", async (route) => {
    if (route.request().url().includes("type=list")) return route.fulfill({ json: { entries: [{ name: "src", isDir: true, size: 0, modified: "" }, { name: "README.md", isDir: false, size: 10, modified: "" }] } });
    return route.continue();
  });
  await page.route("**/api/file-index?*", async (route) => route.fulfill({ json: { matches: [{ path: "src/App.tsx", isDir: false }, { path: "src/utils.ts", isDir: false }] } }));
  await page.route("**/api/git/status?*", async (route) => route.fulfill({ json: { isGitRepository: false, files: [] } }));
  await page.route("**/api/workspace-files", async (route) => route.fulfill({ json: { path: "README-renamed.md" } }));

  await page.goto("/");
  const search = page.getByRole("combobox", { name: "Search files" });
  await expect(search).toBeVisible();
  await expect(page.getByRole("button", { name: "New file" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Show hidden files" })).toBeVisible();
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
});
