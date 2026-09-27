import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function encodedPathFor(...parts: string[]): string {
  return join(...parts).split("/").map(encodeURIComponent).join("/");
}

test("a file with a NUL byte is reported as binary instead of returning garbage text", async ({ request }, testInfo) => {
  const workspace = mkdtempSync(join(tmpdir(), `pi-web-e2e-binary-${testInfo.project.name}-`));
  writeFileSync(join(workspace, "sample.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]));
  await request.post("/api/cwd/validate", { data: { cwd: workspace } });

  const response = await request.get(`/api/files/${encodedPathFor(workspace, "sample.bin")}?type=read`);
  expect(response.status()).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ binary: true });
});

test("a file over 256KB offers a truncated preview instead of erroring", async ({ request }, testInfo) => {
  const workspace = mkdtempSync(join(tmpdir(), `pi-web-e2e-truncate-${testInfo.project.name}-`));
  writeFileSync(join(workspace, "big.txt"), "a".repeat(300 * 1024));
  await request.post("/api/cwd/validate", { data: { cwd: workspace } });
  const path = encodedPathFor(workspace, "big.txt");

  const rejected = await request.get(`/api/files/${path}?type=read`);
  expect(rejected.status()).toBe(413);
  await expect(rejected.json()).resolves.toMatchObject({ canTruncate: true });

  const truncated = await request.get(`/api/files/${path}?type=read&truncate=1`);
  expect(truncated.status()).toBe(200);
  const body = await truncated.json();
  expect(body.truncated).toBe(true);
  expect(body.content.length).toBe(256 * 1024);
});

test("saving a file succeeds, then is refused with a conflict after an external change", async ({ request }, testInfo) => {
  const workspace = mkdtempSync(join(tmpdir(), `pi-web-e2e-save-${testInfo.project.name}-`));
  writeFileSync(join(workspace, "notes.txt"), "original\n");
  await request.post("/api/cwd/validate", { data: { cwd: workspace } });
  const path = encodedPathFor(workspace, "notes.txt");

  const initial = await request.get(`/api/files/${path}?type=read`);
  const { mtimeMs } = await initial.json();

  const saved = await request.post(`/api/files/${path}?type=write`, { data: { content: "edited\n", mtimeMs } });
  expect(saved.status()).toBe(200);
  expect(readFileSync(join(workspace, "notes.txt"), "utf-8")).toBe("edited\n");

  // A second save, chained off the mtimeMs the first save returned (rather
  // than a fresh read), should succeed: the returned mtimeMs must itself be
  // usable for the next save's conflict check.
  const { mtimeMs: savedMtimeMs } = await saved.json();
  const resaved = await request.post(`/api/files/${path}?type=write`, { data: { content: "edited again\n", mtimeMs: savedMtimeMs } });
  expect(resaved.status()).toBe(200);
  expect(readFileSync(join(workspace, "notes.txt"), "utf-8")).toBe("edited again\n");
  const { mtimeMs: resavedMtimeMs } = await resaved.json();

  // Simulate an external edit landing after the client's last read.
  await new Promise((resolve) => setTimeout(resolve, 20));
  writeFileSync(join(workspace, "notes.txt"), "changed on disk by someone else\n");

  const conflicted = await request.post(`/api/files/${path}?type=write`, { data: { content: "stale edit\n", mtimeMs: resavedMtimeMs } });
  expect(conflicted.status()).toBe(409);
  expect(readFileSync(join(workspace, "notes.txt"), "utf-8")).toBe("changed on disk by someone else\n");
});

