# P0 Reliability Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix eight user-facing problems where TianForge loses data, destroys work, or fails without telling the user.

**Architecture:** Each fix is local to the module that owns the behavior. Pure decision logic goes into small `lib/*.ts` helpers so `node --test` can cover it. UI behavior that needs a browser is covered by one new Playwright file, `e2e/reliability.spec.ts`, which mocks the API the same way `e2e/app-shell.spec.ts` does.

**Tech Stack:** Next.js 16 route handlers, React 19, the custom Node server (`server/pi-web-server.js`), `node --test` (TS loaded through `jiti` or Node type stripping), Playwright.

**Spec:** There is no separate spec document. The eight problems come from the product audit done in conversation on 2026-09-26. The **Problem** line in each task is the requirement.

## Global Constraints

- No new dependencies.
- UI copy is English, matching the rest of the app. PRD edits (`docs/prd/*.md`) are Chinese, matching those files.
- Follow AGENTS.md rule: when feature behavior changes, update the matching PRD in the same commit.
- Every task ends green on `npx tsc --noEmit -p .`, `npx eslint <touched files>`, and `npm test`. Tasks that touch UI also run `npx playwright test e2e/reliability.spec.ts`.
- Work on branch `fix/p0-reliability` (create it from `main` before Task 1: `git switch -c fix/p0-reliability`).

## Facts the implementer needs

- `npm test` only picks up `server/agents/*.test.cjs`, `lib/*.test.mjs`, `lib/workspace/*.test.mjs` and `components/*.test.mjs`. Put new unit tests in `lib/`.
- Tests that import TS with `@/` aliases use `createJiti(import.meta.url, { tsconfigPaths: true })`. Plain relative imports of `.ts` also work through jiti.
- The e2e server runs on `http://127.0.0.1:30142` with no password, so every page is authenticated. Mock APIs with `page.route`. The running-session mock pattern is at `e2e/app-shell.spec.ts:111-160`.
- The global Esc handler (`hooks/useKeyboardShortcuts.ts`) listens on `window`. Dialogs listen on `document`. Both fire for the same keypress.
- All `/api/*` requests without a valid session get `401 {"error":"authentication required"}` from `server/pi-web-server.js:260`. `GET /api/auth/session` returns `{ authenticated, passwordRequired }` and never returns 401.
- `lib/git-changes.ts` calls git through a local `git(cwd, args, maxBuffer)`, and `args[0]` is always the git subcommand.

---

### Task 1: Esc in a dialog must not stop the running agent

**Problem:** A running agent gets stopped when the user presses Esc to close Settings (or any modal) while focus is on a button. `SettingsPanel` closes on Esc, and the global handler also calls the abort handler, because it only skips `TEXTAREA`/`INPUT` targets.

**Files:**
- Create: `lib/escape-abort.ts`
- Create: `lib/escape-abort.test.mjs`
- Modify: `hooks/useKeyboardShortcuts.ts:47-57`
- Create: `e2e/reliability.spec.ts`

**Interfaces:**
- Produces: `shouldAbortOnEscape(input: { targetTag: string | undefined; defaultPrevented: boolean; modalOpen: boolean }): boolean`
- Produces (e2e helper, reused by Tasks 6 and 8): `mockRunningSession(page): Promise<{ agentPosts: Array<Record<string, unknown>> }>` in `e2e/reliability.spec.ts`

- [ ] **Step 1: Write the failing unit test** — `lib/escape-abort.test.mjs`

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { shouldAbortOnEscape } = await jiti.import("./escape-abort.ts");

const base = { targetTag: "BODY", defaultPrevented: false, modalOpen: false };

test("Esc on the page stops the agent", () => {
  assert.equal(shouldAbortOnEscape(base), true);
  assert.equal(shouldAbortOnEscape({ ...base, targetTag: "BUTTON" }), true);
});

test("text fields handle their own Esc", () => {
  assert.equal(shouldAbortOnEscape({ ...base, targetTag: "TEXTAREA" }), false);
  assert.equal(shouldAbortOnEscape({ ...base, targetTag: "INPUT" }), false);
});

