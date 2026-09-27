import { expect, test, type Page } from "@playwright/test";
import { mockRunningSession } from "./support/mock-running-session";

async function mockStatusStream(page: Page, frames: Array<Record<string, unknown>> = []) {
  await page.route("**/api/agent/running/events", (route) => route.fulfill({
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    body: frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""),
  }));
}

// Dispatches one native HTML5 drag event per call (its own page.evaluate
// round trip) rather than firing dragstart/dragover/drop back-to-back inside
// a single evaluate: React 18 batches the setState calls TabBar.tsx's drag
// handlers make, so firing every event synchronously in one browser task
// left later handlers reading the *previous* render's (stale) drag state —
// each event needs its own tick for React to flush and re-render in between.
async function dispatchDragEvent(page: Page, selector: string, type: string, x: number, y: number) {
  await page.evaluate(({ selector, type, x, y }) => {
    const element = document.querySelector(selector);
    if (!(element instanceof HTMLElement)) throw new Error(`no element for ${selector}`);
    element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: new DataTransfer(), clientX: x, clientY: y }));
  }, { selector, type, x, y });
}

// SessionInfo requires `created`/`modified` (buildSessionTree and
// sortSessionsByRecent both call `.localeCompare` on them directly) and
// `messageCount`/`path`; the brief's scaffold used a non-existent
// `updatedAt` field, which would throw at render time.
const SESSIONS = [
  { id: "s-auth", path: "/tmp/proj/.pi/sessions/s-auth.jsonl", name: "Refactor auth flow", firstMessage: "Refactor auth flow", cwd: "/tmp/proj", projectRoot: "/tmp/proj", created: "2026-01-03T00:00:00.000Z", modified: "2026-01-03T00:00:00.000Z", messageCount: 1 },
  { id: "s-docs", path: "/tmp/proj/.pi/sessions/s-docs.jsonl", name: "Update docs", firstMessage: "Update docs", cwd: "/tmp/proj", projectRoot: "/tmp/proj", created: "2026-01-02T00:00:00.000Z", modified: "2026-01-02T00:00:00.000Z", messageCount: 1 },
];

test("session search filters the sidebar by title", async ({ page }) => {
  await mockStatusStream(page);
  await page.route("**/api/sessions", (route) => route.fulfill({ json: { sessions: SESSIONS, runningSessionIds: [] } }));
  await page.goto("/");
  // <input type="search"> maps to the ARIA "searchbox" role, not "textbox".
  const search = page.getByRole("searchbox", { name: "Search Pi sessions" });
  await expect(search).toBeVisible();
  await search.fill("auth");
  await expect(page.getByText("Refactor auth flow")).toBeVisible();
  await expect(page.getByText("Update docs")).toBeHidden();
  // The custom clear (X) button (aria-label "Clear session search") sits next
  // to this <input type="search">; the native WebKit/Blink cancel control is
  // hidden via app/globals.css (see components/globals-css.test.mjs, which
  // checks that rule directly — Chromium's getComputedStyle(el, pseudo) does
  // not support querying "::-webkit-search-cancel-button", so it can't be
  // asserted from here) so it isn't shown doubled.
  await expect(page.getByRole("button", { name: "Clear session search" })).toBeVisible();
  await search.fill("");
  await expect(page.getByText("Update docs")).toBeVisible();
});

test("Regenerate is hidden while the agent is still running", async ({ page }) => {
  // Default mockRunningSession fixture is busy (mid-turn); Regenerate must
  // not offer to resend on top of an in-flight prompt.
  await mockRunningSession(page);
  await expect(page.getByRole("button", { name: "Regenerate response" })).toHaveCount(0);
});

test("regenerate resends the last user message and replaces the reply", async ({ page }) => {
  const { agentPosts } = await mockRunningSession(page, undefined, { busy: false });
  const button = page.getByRole("button", { name: "Regenerate response" });
  await expect(button).toBeVisible();
  await button.click();

  // Regenerate navigates back to the last user turn's own entry (forking the
  // tree there, dropping the assistant reply that followed it), then resends
  // that turn's exact text — one navigate_tree, one fresh prompt.
  await expect.poll(() => agentPosts.filter((body) => body.type === "prompt").length).toBe(1);
  expect(agentPosts.some((body) => body.type === "navigate_tree" && body.targetId === "user-1")).toBe(true);
  const promptCall = agentPosts.find((body) => body.type === "prompt");
  expect(promptCall?.message).toBe("Start the task");
});

test("regenerate does not resend when the branch switch fails", async ({ page }) => {
  const { agentPosts } = await mockRunningSession(page, (body) => (
    body.type === "navigate_tree" ? { status: 500, json: { error: "session busy" } } : null
  ), { busy: false });
  const button = page.getByRole("button", { name: "Regenerate response" });
  await expect(button).toBeVisible();
  await button.click();

  await expect(page.getByText("Could not switch branch: session busy")).toBeVisible();
  // Give any (incorrect) prompt send a moment to fire before asserting none did.
  await page.waitForTimeout(300);
  expect(agentPosts.some((body) => body.type === "prompt")).toBe(false);
});