test("a non-UTF-8 text file is readable but not editable, and a stale save is refused", async ({ request }, testInfo) => {
  const workspace = mkdtempSync(join(tmpdir(), `pi-web-e2e-gbk-${testInfo.project.name}-`));
  // "你好" in GBK: valid text bytes with no NUL, but not valid UTF-8.
  const gbk = Buffer.from([0x68, 0x69, 0x20, 0xc4, 0xe3, 0xba, 0xc3, 0x0a]);
  writeFileSync(join(workspace, "gbk.txt"), gbk);
  await request.post("/api/cwd/validate", { data: { cwd: workspace } });
  const path = encodedPathFor(workspace, "gbk.txt");

  const read = await request.get(`/api/files/${path}?type=read`);
  expect(read.status()).toBe(200);
  const body = await read.json();
  expect(body).toMatchObject({ editable: false, notEditableReason: "Not UTF-8 text" });
  expect(body.content.startsWith("hi ")).toBe(true);

  const saved = await request.post(`/api/files/${path}?type=write`, { data: { content: body.content, mtimeMs: body.mtimeMs, size: body.size } });
  expect(saved.status()).toBe(400);
  expect(readFileSync(join(workspace, "gbk.txt")).equals(gbk)).toBe(true);

  writeFileSync(join(workspace, "utf8.txt"), "héllo\n");
  const utf8 = await request.get(`/api/files/${encodedPathFor(workspace, "utf8.txt")}?type=read`);
  await expect(utf8.json()).resolves.toMatchObject({ editable: true, content: "héllo\n" });
});

test("clicking Edit on a Markdown file (opened in Preview) shows an editable textarea", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop file-panel test");
  const workspace = mkdtempSync(join(tmpdir(), `pi-web-e2e-md-edit-${testInfo.project.name}-`));
  writeFileSync(join(workspace, "README.md"), "# Title\n\nBody text\n");
  await page.request.post("/api/cwd/validate", { data: { cwd: workspace } });
  await page.route("**/api/sessions", async (route) => route.fulfill({ json: { sessions: [{
    id: "pi-session", path: "/tmp/pi-web-e2e/session.jsonl", cwd: workspace, projectRoot: workspace,
    created: "2026-08-03T00:00:00.000Z", modified: "2026-08-03T00:00:00.000Z", messageCount: 1, firstMessage: "test",
  }], runningSessionIds: [] } }));

  await page.goto("/");
  await expect(page.getByRole("searchbox", { name: "Search Pi sessions" })).toBeVisible();
  await page.getByRole("button", { name: "Show file panel" }).click();
  await page.locator(`[data-file-path="${join(workspace, "README.md")}"]`).click();
  await expect(page.getByRole("button", { name: "Preview" })).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Edit file" }).click();
  const textarea = page.getByRole("textbox", { name: "Edit README.md" });
  await expect(textarea).toBeVisible();
  await expect(textarea).toHaveValue("# Title\n\nBody text\n");
  await textarea.fill("# Title\n\nEdited body\n");
  await expect(textarea).toHaveValue("# Title\n\nEdited body\n");
  // Switching back to Preview is blocked while editing, so the editor can't disappear.
  await expect(page.getByRole("button", { name: "Preview" })).toBeDisabled();

  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => readFileSync(join(workspace, "README.md"), "utf-8")).toBe("# Title\n\nEdited body\n");
});

test("a chat link to the file being edited keeps the unsaved draft", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop file-panel test");
  const workspace = mkdtempSync(join(tmpdir(), `pi-web-e2e-chat-link-${testInfo.project.name}-`));
  const notePath = join(workspace, "note.txt");
  writeFileSync(notePath, "original\n");
  await page.request.post("/api/cwd/validate", { data: { cwd: workspace } });
  const session = {
    id: "link-session", path: "/tmp/pi-web-e2e/link-session.jsonl", cwd: workspace, projectRoot: workspace,
    created: "2026-08-03T00:00:00.000Z", modified: "2026-08-03T00:01:00.000Z", messageCount: 2, firstMessage: "Where is the note?",
  };
  await page.route("**/api/sessions", async (route) => route.fulfill({ json: { sessions: [session], runningSessionIds: [] } }));
  await page.route("**/api/sessions/link-session/state", async (route) => route.fulfill({ json: { running: false } }));
  await page.route("**/api/sessions/link-session?*", async (route) => route.fulfill({ json: {
    sessionId: session.id, filePath: session.path, modified: session.modified, info: session, leafId: "tip", tree: [],
    context: {
      messages: [
        { role: "user", content: "Where is the note?", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: `See [the note](${notePath}).` }], stopReason: "stop", timestamp: 2 },
      ],
      entryIds: ["user", "tip"], thinkingLevel: "medium", model: { provider: "openai-codex", modelId: "gpt-5.6-sol" },
      page: { hasMore: false, beforeEntryId: null, totalMessages: 2 },
    },
  } }));

  await page.goto("/?session=link-session");
  const chatLink = page.getByRole("link", { name: "the note" });
  await expect(chatLink).toBeVisible();
  await page.getByRole("button", { name: "Show file panel" }).click();
  await page.locator(`[data-file-path="${notePath}"]`).click();
  await page.getByRole("button", { name: "Edit file" }).click();
  const textarea = page.getByRole("textbox", { name: "Edit note.txt" });
  await textarea.fill("unsaved draft\n");

  let dialogShown = false;
  page.on("dialog", (dialog) => { dialogShown = true; void dialog.dismiss(); });
  await chatLink.click();

  // Same path: no discard prompt, and the draft survives the tab's new sourceSessionId.
  await expect(textarea).toBeVisible();
  await expect(textarea).toHaveValue("unsaved draft\n");
  expect(dialogShown).toBe(false);
});

