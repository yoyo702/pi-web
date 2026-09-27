import { test, expect } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeWorkspace(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pi-web-e2e-${name}-`));
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  return dir;
}

test.describe("mobile accessibility and touch reachability", () => {
  test("File actions button reaches rename/delete on coarse pointers", async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.startsWith("mobile"), "coarse-pointer-only affordance");
    const workspace = makeWorkspace("explorer-touch");
    await page.route("**/api/git/status?*", (route) => route.fulfill({ json: { isGitRepository: false, files: [] } }));
    await page.route("**/api/worktrees?*", (route) => route.fulfill({ json: { projectRoot: workspace, isGit: false, isTopLevel: true, worktrees: [] } }));
    // Do NOT mock /api/cwd/validate here: it is the real authorization endpoint
    // (allowFileRoot) that grants this real temp dir access to /api/files below.
    // AppShell's own effect calls it for free whenever activeCwd is set (see
    // components/AppShell.tsx's "Always establish the server grant" effect), so
    // mocking it (as the scaffold originally did) left the workspace unauthorized
    // and the Explorer showed "Access denied" instead of the fixture file.
    await page.route("**/api/sessions", (route) => route.fulfill({ json: { sessions: [], runningSessionIds: [] } }));
    await page.addInitScript((snapshot) => {
      localStorage.setItem("pi-web:project-workspaces:v1", JSON.stringify(snapshot));
    }, {
      activeId: workspace,
      workspaces: [{ id: workspace, projectRoot: workspace, cwd: workspace, label: "explorer-touch", sessionId: null, lastActive: 1 }],
    });
    await page.goto("/");
    await expect(page.getByRole("searchbox", { name: "Search Pi sessions" })).toBeVisible();
    const navigation = page.getByRole("navigation", { name: "Mobile navigation" });
    await navigation.getByRole("button", { name: "Files" }).click();
    const row = page.locator("[data-explorer-row][data-file-path$=\"README.md\"]");
    await expect(row).toBeVisible();
    await expect(row.getByRole("button", { name: "File actions" })).toBeVisible();
    await row.getByRole("button", { name: "File actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
  });

  test("File actions button is absent on non-touch pointers", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.startsWith("mobile"), "desktop-only assertion");
    const workspace = makeWorkspace("explorer-desktop");
    await page.route("**/api/git/status?*", (route) => route.fulfill({ json: { isGitRepository: false, files: [] } }));
    await page.route("**/api/worktrees?*", (route) => route.fulfill({ json: { projectRoot: workspace, isGit: false, isTopLevel: true, worktrees: [] } }));
    // See the touch-pointer test above: /api/cwd/validate must hit the real
    // handler to authorize this real temp dir, not be mocked.
    await page.route("**/api/sessions", (route) => route.fulfill({ json: { sessions: [], runningSessionIds: [] } }));
    await page.addInitScript((snapshot) => {
      localStorage.setItem("pi-web:project-workspaces:v1", JSON.stringify(snapshot));
    }, {
      activeId: workspace,
      workspaces: [{ id: workspace, projectRoot: workspace, cwd: workspace, label: "explorer-desktop", sessionId: null, lastActive: 1 }],
    });
    await page.goto("/");
    await expect(page.getByRole("searchbox", { name: "Search Pi sessions" })).toBeVisible();
    const row = page.locator("[data-explorer-row][data-file-path$=\"README.md\"]");
    await expect(row).toBeVisible();
    await expect(row.getByRole("button", { name: "File actions" })).toHaveCount(0);
  });

  test("expired pairing QR shows Expired — Refresh instead of a dead code", async ({ page }) => {
    const workspace = makeWorkspace("qr-expiry");
    let pairCalls = 0;
    await page.route("**/api/access", (route) => route.fulfill({ json: {
      protocol: "http", listenHost: "0.0.0.0", port: 30142, passwordRequired: true,
      addresses: [{ id: "lan", label: "LAN", address: "192.168.1.20", origin: "http://192.168.1.20:30142", kind: "lan", reachable: true }],
    } }));
    await page.route("**/api/auth/pair", (route) => {
      pairCalls += 1;
      // React's dev-mode Strict Mode double-invokes the mount effect that calls
      // load(), so the initial automatic mount reliably fires two /api/auth/pair
      // requests back to back (not just one) before the user interacts with
      // anything. Both must resolve to the same short-lived token so the dialog
      // settles into an expired state regardless of which of the two responses
      // "wins" the race; only a later, user-triggered refresh (the third call)
      // should return a long-lived token.
      const expiresAt = pairCalls <= 2 ? Date.now() + 300 : Date.now() + 300_000;
      return route.fulfill({ json: { token: `token-${pairCalls}`, expiresAt } });
    });
    await page.route("**/api/git/status?*", (route) => route.fulfill({ json: { isGitRepository: false, files: [] } }));
    await page.route("**/api/worktrees?*", (route) => route.fulfill({ json: { projectRoot: workspace, isGit: false, isTopLevel: true, worktrees: [] } }));
    await page.route("**/api/cwd/validate", (route) => route.fulfill({ json: { success: true, cwd: workspace } }));
    await page.route("**/api/sessions", (route) => route.fulfill({ json: { sessions: [], runningSessionIds: [] } }));
    await page.goto("/");
    // The ProjectRail's standalone "Settings" button is desktop-only (hidden on
    // mobile); the "TianForge app menu" -> "Settings" menuitem path works on
    // both chromium and mobile-chromium, so use that path here. On mobile the
    // sidebar containing the app menu is an off-canvas drawer closed by
    // default (AppShell forces sidebarOpen=false once isMobile resolves), so
    // open it via the bottom nav first and wait out its slide-in transition.
    const mobileNav = page.getByRole("navigation", { name: "Mobile navigation" });
    if (await mobileNav.isVisible()) {
      await mobileNav.getByRole("button", { name: "Agents" }).click();
      await page.waitForTimeout(500);
    }
    // The mobile "Switch project" trigger is hidden while the drawer is open
    // (AppShell passes hideMobileSwitcher={isMobile && sidebarOpen} to
    // ProjectRail) so it no longer covers the app-menu button; click it
    // normally.
    await expect(page.getByRole("button", { name: "Switch project" })).toHaveCount(0);
    await page.getByRole("button", { name: "TianForge app menu" }).click();
    await page.getByRole("menuitem", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Remote access" }).click();
    await expect(page.getByText(/expires at/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Expired — Refresh" })).toBeVisible({ timeout: 3000 });
    await page.getByRole("button", { name: "Expired — Refresh" }).click();
    await expect(page.getByText(/Scan to sign in automatically/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Expired — Refresh" })).toHaveCount(0);
  });

  test("pairing QR re-checks expiry when the tab becomes visible again", async ({ page }) => {
    // Regression test for the throttled-background-tab case: the dialog's expiry
    // switch relies on a single setTimeout, which a backgrounded/throttled tab
    // can delay well past the real expiresAt. Freeze the clock so we can move
    // past expiresAt WITHOUT firing that timer, then simulate the tab coming
    // back to the foreground and assert the expired state appears immediately
    // rather than only once the delayed timer eventually runs.
    const workspace = makeWorkspace("qr-visibility-recheck");
    const startedAt = Date.now();
    await page.clock.install({ time: startedAt });
    let pairCalls = 0;
    await page.route("**/api/access", (route) => route.fulfill({ json: {
      protocol: "http", listenHost: "0.0.0.0", port: 30143, passwordRequired: true,
      addresses: [{ id: "lan", label: "LAN", address: "192.168.1.21", origin: "http://192.168.1.21:30143", kind: "lan", reachable: true }],
    } }));
    await page.route("**/api/auth/pair", (route) => {
      pairCalls += 1;
      return route.fulfill({ json: { token: `token-${pairCalls}`, expiresAt: Date.now() + 300_000 } });
    });
    await page.route("**/api/git/status?*", (route) => route.fulfill({ json: { isGitRepository: false, files: [] } }));
    await page.route("**/api/worktrees?*", (route) => route.fulfill({ json: { projectRoot: workspace, isGit: false, isTopLevel: true, worktrees: [] } }));
    await page.route("**/api/cwd/validate", (route) => route.fulfill({ json: { success: true, cwd: workspace } }));
    await page.route("**/api/sessions", (route) => route.fulfill({ json: { sessions: [], runningSessionIds: [] } }));
    await page.goto("/");
    const mobileNav = page.getByRole("navigation", { name: "Mobile navigation" });
    if (await mobileNav.isVisible()) {
      await mobileNav.getByRole("button", { name: "Agents" }).click();
      await page.waitForTimeout(500);
    }
    await page.getByRole("button", { name: "TianForge app menu" }).click();
    await page.getByRole("menuitem", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Remote access" }).click();
    await expect(page.getByText(/Scan to sign in automatically/)).toBeVisible();

    // Move the wall clock 6 minutes past expiresAt WITHOUT running the fake
    // timer queue (setSystemTime does not fire pending setTimeout callbacks),
    // mirroring a throttled background tab where Date.now() has moved on but
    // the scheduled callback hasn't run yet.
    await page.clock.setSystemTime(startedAt + 360_000);
    await expect(page.getByRole("button", { name: "Expired — Refresh" })).toHaveCount(0);

    // Simulate the tab returning to the foreground.
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.getByRole("button", { name: "Expired — Refresh" })).toBeVisible();
  });

  test("Git panel stacks list above diff on narrow screens instead of squeezing the diff", async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.startsWith("mobile"), "narrow-viewport layout only");
    const workspace = makeWorkspace("git-mobile-layout");
    // 40 modified files so the changes list overflows its allotted mobile
    // height and exercises the aside's internal scrolling (rather than the
    // whole column growing to fit the content and pushing the commit footer
    // off-screen).
    const files = Array.from({ length: 40 }, (_, i) => ({
      filePath: `src/file-${String(i).padStart(2, "0")}.ts`, status: "modified", code: "M", indexStatus: " ", worktreeStatus: "M",
    }));
    files.push({ filePath: "README.md", status: "modified", code: "M", indexStatus: " ", worktreeStatus: "M" });
    await page.route("**/api/git/status?*", (route) => route.fulfill({ json: {
      isGitRepository: true, repositoryRoot: workspace, branch: "main", files,
    } }));
    await page.route("**/api/git/diff?*", (route) => route.fulfill({ json: {
      supported: true, patch: "@@ -1 +1 @@\n-old\n+new\n", fingerprint: "f1",
    } }));
    await page.route("**/api/git/repositories?*", (route) => route.fulfill({ json: {
      repositories: [{ path: workspace, repositoryRoot: workspace, label: "git-mobile-layout", relativePath: "." }],
    } }));
    await page.route("**/api/worktrees?*", (route) => route.fulfill({ json: { projectRoot: workspace, isGit: true, isTopLevel: true, worktrees: [] } }));
    await page.route("**/api/cwd/validate", (route) => route.fulfill({ json: { success: true, cwd: workspace } }));
    await page.route("**/api/sessions", (route) => route.fulfill({ json: { sessions: [], runningSessionIds: [] } }));
    await page.addInitScript((snapshot) => {
      localStorage.setItem("pi-web:project-workspaces:v1", JSON.stringify(snapshot));
    }, {
      activeId: workspace,
      workspaces: [{ id: workspace, projectRoot: workspace, cwd: workspace, label: "git-mobile-layout", sessionId: null, lastActive: 1 }],
    });
    await page.goto("/");
    const navigation = page.getByRole("navigation", { name: "Mobile navigation" });
    await navigation.getByRole("button", { name: "Git" }).click();
    // The file row's accessible name comes from its visible "M README.md" text
    // content, not its `title="View diff: README.md"` attribute (content wins
    // over title in accessible-name computation), so select by title instead.
    const fileButton = page.getByTitle("View diff: README.md");
    await expect(fileButton).toBeVisible();
    // The 40-file list overflows the aside's bounded height, so it must
    // scroll internally (flex: 1 + minHeight: 0) instead of expanding the
    // whole column and pushing the commit footer out of the viewport.
    const changesAside = page.locator("aside").filter({ hasText: "file-00" });
    await expect(changesAside).toBeVisible();
    const [scrollHeight, clientHeight] = await changesAside.evaluate((el) => [el.scrollHeight, el.clientHeight]);
    expect(scrollHeight).toBeGreaterThan(clientHeight);
    // Exact match: substring matching would also hit the "▸ Pre-commit
    // checks" disclosure button.
    const commitButton = page.getByRole("button", { name: "Commit", exact: true });
    await expect(commitButton).toBeVisible();
    await expect(commitButton).toBeInViewport();
    await fileButton.click();
    const backButton = page.getByRole("button", { name: "Back to changes" });
    await expect(backButton).toBeVisible();
    // The file list must be gone (not squeezed to ~100px) while a diff is open.
    await expect(page.getByTitle("View diff: README.md")).toHaveCount(0);
    await backButton.click();
    await expect(page.getByTitle("View diff: README.md")).toBeVisible();
  });

  test("Git History stacks commit list above commit detail on narrow screens", async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.startsWith("mobile"), "narrow-viewport layout only");
    const workspace = makeWorkspace("git-mobile-history");
    await page.route("**/api/git/status?*", (route) => route.fulfill({ json: { isGitRepository: true, repositoryRoot: workspace, branch: "main", files: [] } }));
    await page.route("**/api/git/log?*", (route) => route.fulfill({ json: {
      isGitRepository: true,
      commits: [
        { hash: "aaaaaaa1", shortHash: "aaaaaaa", subject: "First commit", author: "Test", date: new Date().toISOString(), parents: [], refs: [] },
        { hash: "bbbbbbb2", shortHash: "bbbbbbb", subject: "Second commit", author: "Test", date: new Date().toISOString(), parents: ["aaaaaaa1"], refs: [] },
      ],
      hasMore: false,
    } }));
    await page.route("**/api/git/commit?*", (route) => route.fulfill({ json: {
      hash: "aaaaaaa1", shortHash: "aaaaaaa", subject: "First commit", body: "", author: "Test", email: "test@example.com", date: new Date().toISOString(),
      parents: [], refs: [], additions: 1, deletions: 1,
      files: [{ path: "README.md", status: "modified", additions: 1, deletions: 1 }],
    } }));
    await page.route("**/api/git/repositories?*", (route) => route.fulfill({ json: {
      repositories: [{ path: workspace, repositoryRoot: workspace, label: "git-mobile-history", relativePath: "." }],
    } }));
    await page.route("**/api/worktrees?*", (route) => route.fulfill({ json: { projectRoot: workspace, isGit: true, isTopLevel: true, worktrees: [] } }));
    await page.route("**/api/cwd/validate", (route) => route.fulfill({ json: { success: true, cwd: workspace } }));
    await page.route("**/api/sessions", (route) => route.fulfill({ json: { sessions: [], runningSessionIds: [] } }));
    await page.addInitScript((snapshot) => {
      localStorage.setItem("pi-web:project-workspaces:v1", JSON.stringify(snapshot));
    }, {
      activeId: workspace,
      workspaces: [{ id: workspace, projectRoot: workspace, cwd: workspace, label: "git-mobile-history", sessionId: null, lastActive: 1 }],
    });
    await page.goto("/");
    const navigation = page.getByRole("navigation", { name: "Mobile navigation" });
    await navigation.getByRole("button", { name: "Git" }).click();
    // Exact match: substring matching would also hit the disabled "View full
    // history" button and the "Copy project path" button (whose title happens
    // to contain this fixture's "git-mobile-history" temp-dir name).
    await page.getByRole("button", { name: "History", exact: true }).click();
    const commitButton = page.getByTitle("View commit: First commit");
    await expect(commitButton).toBeVisible();
    // History must not auto-open the first commit on mobile: the detail pane
    // (and its Back button) should stay hidden until a commit is tapped.
    await expect(page.getByRole("button", { name: "Back to history" })).toHaveCount(0);
    await commitButton.click();
    const backButton = page.getByRole("button", { name: "Back to history" });
    await expect(backButton).toBeVisible();
    await expect(page.getByTitle("View commit: First commit")).toHaveCount(0);
    await backButton.click();
    await expect(page.getByTitle("View commit: First commit")).toBeVisible();
  });

  test("stable message keys keep an expanded Thinking block open after loading earlier messages", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.startsWith("mobile"), "desktop-only: exercises IntersectionObserver-driven auto-load, not a mobile interaction");
    const sessionId = "load-earlier-session";
    const cwd = "/tmp/pi-web-e2e";
    const olderMessages = [
      { role: "user", content: "Older question", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "Older answer" }], model: "gpt-5.6-sol", provider: "openai-codex", stopReason: "stop", timestamp: 2 },
    ];
    const recentMessages = [
      { role: "user", content: "Recent question", timestamp: 3 },
      { role: "assistant", content: [{ type: "thinking", thinking: "Let me consider this." }, { type: "text", text: "Recent answer" }], model: "gpt-5.6-sol", provider: "openai-codex", stopReason: "stop", timestamp: 4 },
    ];
    let loadedOlder = false;
    // The IntersectionObserver-driven auto-load fires almost immediately on
    // mount (the sentinel is visible before the user does anything), so if
    // the older-messages response were allowed to resolve right away, the
    // Process details/Thinking blocks would always be expanded *after* the
    // reflow — never actually exercising key stability across it. Gate the
    // response so it can only resolve once the test has expanded them first.
    let releaseOlder = () => {};
    const olderGate = new Promise<void>((resolve) => { releaseOlder = resolve; });
    await page.route(`**/api/sessions/${sessionId}/state`, (route) => route.fulfill({ json: { running: false, state: { isStreaming: false, isPromptRunning: false, isBashRunning: false, isCompacting: false } } }));
    await page.route(`**/api/sessions/${sessionId}?*`, (route) => route.fulfill({ json: {
      sessionId, filePath: `${cwd}/session.jsonl`,
      info: { id: sessionId, path: `${cwd}/session.jsonl`, cwd, projectRoot: cwd, created: "2026-09-28T00:00:00.000Z", modified: "2026-09-28T00:00:00.000Z", messageCount: 4, firstMessage: "Older question" },
      leafId: "recent-assistant", tree: [],
      context: { messages: recentMessages, entryIds: ["recent-user", "recent-assistant"], page: { hasMore: true, beforeEntryId: "recent-user" }, thinkingLevel: "medium", model: { provider: "openai-codex", modelId: "gpt-5.6-sol" } },
    } }));
    await page.route(`**/api/sessions/${sessionId}/context?*`, async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("beforeEntryId")) {
        await olderGate;
        loadedOlder = true;
        return route.fulfill({ json: { context: {
          messages: [...olderMessages, ...recentMessages], entryIds: ["older-user", "older-assistant", "recent-user", "recent-assistant"],
          page: { hasMore: false, beforeEntryId: null }, thinkingLevel: "medium", model: { provider: "openai-codex", modelId: "gpt-5.6-sol" },
        } } });
      }
      return route.fulfill({ json: { context: {
        messages: recentMessages, entryIds: ["recent-user", "recent-assistant"], page: { hasMore: true, beforeEntryId: "recent-user" },
        thinkingLevel: "medium", model: { provider: "openai-codex", modelId: "gpt-5.6-sol" },
      } } });
    });
    await page.route("**/api/sessions", (route) => route.fulfill({ json: { sessions: [{ id: sessionId, path: `${cwd}/session.jsonl`, cwd, projectRoot: cwd, created: "2026-09-28T00:00:00.000Z", modified: "2026-09-28T00:00:00.000Z", messageCount: 4, firstMessage: "Older question" }], runningSessionIds: [] } }));
    await page.route("**/api/cwd/validate", (route) => route.fulfill({ json: { success: true, cwd } }));
    await page.route(`**/api/agent/${sessionId}/events`, (route) => route.fulfill({
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      body: `data: ${JSON.stringify({ type: "connected", sessionId })}\n\n`,
    }));

    await page.goto(`/?session=${sessionId}`);
    await expect(page.getByText("Recent answer")).toBeVisible();
    // The recent assistant message has a thinking block ahead of its final
    // text, so it renders as a collapsed "Process details" group; expand that
    // first, then the nested Thinking toggle.
    await page.getByRole("button", { name: /Process details/ }).click();
    await page.getByRole("button", { name: "Thinking" }).click();
    await expect(page.getByText("Let me consider this.")).toBeVisible();
    releaseOlder();
    await expect.poll(() => loadedOlder).toBe(true);
    await expect(page.getByText("Older answer")).toBeVisible();
    await expect(page.getByText("Let me consider this.")).toBeVisible();
  });

  test("Copy button becomes visible on keyboard focus, not just hover", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.startsWith("mobile"), "focus-within is a keyboard/desktop concern; touch visibility is covered by the coarse-pointer branch");
    const sessionId = "focus-visible-session";
    const cwd = "/tmp/pi-web-e2e";
    const messages = [{ role: "user", content: "Hello there", timestamp: 1 }];
    await page.route(`**/api/sessions/${sessionId}/state`, (route) => route.fulfill({ json: { running: false, state: { isStreaming: false, isPromptRunning: false, isBashRunning: false, isCompacting: false } } }));
    await page.route(`**/api/sessions/${sessionId}?*`, (route) => route.fulfill({ json: {
      sessionId, filePath: `${cwd}/session.jsonl`,
      info: { id: sessionId, path: `${cwd}/session.jsonl`, cwd, projectRoot: cwd, created: "2026-09-28T00:00:00.000Z", modified: "2026-09-28T00:00:00.000Z", messageCount: 1, firstMessage: "Hello there" },
      leafId: "user-1", tree: [],
      context: { messages, entryIds: ["user-1"], page: { hasMore: false }, thinkingLevel: "medium", model: { provider: "openai-codex", modelId: "gpt-5.6-sol" } },
    } }));
    await page.route(`**/api/sessions/${sessionId}/context?*`, (route) => route.fulfill({ json: { context: {
      messages, entryIds: ["user-1"], page: { hasMore: false }, thinkingLevel: "medium", model: { provider: "openai-codex", modelId: "gpt-5.6-sol" },
    } } }));
    await page.route("**/api/sessions", (route) => route.fulfill({ json: { sessions: [{ id: sessionId, path: `${cwd}/session.jsonl`, cwd, projectRoot: cwd, created: "2026-09-28T00:00:00.000Z", modified: "2026-09-28T00:00:00.000Z", messageCount: 1, firstMessage: "Hello there" }], runningSessionIds: [] } }));
    await page.route("**/api/cwd/validate", (route) => route.fulfill({ json: { success: true, cwd } }));
    await page.route(`**/api/agent/${sessionId}/events`, (route) => route.fulfill({
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      body: `data: ${JSON.stringify({ type: "connected", sessionId })}\n\n`,
    }));

    await page.goto(`/?session=${sessionId}`);
    // Accessible name is "Copy" (from the button's visible text), not the
    // "Copy message" title, so disambiguate from the sidebar's "Copy project
    // path" button (which also matches name "Copy" as a substring) by title.
    const copyButton = page.locator("button[title='Copy message']");
    // UserMessageView applies opacity/pointer-events to the button's
    // immediate wrapping group div (so the fork/edit buttons in the same row
    // fade in together), not to the button itself, so assert on that group.
    const copyButtonGroup = copyButton.locator("..");
    await expect(copyButtonGroup).toHaveCSS("opacity", "0");
    await copyButton.focus();
    await expect(copyButtonGroup).toHaveCSS("opacity", "1");

    // hovered and focus-within are tracked separately: hovering the
    // still-focused button, then moving the mouse away entirely, must not
    // hide it — only actually losing focus should.
    await copyButton.hover();
    await expect(copyButtonGroup).toHaveCSS("opacity", "1");
    await page.mouse.move(0, 0);
    // Give the opacity transition (0.12s) time to fully settle before
    // asserting, so this checks the resting state rather than racing a
    // still-in-flight transition that hasn't caught up to the mouseleave yet.
    await page.waitForTimeout(300);
    await expect(copyButtonGroup).toHaveCSS("opacity", "1");
    await expect(copyButton).toBeFocused();
  });

  test("Branch tree is keyboard operable with arrow keys and Enter", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.startsWith("mobile"), "desktop-only: the Branches button opens as an inline dropdown, not exercised on the mobile nav");
    const sessionId = "branch-keyboard-session";
    const cwd = "/tmp/pi-web-e2e";
    const tree = [{
      entry: { id: "root", type: "message", parentId: null, timestamp: "2026-09-28T00:00:00.000Z", message: { role: "user", content: "Start" } },
      children: [
        { entry: { id: "branch-a", type: "message", parentId: "root", timestamp: "2026-09-28T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "Branch A" }], model: "gpt-5.6-sol", provider: "openai-codex", stopReason: "stop" } }, children: [] },
        { entry: { id: "branch-b", type: "message", parentId: "root", timestamp: "2026-09-28T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "Branch B" }], model: "gpt-5.6-sol", provider: "openai-codex", stopReason: "stop" } }, children: [] },
      ],
    }];
    const contextFor = (leafId: string) => ({
      messages: [
        { role: "user", content: "Start", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: leafId === "branch-a" ? "Branch A" : "Branch B" }], model: "gpt-5.6-sol", provider: "openai-codex", stopReason: "stop", timestamp: 2 },
      ],
      entryIds: ["root", leafId],
      page: { hasMore: false },
      thinkingLevel: "medium",
      model: { provider: "openai-codex", modelId: "gpt-5.6-sol" },
    });
    await page.route(`**/api/sessions/${sessionId}/state`, (route) => route.fulfill({ json: { running: false, state: { isStreaming: false, isPromptRunning: false, isBashRunning: false, isCompacting: false } } }));
    await page.route(`**/api/sessions/${sessionId}?*`, (route) => route.fulfill({ json: {
      sessionId, filePath: `${cwd}/session.jsonl`,
      info: { id: sessionId, path: `${cwd}/session.jsonl`, cwd, projectRoot: cwd, created: "2026-09-28T00:00:00.000Z", modified: "2026-09-28T00:00:00.000Z", messageCount: 2, firstMessage: "Start" },
      leafId: "branch-a", tree,
      context: contextFor("branch-a"),
    } }));
    await page.route(`**/api/sessions/${sessionId}/context?*`, (route) => {
      const url = new URL(route.request().url());
      const leafId = url.searchParams.get("leafId") ?? "branch-a";
      return route.fulfill({ json: { context: contextFor(leafId) } });
    });
    await page.route("**/api/sessions", (route) => route.fulfill({ json: { sessions: [{ id: sessionId, path: `${cwd}/session.jsonl`, cwd, projectRoot: cwd, created: "2026-09-28T00:00:00.000Z", modified: "2026-09-28T00:00:00.000Z", messageCount: 2, firstMessage: "Start" }], runningSessionIds: [] } }));
    await page.route("**/api/cwd/validate", (route) => route.fulfill({ json: { success: true, cwd } }));
    await page.route(`**/api/agent/${sessionId}/events`, (route) => route.fulfill({
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      body: `data: ${JSON.stringify({ type: "connected", sessionId })}\n\n`,
    }));
    // Selecting a branch optimistically updates the UI via the /context
    // route above, then fires a "navigate_tree" command at this endpoint;
    // without a mock it 404s, which rolls the optimistic update back. Scope
    // the mock to that specific POST command and fall back to the real
    // handler for anything else this endpoint might receive.
    await page.route(`**/api/agent/${sessionId}`, (route) => {
      const req = route.request();
      if (req.method() !== "POST") return route.fallback();
      let body: { type?: string } = {};
      try {
        body = JSON.parse(req.postData() ?? "{}");
      } catch {
        // leave body as {}
      }
      if (body.type !== "navigate_tree") return route.fallback();
      return route.fulfill({ json: { success: true, data: {} } });
    });

    await page.goto(`/?session=${sessionId}`);
    await expect(page.getByText("Branch A", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Branches" }).click();
    const tree_ = page.getByRole("tree", { name: "Branches" });
    await expect(tree_).toBeVisible();
    const firstRow = tree_.locator("[data-branch-row]").first();
    const lastRow = tree_.locator("[data-branch-row]").last();
    // Selecting a branch does not close the dropdown, so once it's open the
    // tree's own row labels ("Branch A"/"Branch B") coexist with the chat
    // message rendered below — disambiguate by targeting the rendered
    // message's paragraph, not the tree row's label span.
    const chatMessage = (text: string) => page.getByRole("paragraph").filter({ hasText: text });
    await firstRow.focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(chatMessage("Branch B")).toBeVisible();

    // Home/End jump to the first/last row regardless of current focus.
    await page.keyboard.press("Home");
    await expect(firstRow).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(chatMessage("Branch A")).toBeVisible();

    await page.keyboard.press("End");
    await expect(lastRow).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(chatMessage("Branch B")).toBeVisible();
  });
});