test("Cmd/Ctrl+, opens Settings", async ({ page }) => {
  await mockStatusStream(page);
  await page.route("**/api/sessions", (route) => route.fulfill({ json: { sessions: [], runningSessionIds: [] } }));
  await page.goto("/");
  // Wait for hydration before firing the shortcut (see the Cmd/Ctrl+K test).
  await expect(page.getByRole("searchbox", { name: "Search Pi sessions" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+,");
  // SettingsPanel's dialog root: role="dialog" aria-modal="true" aria-label="Settings".
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
});

test("Cmd/Ctrl+, does nothing while another modal is open", async ({ page }) => {
  await mockStatusStream(page);
  await page.route("**/api/sessions", (route) => route.fulfill({ json: { sessions: [], runningSessionIds: [] } }));
  await page.goto("/");
  await expect(page.getByRole("searchbox", { name: "Search Pi sessions" })).toBeVisible();
  // Open the "Search projects" dialog (Cmd/Ctrl+Shift+P, bound in
  // ProjectRail.tsx independently of project-rail collapse state), then press
  // Cmd/Ctrl+, and assert Settings did NOT also open — only one aria-modal
  // dialog is visible at a time.
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await expect(page.getByRole("dialog", { name: "Search projects" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+,");
  await expect(page.locator('[aria-modal="true"]')).toHaveCount(1);
});

test("Cmd/Ctrl+K opens the quick switcher and jumps to an open tab", async ({ page }) => {
  await mockStatusStream(page);
  await page.route("**/api/sessions", (route) => route.fulfill({ json: { sessions: [], runningSessionIds: [] } }));
  await page.goto("/");
  // Wait for hydration (the window keydown listener attaches in a useEffect,
  // after "load") before firing the shortcut — the sidebar search box is a
  // stable anchor already present in every other test in this file.
  await expect(page.getByRole("searchbox", { name: "Search Pi sessions" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  // QuickSwitcher's dialog root: role="dialog" aria-modal="true" aria-label="Quick switcher".
  const dialog = page.getByRole("dialog", { name: "Quick switcher" });
  await expect(dialog).toBeVisible();
  // With no project workspaces recorded, the only entry is the always-open
  // "TianForge pi" tab (lib/workspace/panel-state.ts's initialCenterState).
  await page.getByRole("textbox", { name: "Quick switcher search" }).fill("pi");
  await expect(page.getByRole("option").first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
});

test("Escape closes the quick switcher without closing anything underneath", async ({ page }) => {
  await mockStatusStream(page);
  await page.route("**/api/sessions", (route) => route.fulfill({ json: { sessions: [], runningSessionIds: [] } }));
  await page.goto("/");
  await expect(page.getByRole("searchbox", { name: "Search Pi sessions" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByRole("dialog", { name: "Quick switcher" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Quick switcher" })).toBeHidden();
});

test("quick switcher traps Tab focus and restores focus to the trigger on close", async ({ page }) => {
  await mockStatusStream(page);
  await page.route("**/api/sessions", (route) => route.fulfill({ json: { sessions: SESSIONS, runningSessionIds: [] } }));
  await page.goto("/");
  const search = page.getByRole("searchbox", { name: "Search Pi sessions" });
  await expect(search).toBeVisible();
  // Focus a known element before opening, so we can assert focus returns to it.
  await search.focus();
  await expect(search).toBeFocused();
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: "Quick switcher" });
  await expect(dialog).toBeVisible();
  const input = page.getByRole("textbox", { name: "Quick switcher search" });
  await expect(input).toBeFocused();

  // Shift+Tab from the input (the first focusable element) wraps to the last option.
  await page.keyboard.press("Shift+Tab");
  const options = dialog.getByRole("option");
  const lastOption = options.last();
  await expect(lastOption).toBeFocused();

  // Tab from the last option wraps back to the input.
  await page.keyboard.press("Tab");
  await expect(input).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(search).toBeFocused();
});

test("Cmd/Ctrl+K does nothing while another modal is open", async ({ page }) => {
  await mockStatusStream(page);
  await page.route("**/api/sessions", (route) => route.fulfill({ json: { sessions: [], runningSessionIds: [] } }));
  await page.goto("/");
  await expect(page.getByRole("searchbox", { name: "Search Pi sessions" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+,");
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator('[aria-modal="true"]')).toHaveCount(1);
});

test("Quick switcher ignores Enter and Escape while an IME composition is in progress", async ({ page }) => {
  // Mirrors ChatInput's IME guard: a composing Enter (e.g. confirming a
  // Japanese/Chinese candidate) must not also select an entry, and a
  // composing Escape (cancelling the candidate window) must not also close
  // the dialog — both are recognizable via isComposing or the legacy
  // keyCode 229 some browsers still report.
  await mockStatusStream(page);
  await page.route("**/api/sessions", (route) => route.fulfill({ json: { sessions: [], runningSessionIds: [] } }));
  await page.goto("/");
  await expect(page.getByRole("searchbox", { name: "Search Pi sessions" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: "Quick switcher" });
  await expect(dialog).toBeVisible();
  const input = page.getByRole("textbox", { name: "Quick switcher search" });
  await input.fill("pi");
  await expect(page.getByRole("option").first()).toBeVisible();

  await input.dispatchEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true });
  await expect(dialog).toBeVisible();

  await input.dispatchEvent("keydown", { key: "Escape", isComposing: true, bubbles: true, cancelable: true });
  await expect(dialog).toBeVisible();

  // A non-composing Enter still selects and closes, confirming the guard is
  // scoped to composition and not a blanket break of the keydown handler.
  await input.dispatchEvent("keydown", { key: "Enter", isComposing: false, bubbles: true, cancelable: true });
  await expect(dialog).toBeHidden();
});

test("Ctrl+K inside a terminal does not open the quick switcher, but Meta+K still does", async ({ page }) => {
  // Terminal emulators on Linux/Windows bind Ctrl+K themselves (e.g. xterm's
  // readline-style "delete to end of line"). hooks/useKeyboardShortcuts.ts
  // must let that through instead of hijacking it for the Quick Switcher —
  // but only for Ctrl; Meta+K (macOS) keeps opening the switcher everywhere,
  // including from inside a terminal.
  await mockStatusStream(page);
  await page.route("**/api/sessions", (route) => route.fulfill({ json: { sessions: [], runningSessionIds: [] } }));
  await page.goto("/");
  await expect(page.getByRole("searchbox", { name: "Search Pi sessions" })).toBeVisible();

  // A minimal stand-in for an xterm viewport — the hook only checks for a
  // ".xterm" ancestor on the event target, so a real terminal isn't needed.
  await page.evaluate(() => {
    const el = document.createElement("div");
    el.className = "xterm";
    el.tabIndex = 0;
    el.id = "fake-xterm";
    document.body.appendChild(el);
  });
  const xterm = page.locator("#fake-xterm");
  await xterm.focus();

  await xterm.dispatchEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true });
  await expect(page.getByRole("dialog", { name: "Quick switcher" })).toBeHidden();

  await xterm.dispatchEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true });
  await expect(page.getByRole("dialog", { name: "Quick switcher" })).toBeVisible();
});

test("Close Others on the center tab bar keeps the clicked tab and prompts for a busy terminal", async ({ page }, testInfo) => {
  // ProjectRail's floating mobile project switcher (app/globals.css:1227,
  // "position: fixed; top: 4px; left: 46px") overlaps the workspace tab
  // bar's leftmost tabs on narrow viewports — pre-existing, unrelated to this
  // task's context menu. e2e/app-shell.spec.ts's own tab-bar context-menu
  // test ("searches and manages files from Explorer") skips mobile for the
  // same reason.
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop tab bar context menu test");
  // A single active project workspace with one running terminal already
  // restored as a center tab (mirrors panel-storage.ts's persisted shape),
  // so on load the center tab bar shows the always-open "TianForge pi" tab
  // plus that terminal tab — two tabs is what makes the bar visible at all
  // (AppShell.tsx's showWorkspaceTabBar = workspaceTabs.length > 1).
  const cwd = "/tmp/pi-web-nav-close-others";
  const terminal = {
    id: "t1", title: "Dev server", provider: "shell", state: "running", exitCode: null, cwd,
    pid: 111, permissionMode: "confirm", launchMode: "new", noAltScreen: false, cols: 80, rows: 24,
    createdAt: "2026-08-03T00:00:00.000Z", endedAt: null, signal: null, bufferBytes: 0, bufferTruncated: false, history: [],
  };
  await page.addInitScript(({ cwd, terminalId }) => {
    localStorage.setItem("pi-web:project-workspaces:v1", JSON.stringify({
      activeId: cwd,
      workspaces: [{ id: cwd, projectRoot: cwd, cwd, label: "nav-close-others", sessionId: null, lastActive: 0 }],
    }));
    localStorage.setItem(`pi-web:workspace-tabs:${encodeURIComponent(cwd)}`, JSON.stringify({
      tabs: [{ id: `terminal:${terminalId}`, label: "Dev server", kind: "terminal", terminalId, cwd, status: "running" }],
      activeId: `terminal:${terminalId}`,
      split: null,
    }));
  }, { cwd, terminalId: terminal.id });
  await page.route("**/api/sessions", (route) => route.fulfill({ json: { sessions: [], runningSessionIds: [] } }));
  await page.route("**/api/cwd/validate", (route) => route.fulfill({ json: { success: true, cwd } }));
  await page.route("**/api/git/status?*", (route) => route.fulfill({ json: { isGitRepository: false, files: [] } }));
  await page.route("**/api/worktrees?*", (route) => route.fulfill({ json: { projectRoot: cwd, isGit: false, isTopLevel: true, worktrees: [] } }));
  await page.route("**/api/terminals**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/api/terminals") return route.fulfill({ status: 404, json: { error: "not found" } });
    return route.fulfill({ json: {
      cwd: url.searchParams.get("cwd") ?? "",
      terminals: [terminal],
      stats: { workspace: { running: 1, records: 1, bufferBytes: 0 }, global: { running: 1, records: 1, bufferBytes: 0 }, limits: { running: 20, records: 100 } },
    } });
  });
  await mockStatusStream(page, [{ type: "terminals", terminals: [terminal], limits: { running: 20, records: 100 } }]);

  await page.goto("/");
  // Wait for hydration before interacting (see the Cmd/Ctrl+K test).
  await expect(page.getByRole("searchbox", { name: "Search Pi sessions" })).toBeVisible();

  const workspaceTabs = page.locator(".center-workspace").getByRole("tablist", { name: "Workspace tabs" });
  const piTab = workspaceTabs.getByRole("tab", { name: "TianForge pi" });
  const terminalTab = workspaceTabs.getByRole("tab", { name: "Dev server" });
  await expect(piTab).toBeVisible();
  await expect(terminalTab).toBeVisible();

  // Right-click the non-busy Pi tab and close every *other* tab — the only
  // other tab is the running terminal, so this must go through the same
  // confirmation the terminal's own close button uses, not force-remove it.
  await piTab.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Close Other Tabs" }).click();
  await expect(page.getByRole("dialog", { name: "Close terminal" })).toBeVisible();
  await expect(terminalTab).toBeVisible();

  // Cancelling the dialog leaves the terminal tab open rather than dropping
  // it silently.
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(terminalTab).toBeVisible();
  await expect(piTab).toBeVisible();
});

test("dragging a tab reorders the center tab bar", async ({ page }) => {
  // The brief's scaffold drags "file" tabs in the center workspace, but
  // CenterTab (lib/workspace/tabs.ts) has no "file" kind — file tabs only
  // exist in the right-panel's SideTab bar. Two terminal tabs, seeded the
  // same way "Close Others on the center tab bar..." above seeds one, give
  // the center tab bar two draggable, closable tabs instead.
  //
  // Playwright's page.mouse drag does not reliably trigger native HTML5
  // drag-and-drop (dragstart/dragover/drop with a DataTransfer) across
  // browsers/projects, so this dispatches those DragEvents directly via
  // page.evaluate — deterministic in both chromium and mobile-chromium (this
  // approach doesn't depend on real pointer/touch gestures, unlike the
  // right-click context-menu test above that does skip mobile).
  const cwd = "/tmp/pi-web-nav-reorder";
  const terminalA = {
    id: "ra", title: "Terminal A", provider: "shell", state: "running", exitCode: null, cwd,
    pid: 201, permissionMode: "confirm", launchMode: "new", noAltScreen: false, cols: 80, rows: 24,
    createdAt: "2026-08-03T00:00:00.000Z", endedAt: null, signal: null, bufferBytes: 0, bufferTruncated: false, history: [],
  };
  const terminalB = { ...terminalA, id: "rb", title: "Terminal B", pid: 202 };
  await page.addInitScript(({ cwd, idA, idB }) => {
    localStorage.setItem("pi-web:project-workspaces:v1", JSON.stringify({
      activeId: cwd,
      workspaces: [{ id: cwd, projectRoot: cwd, cwd, label: "nav-reorder", sessionId: null, lastActive: 0 }],
    }));
    localStorage.setItem(`pi-web:workspace-tabs:${encodeURIComponent(cwd)}`, JSON.stringify({
      tabs: [
        { id: `terminal:${idA}`, label: "Terminal A", kind: "terminal", terminalId: idA, cwd, status: "running" },
        { id: `terminal:${idB}`, label: "Terminal B", kind: "terminal", terminalId: idB, cwd, status: "running" },
      ],
      activeId: `terminal:${idA}`,
      split: null,
    }));
  }, { cwd, idA: terminalA.id, idB: terminalB.id });
  await page.route("**/api/sessions", (route) => route.fulfill({ json: { sessions: [], runningSessionIds: [] } }));
  await page.route("**/api/cwd/validate", (route) => route.fulfill({ json: { success: true, cwd } }));
  await page.route("**/api/git/status?*", (route) => route.fulfill({ json: { isGitRepository: false, files: [] } }));
  await page.route("**/api/worktrees?*", (route) => route.fulfill({ json: { projectRoot: cwd, isGit: false, isTopLevel: true, worktrees: [] } }));
  await page.route("**/api/terminals**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/api/terminals") return route.fulfill({ status: 404, json: { error: "not found" } });
    return route.fulfill({ json: {
      cwd: url.searchParams.get("cwd") ?? "",
      terminals: [terminalA, terminalB],
      stats: { workspace: { running: 2, records: 2, bufferBytes: 0 }, global: { running: 2, records: 2, bufferBytes: 0 }, limits: { running: 20, records: 100 } },
    } });
  });
  await mockStatusStream(page, [{ type: "terminals", terminals: [terminalA, terminalB], limits: { running: 20, records: 100 } }]);

  await page.goto("/");
  // Wait for hydration before interacting (see the Cmd/Ctrl+K test).
  await expect(page.getByRole("searchbox", { name: "Search Pi sessions" })).toBeVisible();

  const workspaceTabs = page.locator(".center-workspace").getByRole("tablist", { name: "Workspace tabs" });
  const tabA = workspaceTabs.getByRole("tab", { name: "Terminal A" });
  const tabB = workspaceTabs.getByRole("tab", { name: "Terminal B" });
  await expect(tabA).toBeVisible();
  await expect(tabB).toBeVisible();
  // The Pi tab's accessible name is "TianForge pi" (ProductBrand renders it
  // as separate text nodes with no literal space, so .toHaveText's rendered
  // text would read "TianForgepi" — aria-label, not textContent, is the
  // source of truth here), read via getByRole's `name` matcher.
  await expect(workspaceTabs.getByRole("tab", { name: "TianForge pi" })).toBeVisible();
  const order = await workspaceTabs.getByRole("tab").evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("data-tab-id")));
  expect(order).toEqual(["pi", `terminal:${terminalA.id}`, `terminal:${terminalB.id}`]);

  // Drag Terminal A to just past the right edge of Terminal B — the last
  // tab, so onDragOver's "next tab after the target" falls through to
  // `null`, i.e. "move to the end".
  const sourceSelector = `[data-tab-id="terminal:${terminalA.id}"]`;
  const targetSelector = `[data-tab-id="terminal:${terminalB.id}"]`;
  const targetBox = await tabB.boundingBox();
  if (!targetBox) throw new Error("Terminal B tab has no bounding box");
  const dropX = targetBox.x + targetBox.width - 2;
  const dropY = targetBox.y + targetBox.height / 2;
  await dispatchDragEvent(page, sourceSelector, "dragstart", targetBox.x, targetBox.y);
  await dispatchDragEvent(page, targetSelector, "dragover", dropX, dropY);
  await dispatchDragEvent(page, targetSelector, "drop", dropX, dropY);
  await dispatchDragEvent(page, sourceSelector, "dragend", dropX, dropY);

  await expect.poll(() => workspaceTabs.getByRole("tab").evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("data-tab-id"))))
    .toEqual(["pi", `terminal:${terminalB.id}`, `terminal:${terminalA.id}`]);
});

test("Close All confirms two busy terminals one at a time, never two dialogs at once", async ({ page }, testInfo) => {
  // Same mobile caveat as "Close Others on the center tab bar..." above
  // (ProjectRail's floating mobile project switcher overlaps the tab bar).
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop tab bar context menu test");
  // Regression test for a bulk-close bug: pendingTerminalClose/pendingChatClose
  // are single-slot state, so a naive loop calling handleCloseWorkspaceTab
  // once per busy id would overwrite the first busy tab's dialog with the
  // second's, silently dropping the first. closeWorkspaceTabsSequentially
  // must instead queue busy tabs and confirm them one at a time.
  const cwd = "/tmp/pi-web-nav-close-all-busy";
  const terminal = (id: string, title: string, pid: number) => ({
    id, title, provider: "shell", state: "running", exitCode: null, cwd,
    pid, permissionMode: "confirm", launchMode: "new", noAltScreen: false, cols: 80, rows: 24,
    createdAt: "2026-08-03T00:00:00.000Z", endedAt: null, signal: null, bufferBytes: 0, bufferTruncated: false, history: [],
  });
  const terminalA = terminal("qa", "Queue A", 301);
  const terminalB = terminal("qb", "Queue B", 302);
  await page.addInitScript(({ cwd, idA, idB }) => {
    localStorage.setItem("pi-web:project-workspaces:v1", JSON.stringify({
      activeId: cwd,
      workspaces: [{ id: cwd, projectRoot: cwd, cwd, label: "nav-close-all-busy", sessionId: null, lastActive: 0 }],
    }));
    localStorage.setItem(`pi-web:workspace-tabs:${encodeURIComponent(cwd)}`, JSON.stringify({
      tabs: [
        { id: `terminal:${idA}`, label: "Queue A", kind: "terminal", terminalId: idA, cwd, status: "running" },
        { id: `terminal:${idB}`, label: "Queue B", kind: "terminal", terminalId: idB, cwd, status: "running" },
      ],
      activeId: `terminal:${idA}`,
      split: null,
    }));
  }, { cwd, idA: terminalA.id, idB: terminalB.id });
  await page.route("**/api/sessions", (route) => route.fulfill({ json: { sessions: [], runningSessionIds: [] } }));
  await page.route("**/api/cwd/validate", (route) => route.fulfill({ json: { success: true, cwd } }));
  await page.route("**/api/git/status?*", (route) => route.fulfill({ json: { isGitRepository: false, files: [] } }));
  await page.route("**/api/worktrees?*", (route) => route.fulfill({ json: { projectRoot: cwd, isGit: false, isTopLevel: true, worktrees: [] } }));
  await page.route("**/api/terminals**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/api/terminals") return route.fulfill({ status: 404, json: { error: "not found" } });
    return route.fulfill({ json: {
      cwd: url.searchParams.get("cwd") ?? "",
      terminals: [terminalA, terminalB],
      stats: { workspace: { running: 2, records: 2, bufferBytes: 0 }, global: { running: 2, records: 2, bufferBytes: 0 }, limits: { running: 20, records: 100 } },
    } });
  });
  await mockStatusStream(page, [{ type: "terminals", terminals: [terminalA, terminalB], limits: { running: 20, records: 100 } }]);

  await page.goto("/");
  await expect(page.getByRole("searchbox", { name: "Search Pi sessions" })).toBeVisible();

  const workspaceTabs = page.locator(".center-workspace").getByRole("tablist", { name: "Workspace tabs" });
  const piTab = workspaceTabs.getByRole("tab", { name: "TianForge pi" });
  const tabA = workspaceTabs.getByRole("tab", { name: "Queue A" });
  const tabB = workspaceTabs.getByRole("tab", { name: "Queue B" });
  await expect(tabA).toBeVisible();
  await expect(tabB).toBeVisible();

  const dialog = page.getByRole("dialog", { name: "Close terminal" });
  await piTab.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Close All Tabs" }).click();

  // The first busy tab prompts; the second is untouched, and there is
  // exactly one dialog on screen (pendingTerminalClose is single-slot).
  await expect(dialog).toBeVisible();
  await expect(page.locator('[aria-modal="true"]')).toHaveCount(1);
  await expect(tabA).toBeVisible();
  await expect(tabB).toBeVisible();

  // Confirming the first advances the queue: its tab closes, and the same
  // single dialog slot now confirms the second busy tab — never two at once.
  await dialog.getByRole("button", { name: "Keep running" }).click();
  await expect(tabA).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(page.locator('[aria-modal="true"]')).toHaveCount(1);
  await expect(tabB).toBeVisible();

  // Cancelling the second stops the queue: the second tab stays open and no
  // further dialog appears.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(tabB).toBeVisible();
  await expect(piTab).toBeVisible();
});