test("switching file tabs while editing prompts to discard, and cancelling keeps the draft", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop file-tab test");
  const workspace = mkdtempSync(join(tmpdir(), `pi-web-e2e-dirty-tab-${testInfo.project.name}-`));
  writeFileSync(join(workspace, "a.txt"), "file a\n");
  writeFileSync(join(workspace, "b.txt"), "file b\n");
  await page.request.post("/api/cwd/validate", { data: { cwd: workspace } });
  await page.route("**/api/sessions", async (route) => route.fulfill({ json: { sessions: [{
    id: "pi-session", path: "/tmp/pi-web-e2e/session.jsonl", cwd: workspace, projectRoot: workspace,
    created: "2026-08-03T00:00:00.000Z", modified: "2026-08-03T00:00:00.000Z", messageCount: 1, firstMessage: "test",
  }], runningSessionIds: [] } }));

  await page.goto("/");
  await expect(page.getByRole("searchbox", { name: "Search Pi sessions" })).toBeVisible();
  await page.getByRole("button", { name: "Show file panel" }).click();

  const aRow = page.locator(`[data-file-path="${join(workspace, "a.txt")}"]`);
  const bRow = page.locator(`[data-file-path="${join(workspace, "b.txt")}"]`);
  await expect(aRow).toBeVisible();
  await aRow.click();
  await expect(bRow).toBeVisible();
  await bRow.click();

  // Re-activate a.txt (still not dirty) and start editing it.
  await page.getByRole("tab", { name: "a.txt" }).click();
  await page.getByRole("button", { name: "Edit file" }).click();
  const textarea = page.getByRole("textbox", { name: "Edit a.txt" });
  await expect(textarea).toBeVisible();
  await textarea.fill("file a, edited\n");

  let dialogMessage = "";
  page.once("dialog", (dialog) => {
    dialogMessage = dialog.message();
    void dialog.dismiss();
  });
  await page.getByRole("tab", { name: "b.txt" }).click();
  await expect.poll(() => dialogMessage).toContain("Discard unsaved changes");

  // Cancelling the dialog keeps the user on the dirty tab with the draft intact.
  await expect(page.getByRole("tab", { name: "a.txt" })).toHaveAttribute("aria-selected", "true");
  await expect(textarea).toHaveValue("file a, edited\n");
});