test("Esc that closes a modal or was already handled does not stop the agent", () => {
  assert.equal(shouldAbortOnEscape({ ...base, targetTag: "BUTTON", modalOpen: true }), false);
  assert.equal(shouldAbortOnEscape({ ...base, defaultPrevented: true }), false);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --require ./server/test-env.cjs --test lib/escape-abort.test.mjs`
Expected: FAIL. Cannot find module `./escape-abort.ts`.

- [ ] **Step 3: Implement** — `lib/escape-abort.ts`

```ts
/**
 * Whether a window-level Esc should stop the running agent. Esc belongs to
 * whatever is on top: text fields (ChatInput menus), open modals (Settings,
 * dialogs), and handlers that already called preventDefault.
 */
export function shouldAbortOnEscape(input: { targetTag: string | undefined; defaultPrevented: boolean; modalOpen: boolean }): boolean {
  if (input.defaultPrevented || input.modalOpen) return false;
  return input.targetTag !== "TEXTAREA" && input.targetTag !== "INPUT";
}
```

- [ ] **Step 4: Use it in the hook.** In `hooks/useKeyboardShortcuts.ts`, add `import { shouldAbortOnEscape } from "@/lib/escape-abort";`, then replace the Esc branch body with:

```ts
      // ---- Esc: stop agent ----
      if (e.key === "Escape") {
        if (!globalAbortHandler) return;
        // Text fields handle Esc themselves (ChatInput menus / stop); an open
        // modal (every dialog sets aria-modal) owns Esc to close itself.
        if (!shouldAbortOnEscape({
          targetTag: (e.target as HTMLElement | null)?.tagName,
          defaultPrevented: e.defaultPrevented,
          modalOpen: document.querySelector('[aria-modal="true"]') !== null,
        })) return;

        e.preventDefault();
        globalAbortHandler();
        return;
      }
```

Also update the doc comment above `useGlobalKeyboardShortcuts` so it says Esc is skipped while a modal is open.

- [ ] **Step 5: Run the unit test and confirm it passes**

Run: `node --require ./server/test-env.cjs --test lib/escape-abort.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 6: Write the e2e test.** Create `e2e/reliability.spec.ts` with the shared helper and the first test:

```ts
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
```

- [ ] **Step 7: Run e2e and confirm it passes**

Run: `npx playwright test e2e/reliability.spec.ts --project=chromium`
Expected: PASS. To confirm the test catches the bug, temporarily revert Step 4 (`git stash push hooks/useKeyboardShortcuts.ts`), re-run and see FAIL with one `abort` post, then `git stash pop`.

- [ ] **Step 8: Checks and commit**

Run: `npx tsc --noEmit -p . && npx eslint lib/escape-abort.ts hooks/useKeyboardShortcuts.ts e2e/reliability.spec.ts && npm test`

```bash
git add lib/escape-abort.ts lib/escape-abort.test.mjs hooks/useKeyboardShortcuts.ts e2e/reliability.spec.ts
git commit -m "fix: Esc that closes a dialog no longer stops the running agent"
```

---

### Task 2: A failed models.json load must not become an empty config that Save writes back

**Problem:** `ModelsConfig` ignores `res.ok` and turns any load failure into `{ providers: {} }`. Clicking Save then overwrites models.json with an empty config. On the server, `readModelsJson()` also returns `{ providers: {} }` for a file that isn't valid JSON, so GET shows nothing and PUT replaces the broken file.

**Files:**
- Modify: `lib/models-config-file.ts`
- Create: `lib/models-config-file.test.mjs`
- Modify: `app/api/models-config/route.ts` (GET)
- Modify: `components/ModelsConfig.tsx:1296-1335` (state and load), `:1409-1427` (save), `:1628-1645` (detail area and footer)
- Modify: `e2e/reliability.spec.ts`

**Interfaces:**
- Produces: `readModelsJson()` throws `Error("<path> is not valid JSON (...)")` when the file exists but can't be parsed. A missing file still returns `{ providers: {} }`.

- [ ] **Step 1: Write the failing unit test** — `lib/models-config-file.test.mjs`

```js
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-models-file-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.once("exit", () => fs.rmSync(agentDir, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { readModelsJson, getModelsPath } = await jiti.import("./models-config-file.ts");

test("a missing models.json reads as an empty config", () => {
  fs.rmSync(getModelsPath(), { force: true });
  assert.deepEqual(readModelsJson(), { providers: {} });
});

test("a valid models.json is returned as parsed", () => {
  fs.writeFileSync(getModelsPath(), JSON.stringify({ providers: { local: { api: "openai-completions" } } }));
  assert.deepEqual(readModelsJson(), { providers: { local: { api: "openai-completions" } } });
});

test("an unparseable models.json is an error, not an empty config", () => {
  fs.writeFileSync(getModelsPath(), "{ \"providers\": ");
  assert.throws(() => readModelsJson(), /models\.json is not valid JSON/);
  assert.equal(fs.readFileSync(getModelsPath(), "utf8"), "{ \"providers\": ");
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --require ./server/test-env.cjs --test lib/models-config-file.test.mjs`
Expected: the third test FAILS (no throw).

- [ ] **Step 3: Implement.** Replace `readModelsJson` in `lib/models-config-file.ts`:

```ts
export function readModelsJson(): Record<string, unknown> {
  const path = getModelsPath();
  if (!existsSync(path)) return { providers: {} };
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    // Never treat a broken file as empty: the settings UI would show no
    // providers and its next Save would overwrite the user's file.
    throw new Error(`${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}). Fix or remove it, then reload.`);
  }
}
```

In `app/api/models-config/route.ts`, wrap GET so the error reaches the client as JSON:

```ts
export async function GET() {
  try {
    return NextResponse.json(redactModelsConfig(readModelsJson()), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
```

PUT already catches errors (`restoreModelsConfigSecrets(..., readModelsJson())` sits inside its `try`), so it now refuses to overwrite a broken file. `app/api/models-config/test/route.ts:46` also runs inside that handler's `try` (opened at line 33), so nothing changes there.

- [ ] **Step 4: Run the unit test and confirm it passes**

Run: `node --require ./server/test-env.cjs --test lib/models-config-file.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Client load and save.** In `components/ModelsConfig.tsx`:

Add state next to `saveError`:

```ts
  const [loadError, setLoadError] = useState<string | null>(null);
```

Replace the load `useEffect` (the one that fetches `/api/models-config`) with:

```ts
  const loadConfig = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    fetch("/api/models-config")
      .then(async (r) => {
        const d = await r.json().catch(() => ({})) as ModelsJson & { error?: string };
        if (!r.ok || d.error) throw new Error(d.error ?? `Could not load models.json (HTTP ${r.status})`);
        return d;
      })
      .then((d) => {
        const normalized = d.providers ? d : { ...d, providers: {} };
        setConfig(normalized);
        const keys = Object.keys(normalized.providers ?? {});
        if (keys.length > 0) setSelection({ type: "provider", name: keys[0] });
      })
      // Keep whatever was shown before; Save stays disabled until a load succeeds.
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadConfig();
    loadOAuthProviders();
    loadApiKeyProviders();
  }, [loadConfig, loadOAuthProviders, loadApiKeyProviders]);