// Shared terminal-workspace boilerplate for the two Cmd/Ctrl+Shift+T
// "reopen last closed tab" tests below.
function reopenTabRoutes(page: Page, cwd: string, terminal: Record<string, unknown>) {
  return Promise.all([
    page.route("**/api/sessions", (route) => route.fulfill({ json: { sessions: [], runningSessionIds: [] } })),
    page.route("**/api/cwd/validate", async (route) => {
      const body = route.request().postDataJSON() as { cwd?: string };
      return route.fulfill({ json: { success: true, cwd: body.cwd ?? cwd } });
    }),
    page.route("**/api/git/status?*", (route) => route.fulfill({ json: { isGitRepository: false, files: [] } })),
    page.route("**/api/worktrees?*", (route) => route.fulfill({ json: { projectRoot: cwd, isGit: false, isTopLevel: true, worktrees: [] } })),
    page.route("**/api/terminals**", (route) => {
      const url = new URL(route.request().url());
      if (url.pathname !== "/api/terminals") return route.fulfill({ status: 404, json: { error: "not found" } });
      return route.fulfill({ json: {
        cwd: url.searchParams.get("cwd") ?? "",
        terminals: [terminal],
        stats: { workspace: { running: 0, records: 1, bufferBytes: 0 }, global: { running: 0, records: 1, bufferBytes: 0 }, limits: { running: 20, records: 100 } },
      } });
    }),
    mockStatusStream(page, [{ type: "terminals", terminals: [terminal], limits: { running: 20, records: 100 } }]),
  ]);
}