test("deleting a file with unsaved edits from the Explorer closes its tab with a notice", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop file-tab test");
  const workspace = mkdtempSync(join(tmpdir(), `pi-web-e2e-deleted-dirty-${testInfo.project.name}-`));
  writeFileSync(join(workspace, "README.md"), "# readme\n");
  await page.request.post("/api/cwd/validate", { data: { cwd: workspace } });
  await page.route("**/api/sessions", async (route) => route.fulfill({ json: { sessions: [{
    id: "pi-session", path: "/tmp/pi-web-e2e/session.jsonl", cwd: workspace, projectRoot: workspace,
    created: "2026-08-03T00:00:00.000Z", modified: "2026-08-03T00:00:00.000Z", messageCount: 1, firstMessage: "test",
  }], runningSessionIds: [] } }));

  await page.goto("/");
  await expect(page.getByRole("searchbox", { name: "Search Pi sessions" })).toBeVisible();
  await page.getByRole("button", { name: "Show file panel" }).click();

  const row = page.locator(`[data-file-path="${join(workspace, "README.md")}"]`);
  await expect(row).toBeVisible();
  await row.click();
  await page.getByRole("button", { name: "Edit file" }).click();
  const textarea = page.getByRole("textbox", { name: "Edit README.md" });
  await textarea.fill("# readme, edited\n");

  let dialogShown = false;
  page.on("dialog", (dialog) => { dialogShown = true; void dialog.dismiss(); });
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  // Keyboard-activate: with the side panel open, its resize handle overlaps
  // the centred confirm dialog and would intercept a pointer click.
  await page.getByRole("alertdialog", { name: "Confirm deletion" }).getByRole("button", { name: "Delete" }).press("Enter");

  await expect(page.getByTestId("discarded-draft-notice")).toContainText("README.md was deleted. Unsaved changes were discarded.");
  await expect(page.getByRole("tab", { name: "README.md" })).toHaveCount(0);
  expect(dialogShown).toBe(false);
});

test("switching projects while editing prompts to discard, and cancelling keeps the draft and the project", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop project-rail test");
  const projectA = mkdtempSync(join(tmpdir(), `pi-web-e2e-proj-a-${testInfo.project.name}-`));
  const projectB = mkdtempSync(join(tmpdir(), `pi-web-e2e-proj-b-${testInfo.project.name}-`));
  writeFileSync(join(projectA, "note.txt"), "note a\n");
  await page.request.post("/api/cwd/validate", { data: { cwd: projectA } });
  await page.request.post("/api/cwd/validate", { data: { cwd: projectB } });
  // Two sessions in different projects seed two project-rail workspaces (see
  // recoverProjectWorkspaceSnapshot in lib/project-workspaces.ts); project A's
  // later `modified` date makes it the initially active one.
  await page.route("**/api/sessions", async (route) => route.fulfill({ json: { sessions: [
    { id: "session-a", path: "/tmp/pi-web-e2e/session-a.jsonl", cwd: projectA, projectRoot: projectA,
      created: "2026-08-03T00:00:00.000Z", modified: "2026-08-03T00:00:00.000Z", messageCount: 1, firstMessage: "test a" },
    { id: "session-b", path: "/tmp/pi-web-e2e/session-b.jsonl", cwd: projectB, projectRoot: projectB,
      created: "2026-08-02T00:00:00.000Z", modified: "2026-08-02T00:00:00.000Z", messageCount: 1, firstMessage: "test b" },
  ], runningSessionIds: [] } }));

  await page.goto("/");
  await expect(page.getByRole("searchbox", { name: "Search Pi sessions" })).toBeVisible();
  const projectRail = page.getByRole("navigation", { name: "Project workspaces" });
  const projectAButton = projectRail.locator(".project-rail-select").filter({ hasText: "proj-a" });
  const projectBButton = projectRail.locator(".project-rail-select").filter({ hasText: "proj-b" });
  await expect(projectAButton).toHaveAttribute("aria-current", "page");

  await page.getByRole("button", { name: "Show file panel" }).click();
  const noteRow = page.locator(`[data-file-path="${join(projectA, "note.txt")}"]`);
  await expect(noteRow).toBeVisible();
  await noteRow.click();
  await page.getByRole("button", { name: "Edit file" }).click();
  const textarea = page.getByRole("textbox", { name: "Edit note.txt" });
  await expect(textarea).toBeVisible();
  await textarea.fill("edited in project a\n");

  let dialogMessage = "";
  page.once("dialog", (dialog) => {
    dialogMessage = dialog.message();
    void dialog.dismiss();
  });
  await projectBButton.click();
  await expect.poll(() => dialogMessage).toContain("Discard unsaved changes");

  // Cancelling the dialog keeps project A active with the draft intact.
  await expect(projectAButton).toHaveAttribute("aria-current", "page");
  await expect(textarea).toHaveValue("edited in project a\n");
});