```

At the top of `handleSave`, before `setSaving(true)`, add `if (loadError) return;` and add `loadError` to its dependency array.

In the right detail area, change `{loading ? null : detailContent ?? (` to show the error first:

```tsx
            {loadError ? (
              <div role="alert" style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13, color: "var(--text)" }}>
                <strong style={{ color: "#f87171" }}>Could not load your model configuration</strong>
                <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "var(--text-muted)" }}>{loadError}</span>
                <span style={{ color: "var(--text-muted)" }}>Saving is disabled so your existing models.json is not overwritten.</span>
                <button type="button" onClick={loadConfig} style={{ alignSelf: "flex-start", padding: "6px 14px", background: "none", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", cursor: "pointer", fontSize: 13 }}>Retry</button>
              </div>
            ) : loading ? null : detailContent ?? (
```

On the Save button, change `disabled={saving || savedOk}` to `disabled={saving || savedOk || loading || loadError !== null}`. Apply the same condition to the button's `cursor` expression.

- [ ] **Step 6: e2e test.** Append to `e2e/reliability.spec.ts`:

```ts
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
```

- [ ] **Step 7: Run e2e**

Run: `npx playwright test e2e/reliability.spec.ts --project=chromium`
Expected: PASS (2 tests).

- [ ] **Step 8: Checks and commit**

Run: `npx tsc --noEmit -p . && npx eslint lib/models-config-file.ts app/api/models-config/route.ts components/ModelsConfig.tsx e2e/reliability.spec.ts && npm test`

```bash
git add lib/models-config-file.ts lib/models-config-file.test.mjs app/api/models-config/route.ts components/ModelsConfig.tsx e2e/reliability.spec.ts
git commit -m "fix: never save an empty model config after models.json fails to load"
```

---

### Task 3: Git commit, push, fetch, pull and switch get a 5-minute timeout

**Problem:** Every git command has a 10 s timeout. Commits with pre-commit hooks (husky/lint-staged), and push/fetch/pull on slow networks, get killed mid-run and show a bare "Command failed".

**Files:**
- Modify: `lib/git-exec.ts`
- Create: `lib/git-exec.test.mjs`
- Modify: `lib/git-changes.ts:28-42` (remove the local `GIT_TIMEOUT_MS`, update `git()`)

**Interfaces:**
- Produces: `GIT_TIMEOUT_MS = 10_000`, `GIT_LONG_TIMEOUT_MS = 300_000`, `gitCommandTimeout(args: string[]): number`, `gitFailureMessage(error: unknown, args: string[], timeout: number): string` from `lib/git-exec.ts`.

- [ ] **Step 1: Write the failing test** — `lib/git-exec.test.mjs`

```js
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { GIT_TIMEOUT_MS, GIT_LONG_TIMEOUT_MS, gitCommandTimeout, gitFailureMessage, runGit } = await jiti.import("./git-exec.ts");

test("commands that run hooks or use the network get the long timeout", () => {
  for (const command of ["commit", "push", "fetch", "pull", "switch"]) {
    assert.equal(gitCommandTimeout([command, "--quiet"]), GIT_LONG_TIMEOUT_MS, command);
  }
  for (const command of ["status", "diff", "log", "add", "restore", "stash"]) {
    assert.equal(gitCommandTimeout([command]), GIT_TIMEOUT_MS, command);
  }
});

test("failure messages prefer git's stderr", () => {
  const error = Object.assign(new Error("Command failed: git push"), { stderr: "fatal: could not read from remote\n" });
  assert.equal(gitFailureMessage(error, ["push"], GIT_LONG_TIMEOUT_MS), "fatal: could not read from remote");
  assert.equal(gitFailureMessage(new Error("spawn git ENOENT"), ["status"], GIT_TIMEOUT_MS), "spawn git ENOENT");
});

test("a killed git command reports which command timed out and after how long", async (t) => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-git-timeout-")));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  const hook = path.join(repo, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hook, "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  execFileSync("git", ["add", "a.txt"], { cwd: repo });

  const args = ["commit", "-m", "slow hook"];
  const error = await runGit(args, { cwd: repo, timeout: 300 }).then(() => null, (caught) => caught);
  assert.ok(error, "the commit was stopped");
  assert.equal(gitFailureMessage(error, args, 300), "git commit did not finish within 0.3 s and was stopped");
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --require ./server/test-env.cjs --test lib/git-exec.test.mjs`
Expected: FAIL. `gitCommandTimeout` is not a function.

- [ ] **Step 3: Implement.** Append to `lib/git-exec.ts`:

```ts
export const GIT_TIMEOUT_MS = 10_000;
/** Hooks (husky, lint-staged, LFS) and the network can legitimately take minutes. */
export const GIT_LONG_TIMEOUT_MS = 5 * 60_000;
const LONG_RUNNING_COMMANDS = new Set(["commit", "push", "fetch", "pull", "switch"]);

/** Timeout for `git <args>`; `args[0]` is the subcommand. */
export function gitCommandTimeout(args: string[]): number {
  return LONG_RUNNING_COMMANDS.has(args[0]) ? GIT_LONG_TIMEOUT_MS : GIT_TIMEOUT_MS;
}

/** A message the Git panel can show: timeouts name the command, other failures use git's stderr. */
export function gitFailureMessage(error: unknown, args: string[], timeout: number): string {
  if (typeof error === "object" && error !== null && "killed" in error && error.killed) {
    return `git ${args[0]} did not finish within ${timeout / 1000} s and was stopped`;
  }
  const detail = typeof error === "object" && error !== null && "stderr" in error
    ? String(error.stderr).trim()
    : "";
  return detail || (error instanceof Error ? error.message : String(error));
}
```

In `lib/git-changes.ts`, delete `const GIT_TIMEOUT_MS = 10_000;` and replace `git()`:

```ts
async function git(cwd: string, args: string[], maxBuffer = GIT_STATUS_MAX_BUFFER): Promise<string> {
  const timeout = gitCommandTimeout(args);
  try {
    return await runGit(args, { cwd, timeout, maxBuffer });
  } catch (error) {
    throw new Error(gitFailureMessage(error, args, timeout));
  }
}
```

Add `gitCommandTimeout` and `gitFailureMessage` to the existing `./git-exec` import. Run `grep -n GIT_TIMEOUT_MS lib/git-changes.ts`. If anything else still uses it, import `GIT_TIMEOUT_MS` from `./git-exec` rather than redefining it.

- [ ] **Step 4: Run tests and confirm they pass**

Run: `node --require ./server/test-env.cjs --test lib/git-exec.test.mjs lib/git-changes.test.mjs lib/git-line-staging.test.mjs`
Expected: PASS.

- [ ] **Step 5: Docs.** In `docs/prd/git-review.md`, add to 已实现范围: `commit、push、fetch、pull、切换分支最长等待 5 分钟（其他 Git 命令 10 秒），超时提示会说明是哪条命令、等了多久。` In AGENTS.md, add one sentence to the Git notes: timeouts come from `gitCommandTimeout` in `lib/git-exec.ts`.

- [ ] **Step 6: Checks and commit**

Run: `npx tsc --noEmit -p . && npx eslint lib/git-exec.ts lib/git-changes.ts && npm test`

```bash
git add lib/git-exec.ts lib/git-exec.test.mjs lib/git-changes.ts docs/prd/git-review.md AGENTS.md
git commit -m "fix: give git commit, push, fetch, pull and switch a 5-minute timeout"
```

---

### Task 4: Discard saves changes as a stash instead of deleting them

**Problem:** Discarding untracked files calls `fs.rmSync`, so they are gone for good. Discarding tracked files is also unrecoverable. The confirm dialog only says "Discard changes to N files?", and one click on a group's ⨯ can wipe new source files or `.env`.

**Files:**
- Create: `lib/git-discard.ts` (browser-safe: no Node imports)
- Create: `lib/git-discard.test.mjs`
- Modify: `lib/git-changes.ts:612-639` (`discardChanges`)
- Modify: `components/GitReviewPanel.tsx:307-313` (`discard`), `:487`, `:506` (callers and titles)
- Modify: `docs/prd/git-review.md`

**Interfaces:**
- Produces: `DISCARD_STASH_MESSAGE = "TianForge: discarded changes"` and `discardConfirmMessage(files: Pick<GitFileStatus, "status">[]): string` from `lib/git-discard.ts`.
- `discardChanges(cwd, paths)` keeps its signature. Non-conflicted paths go into one `git stash push --include-untracked` entry. Conflicted paths are restored to HEAD, as before. In a repository with no commits it throws `"Discard needs at least one commit…"` and touches nothing.

- [ ] **Step 1: Write the failing test** — `lib/git-discard.test.mjs`

```js
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { discardChanges } = await jiti.import("./git-changes.ts");
const { DISCARD_STASH_MESSAGE, discardConfirmMessage } = await jiti.import("./git-discard.ts");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepo(t, { commit = true } = {}) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-discard-")));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  if (commit) {
    fs.writeFileSync(path.join(repo, "tracked.txt"), "original\n");
    fs.writeFileSync(path.join(repo, "other.txt"), "other\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "init"]);
  }
  return repo;
}

test("discarded tracked and new files are saved in one stash and can be restored", async (t) => {
  const repo = makeRepo(t);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "edited\n");
  fs.writeFileSync(path.join(repo, "new.txt"), "brand new\n");
  fs.writeFileSync(path.join(repo, "a[1].txt"), "glob-looking name\n");
  fs.writeFileSync(path.join(repo, "other.txt"), "keep this edit\n");

  const status = await discardChanges(repo, ["tracked.txt", "new.txt", "a[1].txt"].map((name) => path.join(repo, name)));

  assert.deepEqual(status.files.map((file) => file.filePath).sort(), [path.join(repo, "other.txt")]);
  assert.equal(fs.readFileSync(path.join(repo, "tracked.txt"), "utf8"), "original\n");
  assert.equal(fs.existsSync(path.join(repo, "new.txt")), false);
  assert.equal(fs.readFileSync(path.join(repo, "other.txt"), "utf8"), "keep this edit\n");
  assert.match(git(repo, ["stash", "list"]), new RegExp(DISCARD_STASH_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  git(repo, ["stash", "pop", "-q"]);
  assert.equal(fs.readFileSync(path.join(repo, "tracked.txt"), "utf8"), "edited\n");
  assert.equal(fs.readFileSync(path.join(repo, "new.txt"), "utf8"), "brand new\n");
  assert.equal(fs.readFileSync(path.join(repo, "a[1].txt"), "utf8"), "glob-looking name\n");
});

test("discard before the first commit refuses and deletes nothing", async (t) => {
  const repo = makeRepo(t, { commit: false });
  fs.writeFileSync(path.join(repo, "draft.txt"), "unsaved work\n");
  await assert.rejects(discardChanges(repo, [path.join(repo, "draft.txt")]), /at least one commit/);
  assert.equal(fs.readFileSync(path.join(repo, "draft.txt"), "utf8"), "unsaved work\n");
});

test("the confirmation says where discarded changes go", () => {
  assert.match(discardConfirmMessage([{ status: "untracked" }]), /^Discard this file\?/);
  assert.match(discardConfirmMessage([{ status: "modified" }, { status: "untracked" }]), /^Discard changes to 2 files\?/);
  assert.match(discardConfirmMessage([{ status: "modified" }]), /saved as a Git stash/);
  assert.match(discardConfirmMessage([{ status: "conflict" }, { status: "modified" }]), /1 conflicted file is reset to HEAD and cannot be restored/);
  assert.doesNotMatch(discardConfirmMessage([{ status: "conflict" }]), /saved as a Git stash/);
});
```

Note: `status.files[].filePath` is absolute, as `lib/git-line-staging.test.mjs` shows. If `getGitStatus` returns repo-relative paths, compare against `"other.txt"` instead. Check once in Step 2.

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --require ./server/test-env.cjs --test lib/git-discard.test.mjs`
Expected: FAIL. Cannot find `./git-discard.ts`.

- [ ] **Step 3: Implement `lib/git-discard.ts`**

```ts
import type { GitFileStatus } from "./git-types";

/** Stash message for changes discarded from the Git panel; restore them from the stash list. */
export const DISCARD_STASH_MESSAGE = "TianForge: discarded changes";

export function discardConfirmMessage(files: Pick<GitFileStatus, "status">[]): string {
  const conflicts = files.filter((file) => file.status === "conflict").length;
  const saved = files.length - conflicts;
  const head = files.length === 1
    ? (files[0].status === "untracked" ? "Discard this file?" : "Discard changes to this file?")
    : `Discard changes to ${files.length} files?`;
  const lines = [head];
  if (saved > 0) lines.push(`The changes are saved as a Git stash ("${DISCARD_STASH_MESSAGE}"), so you can restore them from the stash list.`);
  if (conflicts > 0) lines.push(`${conflicts} conflicted file${conflicts === 1 ? " is" : "s are"} reset to HEAD and cannot be restored.`);
  return lines.join("\n\n");
}
```

- [ ] **Step 4: Replace `discardChanges` in `lib/git-changes.ts`** and add `import { DISCARD_STASH_MESSAGE } from "./git-discard";`:

```ts
async function hasHead(repositoryRoot: string): Promise<boolean> {
  try {
    await git(repositoryRoot, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Discard changes by stashing them (untracked files included), so a mistaken
 * discard can be undone from the stash list. Git cannot stash unmerged paths,
 * so conflicted files are reset to HEAD as before.
 */
export async function discardChanges(cwd: string, paths: string[]): Promise<GitStatusResponse> {
  const repositoryRoot = await requireRepositoryRoot(cwd);
  const rel = safeRepoRelPaths(repositoryRoot, paths);
  if (rel.length === 0) return getGitStatus(cwd);

  const entries = await readStatusEntries(repositoryRoot);
  const conflicted: string[] = [];
  const stashed: string[] = [];
  for (const relPath of rel) {
    const entry = entries.find((candidate) => candidate.path === relPath);
    if (!entry) continue; // Already clean.
    if (classifyGitStatus(entry).status === "conflict") conflicted.push(relPath);
    else stashed.push(relPath);
  }

  if (stashed.length > 0 && !(await hasHead(repositoryRoot))) {
    throw new Error("Discard needs at least one commit: Git cannot save changes before the first commit. Delete new files from the Explorer instead.");
  }
  if (conflicted.length > 0) {
    await git(repositoryRoot, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...conflicted]);
  }
  if (stashed.length > 0) {
    await git(repositoryRoot, [
      "stash", "push", "--include-untracked", "--message", DISCARD_STASH_MESSAGE,
      "--", ...stashed.map((relPath) => `:(literal)${relPath}`),
    ]);
  }
  return getGitStatus(cwd);
}
```

If `fs` is no longer used anywhere in `git-changes.ts` after this change, drop its import (eslint will flag it).

- [ ] **Step 5: Run tests and confirm they pass**

Run: `node --require ./server/test-env.cjs --test lib/git-discard.test.mjs lib/git-changes.test.mjs lib/git-line-staging.test.mjs`
Expected: PASS.

- [ ] **Step 6: UI.** In `components/GitReviewPanel.tsx`, import `discardConfirmMessage` from `@/lib/git-discard`. Change `discard` to take file objects:

```ts
  const discard = useCallback((files: GitFileStatus[]) => {
    if (!files.length) return;
    if (window.confirm(discardConfirmMessage(files))) {
      void runWrite("/api/git/discard", { paths: files.map((file) => file.filePath) });
    }
  }, [runWrite]);
```

(Import `GitFileStatus` from `@/lib/git-types` if the file doesn't already.) Update the two callers:
- group button (line ~487): `onClick={() => discard(files)}` with `title="Discard every file in this group (saved as a Git stash)"`
- file button (line ~506): `onClick={() => discard([file])}` with `title="Discard this file's changes (saved as a Git stash)"`

After this change, the stash list must refresh when a discard happens while it's open. Discard calls `runWrite`, which bumps `diffNonce` and calls `onRepoChanged`. Check how the stash list gets its `refreshToken` (`grep -n "refreshToken" components/GitReviewPanel.tsx`). If the stash list isn't driven by the same `refreshKey + nonce` as History, pass it the same way.

- [ ] **Step 7: PRD.** In `docs/prd/git-review.md` 已实现范围, change the discard description to: `丢弃（单文件或整组，包括未跟踪文件）会把改动保存为一条名为 "TianForge: discarded changes" 的 stash，可在 stash 列表中恢复；冲突文件无法 stash，仍重置到 HEAD，确认框会单独说明。仓库还没有任何提交时拒绝丢弃。`

- [ ] **Step 8: Checks and commit**

Run: `npx tsc --noEmit -p . && npx eslint lib/git-discard.ts lib/git-changes.ts components/GitReviewPanel.tsx && npm test`

```bash
git add lib/git-discard.ts lib/git-discard.test.mjs lib/git-changes.ts components/GitReviewPanel.tsx docs/prd/git-review.md
git commit -m "fix: save discarded Git changes as a stash instead of deleting them"
```

---

### Task 5: Tell the user when their login expires

**Problem:** Logins expire after 24 h. After that every `/api/*` call returns 401, but nothing in the client handles it. Panels show scattered "authentication required" errors, and nothing tells the user to sign in again.

**Files:**
- Create: `lib/auth-expiry.ts`
- Create: `lib/auth-expiry.test.mjs`
- Create: `components/AuthExpiryGuard.tsx`
- Modify: `app/layout.tsx` (mount the guard in `<body>`)
- Modify: `e2e/reliability.spec.ts`
- Modify: `docs/prd/secure-lan-access.md`

**Interfaces:**
- Produces: `isPossibleAuthExpiry(requestUrl: string, status: number, origin: string): boolean`, and the components `AuthExpiryGuard` and `AuthExpiredNotice({ open }: { open: boolean })`.
- Design: `window.fetch` is wrapped once. A same-origin `/api/*` 401 (excluding `/api/auth/*`) triggers a probe of `GET /api/auth/session`. The dialog opens only when the probe says `authenticated: false`, so 401s passed through from upstream services can't trigger it. The guard probes again whenever the tab becomes visible, and the dialog closes by itself once the session is valid again. "Sign in" opens `/login` in a new tab, so this tab keeps its drafts.

- [ ] **Step 1: Write the failing test** — `lib/auth-expiry.test.mjs`

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { isPossibleAuthExpiry } = await jiti.import("./auth-expiry.ts");
const origin = "https://pi.example:30141";

test("a same-origin API 401 may mean the login expired", () => {
  assert.equal(isPossibleAuthExpiry("/api/sessions", 401, origin), true);
  assert.equal(isPossibleAuthExpiry(`${origin}/api/git/status?cwd=%2Ftmp`, 401, origin), true);
});

test("other statuses, auth endpoints, pages and other origins are ignored", () => {
  assert.equal(isPossibleAuthExpiry("/api/sessions", 403, origin), false);
  assert.equal(isPossibleAuthExpiry("/api/sessions", 500, origin), false);
  assert.equal(isPossibleAuthExpiry("/api/auth/login", 401, origin), false);
  assert.equal(isPossibleAuthExpiry("/login", 401, origin), false);
  assert.equal(isPossibleAuthExpiry("https://api.github.com/api/x", 401, origin), false);
  assert.equal(isPossibleAuthExpiry("http://[bad", 401, origin), false);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --require ./server/test-env.cjs --test lib/auth-expiry.test.mjs`
Expected: FAIL. Module not found.

- [ ] **Step 3: Implement `lib/auth-expiry.ts`**

```ts
/**
 * Whether a response may mean the login session ended: a 401 from one of our
 * own API routes, other than the auth routes (a wrong password is also a 401).
 * Callers confirm with GET /api/auth/session before telling the user.
 */
export function isPossibleAuthExpiry(requestUrl: string, status: number, origin: string): boolean {
  if (status !== 401) return false;
  let url: URL;
  try {
    url = new URL(requestUrl, origin);
  } catch {
    return false;
  }
  return url.origin === origin && url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/auth/");
}
```

- [ ] **Step 4: Run the unit test and confirm it passes**

Run: `node --require ./server/test-env.cjs --test lib/auth-expiry.test.mjs`
Expected: PASS.

- [ ] **Step 5: Implement `components/AuthExpiryGuard.tsx`**

```tsx
"use client";

import { useEffect, useState } from "react";
import { isPossibleAuthExpiry } from "@/lib/auth-expiry";

export function AuthExpiredNotice({ open }: { open: boolean }) {
  if (!open) return null;
  return <div role="alertdialog" aria-modal="true" aria-labelledby="auth-expired-title" aria-describedby="auth-expired-detail" style={{ position: "fixed", inset: 0, zIndex: 10000, display: "grid", placeItems: "center", padding: 16, background: "rgba(0,0,0,.45)" }}>
    <div style={{ width: "min(100%, 380px)", padding: 22, borderRadius: 10, border: "1px solid var(--border)", background: "var(--bg-panel)", color: "var(--text)", boxShadow: "0 14px 40px rgba(0,0,0,.25)" }}>
      <h2 id="auth-expired-title" style={{ margin: "0 0 8px", fontSize: 16 }}>Signed out</h2>
      <p id="auth-expired-detail" style={{ margin: "0 0 16px", fontSize: 13, lineHeight: 1.5, color: "var(--text-muted)" }}>Your login expired, so TianForge can&apos;t reach the server. Sign in again in a new tab; this tab reconnects when you come back, and your drafts stay here.</p>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" onClick={() => window.location.reload()} style={{ padding: "6px 14px", background: "none", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-muted)", cursor: "pointer", fontSize: 13 }}>Reload</button>
        <a href="/login" target="_blank" rel="noopener" style={{ padding: "6px 14px", borderRadius: 6, background: "var(--accent)", color: "#fff", fontSize: 13, fontWeight: 600, textDecoration: "none" }}>Sign in</a>
      </div>
    </div>
  </div>;
}

/** Shows AuthExpiredNotice while the server says this browser is signed out. */
export function AuthExpiryGuard() {
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    const originalFetch = window.fetch;
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const response = await originalFetch("/api/auth/session", { cache: "no-store" });
        const body = await response.json() as { authenticated?: boolean };
        setExpired(body.authenticated === false);
      } catch {
        // Offline or restarting: not a login problem.
      } finally {
        checking = false;
      }
    };
    window.fetch = async (input, init) => {
      const response = await originalFetch(input, init);
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (isPossibleAuthExpiry(url, response.status, window.location.origin)) void check();
      return response;
    };
    const onVisibility = () => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.fetch = originalFetch;
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return <AuthExpiredNotice open={expired} />;
}
```

In `app/layout.tsx`, import it and add `<AuthExpiryGuard />` right after `{children}`.

- [ ] **Step 6: e2e test.** Append to `e2e/reliability.spec.ts`:

```ts
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
```

(The first `probe=1` fetch returns 200 and must not open the notice. It only makes the ordering explicit.)

- [ ] **Step 7: Run e2e**

Run: `npx playwright test e2e/reliability.spec.ts`
Expected: PASS on both projects.

- [ ] **Step 8: PRD.** In `docs/prd/secure-lan-access.md` 已实现范围, add: `登录过期后，任何 API 返回 401 都会先向 /api/auth/session 确认，确认已登出后弹出"Signed out"提示；"Sign in"在新标签页打开登录页，原标签页回到前台时自动检测，恢复登录后提示自动消失，草稿不丢失。`

- [ ] **Step 9: Checks and commit**

Run: `npx tsc --noEmit -p . && npx eslint lib/auth-expiry.ts components/AuthExpiryGuard.tsx app/layout.tsx e2e/reliability.spec.ts && npm test`

```bash
git add lib/auth-expiry.ts lib/auth-expiry.test.mjs components/AuthExpiryGuard.tsx app/layout.tsx e2e/reliability.spec.ts docs/prd/secure-lan-access.md
git commit -m "feat: prompt to sign in again when the login expires"
```

---

### Task 6: A failed steer or follow-up keeps the message and says why

**Problem:** `ChatInput.sendQueued` calls `onSteer`/`onFollowUp` without awaiting, then clears the input straight away. When the request fails, `useAgentSession` only logs `console.error`, so the user's instruction is lost without any message.

**Files:**
- Modify: `hooks/useAgentSession.ts:1675-1725` (`handleSteer`, `handlePromptWithStreamingBehavior`, `handleFollowUp`)
- Modify: `components/ChatInput.tsx:30-35` (props), `:714-731` (`sendQueued`), the Steer/Follow-up button `disabled` condition (`canQueueStreamingMessage`), and the area above the textarea (error line)
- Modify: `components/ChatWindow.tsx` only if it re-declares these callback types (tsc will tell)
- Modify: `e2e/reliability.spec.ts`

**Interfaces:**
- Changes: `onSteer`, `onFollowUp`: `(message: string, images?: AttachedImage[]) => Promise<string | null>`; `onPromptWithStreamingBehavior`: `(message, behavior, images?) => Promise<string | null>`. They resolve to `null` on success and to an error message on failure. They never reject.

- [ ] **Step 1: Write the failing e2e test.** Append to `e2e/reliability.spec.ts`:

```ts
test("a failed steer keeps the message and shows why", async ({ page }) => {
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
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx playwright test e2e/reliability.spec.ts -g "failed steer" --project=chromium`
Expected: FAIL. The input is empty after the first click, and there's no alert.

- [ ] **Step 3: Hook handlers return the error.** In `hooks/useAgentSession.ts`, give all three handlers this shape (`handleSteer` shown; `handleFollowUp` uses `type: "follow_up"`; `handlePromptWithStreamingBehavior` sends `type: "prompt", streamingBehavior: behavior`):

```ts
  const handleSteer = useCallback(async (message: string, images?: AttachedImage[]): Promise<string | null> => {
    const sid = sessionIdRef.current;
    if (!sid) return "No active session";
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "steer",
        message,
        ...(piImages?.length ? { images: piImages } : {}),
      });
      return null;
    } catch (e) {
      console.error("Failed to steer:", e);
      return e instanceof Error ? e.message : String(e);
    }
  }, []);
```

- [ ] **Step 4: ChatInput waits for the result.** Update the three prop types in `Props` to return `Promise<string | null>`. Add state near the other `useState`s. It must be declared above `canQueueStreamingMessage` (line ~530), which reads `queueSending`:

```ts
  const [queueSending, setQueueSending] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  useEffect(() => { setQueueError(null); }, [value]);
```

Replace `sendQueued`:

```ts
  const sendQueued = useCallback(async (mode: "steer" | "followup") => {
    const msg = value.trim();
    if (!msg || attachedImages.length || queueSending) return;
    onAudioUnlock?.();
    const streamingBehavior = mode === "steer" ? "steer" : "followUp";
    const send = msg.startsWith("/") && onPromptWithStreamingBehavior
      ? onPromptWithStreamingBehavior(msg, streamingBehavior)
      : mode === "steer" ? onSteer?.(msg) : onFollowUp?.(msg);
    if (!send) return;
    // Keep the text until the server accepts it, so a failed send loses nothing.
    setQueueSending(true);
    const error = await send;
    setQueueSending(false);
    if (error) {
      setQueueError(`Not sent: ${error}`);
      return;
    }
    // Don't wipe anything typed while the request was in flight.
    if (textareaRef.current?.value.trim() === msg) clearInput();
  }, [value, attachedImages, queueSending, onPromptWithStreamingBehavior, onSteer, onFollowUp, clearInput, onAudioUnlock]);
```

Where `canQueueStreamingMessage` is defined (`grep -n "canQueueStreamingMessage =" components/ChatInput.tsx`), add `&& !queueSending`. The Enter-key path (`sendQueued(onSteer ? "steer" : "followup")` around line 891) becomes `void sendQueued(...)`, and the two button handlers become `onClick={() => void sendQueued("steer")}` / `("followup")`.

Render the error directly above the textarea's container. Place it next to where `ModelErrorBanner` renders (line ~1045):

```tsx
        {queueError && <div role="alert" style={{ margin: "0 0 6px", fontSize: 12, color: "#f87171", overflowWrap: "anywhere" }}>{queueError}</div>}
```

- [ ] **Step 5: Run the e2e test and confirm it passes**

Run: `npx playwright test e2e/reliability.spec.ts -g "failed steer"`
Expected: PASS on both projects.

- [ ] **Step 6: Checks and commit**

Run: `npx tsc --noEmit -p . && npx eslint hooks/useAgentSession.ts components/ChatInput.tsx components/ChatWindow.tsx e2e/reliability.spec.ts && npm test`
(`components/ChatInput.test.mjs` renders `ChatInput`. If it passes `onSteer: () => {}`, change that to `async () => null`.)

```bash
git add hooks/useAgentSession.ts components/ChatInput.tsx components/ChatWindow.tsx components/ChatInput.test.mjs e2e/reliability.spec.ts
git commit -m "fix: keep a steer or follow-up message and show the error when sending fails"
```

---

### Task 7: Codex/Claude queued messages survive unmounting and retry after a failure

**Problem:** Codex/Claude Chat messages queued with "Queue" while a turn runs live in `useState` inside `CodexAssistantThread`. Switching projects unmounts the thread and the queue is lost. If sending the head of the queue fails, the effect never runs again: the queue is stuck, and there's no error or retry.

**Files:**
- Create: `lib/chat-queue-store.ts`
- Create: `lib/chat-queue-store.test.mjs`
- Modify: `components/agents/codex/CodexAssistantThread.tsx:225-236` (queue state and effect) and the `codex-aui-queue` bar in the return JSX (line ~263)

**Interfaces:**
- Produces: `QueuedChatMessage = { text: string; images: ChatDraftImage[] }`, `ChatQueue = { items: QueuedChatMessage[]; failed: boolean }`, `EMPTY_CHAT_QUEUE`, `getChatQueue(key): ChatQueue`, `updateChatQueue(key, update: (queue: ChatQueue) => ChatQueue): void`, `subscribeChatQueues(listener: () => void): () => void`.
- Scope note: the queue is module memory, the same lifetime as `lib/draft-store.ts`. It survives tab and project switches, but not a page reload. This is deliberate: auto-sending stale queued prompts after a reload would surprise the user.

- [ ] **Step 1: Write the failing test** — `lib/chat-queue-store.test.mjs`

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { EMPTY_CHAT_QUEUE, getChatQueue, updateChatQueue, subscribeChatQueues } = await jiti.import("./chat-queue-store.ts");

test("queues are kept per key and notify subscribers", () => {
  let calls = 0;
  const unsubscribe = subscribeChatQueues(() => { calls += 1; });
  updateChatQueue("codex:a", (queue) => ({ ...queue, items: [...queue.items, { text: "one", images: [] }] }));
  updateChatQueue("codex:a", (queue) => ({ ...queue, items: [...queue.items, { text: "two", images: [] }] }));
  assert.deepEqual(getChatQueue("codex:a").items.map((item) => item.text), ["one", "two"]);
  assert.equal(getChatQueue("codex:b"), EMPTY_CHAT_QUEUE);
  assert.equal(calls, 2);
  unsubscribe();
  updateChatQueue("codex:a", () => EMPTY_CHAT_QUEUE);
});

test("the same snapshot is returned until the queue changes", () => {
  updateChatQueue("codex:c", (queue) => ({ ...queue, items: [{ text: "x", images: [] }] }));
  assert.equal(getChatQueue("codex:c"), getChatQueue("codex:c"));
  updateChatQueue("codex:c", () => EMPTY_CHAT_QUEUE);
});

test("an emptied queue is dropped and its failed flag cleared", () => {
  updateChatQueue("codex:d", () => ({ items: [{ text: "x", images: [] }], failed: true }));
  updateChatQueue("codex:d", (queue) => ({ ...queue, items: [] }));
  assert.equal(getChatQueue("codex:d"), EMPTY_CHAT_QUEUE);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --require ./server/test-env.cjs --test lib/chat-queue-store.test.mjs`
Expected: FAIL. Module not found.

- [ ] **Step 3: Implement `lib/chat-queue-store.ts`**

```ts
import type { ChatDraftImage } from "./draft-store";

export interface QueuedChatMessage {
  text: string;
  images: ChatDraftImage[];
}

export interface ChatQueue {
  items: QueuedChatMessage[];
  /** Sending the first item failed; the queue waits for Retry. */
  failed: boolean;
}

export const EMPTY_CHAT_QUEUE: ChatQueue = Object.freeze({ items: [], failed: false }) as ChatQueue;

// Module memory like the draft store: queued messages outlive the chat
// component (tab and project switches) but not a page reload.
const queues = new Map<string, ChatQueue>();
const listeners = new Set<() => void>();

export function getChatQueue(key: string): ChatQueue {
  return queues.get(key) ?? EMPTY_CHAT_QUEUE;
}

export function updateChatQueue(key: string, update: (queue: ChatQueue) => ChatQueue): void {
  const next = update(getChatQueue(key));
  if (next.items.length === 0) queues.delete(key);
  else queues.set(key, next);
  for (const listener of listeners) listener();
}

export function subscribeChatQueues(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
```

- [ ] **Step 4: Run the unit test and confirm it passes**

Run: `node --require ./server/test-env.cjs --test lib/chat-queue-store.test.mjs`
Expected: PASS.

- [ ] **Step 5: Use the store in `CodexAssistantThread`.** Import `useSyncExternalStore` from React, and `EMPTY_CHAT_QUEUE`, `getChatQueue`, `subscribeChatQueues`, `updateChatQueue` from `@/lib/chat-queue-store`. Replace the `queue` `useState` line with:

```ts
  const queue = useSyncExternalStore(subscribeChatQueues, () => getChatQueue(draftKey), () => EMPTY_CHAT_QUEUE);
```

Replace the auto-send effect:

```ts
  useEffect(() => {
    if (running || !queue.items.length || queue.failed || queueSendingRef.current) return;
    queueSendingRef.current = true;
    const next = queue.items[0];
    void onSend(next.text, next.images).then((sent) => {
      updateChatQueue(draftKey, (current) => {
        if (current.items[0] !== next) return current; // Cleared or changed meanwhile.
        return sent ? { items: current.items.slice(1), failed: false } : { ...current, failed: true };
      });
    }).finally(() => { queueSendingRef.current = false; });
  }, [draftKey, onSend, queue, running]);
```

In the JSX, replace the queue bar and the `onQueue` prop:

```tsx
{queue.items.length > 0 && <div className="codex-aui-queue" role={queue.failed ? "alert" : undefined}>{queue.items.length} queued{queue.failed && " · sending failed"}{queue.failed && <button type="button" onClick={() => updateChatQueue(draftKey, (current) => ({ ...current, failed: false }))}>Retry</button>}<button type="button" onClick={() => updateChatQueue(draftKey, () => EMPTY_CHAT_QUEUE)}>Clear</button></div>}
```

```tsx
onQueue={(message) => updateChatQueue(draftKey, (current) => ({ ...current, items: [...current.items, message] }))}
```

- [ ] **Step 6: e2e.** The existing test `"shows Codex chat retries, turn failures, the terminal conflict prompt, question cards and steering"` (`e2e/app-shell.spec.ts:1561`) covers queueing. Run it first to confirm nothing regressed:

Run: `npx playwright test e2e/app-shell.spec.ts -g "Codex chat retries" --project=chromium`
Expected: PASS.

Then read that test to see how it mocks a running Codex thread and the send endpoint. Add a test to `e2e/reliability.spec.ts` built on the same mocks:
1. While running, type a message and choose Queue. Expect "1 queued".
2. Make the send endpoint return 500 and flip the pushed runtime state to idle. Expect "1 queued · sending failed" and a Retry button.
3. Make the send endpoint succeed and click Retry. Expect the queue bar to disappear, and the send endpoint to have received the queued text twice (once failed, once succeeded).
Copy the mock setup from the existing test into the new one; don't import across spec files.

- [ ] **Step 7: Checks and commit**

Run: `npx tsc --noEmit -p . && npx eslint lib/chat-queue-store.ts components/agents/codex/CodexAssistantThread.tsx e2e/reliability.spec.ts && npm test && npx playwright test e2e/reliability.spec.ts`

```bash
git add lib/chat-queue-store.ts lib/chat-queue-store.test.mjs components/agents/codex/CodexAssistantThread.tsx e2e/reliability.spec.ts
git commit -m "fix: keep queued Codex and Claude messages across tab switches and retry failed sends"
```

---

### Task 8: Session rename and delete report server errors

**Problem:** `SessionItem.handleDeleteConfirm` never checks `res.ok`, so a failed DELETE still removes the row, and the session comes back on refresh. `commitRename` ignores both HTTP errors and network errors.

**Files:**
- Modify: `components/SessionSidebar.tsx:1692-1740` (`SessionItem` state, `commitRename`, `handleDeleteConfirm`) and the normal-view subtitle row (line ~1872)
- Modify: `e2e/reliability.spec.ts`

**Interfaces:** none new.

- [ ] **Step 1: Write the failing e2e test.** Append to `e2e/reliability.spec.ts`:

```ts
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
  await page.goto("/");
  const row = page.getByText("Refactor the parser").first();
  await expect(row).toBeVisible();

  await row.hover();
  await page.getByTitle("Delete").first().click();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Delete failed: session is running in another window" })).toBeVisible();
  await expect(page.getByText("Refactor the parser").first()).toBeVisible();

  await row.hover();
  await page.getByTitle("Rename").first().click();
  await page.keyboard.type("New name");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: "Rename failed: disk full" })).toBeVisible();
});
```

If the sidebar doesn't list sessions on `/` without a selected project, open the project the same way `e2e/app-shell.spec.ts` does for its session-list tests (e.g. `/?session=` or the project workspace setup at `:527`). Adjust the navigation; leave the assertions as they are.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx playwright test e2e/reliability.spec.ts -g "failed session delete" --project=chromium`
Expected: FAIL. No alert, and the row disappears.

- [ ] **Step 3: Implement.** In `SessionItem`, add:

```ts
  const [actionError, setActionError] = useState<string | null>(null);
  useEffect(() => {
    if (!actionError) return;
    const timer = setTimeout(() => setActionError(null), 6000);
    return () => clearTimeout(timer);
  }, [actionError]);
```

(Add `useEffect` to the React import if it's missing.) Replace `commitRename` and `handleDeleteConfirm`:

```ts
  const commitRename = useCallback(async () => {
    const name = renameValue.trim();
    setRenaming(false);
    if (name === (session.name ?? "")) return;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      onRenamed?.();
    } catch (error) {
      setActionError(`Rename failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [renameValue, session.id, session.name, onRenamed]);
```

```ts
  const handleDeleteConfirm = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
    setDeleting(true);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      onDeleted?.(session.id);
    } catch (error) {
      setDeleting(false);
      setActionError(`Delete failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [session.id, onDeleted]);
```

In the normal view, render the error in place of the metadata line (the `<div style={{ marginTop: 2, display: "flex", ... fontSize: 11 ...}}>` under the title). Wrap the existing line like this:

```tsx
            {actionError ? (
              <div role="alert" title={actionError} style={{ marginTop: 2, color: "#f87171", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{actionError}</div>
            ) : (
              /* existing metadata <div> unchanged */
            )}
```

- [ ] **Step 4: Run e2e and confirm it passes**

Run: `npx playwright test e2e/reliability.spec.ts --project=chromium`
Expected: all reliability tests PASS.

- [ ] **Step 5: Checks and commit**

Run: `npx tsc --noEmit -p . && npx eslint components/SessionSidebar.tsx e2e/reliability.spec.ts && npm test && npx playwright test`

```bash
git add components/SessionSidebar.tsx e2e/reliability.spec.ts
git commit -m "fix: keep a session and show the error when rename or delete fails"
```

---

## Finish

- [ ] Run the full gate: `npx tsc --noEmit -p . && npm run lint && npm test && npx playwright test`
- [ ] Use superpowers:finishing-a-development-branch to merge `fix/p0-reliability` (the repo merges feature branches into `main` with a merge commit; see `git log`).