test("Cmd/Ctrl+Shift+T reopens the last closed workspace tab", async ({ page }) => {
  // The brief's scaffold closed a "file" tab named "a.ts", but CenterTab
  // (lib/workspace/tabs.ts) has no "file" kind — file tabs only exist in the
  // right-panel's SideTab bar, and removeWorkspaceTab (the funnel this
  // shortcut hooks into) only ever removes CenterTab. A terminal tab, seeded
  // the same way the Close Others/reorder tests above do, is a real center
  // tab instead.
  const cwd = "/tmp/pi-web-nav-reopen-tab";
  const terminal = {
    id: "t-reopen", title: "Build", provider: "shell", state: "exited", exitCode: 0, cwd,
    pid: 401, permissionMode: "confirm", launchMode: "new", noAltScreen: false, cols: 80, rows: 24,
    createdAt: "2026-08-03T00:00:00.000Z", endedAt: "2026-08-03T00:01:00.000Z", signal: null, bufferBytes: 0, bufferTruncated: false, history: [],
  };
  await page.addInitScript(({ cwd, terminalId }) => {
    localStorage.setItem("pi-web:project-workspaces:v1", JSON.stringify({
      activeId: cwd,
      workspaces: [{ id: cwd, projectRoot: cwd, cwd, label: "nav-reopen-tab", sessionId: null, lastActive: 0 }],
    }));
    localStorage.setItem(`pi-web:workspace-tabs:${encodeURIComponent(cwd)}`, JSON.stringify({
      tabs: [{ id: `terminal:${terminalId}`, label: "Build", kind: "terminal", terminalId, cwd, status: "ended" }],
      activeId: `terminal:${terminalId}`,
      split: null,
    }));
  }, { cwd, terminalId: terminal.id });
  await reopenTabRoutes(page, cwd, terminal);

  await page.goto("/");
  // Wait for hydration before interacting (see the Cmd/Ctrl+K test).
  await expect(page.getByRole("searchbox", { name: "Search Pi sessions" })).toBeVisible();

  const workspaceTabs = page.locator(".center-workspace").getByRole("tablist", { name: "Workspace tabs" });
  const tab = workspaceTabs.getByRole("tab", { name: "Build" });
  await expect(tab).toBeVisible();

  // The terminal isn't running, so its close button removes it immediately
  // with no confirmation dialog.
  await page.getByRole("button", { name: "Close Build" }).click();
  await expect(tab).toBeHidden();

  await page.keyboard.press("ControlOrMeta+Shift+t");
  await expect(tab).toBeVisible();
});