test("selecting a different project's session via Quick Switcher prompts to discard, and cancelling keeps the draft", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop Quick Switcher test");
  const projectA = mkdtempSync(join(tmpdir(), `pi-web-e2e-qs-proj-a-${testInfo.project.name}-`));
  writeFileSync(join(projectA, "note.txt"), "note a\n");
  await page.request.post("/api/cwd/validate", { data: { cwd: projectA } });
  // session-b shares project A's cwd (so Quick Switcher's activeCwd-scoped
  // session search surfaces it) but declares a *different* projectRoot — the
  // same shape as a session sidebar entry sharing a worktree whose backend-
  // resolved project root disagrees with the currently active one. Selecting
  // it is still a cross-project switch and must be guarded.
  await page.route("**/api/sessions", async (route) => route.fulfill({ json: { sessions: [
    { id: "session-a", path: "/tmp/pi-web-e2e/session-a.jsonl", cwd: projectA, projectRoot: projectA,
      created: "2026-08-03T00:00:00.000Z", modified: "2026-08-03T00:00:00.000Z", messageCount: 1, firstMessage: "test a" },
    { id: "session-b", path: "/tmp/pi-web-e2e/session-b.jsonl", cwd: projectA, projectRoot: "/tmp/pi-web-e2e-qs-proj-b",
      created: "2026-08-02T00:00:00.000Z", modified: "2026-08-02T00:00:00.000Z", messageCount: 1, firstMessage: "other project session" },
  ], runningSessionIds: [] } }));

  await page.goto("/");
  await expect(page.getByRole("searchbox", { name: "Search Pi sessions" })).toBeVisible();

  await page.getByRole("button", { name: "Show file panel" }).click();
  const noteRow = page.locator(`[data-file-path="${join(projectA, "note.txt")}"]`);
  await expect(noteRow).toBeVisible();
  await noteRow.click();
  await page.getByRole("button", { name: "Edit file" }).click();
  const textarea = page.getByRole("textbox", { name: "Edit note.txt" });
  await expect(textarea).toBeVisible();
  await textarea.fill("edited in project a\n");

  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "Quick switcher" })).toBeVisible();
  await page.getByRole("textbox", { name: "Quick switcher search" }).fill("other project session");
  const sessionOption = page.getByRole("option").filter({ hasText: "other project session" });
  await expect(sessionOption).toBeVisible();

  let dialogMessage = "";
  page.once("dialog", (dialog) => {
    dialogMessage = dialog.message();
    void dialog.dismiss();
  });
  await sessionOption.click();
  await expect.poll(() => dialogMessage).toContain("Discard unsaved changes");

  // Cancelling the dialog keeps the draft (and project A / session A) intact.
  await expect(textarea).toHaveValue("edited in project a\n");
});

for (const pushed of [false, true]) test(`Amend recommits with a new message and no staged changes required${pushed ? " (warns when HEAD is already pushed)" : ""}`, async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop Git Review test");
  const repo = "/tmp/pi-web-e2e/service-a";
  const commitRequests: Array<Record<string, unknown>> = [];
  await page.route("**/api/sessions", async (route) => route.fulfill({ json: { sessions: [{
    id: "pi-session", path: "/tmp/pi-web-e2e/session.jsonl", cwd: "/tmp/pi-web-e2e", projectRoot: "/tmp/pi-web-e2e",
    created: "2026-08-03T00:00:00.000Z", modified: "2026-08-03T00:00:00.000Z", messageCount: 1, firstMessage: "test",
  }], runningSessionIds: [] } }));
  await page.route("**/api/files/**", async (route) => route.fulfill({ json: { entries: [] } }));
  await page.route("**/api/cwd/validate", async (route) => route.fulfill({ json: { success: true, cwd: "/tmp/pi-web-e2e" } }));
  await page.route("**/api/git/repositories?*", async (route) => route.fulfill({ json: { repositories: [
    { path: repo, repositoryRoot: repo, label: "service-a", relativePath: "service-a" },
  ] } }));
  await page.route("**/api/git/status?*", async (route) => route.fulfill({ json: { isGitRepository: true, repositoryRoot: repo, branch: "main", remotes: [], files: [] } }));
  await page.route("**/api/git/log?*", async (route) => route.fulfill({ json: { isGitRepository: true, hasMore: false, commits: [
    { hash: "abc1234def", shortHash: "abc1234", author: "Test", date: "2026-08-03T00:00:00.000Z", parents: [], refs: [], subject: "feat: the previous commit" },
  ], ...(new URL(route.request().url()).searchParams.get("headPushed") === "1" ? { headPushed: pushed } : {}) } }));
  await page.route("**/api/git/commit", async (route) => {
    commitRequests.push(route.request().postDataJSON());
    return route.fulfill({ json: { isGitRepository: true, repositoryRoot: repo, branch: "main", remotes: [], files: [] } });
  });

  await page.goto("/");
  await expect(page.getByRole("searchbox", { name: "Search Pi sessions" })).toBeVisible();
  await page.getByRole("button", { name: "Show file panel" }).click();
  await page.getByRole("button", { name: "Open Git Review" }).click();
  await page.getByRole("checkbox", { name: "Amend previous commit" }).check();
  await expect(page.getByTestId("amend-target")).toHaveText(/abc1234.*feat: the previous commit/);
  const warning = page.getByTestId("amend-pushed-warning");
  if (pushed) await expect(warning).toHaveText("This commit is already pushed. Amending rewrites history and will need a force push.");
  else await expect(warning).toHaveCount(0);
  await page.getByPlaceholder("Commit message (⌘/Ctrl+Enter)").fill("fix: correct typo from the previous commit");
  await expect(page.getByRole("button", { name: "Amend" })).toBeEnabled();
  await page.getByRole("button", { name: "Amend" }).click();
  await expect.poll(() => commitRequests).toEqual([{ cwd: repo, message: "fix: correct typo from the previous commit", amend: true }]);
});

test("reverting a commit from History creates a clean revert commit", async ({ request }, testInfo) => {
  const repo = mkdtempSync(join(tmpdir(), `pi-web-e2e-revert-${testInfo.project.name}-`));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  writeFileSync(join(repo, "a.txt"), "v1\n");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "add a.txt"]);
  writeFileSync(join(repo, "a.txt"), "v2\n");
  execFileSync("git", ["-C", repo, "commit", "-q", "-am", "update a.txt"]);
  const hash = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  await request.post("/api/cwd/validate", { data: { cwd: repo } });
  const response = await request.post("/api/git/revert", { data: { cwd: repo, hash } });
  expect(response.status()).toBe(200);
  expect(readFileSync(join(repo, "a.txt"), "utf-8")).toBe("v1\n");
});

test("content search finds matches via the file-index API in a real Git repo", async ({ request }, testInfo) => {
  const repo = mkdtempSync(join(tmpdir(), `pi-web-e2e-content-search-${testInfo.project.name}-`));
  mkdirSync(join(repo, "src"), { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, "src", "widget.ts"), "export function renderWidget() {\n  return findTheNeedleHere();\n}\n");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "init"]);
  await request.post("/api/cwd/validate", { data: { cwd: repo } });

  const search = await request.get(`/api/file-index?${new URLSearchParams({ cwd: repo, contentQuery: "findTheNeedleHere" })}`);
  expect(search.status()).toBe(200);
  await expect(search.json()).resolves.toMatchObject({
    matches: [expect.objectContaining({ path: "src/widget.ts", line: 2 })],
  });
});