test("Cmd/Ctrl+Shift+T undoes a project close instead, when both are pending", async ({ page }, testInfo) => {
  // ProjectRail's own rail-tab close button (project-rail-tab / project-rail-close)
  // isn't rendered on mobile's floating switcher — same desktop-only caveat as
  // the Close Others/Close All tests above.
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop project rail test");
  const cwd = "/tmp/pi-web-nav-reopen-vs-project";
  const label = "nav-reopen-vs-project";
  const terminal = {
    id: "t-reopen-vs-project", title: "Build", provider: "shell", state: "exited", exitCode: 0, cwd,
    pid: 402, permissionMode: "confirm", launchMode: "new", noAltScreen: false, cols: 80, rows: 24,
    createdAt: "2026-08-03T00:00:00.000Z", endedAt: "2026-08-03T00:01:00.000Z", signal: null, bufferBytes: 0, bufferTruncated: false, history: [],
  };
  await page.addInitScript(({ cwd, label, terminalId }) => {
    localStorage.setItem("pi-web:project-workspaces:v1", JSON.stringify({
      activeId: cwd,
      workspaces: [{ id: cwd, projectRoot: cwd, cwd, label, sessionId: null, lastActive: 0 }],
    }));
    localStorage.setItem(`pi-web:workspace-tabs:${encodeURIComponent(cwd)}`, JSON.stringify({
      tabs: [{ id: `terminal:${terminalId}`, label: "Build", kind: "terminal", terminalId, cwd, status: "ended" }],
      activeId: `terminal:${terminalId}`,
      split: null,
    }));
  }, { cwd, label, terminalId: terminal.id });
  await reopenTabRoutes(page, cwd, terminal);

  await page.goto("/");
  await expect(page.getByRole("searchbox", { name: "Search Pi sessions" })).toBeVisible();

  const workspaceTabs = page.locator(".center-workspace").getByRole("tablist", { name: "Workspace tabs" });
  const tab = workspaceTabs.getByRole("tab", { name: "Build" });
  await expect(tab).toBeVisible();

  // Arm the tab-reopen ref first...
  await page.getByRole("button", { name: "Close Build" }).click();
  await expect(tab).toBeHidden();

  // ...then arm ProjectRail's 6-second project-reopen window.
  await page.getByRole("button", { name: `Close ${label}` }).click();
  const closedNotice = page.getByRole("status");
  await expect(closedNotice).toContainText(`Closed ${label}`);

  // One shortcut press: ProjectRail's own bubble-phase `document` listener
  // runs first and calls preventDefault(), so its handler wins — the project
  // comes back, not the tab.
  await page.keyboard.press("ControlOrMeta+Shift+t");
  await expect(closedNotice).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Project workspaces" }).getByTitle(cwd)).toBeVisible();
  await expect(tab).toBeHidden();
});

test("Cmd/Ctrl+Shift+T does nothing while a modal is open", async ({ page }) => {
  // Reviewer-found gap: the shortcut checked only event.defaultPrevented, so
  // it fired right underneath an open Settings dialog (nothing else calls
  // preventDefault() on Cmd/Ctrl+Shift+T while a modal is up). It must also
  // bail on hasVisibleModal(document), same as the Settings/Quick Switcher
  // shortcuts in hooks/useKeyboardShortcuts.ts.
  // On mobile, the fixed "Install TianForge" prompt can shift layout enough
  // to sit over the mobile project switcher pill, which in turn intercepts
  // the tab bar's close button underneath it; dismiss it up front like a
  // returning user would (same workaround as e2e/reliability.spec.ts).
  await page.addInitScript(() => window.sessionStorage.setItem("tianforge-mobile-install-prompt-dismissed-v2", "1"));
  const cwd = "/tmp/pi-web-nav-reopen-modal-guard";
  const terminal = {
    id: "t-reopen-modal-guard", title: "Build", provider: "shell", state: "exited", exitCode: 0, cwd,
    pid: 403, permissionMode: "confirm", launchMode: "new", noAltScreen: false, cols: 80, rows: 24,
    createdAt: "2026-08-03T00:00:00.000Z", endedAt: "2026-08-03T00:01:00.000Z", signal: null, bufferBytes: 0, bufferTruncated: false, history: [],
  };
  await page.addInitScript(({ cwd, terminalId }) => {
    localStorage.setItem("pi-web:project-workspaces:v1", JSON.stringify({
      activeId: cwd,
      // Kept short: the mobile project switcher pill (app/globals.css's
      // .project-mobile-trigger) sizes to its label and sits fixed at the
      // top of the viewport, and a long label here widened it enough to
      // overlap (and intercept clicks on) the tab bar's close button.
      workspaces: [{ id: cwd, projectRoot: cwd, cwd, label: "modal-guard", sessionId: null, lastActive: 0 }],
    }));
    localStorage.setItem(`pi-web:workspace-tabs:${encodeURIComponent(cwd)}`, JSON.stringify({
      tabs: [{ id: `terminal:${terminalId}`, label: "Build", kind: "terminal", terminalId, cwd, status: "ended" }],
      activeId: `terminal:${terminalId}`,
      split: null,
    }));
  }, { cwd, terminalId: terminal.id });
  await reopenTabRoutes(page, cwd, terminal);

  await page.goto("/");
  await expect(page.getByRole("searchbox", { name: "Search Pi sessions" })).toBeVisible();

  const workspaceTabs = page.locator(".center-workspace").getByRole("tablist", { name: "Workspace tabs" });
  const tab = workspaceTabs.getByRole("tab", { name: "Build" });
  await expect(tab).toBeVisible();

  await page.getByRole("button", { name: "Close Build" }).click();
  await expect(tab).toBeHidden();

  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();

  await page.keyboard.press("ControlOrMeta+Shift+t");
  await expect(tab).toBeHidden();
  await expect(settings).toBeVisible();
});

test("Cmd/Ctrl+Shift+T never reopens another project's closed tab", async ({ page }, testInfo) => {
  // Reviewer-found gap: the closed-batch stack wasn't scoped per project, so
  // closing a tab in project A, switching to project B, and pressing the
  // shortcut injected (and persisted) A's tab into B. The stack must be keyed
  // by activeCwd, same scope workspaceTabs/localStorage persistence uses.
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop project rail test");
  const cwdA = "/tmp/pi-web-nav-reopen-scope-a";
  const cwdB = "/tmp/pi-web-nav-reopen-scope-b";
  const terminal = (cwd: string, id: string, title: string, pid: number) => ({
    id, title, provider: "shell", state: "exited", exitCode: 0, cwd,
    pid, permissionMode: "confirm", launchMode: "new", noAltScreen: false, cols: 80, rows: 24,
    createdAt: "2026-08-03T00:00:00.000Z", endedAt: "2026-08-03T00:01:00.000Z", signal: null, bufferBytes: 0, bufferTruncated: false, history: [],
  });
  const terminalA = terminal(cwdA, "t-scope-a", "Scope A", 421);
  const terminalB = terminal(cwdB, "t-scope-b", "Scope B", 422);
  await page.addInitScript(({ cwdA, cwdB, idA, idB }) => {
    localStorage.setItem("pi-web:project-workspaces:v1", JSON.stringify({
      activeId: cwdA,
      workspaces: [
        { id: cwdA, projectRoot: cwdA, cwd: cwdA, label: "nav-reopen-scope-a", sessionId: null, lastActive: 0 },
        { id: cwdB, projectRoot: cwdB, cwd: cwdB, label: "nav-reopen-scope-b", sessionId: null, lastActive: 0 },
      ],
    }));
    localStorage.setItem(`pi-web:workspace-tabs:${encodeURIComponent(cwdA)}`, JSON.stringify({
      tabs: [{ id: `terminal:${idA}`, label: "Scope A", kind: "terminal", terminalId: idA, cwd: cwdA, status: "ended" }],
      activeId: `terminal:${idA}`,
      split: null,
    }));
    localStorage.setItem(`pi-web:workspace-tabs:${encodeURIComponent(cwdB)}`, JSON.stringify({
      tabs: [{ id: `terminal:${idB}`, label: "Scope B", kind: "terminal", terminalId: idB, cwd: cwdB, status: "ended" }],
      activeId: `terminal:${idB}`,
      split: null,
    }));
  }, { cwdA, cwdB, idA: terminalA.id, idB: terminalB.id });
  await page.route("**/api/sessions", (route) => route.fulfill({ json: { sessions: [], runningSessionIds: [] } }));
  await page.route("**/api/cwd/validate", async (route) => {
    const body = route.request().postDataJSON() as { cwd?: string };
    return route.fulfill({ json: { success: true, cwd: body.cwd ?? cwdA } });
  });
  await page.route("**/api/git/status?*", (route) => route.fulfill({ json: { isGitRepository: false, files: [] } }));
  await page.route("**/api/worktrees?*", (route) => route.fulfill({ json: { projectRoot: new URL(route.request().url()).searchParams.get("cwd"), isGit: false, isTopLevel: true, worktrees: [] } }));
  await page.route("**/api/terminals**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/api/terminals") return route.fulfill({ status: 404, json: { error: "not found" } });
    const cwd = url.searchParams.get("cwd") ?? "";
    const own = [terminalA, terminalB].filter((item) => item.cwd === cwd);
    return route.fulfill({ json: {
      cwd,
      terminals: own,
      stats: { workspace: { running: 0, records: own.length, bufferBytes: 0 }, global: { running: 0, records: 2, bufferBytes: 0 }, limits: { running: 20, records: 100 } },
    } });
  });
  await mockStatusStream(page, [{ type: "terminals", terminals: [terminalA, terminalB], limits: { running: 20, records: 100 } }]);

  await page.goto("/");
  await expect(page.getByRole("searchbox", { name: "Search Pi sessions" })).toBeVisible();

  const rail = page.getByRole("navigation", { name: "Project workspaces" });
  await expect(rail.getByTitle(cwdA)).toHaveAttribute("aria-current", "page");

  const workspaceTabs = page.locator(".center-workspace").getByRole("tablist", { name: "Workspace tabs" });
  const tabA = workspaceTabs.getByRole("tab", { name: "Scope A" });
  await expect(tabA).toBeVisible();

  // Close project A's tab, then switch to project B before pressing the
  // shortcut.
  await page.getByRole("button", { name: "Close Scope A" }).click();
  await expect(tabA).toBeHidden();

  await rail.getByTitle(cwdB).click();
  await expect(rail.getByTitle(cwdB)).toHaveAttribute("aria-current", "page");
  const tabB = workspaceTabs.getByRole("tab", { name: "Scope B" });
  await expect(tabB).toBeVisible();

  // Pressing the shortcut in project B must not inject project A's closed
  // tab here.
  await page.keyboard.press("ControlOrMeta+Shift+t");
  await expect(tabA).toHaveCount(0);
  await expect(tabB).toBeVisible();

  // Switching back to A, the shortcut still reopens A's own closed tab — the
  // batch wasn't lost or consumed by the earlier (no-op) press in B.
  await rail.getByTitle(cwdA).click();
  await expect(rail.getByTitle(cwdA)).toHaveAttribute("aria-current", "page");
  await expect(tabA).toBeHidden();
  await page.keyboard.press("ControlOrMeta+Shift+t");
  await expect(tabA).toBeVisible();
});