test("the commit message draft is saved per repository in localStorage and restored", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop Git Review test");
  const repo = "/tmp/pi-web-e2e/service-a";
  const draftKey = `pi-web:git-commit-draft:${encodeURIComponent(repo)}`;
  await page.route("**/api/sessions", async (route) => route.fulfill({ json: { sessions: [{
    id: "pi-session", path: "/tmp/pi-web-e2e/session.jsonl", cwd: "/tmp/pi-web-e2e", projectRoot: "/tmp/pi-web-e2e",
    created: "2026-08-03T00:00:00.000Z", modified: "2026-08-03T00:00:00.000Z", messageCount: 1, firstMessage: "test",
  }], runningSessionIds: [] } }));
  await page.route("**/api/files/**", async (route) => route.fulfill({ json: { entries: [] } }));
  await page.route("**/api/cwd/validate", async (route) => route.fulfill({ json: { success: true, cwd: "/tmp/pi-web-e2e" } }));
  await page.route("**/api/git/repositories?*", async (route) => route.fulfill({ json: { repositories: [
    { path: repo, repositoryRoot: repo, label: "service-a", relativePath: "service-a" },
  ] } }));
  await page.route("**/api/git/status?*", async (route) => route.fulfill({ json: { isGitRepository: true, repositoryRoot: repo, branch: "main", remotes: [], files: [] } }));

  await page.goto("/");
  await page.getByRole("button", { name: "Show file panel" }).click();
  await page.getByRole("button", { name: "Open Git Review" }).click();
  const commitBox = page.getByPlaceholder("Commit message (⌘/Ctrl+Enter)");
  await commitBox.fill("wip: draft message survives a reload");
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), draftKey)).toBe("wip: draft message survives a reload");

  await page.reload();
  // The workspace already remembers the right panel's open state and active
  // tab per project (see docs/prd/workspace-explorer.md), so after a reload
  // the panel may reopen straight to Git Review on its own. Only drive the
  // panel open if it didn't restore itself.
  const reloadedCommitBox = page.getByPlaceholder("Commit message (⌘/Ctrl+Enter)");
  const showPanelButton = page.getByRole("button", { name: "Show file panel" });
  await Promise.race([
    reloadedCommitBox.waitFor({ state: "visible" }),
    showPanelButton.waitFor({ state: "visible" }),
  ]);
  if (await showPanelButton.isVisible()) {
    await showPanelButton.click();
    await page.getByRole("button", { name: "Open Git Review" }).click();
  }
  await expect(reloadedCommitBox).toHaveValue("wip: draft message survives a reload");
});

test("pull only blocks when Git itself would overwrite a file, not on unrelated local edits", async ({ request }, testInfo) => {
  const origin = mkdtempSync(join(tmpdir(), `pi-web-e2e-pull-origin-${testInfo.project.name}-`));
  execFileSync("git", ["init", "-q", "-b", "main", origin]);
  execFileSync("git", ["-C", origin, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", origin, "config", "user.name", "Test"]);
  writeFileSync(join(origin, "tracked.txt"), "v1\n");
  execFileSync("git", ["-C", origin, "add", "."]);
  execFileSync("git", ["-C", origin, "commit", "-q", "-m", "init"]);

  const clone = mkdtempSync(join(tmpdir(), `pi-web-e2e-pull-clone-${testInfo.project.name}-`));
  execFileSync("git", ["clone", "-q", origin, clone]);
  execFileSync("git", ["-C", clone, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", clone, "config", "user.name", "Test"]);

  writeFileSync(join(origin, "other.txt"), "from origin\n");
  execFileSync("git", ["-C", origin, "add", "other.txt"]);
  execFileSync("git", ["-C", origin, "commit", "-q", "-m", "add other.txt"]);
  // A local edit to a file pull never touches — the old code blocked pull here regardless.
  writeFileSync(join(clone, "tracked.txt"), "locally edited, unrelated\n");

  await request.post("/api/cwd/validate", { data: { cwd: clone } });
  const response = await request.post("/api/git/sync", { data: { cwd: clone, action: "pull" } });
  expect(response.status()).toBe(200);
  expect(readFileSync(join(clone, "other.txt"), "utf-8")).toBe("from origin\n");
  expect(readFileSync(join(clone, "tracked.txt"), "utf-8")).toBe("locally edited, unrelated\n");
});