test("Cmd/Ctrl+Shift+T reopens a whole Close All batch at once", async ({ page }, testInfo) => {
  // Reviewer-requested coverage for the batch-undo design: Close All (or
  // Close Others) closes every affected tab as one batch, so one shortcut
  // press must bring all of them back together, not just the last one.
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop tab bar context menu test");
  const cwd = "/tmp/pi-web-nav-reopen-batch";
  const terminal = (id: string, title: string, pid: number) => ({
    id, title, provider: "shell", state: "exited", exitCode: 0, cwd,
    pid, permissionMode: "confirm", launchMode: "new", noAltScreen: false, cols: 80, rows: 24,
    createdAt: "2026-08-03T00:00:00.000Z", endedAt: "2026-08-03T00:01:00.000Z", signal: null, bufferBytes: 0, bufferTruncated: false, history: [],
  });
  const terminalA = terminal("t-batch-a", "Batch A", 411);
  const terminalB = terminal("t-batch-b", "Batch B", 412);
  await page.addInitScript(({ cwd, idA, idB }) => {
    localStorage.setItem("pi-web:project-workspaces:v1", JSON.stringify({
      activeId: cwd,
      workspaces: [{ id: cwd, projectRoot: cwd, cwd, label: "nav-reopen-batch", sessionId: null, lastActive: 0 }],
    }));
    localStorage.setItem(`pi-web:workspace-tabs:${encodeURIComponent(cwd)}`, JSON.stringify({
      tabs: [
        { id: `terminal:${idA}`, label: "Batch A", kind: "terminal", terminalId: idA, cwd, status: "ended" },
        { id: `terminal:${idB}`, label: "Batch B", kind: "terminal", terminalId: idB, cwd, status: "ended" },
      ],
      activeId: `terminal:${idA}`,
      split: null,
    }));
  }, { cwd, idA: terminalA.id, idB: terminalB.id });
  await page.route("**/api/sessions", (route) => route.fulfill({ json: { sessions: [], runningSessionIds: [] } }));
  await page.route("**/api/cwd/validate", (route) => route.fulfill({ json: { success: true, cwd } }));
  await page.route("**/api/git/status?*", (route) => route.fulfill({ json: { isGitRepository: false, files: [] } }));
  await page.route("**/api/worktrees?*", (route) => route.fulfill({ json: { projectRoot: cwd, isGit: false, isTopLevel: true, worktrees: [] } }));
  await page.route("**/api/terminals**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/api/terminals") return route.fulfill({ status: 404, json: { error: "not found" } });
    return route.fulfill({ json: {
      cwd: url.searchParams.get("cwd") ?? "",
      terminals: [terminalA, terminalB],
      stats: { workspace: { running: 0, records: 2, bufferBytes: 0 }, global: { running: 0, records: 2, bufferBytes: 0 }, limits: { running: 20, records: 100 } },
    } });
  });
  await mockStatusStream(page, [{ type: "terminals", terminals: [terminalA, terminalB], limits: { running: 20, records: 100 } }]);

  await page.goto("/");
  await expect(page.getByRole("searchbox", { name: "Search Pi sessions" })).toBeVisible();

  const workspaceTabs = page.locator(".center-workspace").getByRole("tablist", { name: "Workspace tabs" });
  const tabA = workspaceTabs.getByRole("tab", { name: "Batch A" });
  const tabB = workspaceTabs.getByRole("tab", { name: "Batch B" });
  await expect(tabA).toBeVisible();
  await expect(tabB).toBeVisible();

  // Both terminals are idle (state: "exited"), so Close All Tabs removes them
  // immediately with no confirmation dialogs — one batch of two.
  await tabA.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Close All Tabs" }).click();
  await expect(tabA).toBeHidden();
  await expect(tabB).toBeHidden();

  // One shortcut press brings the whole batch back, not just the most
  // recently closed of the two.
  await page.keyboard.press("ControlOrMeta+Shift+t");
  await expect(tabA).toBeVisible();
  await expect(tabB).toBeVisible();
});

test("renaming and archiving a Claude session updates the Agents panel", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop agent sidebar test");
  await mockStatusStream(page);
  await page.route("**/api/sessions", (route) => route.fulfill({ json: { sessions: [{
    id: "pi-session", path: "/tmp/pi-web-e2e/session.jsonl", cwd: "/tmp/pi-web-e2e", projectRoot: "/tmp/pi-web-e2e",
    created: "2026-08-03T00:00:00.000Z", modified: "2026-08-03T00:00:00.000Z", messageCount: 1, firstMessage: "test",
  }], runningSessionIds: [] } }));
  await page.route("**/api/cwd/validate", (route) => route.fulfill({ json: { success: true, cwd: "/tmp/pi-web-e2e" } }));
  await page.route("**/api/terminals?*", (route) => route.fulfill({ json: { cwd: "/tmp/pi-web-e2e", terminals: [], stats: null } }));
  await page.route("**/api/project-scripts?*", (route) => route.fulfill({ json: { scripts: [], runner: "npm" } }));
  await page.route("**/api/codex/sessions?*", (route) => route.fulfill({ json: { sessions: [], nextCursor: null } }));

  const id = "11111111-4111-4111-8111-111111111111";
  let archived = false;
  let title = "Investigate flaky test";
  await page.route("**/api/claude/sessions?*", (route) => {
    const wantArchived = new URL(route.request().url()).searchParams.get("archived") === "true";
    const rows = wantArchived === archived
      ? [{ id, title, firstMessage: title, cwd: "/tmp/pi-web-e2e", gitBranch: null, createdAt: null, updatedAt: "2026-01-01T00:00:00.000Z", size: 10, archived, runtime: null }]
      : [];
    return route.fulfill({ json: { sessions: rows, nextCursor: null } });
  });
  await page.route(`**/api/claude/sessions/${id}/rename`, (route) => {
    title = (route.request().postDataJSON() as { name: string }).name;
    return route.fulfill({ json: { session: { id, title, archived } } });
  });
  await page.route(`**/api/claude/sessions/${id}/archive`, (route) => {
    archived = true;
    return route.fulfill({ json: { session: { id, title, archived } } });
  });

  await page.goto("/");
  await expect(page.getByRole("searchbox", { name: "Search Pi sessions" })).toBeVisible();
  await page.getByRole("navigation", { name: "Sidebar modules" }).getByRole("button", { name: "Agents" }).click();
  await page.locator("button[aria-expanded]").filter({ hasText: "Claude" }).last().click();
  await expect(page.getByText("Investigate flaky test", { exact: true })).toBeVisible();

  const openMenu = async (name: string) => {
    const trigger = page.getByRole("button", { name: `Manage ${name}` });
    await trigger.hover();
    await trigger.click();
  };

  await openMenu("Investigate flaky test");
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const renameDialog = page.getByRole("dialog", { name: "Rename Claude session" });
  await renameDialog.getByRole("textbox").fill("Fixed flaky test");
  await renameDialog.getByRole("button", { name: "Rename" }).click();
  await expect(page.getByText("Fixed flaky test", { exact: true })).toBeVisible();
  await expect(page.getByText("Investigate flaky test", { exact: true })).toHaveCount(0);

  await openMenu("Fixed flaky test");
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await page.getByRole("dialog", { name: "Archive Claude session" }).getByRole("button", { name: "Archive" }).click();
  await expect(page.getByText("Fixed flaky test", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Archived" }).click();
  await expect(page.getByText("Fixed flaky test", { exact: true })).toBeVisible();
});

test("restarting an unavailable Claude terminal resumes its source session", async ({ page }) => {
  // Mirrors the Codex path AppShell.tsx already exercises: a workspace tab
  // whose terminalId no longer appears in the /api/terminals list renders
  // TerminalTabView's "Terminal process is unavailable" recovery view (see
  // components/workspace/tab-views.tsx) with a "Restart terminal" button.
  const cwd = "/tmp/pi-web-nav-restart-claude";
  const sourceSessionId = "11111111-1111-1111-1111-111111111111";
  await page.addInitScript(({ cwd, sourceSessionId }) => {
    localStorage.setItem("pi-web:project-workspaces:v1", JSON.stringify({
      activeId: cwd,
      workspaces: [{ id: cwd, projectRoot: cwd, cwd, label: "nav-restart-claude", sessionId: null, lastActive: 0 }],
    }));
    localStorage.setItem(`pi-web:workspace-tabs:${encodeURIComponent(cwd)}`, JSON.stringify({
      tabs: [{
        id: "terminal:gone-claude-terminal", label: "Claude", kind: "terminal",
        terminalId: "gone-claude-terminal", terminalProvider: "claude", terminalLaunchMode: "resume", sourceSessionId,
        cwd, status: "running",
      }],
      activeId: "terminal:gone-claude-terminal",
      split: null,
    }));
  }, { cwd, sourceSessionId });
  await page.route("**/api/sessions", (route) => route.fulfill({ json: { sessions: [], runningSessionIds: [] } }));
  await page.route("**/api/cwd/validate", (route) => route.fulfill({ json: { success: true, cwd } }));
  await page.route("**/api/git/status?*", (route) => route.fulfill({ json: { isGitRepository: false, files: [] } }));
  await page.route("**/api/worktrees?*", (route) => route.fulfill({ json: { projectRoot: cwd, isGit: false, isTopLevel: true, worktrees: [] } }));

  // `null as Record<...> | null` (not `let lastLaunch: ... = null`) sidesteps a
  // TS control-flow quirk: a reassignment inside a nested closure (the route
  // handler below) isn't tracked for narrowing, so a plain `null` initializer
  // leaves every later read narrowed to `null`/`never` instead of the full type.
  let lastLaunch = null as Record<string, unknown> | null;
  const restartedTerminal = (overrides: Record<string, unknown>) => ({
    id: "t2", title: "Claude", provider: "claude", state: "running", exitCode: null, cwd,
    pid: 501, permissionMode: "default", launchMode: lastLaunch?.launchMode, noAltScreen: false,
    cols: 80, rows: 24, createdAt: "2026-08-03T00:00:00.000Z", endedAt: null, signal: null,
    bufferBytes: 0, bufferTruncated: false, history: [], sourceSessionId: lastLaunch?.sourceSessionId ?? null,
    ...overrides,
  });
  // "**/api/terminals**" (not the narrower "**/api/terminals") so this also
  // matches the app's real GET, which is `/api/terminals?cwd=...` — a bare
  // "**/api/terminals" pattern only matches a URL with no query string, so
  // the GET branch below was dead code and every restart test was quietly
  // hitting the real server for its terminal list. The pathname check still
  // guards against also swallowing "**/api/terminals/<id>" requests (falls
  // back to the more specific route registered right below, which — being
  // registered later — already takes priority for those).
  await page.route("**/api/terminals**", (route) => {
    if (route.request().method() === "POST") {
      lastLaunch = route.request().postDataJSON();
      return route.fulfill({ json: { terminal: restartedTerminal({}) } });
    }
    const url = new URL(route.request().url());
    if (url.pathname !== "/api/terminals") return route.fallback();
    // The original terminal never comes back into the list — it's gone,
    // which is what makes the tab render as "unavailable" in the first place.
    return route.fulfill({ json: {
      cwd: url.searchParams.get("cwd") ?? "",
      terminals: [],
      stats: { workspace: { running: 0, records: 0, bufferBytes: 0 }, global: { running: 0, records: 0, bufferBytes: 0 }, limits: { running: 20, records: 100 } },
    } });
  });
  await page.route("**/api/terminals/*", (route) => {
    const method = route.request().method();
    if (method === "DELETE") return route.fulfill({ json: { ok: true } });
    if (method === "PATCH") {
      const body = route.request().postDataJSON() as { title?: string };
      return route.fulfill({ json: { terminal: restartedTerminal({ title: body.title }) } });
    }
    return route.continue();
  });
  await mockStatusStream(page, [{ type: "terminals", terminals: [], limits: { running: 20, records: 100 } }]);

  await page.goto("/");
  // Wait for hydration before interacting (see the Cmd/Ctrl+K test).
  await expect(page.getByRole("searchbox", { name: "Search Pi sessions" })).toBeVisible();

  await expect(page.getByText("Terminal process is unavailable")).toBeVisible();
  await page.getByRole("button", { name: "Restart terminal" }).click();

  await expect.poll(() => lastLaunch?.launchMode).toBe("resume");
  expect(lastLaunch?.sourceSessionId).toBe(sourceSessionId);
});

test("restarting an unavailable fork terminal does not resume the parent session", async ({ page }) => {
  // A `fork` terminal's sourceSessionId is the PARENT session it forked from
  // (not its own), so restarting it must never resume that id — it should
  // restart as a fresh terminal instead, same as before a45b246.
  const cwd = "/tmp/pi-web-nav-restart-fork";
  const sourceSessionId = "22222222-2222-2222-2222-222222222222";
  await page.addInitScript(({ cwd, sourceSessionId }) => {
    localStorage.setItem("pi-web:project-workspaces:v1", JSON.stringify({
      activeId: cwd,
      workspaces: [{ id: cwd, projectRoot: cwd, cwd, label: "nav-restart-fork", sessionId: null, lastActive: 0 }],
    }));
    localStorage.setItem(`pi-web:workspace-tabs:${encodeURIComponent(cwd)}`, JSON.stringify({
      tabs: [{
        id: "terminal:gone-fork-terminal", label: "Claude", kind: "terminal",
        terminalId: "gone-fork-terminal", terminalProvider: "claude", terminalLaunchMode: "fork", sourceSessionId,
        cwd, status: "running",
      }],
      activeId: "terminal:gone-fork-terminal",
      split: null,
    }));
  }, { cwd, sourceSessionId });
  await page.route("**/api/sessions", (route) => route.fulfill({ json: { sessions: [], runningSessionIds: [] } }));
  await page.route("**/api/cwd/validate", (route) => route.fulfill({ json: { success: true, cwd } }));
  await page.route("**/api/git/status?*", (route) => route.fulfill({ json: { isGitRepository: false, files: [] } }));
  await page.route("**/api/worktrees?*", (route) => route.fulfill({ json: { projectRoot: cwd, isGit: false, isTopLevel: true, worktrees: [] } }));

  let lastLaunch = null as Record<string, unknown> | null;
  const restartedTerminal = (overrides: Record<string, unknown>) => ({
    id: "t3", title: "Claude", provider: "claude", state: "running", exitCode: null, cwd,
    pid: 502, permissionMode: "default", launchMode: lastLaunch?.launchMode, noAltScreen: false,
    cols: 80, rows: 24, createdAt: "2026-08-03T00:00:00.000Z", endedAt: null, signal: null,
    bufferBytes: 0, bufferTruncated: false, history: [], sourceSessionId: lastLaunch?.sourceSessionId ?? null,
    ...overrides,
  });
  // "**/api/terminals**" so this also matches the app's real GET
  // (`/api/terminals?cwd=...`) — see the comment on the equivalent route in
  // the resume test above.
  await page.route("**/api/terminals**", (route) => {
    if (route.request().method() === "POST") {
      lastLaunch = route.request().postDataJSON();
      return route.fulfill({ json: { terminal: restartedTerminal({}) } });
    }
    const url = new URL(route.request().url());
    if (url.pathname !== "/api/terminals") return route.fallback();
    return route.fulfill({ json: {
      cwd: url.searchParams.get("cwd") ?? "",
      terminals: [],
      stats: { workspace: { running: 0, records: 0, bufferBytes: 0 }, global: { running: 0, records: 0, bufferBytes: 0 }, limits: { running: 20, records: 100 } },
    } });
  });
  await page.route("**/api/terminals/*", (route) => {
    const method = route.request().method();
    if (method === "DELETE") return route.fulfill({ json: { ok: true } });
    if (method === "PATCH") {
      const body = route.request().postDataJSON() as { title?: string };
      return route.fulfill({ json: { terminal: restartedTerminal({ title: body.title }) } });
    }
    return route.continue();
  });
  await mockStatusStream(page, [{ type: "terminals", terminals: [], limits: { running: 20, records: 100 } }]);

  await page.goto("/");
  await expect(page.getByRole("searchbox", { name: "Search Pi sessions" })).toBeVisible();

  await expect(page.getByText("Terminal process is unavailable")).toBeVisible();
  await page.getByRole("button", { name: "Restart terminal" }).click();

  await expect.poll(() => lastLaunch?.launchMode).toBe("new");
  expect(lastLaunch?.sourceSessionId).toBeUndefined();
});
