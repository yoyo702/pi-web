# Mobile, Performance, and Accessibility Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix nine product-audit findings: three mobile/touch usability gaps (Explorer actions, Git panel layout, QR code expiry), a message-list performance and correctness pair (re-render cost, unstable React keys), two accessibility gaps (hover-only buttons, unreachable branch tree), a proxy-deployment security bug (login rate limiting keyed on the wrong address behind a reverse proxy), and a deferred cross-worktree activity-tracking gap (`projectRoot` not attached to terminal/Codex/Claude records, so worktree activity is invisible to the close-project warning, tab title, and notification routing).

**Architecture:** Every fix is local to the component or server module that already owns the behavior; no shared infrastructure is introduced except two small, already-scoped additions: a `useCoarsePointer()` hook (added to the existing `hooks/useIsMobile.ts`, reusing its private touch-detection internals) and a `server/agents/project-root.cjs` helper (a CJS-native, cached, git-common-dir resolver, parallel to the existing TS/ESM `resolveProject()` in `lib/worktree.ts` — CJS server modules cannot `require()` TypeScript ESM modules, so the logic is duplicated in CJS rather than shared). All touch-target and hover-visibility fixes reuse the existing roving-tabindex pattern already established in `components/FileExplorer.tsx`. No new dependencies; virtualization is achieved with CSS `content-visibility: auto`, not a library.

**Tech Stack:** Next.js 16 App Router + the custom Node server (`server/pi-web-server.js`), React 19, TypeScript, `node --test` (CommonJS `.cjs` tests requiring modules directly, `.mjs` tests for `lib/`), Playwright (`chromium` and `mobile-chromium` projects, `e2e/mobile-a11y.spec.ts` is new).

**Spec:** There is no separate spec document. The nine problems come from a product audit done in conversation (eight numbered items plus one item deferred from an earlier silent-failures audit). The **Problem** line in each task is the requirement. Chinese PRD docs under `docs/prd/*.md` are the closest thing to a living spec and are updated in the same task as the behavior they describe, per `AGENTS.md`.

## Global Constraints

- No new dependencies. Item 4 (message list perf) is explicitly hand-rolled (`React.memo`/`useMemo`/CSS `content-visibility: auto`), not a virtualization library.
- UI copy is English, matching the rest of the app. PRD edits (`docs/prd/*.md`) are Chinese, matching those files, and are updated in the same task as the behavior they describe (AGENTS.md rule).
- Every task ends green on `npx tsc --noEmit -p .`, `npx eslint <touched files>`, and `npm test` (`node --require ./server/test-env.cjs --test server/agents/*.test.cjs lib/*.test.mjs lib/workspace/*.test.mjs components/*.test.mjs`). Tasks that touch UI also run a focused `npx playwright test e2e/mobile-a11y.spec.ts` (and, where noted, `e2e/reliability.spec.ts` or `e2e/app-shell.spec.ts`).
- Work on the current branch, `feat/audit-followups` — other audit-followup work is already landing on it (see `git log`; do not create a new branch). Other agents may have local uncommitted changes to files this plan also touches (`components/ModelsConfig.tsx`, `components/PluginsConfig.tsx`, `e2e/reliability.spec.ts`, `docs/prd/secure-lan-access.md` all show as modified in `git status` as of this writing, and `docs/superpowers/plans/2026-09-28-files-and-git.md` is a separate in-flight plan). None of those files are touched by this plan except `e2e/reliability.spec.ts`, which Task 1 only appends to — re-read it fresh before editing, don't assume the line numbers below still match.
- Playwright projects are `chromium` (Desktop Chrome, `hasTouch: false`) and `mobile-chromium` (`devices["Pixel 7"]`, `hasTouch: true`), defined in `playwright.config.ts`. The dev server for e2e runs via `PI_WEB_E2E=1 ... node server/pi-web-server.js dev -H 127.0.0.1 -p 30142`.
- Line numbers quoted throughout this plan are hints from a fresh read taken while writing it — the branch is actively moving. If a quoted line doesn't match, relocate the edit using the quoted surrounding code, not the number.

## Facts the implementer needs

- `e2e/mobile-a11y.spec.ts` does not exist yet. Task 1 creates it (with two shared local helpers used by later tasks); Tasks 2, 3, 4, 5, and 6 append new tests to the same file. Implement in task order to avoid merge conflicts within that one file.
- CJS server modules (`server/**/*.cjs`) cannot `require()` TypeScript/ESM modules under `lib/`. This is why Task 8 writes a new CJs-native `server/agents/project-root.cjs` instead of reusing `lib/worktree.ts`'s `resolveProject()` — they implement the same git-common-dir algorithm independently, one in CJS for the server, one in TS for the client-adjacent code that already worked (`lib/rpc-manager.ts`).
- `lib/activity-notifications.ts`'s `notificationWorkspace`/`notificationOpenWorkspace` already match a notification's workspace by checking **both** `notification.cwd` and `notification.projectRoot` against open workspaces — that matching logic is already correct today. The bug is that `notification.projectRoot` is never populated for terminal/Codex/Claude notifications (only for "pi" session notifications, and only when the caller supplies it). Task 8 supplies it; Task 9 fixes the analogous (but different, and currently missing) `projectRoot` check in `lib/rail-activity.ts`'s `groupRailActivity`, which only ever compared `item.cwd`, never a project-root field, because none of its `RailActivityItem` variants except `"pi"` carried one.
- Every e2e test added by this plan that needs a running session view uses the `?session=<id>` URL trick together with route mocks for `/api/sessions/:id/state`, `/api/sessions/:id?*`, `/api/sessions/:id/context?*`, `/api/sessions`, `/api/cwd/validate`, and `/api/agent/:id/events` — the same pattern `e2e/reliability.spec.ts` and `e2e/app-shell.spec.ts` already use. Task 1's Explorer test instead uses a **real** temp directory (via `mkdtempSync`/`writeFileSync`, no git) because `/api/files/...` is not mocked in that test and the dev server serves it for real, exactly as `e2e/app-shell.spec.ts`'s "shares workspace authorization..." test already does.
- Task 4's e2e test mocks a load-earlier-messages request. The exact query parameter `hooks/useAgentSession.ts`'s `loadOlderMessages` sends (this plan assumes `before`) was not re-verified against that file's current body in this session (it is very large). Before writing the mock route, grep `loadOlderMessages` in `hooks/useAgentSession.ts` and match the real parameter name; adjust the route's parameter check if it differs. This is the one place in this plan where an exact wire-format detail needs a fresh look rather than being taken on faith.

---

### Task 1: Explorer touch reachability — rename/delete/download on coarse pointers

**Problem:** `components/FileExplorer.tsx`'s per-row rename/delete/download affordances are gated on `hovered` (mouse hover) or reached via right-click context menu (`onContextMenu`). On iOS/Android (coarse pointer, no hover, no right-click), there is no way to reach them from a row at all.

**Files:**
- Modify: `hooks/useIsMobile.ts` (add `useCoarsePointer()`)
- Modify: `components/FileExplorer.tsx:13` (import), `components/FileExplorer.tsx:201-233` (`TreeNodeProps`), `components/FileExplorer.tsx:282-428` (row JSX), `components/FileExplorer.tsx:429-450` (recursive call), `components/FileExplorer.tsx:473` (state block), `components/FileExplorer.tsx:1148-1180` (root call)
- Create: `e2e/mobile-a11y.spec.ts`

**Interfaces:**
- Produces: `useCoarsePointer(): boolean` exported from `hooks/useIsMobile.ts`, used by Task 1, Task 5, and Task 6 wherever a component needs to know "this pointer can't hover."
- Produces: `e2e/mobile-a11y.spec.ts` with a local `makeWorkspace(name: string): string` helper (creates and returns a real temp dir) reused by later tasks' appended tests.

- [ ] **Step 1: Add `useCoarsePointer()` to `hooks/useIsMobile.ts`.** This file already defines `installTouchWatch()`, `touchKeyListeners` (a `Set<() => void>`), `TOUCH_SEEN_KEY`, `readStorage()`, and `getServerSnapshot()` for its existing `useIsMobile()`/touch-detection hooks. Append after the file's last export:

```ts
const COARSE_POINTER_QUERY = "(hover: none) and (pointer: coarse)";

function subscribeCoarsePointer(callback: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  installTouchWatch();
  const mql = window.matchMedia(COARSE_POINTER_QUERY);
  touchKeyListeners.add(callback);
  mql.addEventListener("change", callback);
  return () => {
    touchKeyListeners.delete(callback);
    mql.removeEventListener("change", callback);
  };
}

function getCoarsePointerSnapshot(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(COARSE_POINTER_QUERY).matches || readStorage(TOUCH_SEEN_KEY) === "1";
}

/** True on touch-primary devices (no hover, coarse pointer) — used to show touch-reachable affordances that would otherwise only appear on `:hover`. */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(subscribeCoarsePointer, getCoarsePointerSnapshot, getServerSnapshot);
}
```

Confirm `useSyncExternalStore` is already imported from `react` at the top of the file (it is, for the existing `useIsMobile()`); if not, add it to that import.

- [ ] **Step 2: Run the gates on the hook.**

Run: `npx tsc --noEmit -p .`
Run: `npx eslint hooks/useIsMobile.ts`

- [ ] **Step 3: Wire `useCoarsePointer()` into `FileExplorer.tsx`.** Add `MoreVertical` to the existing lucide-react import (`components/FileExplorer.tsx:13`, currently `import { Check, ChevronUp, Copy, Eye, EyeOff, FilePlus2, FolderPlus, Pencil, Search, Trash2, X } from "lucide-react";`) and add a new import:

```ts
import { useCoarsePointer } from "@/hooks/useIsMobile";
```

In the `FileExplorer` component body, right before its first state hook (`const [roots, setRoots] = useState<FileNode[]>([]);`), add:

```ts
  const isCoarsePointer = useCoarsePointer();
```

- [ ] **Step 4: Thread `isCoarsePointer` through `TreeNodeProps` and add the touch-reachable actions button.** In the `TreeNodeProps` interface (`components/FileExplorer.tsx:201-233`), add `isCoarsePointer: boolean;` alongside the existing `onContextMenu: (node: FileNode, event: React.MouseEvent) => void;`. In the row JSX, right after the existing download-link block that is gated on `hovered && !node.isDir` (around `components/FileExplorer.tsx:393-427`), add a sibling button gated on `isCoarsePointer`:

```tsx
        {isCoarsePointer && !hovered && (
          <button
            onClick={(e) => { e.stopPropagation(); onContextMenu(node, e); }}
            title="File actions"
            aria-label="File actions"
            style={{
              position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)",
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 22, height: 22,
              background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 4,
              color: "var(--text-muted)", cursor: "pointer",
            }}
          >
            <MoreVertical size={13} />
          </button>
        )}
```

This reuses the existing `onContextMenu` prop and the existing context menu (Rename/Delete/Copy/Cut/Paste) — no new menu component. Add `isCoarsePointer` to both call sites that construct `<TreeNode>`: the recursive call inside `TreeNode` itself (`components/FileExplorer.tsx:429-450`, pass `isCoarsePointer={isCoarsePointer}`) and the root-level call in `FileExplorer` (`components/FileExplorer.tsx:1148-1180`, pass `isCoarsePointer={isCoarsePointer}`).

- [ ] **Step 5: Run the gates.**

Run: `npx tsc --noEmit -p .`
Run: `npx eslint components/FileExplorer.tsx`
Run: `npm test`

- [ ] **Step 6: Create `e2e/mobile-a11y.spec.ts` with a shared workspace helper and the touch-reachability test.**

```ts
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
    await page.route("**/api/cwd/validate", (route) => route.fulfill({ json: { success: true, cwd: workspace } }));
    await page.route("**/api/sessions", (route) => route.fulfill({ json: { sessions: [], runningSessionIds: [] } }));
    await page.addInitScript((snapshot) => {
      localStorage.setItem("pi-web:project-workspaces:v1", JSON.stringify(snapshot));
    }, {
      activeId: workspace,
      workspaces: [{ id: workspace, projectRoot: workspace, cwd: workspace, label: "explorer-touch", sessionId: null, lastActive: 1 }],
    });
    await page.goto("/");
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
    await page.route("**/api/cwd/validate", (route) => route.fulfill({ json: { success: true, cwd: workspace } }));
    await page.route("**/api/sessions", (route) => route.fulfill({ json: { sessions: [], runningSessionIds: [] } }));
    await page.addInitScript((snapshot) => {
      localStorage.setItem("pi-web:project-workspaces:v1", JSON.stringify(snapshot));
    }, {
      activeId: workspace,
      workspaces: [{ id: workspace, projectRoot: workspace, cwd: workspace, label: "explorer-desktop", sessionId: null, lastActive: 1 }],
    });
    await page.goto("/");
    const row = page.locator("[data-explorer-row][data-file-path$=\"README.md\"]");
    await expect(row).toBeVisible();
    await expect(row.getByRole("button", { name: "File actions" })).toHaveCount(0);
  });
});
```

Run: `npx playwright test e2e/mobile-a11y.spec.ts`

- [ ] **Step 7: Commit.**

```bash
git add hooks/useIsMobile.ts components/FileExplorer.tsx e2e/mobile-a11y.spec.ts
git commit -m "fix: add touch-reachable file actions button in Explorer"
```

---

### Task 2: Git panel mobile layout — stack vertically under a breakpoint

**Problem:** `components/GitReviewPanel.tsx`'s Changes tab and History tab both render a fixed-width `<aside>` file/commit list beside a flexible `<main>` diff view in a `display: "flex"` row, unconditionally. On a narrow phone screen the `<aside>` (`changesSplit.size`, default 240px, or `split.size`, default 300px) consumes most of the width, leaving roughly 100px for the diff. There's also no way to get back to the list once a file/commit is open except un-selecting via developer tools — no back button.

**Files:**
- Modify: `components/GitReviewPanel.tsx:1-23` (imports), `components/GitReviewPanel.tsx:159-181` (`GitReviewPanel` state), `components/GitReviewPanel.tsx:467-539` (Changes tab split), `components/GitReviewPanel.tsx:908-1043` (`HistoryView`)
- Modify: `e2e/mobile-a11y.spec.ts` (new test)

**Interfaces:**
- Consumes: `useIsMobile(): boolean` from `hooks/useIsMobile.ts` (already exported, already used elsewhere in the app, e.g. `components/ChatWindow.tsx`).

- [ ] **Step 1: Import `useIsMobile` and `ArrowLeft`.** `components/GitReviewPanel.tsx` currently has no lucide-react import at all. Add, after the existing imports (`components/GitReviewPanel.tsx:1-23`):

```ts
import { ArrowLeft } from "lucide-react";
import { useIsMobile } from "@/hooks/useIsMobile";
```

- [ ] **Step 2: Add `isMobile` to `GitReviewPanel` and stop auto-selecting the first commit on mobile.** In `GitReviewPanel` (`components/GitReviewPanel.tsx:159-181`), right after `const changesSplit = useSplit(...)`, add:

```ts
  const isMobile = useIsMobile();
```

- [ ] **Step 3: Replace the Changes tab's split block** (`components/GitReviewPanel.tsx:467-539`, the whole `<div style={{ minHeight: 0, flex: 1, display: "flex", flexDirection: "column" }}>...</div>` through its matching closing `</div>` right before the commit-message footer) so the aside and main sections stack on mobile, hide/show based on selection, and the diff view gets a "Back to changes" button:

```tsx
        <div style={{ minHeight: 0, flex: 1, display: "flex", flexDirection: "column" }}>
          <div style={{ minHeight: 0, flex: 1, display: "flex", flexDirection: isMobile ? "column" : "row" }}>
            {(!isMobile || !selected) && (
              <aside style={{ width: isMobile ? "100%" : changesSplit.size, flexShrink: 0, overflow: "auto", borderRight: isMobile ? "none" : "1px solid var(--border)", borderBottom: isMobile ? "1px solid var(--border)" : "none", padding: "8px 6px" }}>
                {GROUPS.map((group) => {
                  const files = grouped.get(group.key) ?? [];
                  if (files.length === 0) return null;
                  const paths = files.map((file) => file.filePath);
                  const staged = group.key === "staged";
                  return (
                    <section key={group.key} style={{ marginBottom: 12 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "5px 8px" }}>
                        <span style={{ color: "var(--text-muted)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em" }}>
                          {group.label} <span style={{ color: "var(--text-dim)" }}>{files.length}</span>
                        </span>
                        <span style={{ display: "flex", gap: 2 }}>
                          {staged ? (
                            <button type="button" onClick={() => unstage(paths)} disabled={busy} title="Unstage every file in this group" style={writeButtonStyle}>−</button>
                          ) : (
                            <>
                              <button type="button" onClick={() => stage(paths)} disabled={busy} title="Stage every file in this group for the next commit" style={writeButtonStyle}>+</button>
                              <button type="button" onClick={() => discard(files)} disabled={busy} title="Discard every file in this group (saved as a Git stash)" style={writeButtonStyle}>⨯</button>
                            </>
                          )}
                        </span>
                      </div>
                      {files.map((file) => {
                        const isSelected = selected?.file.filePath === file.filePath && selected.scope === group.scope;
                        return (
                          <div key={`${group.key}:${file.filePath}`} style={{ display: "flex", alignItems: "center", borderRadius: 4, background: isSelected ? "var(--bg-selected)" : "transparent", minWidth: 0 }}>
                            <button type="button" onClick={() => setSelected({ file, scope: group.scope })} title={`View diff: ${file.filePath}`} style={{ ...fileButtonStyle, background: "transparent", flex: 1 }}>
                              <span style={{ width: 14, flexShrink: 0, fontFamily: "var(--font-mono)", fontWeight: 700, color: STATUS_COLORS[file.status] }}>{statusLetter(file, group.scope)}</span>
                              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{getRelativeFilePath(file.filePath, repoRoot)}</span>
                            </button>
                            <span style={{ display: "flex", gap: 2, flexShrink: 0, paddingRight: 4 }}>
                              {staged ? (
                                <button type="button" onClick={() => unstage([file.filePath])} disabled={busy} title="Remove this file from the next commit" style={writeButtonStyle}>−</button>
                              ) : (
                                <>
                                  <button type="button" onClick={() => stage([file.filePath])} disabled={busy} title="Add this file to the next commit" style={writeButtonStyle}>+</button>
                                  <button type="button" onClick={() => discard([file])} disabled={busy} title="Discard this file's changes (saved as a Git stash)" style={writeButtonStyle}>⨯</button>
                                </>
                              )}
                            </span>
                          </div>
                        );
                      })}
                    </section>
                  );
                })}
                {status.files.length === 0 && <div style={{ padding: 14, color: "var(--text-dim)", fontSize: 12 }}>Working tree clean</div>}
              </aside>
            )}
            {!isMobile && <div className="resize-handle" onMouseDown={changesSplit.onDragStart} role="separator" aria-orientation="vertical" title="Drag to resize" />}
            {(!isMobile || selected) && (
              <main style={{ minWidth: 0, flex: 1, overflow: "auto" }}>
                {isMobile && selected && (
                  <button
                    type="button"
                    onClick={() => setSelected(null)}
                    style={{ display: "flex", alignItems: "center", gap: 6, margin: 8, padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-hover)", color: "var(--text)", cursor: "pointer", fontSize: 12 }}
                  >
                    <ArrowLeft size={14} />Back to changes
                  </button>
                )}
                {!selected ? (
                  <EmptyState title={status.files.length ? "Select a changed file" : "No uncommitted changes"} detail={status.files.length ? "Choose a file from the change list to inspect its diff." : "Changes made by you or the agent will appear here."} />
                ) : loadingDiff ? (
                  <EmptyState title="Loading diff…" />
                ) : diff?.supported && diff.patch ? (
                  <div>
                    <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-muted)" }}>
                      {getFileName(selected.file.filePath)}
                    </div>
                    {diff.fingerprint ? (
                      <GitLineDiffView key={diff.fingerprint} patch={diff.patch} scope={selected.scope} fileLabel={getFileName(selected.file.filePath)} busy={busy} onApply={applyLines} />
                    ) : (
                      <DiffView patch={diff.patch} />
                    )}
                  </div>
                ) : (
                  <EmptyState title="Diff unavailable" detail="This file may be binary, too large, or unchanged in this review group." />
                )}
              </main>
            )}
          </div>
```

(This is the file's own existing JSX, unchanged in content — only the `flexDirection`, the two `(!isMobile || ...)` wrapping conditions, the conditional resize handle, and the new "Back to changes" button are new.)

- [ ] **Step 4: Apply the same treatment to `HistoryView`, and stop auto-selecting the first commit on mobile.** In `HistoryView` (`components/GitReviewPanel.tsx:908-1043`), add `isMobile` next to the existing hooks:

```ts
  const isMobile = useIsMobile();
```

Change the `setSelectedHash` call inside `load()`'s non-append branch (currently `setSelectedHash((prev) => prev && next.commits.some((commit) => commit.hash === prev) ? prev : next.commits[0]?.hash ?? null);`) so mobile shows the commit list first instead of jumping straight to a diff:

```ts
        setSelectedHash((prev) => {
          if (prev && next.commits.some((commit) => commit.hash === prev)) return prev;
          return isMobile ? null : next.commits[0]?.hash ?? null;
        });
```

Add `isMobile` to `load`'s dependency array: `}, [cwd, isMobile]);`.

Replace the render's split container (the `<div style={{ minHeight: 0, flex: 1, display: "flex" }}>` through its matching `</div>` that currently holds `<aside>`, the resize handle, and `<main>`):

```tsx
    <div style={{ minHeight: 0, flex: 1, display: "flex", flexDirection: isMobile ? "column" : "row" }}>
      {(!isMobile || !selectedHash) && (
        <aside style={{ width: isMobile ? "100%" : split.size, flexShrink: 0, overflow: "auto", borderRight: isMobile ? "none" : "1px solid var(--border)", borderBottom: isMobile ? "1px solid var(--border)" : "none", padding: "6px 4px" }}>
          {log.commits.map((commit, index) => {
            const isSelected = commit.hash === selectedHash;
            const row = graph.rows[index];
            if (!row) return null;
            const nodeX = row.nodeCol * GRAPH_COL_W + GRAPH_COL_W / 2;
            const refs = commit.refs.filter((r) => r && r !== "HEAD");
            return (
              <button
                key={commit.hash}
                type="button"
                onClick={() => setSelectedHash(commit.hash)}
                title={`View commit: ${commit.subject}`}
                style={{
                  width: "100%",
                  height: GRAPH_ROW_H,
                  display: "flex",
                  gap: 6,
                  alignItems: "stretch",
                  border: "none",
                  borderRadius: 4,
                  padding: "0 8px 0 2px",
                  cursor: "pointer",
                  textAlign: "left",
                  color: "var(--text)",
                  background: isSelected ? "var(--bg-selected)" : "transparent",
                  minWidth: 0,
                }}
              >
                <svg width={graph.width * GRAPH_COL_W} height={GRAPH_ROW_H} style={{ flexShrink: 0, display: "block" }} aria-hidden="true">
                  {row.segs.map((s, i) => (
                    <path key={i} d={segPath(s)} stroke={s.color} strokeWidth={1.6} fill="none" opacity={0.9} />
                  ))}
                  {isSelected && <circle cx={nodeX} cy={GRAPH_ROW_H / 2} r={6} fill="none" stroke="var(--accent)" strokeWidth={1.5} />}
                  <circle cx={nodeX} cy={GRAPH_ROW_H / 2} r={row.isMerge ? 4 : 3.4} fill={row.nodeColor} stroke="var(--bg-panel)" strokeWidth={1.6} />
                </svg>
                <span style={{ minWidth: 0, flex: 1, alignSelf: "center" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
                    {refs.slice(0, 2).map((r) => (
                      <span key={r} style={{ flexShrink: 0, fontSize: 9.5, lineHeight: "14px", padding: "0 5px", borderRadius: 8, background: "var(--bg-hover)", color: "var(--text-muted)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 96 }}>{r.replace(/^tag: /, "⌘ ")}</span>
                    ))}
                    <span style={{ minWidth: 0, flex: 1, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{commit.subject}</span>
                  </span>
                  <span style={{ display: "block", marginTop: 2, color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 10.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {commit.shortHash} · {commit.author} · {formatRelative(commit.date)}
                  </span>
                </span>
              </button>
            );
          })}
          {log.hasMore && <button type="button" onClick={() => void load(true)} disabled={loadingMore || loading} style={{ width: "calc(100% - 12px)", height: 30, margin: "6px 6px 2px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg-panel)", color: loadMoreError ? "#f87171" : "var(--text-muted)", cursor: loadingMore ? "default" : "pointer", fontSize: 11 }}>{loadingMore ? "Loading more…" : loadMoreError ? "Retry loading more" : `Load more · ${log.commits.length} shown`}</button>}
          {loadMoreError && <div role="alert" style={{ padding: "2px 8px 7px", color: "#f87171", fontSize: 10, lineHeight: 1.35 }}>{loadMoreError}</div>}
        </aside>
      )}
      {!isMobile && <div className="resize-handle" onMouseDown={split.onDragStart} role="separator" aria-orientation="vertical" title="Drag to resize" />}
      {(!isMobile || selectedHash) && (
        <main style={{ minWidth: 0, flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          {isMobile && selectedHash && (
            <button
              type="button"
              onClick={() => setSelectedHash(null)}
              style={{ display: "flex", alignItems: "center", gap: 6, margin: 8, padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-hover)", color: "var(--text)", cursor: "pointer", fontSize: 12, flexShrink: 0 }}
            >
              <ArrowLeft size={14} />Back to history
            </button>
          )}
          {selectedHash
            ? <CommitDetailView cwd={cwd} hash={selectedHash} />
            : <EmptyState title="Select a commit" detail="Choose a commit to inspect its changes." />}
        </main>
      )}
    </div>
```

- [ ] **Step 5: Run the gates.**

Run: `npx tsc --noEmit -p .`
Run: `npx eslint components/GitReviewPanel.tsx`
Run: `npm test`

- [ ] **Step 6: Append a mobile-layout e2e test to `e2e/mobile-a11y.spec.ts`.**

```ts
test("Git panel stacks list above diff on narrow screens instead of squeezing the diff", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("mobile"), "narrow-viewport layout only");
  const workspace = makeWorkspace("git-mobile-layout");
  await page.route("**/api/git/status?*", (route) => route.fulfill({ json: {
    isGitRepository: true, repositoryRoot: workspace, branch: "main",
    files: [{ filePath: "README.md", status: "modified", code: "M", indexStatus: " ", worktreeStatus: "M" }],
  } }));
  await page.route("**/api/git/diff?*", (route) => route.fulfill({ json: {
    supported: true, patch: "@@ -1 +1 @@\n-old\n+new\n", fingerprint: "f1",
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
  await expect(page.getByRole("button", { name: /View diff: README.md/ })).toBeVisible();
  await page.getByRole("button", { name: /View diff: README.md/ }).click();
  const backButton = page.getByRole("button", { name: "Back to changes" });
  await expect(backButton).toBeVisible();
  // The file list must be gone (not squeezed to ~100px) while a diff is open.
  await expect(page.getByRole("button", { name: /View diff: README.md/ })).toHaveCount(0);
  await backButton.click();
  await expect(page.getByRole("button", { name: /View diff: README.md/ })).toBeVisible();
});
```

Run: `npx playwright test e2e/mobile-a11y.spec.ts`

- [ ] **Step 7: Commit.**

```bash
git add components/GitReviewPanel.tsx e2e/mobile-a11y.spec.ts
git commit -m "fix: stack Git panel list/diff vertically on narrow screens"
```

---

### Task 3: QR code expiry — auto state refresh + "Expired — Refresh"

**Problem:** `components/MobileAccessDialog.tsx` requests a single-use pairing token (`POST /api/auth/pair`) that expires after 5 minutes (`PAIRING_TTL_MS` in `server/auth.cjs`) and encodes it into the displayed QR code. Once it expires, the dialog keeps showing the same QR and the same "expires at HH:MM" message — scanning it after expiry fails with no visible indication why, and there is no way to get a fresh code without closing and reopening the dialog (the existing header refresh button re-fetches, but nothing prompts the user to use it).

**Files:**
- Modify: `components/MobileAccessDialog.tsx:15-21` (state), `components/MobileAccessDialog.tsx:84-97` (`pairingUrl`/`copyUrl`), `components/MobileAccessDialog.tsx:138-166` (QR/copy/expiry render)
- Modify: `e2e/mobile-a11y.spec.ts` (new test)

- [ ] **Step 1: Track wall-clock time and derive expiry.** In `MobileAccessDialog`, add a `now` state next to the existing state block (`components/MobileAccessDialog.tsx:15-21`):

```ts
  const [now, setNow] = useState(() => Date.now());
```

Add an effect, after the existing pairing-related effects, that schedules exactly one re-check per `pairing` value (not a recurring interval — this avoids a background timer running for the life of the dialog and avoids `now` depending on itself):

```ts
  useEffect(() => {
    if (!pairing) return;
    const delay = Math.max(0, pairing.expiresAt - Date.now()) + 250;
    const timer = window.setTimeout(() => setNow(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [pairing]);
```

- [ ] **Step 2: Derive `pairingExpired` and stop encoding/copying an expired token.** After the existing `pairingUrl` useMemo (`components/MobileAccessDialog.tsx:84-89`), add:

```ts
  const pairingExpired = pairing ? now >= pairing.expiresAt : false;
  const effectivePairingUrl = pairingUrl && !pairingExpired ? pairingUrl : null;
```

Change the QR code and the copy/label logic to use `effectivePairingUrl` instead of `pairingUrl` everywhere they currently read it:

- The `QRCodeSVG` (`components/MobileAccessDialog.tsx:139`): `value={effectivePairingUrl ?? selected.origin}` and `title={effectivePairingUrl ? "Sign in to TianForge pi" : \`Open ${selected.origin}\`}`.
- `copyUrl` (`components/MobileAccessDialog.tsx:93-97`): `await copyText(effectivePairingUrl ?? selected.origin);`.
- The copy button's label (`components/MobileAccessDialog.tsx:144`): `{copied ? "Copied" : effectivePairingUrl ? "Copy sign-in link" : "Copy link"}`.

This means an expired token is never encoded into the QR or copied to the clipboard — the dialog falls back to the plain (still password-gated) origin QR once expired, exactly like the "automatic sign-in unavailable" case already does.

- [ ] **Step 3: Replace the expiry-message block with a three-way branch that adds an inline "Expired — Refresh" button.** Replace the existing block (`components/MobileAccessDialog.tsx:162-166`):

```tsx
              {selected?.reachable && info.passwordRequired && (
                pairingUrl && pairingExpired
                  ? (
                    <div style={warningStyle}>
                      This sign-in link expired at {new Date(pairing!.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.
                      {" "}
                      <button type="button" onClick={() => void load()} style={inlineRefreshButtonStyle}>
                        <RefreshCw size={13} />Expired — Refresh
                      </button>
                    </div>
                  )
                  : pairingUrl
                    ? <div style={safeStyle}><ShieldCheck size={14} />Scan to sign in automatically—no password entry. This link works once and expires at {new Date(pairing!.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.</div>
                    : <div style={warningStyle}>Automatic sign-in is unavailable{pairingError ? `: ${pairingError}` : ""}. Refresh after restarting the server, or enter the password on the phone.</div>
              )}
```

Add the new style constant next to the file's other style constants (`components/MobileAccessDialog.tsx:225-230`, near `secondaryButtonStyle`):

```ts
const inlineRefreshButtonStyle: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 7px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg-hover)", color: "var(--text)", cursor: "pointer", font: "10.5px/1 inherit" };
```

- [ ] **Step 4: Run the gates.**

Run: `npx tsc --noEmit -p .`
Run: `npx eslint components/MobileAccessDialog.tsx`
Run: `npm test`

- [ ] **Step 5: Append an expiry e2e test to `e2e/mobile-a11y.spec.ts`.**

```ts
test("expired pairing QR shows Expired — Refresh instead of a dead code", async ({ page }) => {
  const workspace = makeWorkspace("qr-expiry");
  let pairCalls = 0;
  await page.route("**/api/access", (route) => route.fulfill({ json: {
    protocol: "http", listenHost: "0.0.0.0", port: 30142, passwordRequired: true,
    addresses: [{ id: "lan", label: "LAN", address: "192.168.1.20", origin: "http://192.168.1.20:30142", kind: "lan", reachable: true }],
  } }));
  await page.route("**/api/auth/pair", (route) => {
    pairCalls += 1;
    const expiresAt = pairCalls === 1 ? Date.now() + 300 : Date.now() + 300_000;
    return route.fulfill({ json: { token: `token-${pairCalls}`, expiresAt } });
  });
  await page.route("**/api/git/status?*", (route) => route.fulfill({ json: { isGitRepository: false, files: [] } }));
  await page.route("**/api/worktrees?*", (route) => route.fulfill({ json: { projectRoot: workspace, isGit: false, isTopLevel: true, worktrees: [] } }));
  await page.route("**/api/cwd/validate", (route) => route.fulfill({ json: { success: true, cwd: workspace } }));
  await page.route("**/api/sessions", (route) => route.fulfill({ json: { sessions: [], runningSessionIds: [] } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Remote access" }).click();
  await expect(page.getByText(/expires at/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Expired — Refresh" })).toBeVisible({ timeout: 3000 });
  await page.getByRole("button", { name: "Expired — Refresh" }).click();
  await expect(page.getByText(/Scan to sign in automatically/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Expired — Refresh" })).toHaveCount(0);
});
```

Run: `npx playwright test e2e/mobile-a11y.spec.ts`

- [ ] **Step 6: Commit.**

```bash
git add components/MobileAccessDialog.tsx e2e/mobile-a11y.spec.ts
git commit -m "fix: refresh expired mobile pairing QR instead of showing a dead code"
```

---

### Task 4: Message list — reduce per-token re-render cost and stabilize keys across "load earlier"

**Problem:** Two related bugs in `components/ChatWindow.tsx`'s message rendering, both fixed together because they're the same code block:
1. **Performance:** The big message-rendering IIFE (builds `toolResultsMap`, scans for the last user/anchor index, builds `renderMessage`, and groups messages into `ProcessDetailsGroup`s) re-runs on every render, including every streaming token update — even though it only reads `streamState.isStreaming` (a boolean that flips twice per turn), never `streamState.streamingMessage` (which changes every token).
2. **Correctness:** Rendered message/group keys use the array index (`` `${keyPrefix}-view-${idx}` ``, `` `${keyPrefix}-${idx}` ``). After "load earlier messages" prepends older entries, every existing message's index shifts, so React unmounts and remounts each `MessageView` under a new key — collapsing any expanded `ThinkingBlock`/`ToolCallBlock` the user had open.

**Files:**
- Modify: `components/ChatWindow.tsx:649-829` (the message-rendering IIFE)
- Modify: `e2e/mobile-a11y.spec.ts` (new test)

**Interfaces:**
- Consumes: `entryIds: string[]` (already produced by `useAgentSession()`, already parallel to `messages`).

- [ ] **Step 1: Wrap the message-rendering IIFE in `useMemo`, and switch its keys from `idx` to `entryIds[idx] ?? idx`.** In `components/ChatWindow.tsx`, the render currently reads:

```tsx
{(() => {
  ...
})()}
```

starting at `components/ChatWindow.tsx:649` and ending at `components/ChatWindow.tsx:829`. Change the wrapping syntax from an immediately-invoked function to a memoized one, keeping the entire function body identical except for the two key template literals:

```tsx
{useMemo(() => {
  const toolResultsMap = new Map<string, ToolResultMessage>();
  // ...unchanged body...
  const renderMessage = (idx: number, options: {
    keyPrefix?: string;
    messageOverride?: AgentMessage;
    showTimestamp?: boolean;
    attachRef?: boolean;
  } = {}): ReactNode => {
    const msg = options.messageOverride ?? messages[idx];
    const prevAssistantEntryId = msg.role === "user" && idx > 0 && messages[idx - 1].role === "assistant" ? entryIds[idx - 1] : undefined;
    const isVisible = msg.role === "user" || msg.role === "assistant";
    const currentRefIdx = visibleRefIndexByMessage.get(idx);
    const keyPrefix = options.keyPrefix ?? "message";
    const stableKey = entryIds[idx] ?? idx;
    let showTimestamp = false;
    if (msg.role === "assistant") {
      showTimestamp = true;
      for (let j = idx + 1; j < messages.length; j++) {
        if (messages[j].role === "assistant") { showTimestamp = false; break; }
        if (messages[j].role === "user") break;
      }
      if (showTimestamp && streamState.isStreaming && idx === messages.length - 1) { showTimestamp = false; }
    }
    if (options.showTimestamp !== undefined) showTimestamp = options.showTimestamp;
    const view = (
      <MessageView
        key={`${keyPrefix}-view-${stableKey}`}
        message={msg}
        toolResults={toolResultsMap}
        modelNames={modelNames}
        cwd={messageCwd}
        onOpenFile={handleOpenFile}
        entryId={entryIds[idx]}
        onFork={sessionBusy || isNew || (idx === 0 && msg.role === "user") ? undefined : handleFork}
        forking={forkingEntryId === entryIds[idx]}
        onNavigate={sessionBusy ? undefined : handleNavigate}
        prevAssistantEntryId={sessionBusy ? undefined : prevAssistantEntryId}
        onEditContent={handleEditContent}
        showTimestamp={showTimestamp}
        prevTimestamp={idx > 0 ? (messages[idx - 1] as AgentMessage & { timestamp?: number }).timestamp : undefined}
        sessionId={session?.id ?? sessionIdRef.current ?? undefined}
      />
    );
    if (!isVisible || options.attachRef === false || currentRefIdx === undefined) return view;
    return (
      <div key={`${keyPrefix}-${stableKey}`} data-entry-id={entryIds[idx] ?? undefined} className="[content-visibility:auto] [contain-intrinsic-size:0_480px]" ref={attachVisibleRef(idx, currentRefIdx)}>
        {view}
      </div>
    );
  };
  // ...unchanged remainder of the body (grouping loop, ProcessDetailsGroup, tail loop, final return)...
}, [messages, entryIds, streamState.isStreaming, sessionBusy, isNew, forkingEntryId, handleFork, handleNavigate, handleEditContent, messageCwd, modelNames, session?.id, hasOlderMessages, loadingOlderMessages, handleOpenFile])}
```

Do not otherwise change the body: `toolResultsMap` construction, the `lastUserIdx`/`lastAnchorIdx` scans, `visibleRefIndexByMessage`, `attachVisibleRef`, the main grouping loop (`isLiveTail`, `ProcessDetailsGroup` block, `finalAnswerMessage`, tail loop), and the trailing `(hasOlderMessages || loadingOlderMessages)` sentinel + `rendered` fragment all stay exactly as they are today — only (a) the outer `(() => {...})()` becomes `useMemo(() => {...}, [deps])`, (b) the two key template literals switch from `idx` to `stableKey` (`entryIds[idx] ?? idx`), and (c) the visible-message wrapper `<div>` gains `data-entry-id` and the `content-visibility` className. `streamState.isStreaming` is a stable boolean that only flips at start/stop of a turn (see `streamReducer` in `hooks/useAgentSession.ts`); the memo's dependency array deliberately omits `streamState.streamingMessage`, which changes every token but is never read inside this block — that's what makes wrapping it in `useMemo` actually skip work during streaming instead of running on every token.

- [ ] **Step 2: Run the gates.**

Run: `npx tsc --noEmit -p .`
Run: `npx eslint components/ChatWindow.tsx`
Run: `npm test`

- [ ] **Step 3: Append a key-stability e2e test to `e2e/mobile-a11y.spec.ts`.** Before writing the route mock, grep `loadOlderMessages` in `hooks/useAgentSession.ts` to confirm the query parameter it sends for "give me older messages" (this plan assumes `before`; adjust the `url.searchParams.get(...)` check below if the real implementation uses a different name):

```ts
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
  await page.route(`**/api/sessions/${sessionId}/state`, (route) => route.fulfill({ json: { running: false, state: { isStreaming: false, isPromptRunning: false, isBashRunning: false, isCompacting: false } } }));
  await page.route(`**/api/sessions/${sessionId}?*`, (route) => route.fulfill({ json: {
    sessionId, filePath: `${cwd}/session.jsonl`,
    info: { id: sessionId, path: `${cwd}/session.jsonl`, cwd, projectRoot: cwd, created: "2026-09-28T00:00:00.000Z", modified: "2026-09-28T00:00:00.000Z", messageCount: 4, firstMessage: "Older question" },
    leafId: "recent-assistant", tree: [],
    context: { messages: recentMessages, entryIds: ["recent-user", "recent-assistant"], page: { hasMore: true }, thinkingLevel: "medium", model: { provider: "openai-codex", modelId: "gpt-5.6-sol" } },
  } }));
  await page.route(`**/api/sessions/${sessionId}/context?*`, (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("before")) {
      loadedOlder = true;
      return route.fulfill({ json: { context: {
        messages: [...olderMessages, ...recentMessages], entryIds: ["older-user", "older-assistant", "recent-user", "recent-assistant"],
        page: { hasMore: false }, thinkingLevel: "medium", model: { provider: "openai-codex", modelId: "gpt-5.6-sol" },
      } } });
    }
    return route.fulfill({ json: { context: {
      messages: recentMessages, entryIds: ["recent-user", "recent-assistant"], page: { hasMore: true },
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
  await page.getByRole("button", { name: "Thinking" }).click();
  await expect(page.getByText("Let me consider this.")).toBeVisible();
  await expect.poll(() => loadedOlder).toBe(true);
  await expect(page.getByText("Older answer")).toBeVisible();
  await expect(page.getByText("Let me consider this.")).toBeVisible();
});
```

Run: `npx playwright test e2e/mobile-a11y.spec.ts`

- [ ] **Step 4: Commit.**

```bash
git add components/ChatWindow.tsx e2e/mobile-a11y.spec.ts
git commit -m "perf: memoize message rendering and use stable entry ids as React keys"
```

---

### Task 5: Hover-only Copy/Edit/Fork buttons — visible on focus-within and touch

**Problem:** `components/MessageView.tsx`'s `UserMessageView` and `AssistantMessageView` both gate their Copy/Edit/Fork buttons behind a `hovered` boolean set only by `onMouseEnter`/`onMouseLeave` on the message's outer wrapper div. A keyboard user tabbing to one of these buttons lands on an invisible (`opacity: 0`) control, and a touch user (no `:hover` at all) can never make them appear.

**Files:**
- Modify: `components/MessageView.tsx:3` (import), `components/MessageView.tsx:173-174` (`UserMessageView` state), `components/MessageView.tsx:201-205` (`UserMessageView` wrapper), `components/MessageView.tsx:257-261` (`UserMessageView` copy-button opacity), `components/MessageView.tsx:293-298` (`UserMessageView` fork/edit-button opacity), `components/MessageView.tsx:390-391` (`AssistantMessageView` state), `components/MessageView.tsx:496-499` (`AssistantMessageView` wrapper), `components/MessageView.tsx:598-599` (`AssistantMessageView` copy-button opacity)
- Modify: `e2e/mobile-a11y.spec.ts` (new test)

**Interfaces:**
- Consumes: `useCoarsePointer(): boolean` from Task 1.

- [ ] **Step 1: Import `useCoarsePointer`.** Add to `components/MessageView.tsx`, near its existing `react` import (`components/MessageView.tsx:3`):

```ts
import { useCoarsePointer } from "@/hooks/useIsMobile";
```

- [ ] **Step 2: Make `UserMessageView`'s action buttons visible on focus-within and touch.** Add `const isCoarsePointer = useCoarsePointer();` right after the existing `const [copied, setCopied] = useState(false);` (`components/MessageView.tsx:174`). Change the outer wrapper (`components/MessageView.tsx:201-205`) to also track focus:

```tsx
    <div
      style={{ marginBottom: 16, display: "flex", flexDirection: "column", alignItems: "flex-end" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setHovered(false); }}
    >
```

Change the copy-button group's opacity/pointer-events (`components/MessageView.tsx:257-261`, currently `opacity: hovered ? 1 : 0, pointerEvents: hovered ? "auto" : "none",`) to:

```tsx
          opacity: (hovered || isCoarsePointer) ? 1 : 0,
          pointerEvents: (hovered || isCoarsePointer) ? "auto" : "none",
```

Change the fork/edit-button group's opacity/pointer-events (`components/MessageView.tsx:293-298`, currently `opacity: (hovered || forking) ? 1 : 0, pointerEvents: (hovered || forking) ? "auto" : "none",`) to:

```tsx
              opacity: (hovered || forking || isCoarsePointer) ? 1 : 0,
              pointerEvents: (hovered || forking || isCoarsePointer) ? "auto" : "none",
```

- [ ] **Step 3: Apply the same treatment to `AssistantMessageView`'s Copy button.** Add `const isCoarsePointer = useCoarsePointer();` right after the existing `const [copied, setCopied] = useState(false);` (`components/MessageView.tsx:391`). Change the outer wrapper (`components/MessageView.tsx:496-499`):

```tsx
    <div
      style={{ marginBottom: 16 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setHovered(false); }}
    >
```

Change the Copy button's opacity/pointer-events (`components/MessageView.tsx:598-599`, currently `opacity: hovered ? 1 : 0, pointerEvents: hovered ? "auto" : "none",`) to:

```tsx
              opacity: (hovered || isCoarsePointer) ? 1 : 0,
              pointerEvents: (hovered || isCoarsePointer) ? "auto" : "none",
```

- [ ] **Step 4: Run the gates.**

Run: `npx tsc --noEmit -p .`
Run: `npx eslint components/MessageView.tsx`
Run: `npm test`

- [ ] **Step 5: Append a focus-visibility e2e test to `e2e/mobile-a11y.spec.ts`.**

```ts
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
  const copyButton = page.getByRole("button", { name: "Copy message" });
  await expect(copyButton).toHaveCSS("opacity", "0");
  await copyButton.focus();
  await expect(copyButton).toHaveCSS("opacity", "1");
});
```

Run: `npx playwright test e2e/mobile-a11y.spec.ts`

- [ ] **Step 6: Commit.**

```bash
git add components/MessageView.tsx e2e/mobile-a11y.spec.ts
git commit -m "fix: show hover-only message action buttons on focus and touch too"
```

---

### Task 6: Branch tree keyboard operability — roving tabindex, arrow keys, Enter

**Problem:** `components/BranchNavigator.tsx`'s `TreeNodeView` row is a plain `<div onClick={...}>` with no `role`, `tabIndex`, or `onKeyDown` — a keyboard-only user cannot reach or activate any branch in the tree at all.

**Files:**
- Modify: `components/BranchNavigator.tsx:83-90` (`TreeNodeProps`), `components/BranchNavigator.tsx:104-112` (row div), `components/BranchNavigator.tsx:204-214` (recursive children render), `components/BranchNavigator.tsx:219-257` (`BranchNavigator` state), `components/BranchNavigator.tsx:306-337` (inline dropdown container), `components/BranchNavigator.tsx:341-399` (non-inline panel container)
- Modify: `e2e/mobile-a11y.spec.ts` (new test)

**Interfaces:**
- Produces: `data-branch-row` / `data-entry-id` attributes on each row, following the same pattern `components/FileExplorer.tsx` already uses (`data-explorer-row` / `data-file-path`).

- [ ] **Step 1: Add `focusedId`/`onFocusRow` to `TreeNodeProps` and make each row a focusable, keyboard-activatable treeitem.** In the `TreeNodeProps` interface (`components/BranchNavigator.tsx:83-90`), add:

```ts
  focusedId: string;
  onFocusRow: (id: string) => void;
```

Change the row div (`components/BranchNavigator.tsx:104-112`, currently `<div style={{ display: "flex", alignItems: "center", height: 24, cursor: "pointer" }} onClick={() => onSelect(rep.entry.id)}>`) to:

```tsx
      <div
        data-branch-row
        data-entry-id={rep.entry.id}
        role="treeitem"
        aria-selected={activePathIds.has(rep.entry.id)}
        tabIndex={focusedId === rep.entry.id ? 0 : -1}
        style={{ display: "flex", alignItems: "center", height: 24, cursor: "pointer" }}
        onClick={() => onSelect(rep.entry.id)}
        onFocus={() => onFocusRow(rep.entry.id)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect(rep.entry.id);
          }
        }}
      >
```

(`activePathIds.has(rep.entry.id)` mirrors however the row already determines `isActive`/highlighting today — use the same expression the row's existing highlight styling reads, so `aria-selected` matches what's visually shown as active.)

- [ ] **Step 2: Thread `focusedId`/`onFocusRow` through the recursive children render.** At `components/BranchNavigator.tsx:204-214`, add `focusedId={focusedId}` and `onFocusRow={onFocusRow}` to the recursive `<TreeNodeView>` call alongside the existing `activePathIds, depth={depth + 1}, isLast, parentLines, onSelect` props.

- [ ] **Step 3: Add `focusedId` state and a roving-tabindex arrow-key handler to `BranchNavigator`.** In `BranchNavigator` (`components/BranchNavigator.tsx:219-257`), add next to the existing `handleSelect` useCallback:

```ts
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const handleFocusRow = useCallback((id: string) => setFocusedId(id), []);
  const effectiveFocusedId = focusedId ?? activeLeafId ?? "";
```

Add a shared keydown handler (arrow-key roving focus, mirroring `components/FileExplorer.tsx`'s existing `data-explorer-row` delegated handler):

```ts
  const handleTreeKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (!(event.target instanceof Element)) return;
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-branch-row]"));
    const row = event.target.closest<HTMLElement>("[data-branch-row]");
    const index = row ? rows.indexOf(row) : -1;
    event.preventDefault();
    const nextIndex = Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
    rows[nextIndex]?.focus();
  }, []);
```

- [ ] **Step 4: Wire `role="tree"`, the keydown handler, and `focusedId`/`onFocusRow` into both dropdown containers.** In the inline dropdown container (`components/BranchNavigator.tsx:306-337`), the content wrapper currently reads:

```tsx
        <div style={{ padding: "4px 12px 8px 12px", maxHeight: 260, overflowY: "auto" }}>
          {firstNode.children.map((child, idx) => (
            <TreeNodeView key={child.entry.id} node={child} activePathIds={activePathIds} depth={0} isLast={idx === firstNode.children.length - 1} parentLines={[]} onSelect={handleSelect} />
          ))}
        </div>
```

Change it to:

```tsx
        <div
          role="tree"
          aria-label="Branches"
          onKeyDown={handleTreeKeyDown}
          style={{ padding: "4px 12px 8px 12px", maxHeight: 260, overflowY: "auto" }}
        >
          {firstNode.children.map((child, idx) => (
            <TreeNodeView key={child.entry.id} node={child} activePathIds={activePathIds} depth={0} isLast={idx === firstNode.children.length - 1} parentLines={[]} onSelect={handleSelect} focusedId={effectiveFocusedId} onFocusRow={handleFocusRow} />
          ))}
        </div>
```

Apply the identical change to the non-inline panel container's matching block (`components/BranchNavigator.tsx:341-399`, the same `firstNode.children.map(...)` pattern).

- [ ] **Step 5: Run the gates.**

Run: `npx tsc --noEmit -p .`
Run: `npx eslint components/BranchNavigator.tsx`
Run: `npm test`

- [ ] **Step 6: Append a keyboard-navigation e2e test to `e2e/mobile-a11y.spec.ts`.**

```ts
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

  await page.goto(`/?session=${sessionId}`);
  await expect(page.getByText("Branch A", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Branches" }).click();
  const tree_ = page.getByRole("tree", { name: "Branches" });
  await expect(tree_).toBeVisible();
  const firstRow = tree_.locator("[data-branch-row]").first();
  await firstRow.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Branch B", { exact: true })).toBeVisible();
});
```

Run: `npx playwright test e2e/mobile-a11y.spec.ts`

- [ ] **Step 7: Commit.**

```bash
git add components/BranchNavigator.tsx e2e/mobile-a11y.spec.ts
git commit -m "fix: make the branch tree keyboard operable with roving tabindex"
```

---

### Task 7: Login rate limiting behind a reverse proxy

**Problem:** `server/auth.cjs`'s `clientKey(req)` returns `req.socket.remoteAddress` — correct when TianForge pi is exposed directly (`X-Forwarded-For` would otherwise be client-spoofable), but wrong when it sits behind a local reverse proxy (Tailscale Serve, nginx): every request's direct peer is then `127.0.0.1`, so `clientKey` returns the same key for every real client, and one person's 8 failed logins (`MAX_LOGIN_FAILURES`) locks out everyone else for 15 minutes (`LOGIN_WINDOW_MS`).

**Files:**
- Modify: `server/auth.cjs:113-119` (`clientKey`)
- Modify: `server/agents/auth-hardening.test.cjs` (new tests)
- Modify: `AGENTS.md:301`
- Modify: `README.md` (new subsection after "Allowed hosts", before "## HTTP Proxy")

**Interfaces:**
- Produces: `PI_WEB_TRUST_PROXY=1` environment variable, read only inside `server/auth.cjs`.

- [ ] **Step 1: Rewrite `clientKey` to only trust `X-Forwarded-For` from a loopback peer when explicitly opted in.** Replace `server/auth.cjs:113-119`:

```js
function isLoopbackAddress(address) {
  if (!address) return false;
  const normalized = address.replace(/^::ffff:/, "");
  return normalized === "127.0.0.1" || normalized === "::1";
}

/**
 * Rate-limit key for login attempts. The direct socket peer is always trusted.
 * X-Forwarded-For is only honored when that peer is loopback AND the operator
 * has explicitly opted in via PI_WEB_TRUST_PROXY=1 — otherwise X-Forwarded-For
 * is client-controlled whenever the server is exposed directly, and unconditionally
 * trusting it behind a local reverse proxy (Tailscale Serve, nginx) has the
 * opposite problem: every request's peer is 127.0.0.1, so one person's failed
 * logins would key-collide with (and lock out) everyone else.
 */
function clientKey(req) {
  const remoteAddress = req?.socket?.remoteAddress || null;
  if (process.env.PI_WEB_TRUST_PROXY === "1" && isLoopbackAddress(remoteAddress)) {
    const forwardedFor = req?.headers?.["x-forwarded-for"];
    const firstHop = typeof forwardedFor === "string" ? forwardedFor.split(",")[0].trim() : "";
    if (firstHop) return firstHop;
  }
  return remoteAddress || "local";
}
```

- [ ] **Step 2: Run the gates.**

Run: `npx tsc --noEmit -p .`
Run: `npx eslint server/auth.cjs`

- [ ] **Step 3: Add tests covering both the opt-in and the default-off behavior.** Append to `server/agents/auth-hardening.test.cjs`, after the existing `"login rate-limit key ignores spoofable X-Forwarded-For"` test:

```js
test("login rate-limit key honors X-Forwarded-For from a loopback peer only when PI_WEB_TRUST_PROXY=1", () => {
  const original = process.env.PI_WEB_TRUST_PROXY;
  try {
    process.env.PI_WEB_TRUST_PROXY = "1";
    const req = { headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" }, socket: { remoteAddress: "127.0.0.1" } };
    assert.equal(auth.clientKey(req), "203.0.113.7");
  } finally {
    if (original === undefined) delete process.env.PI_WEB_TRUST_PROXY;
    else process.env.PI_WEB_TRUST_PROXY = original;
  }
});

test("login rate-limit key ignores X-Forwarded-For from a loopback peer when PI_WEB_TRUST_PROXY is unset", () => {
  const original = process.env.PI_WEB_TRUST_PROXY;
  try {
    delete process.env.PI_WEB_TRUST_PROXY;
    const req = { headers: { "x-forwarded-for": "203.0.113.7" }, socket: { remoteAddress: "127.0.0.1" } };
    assert.equal(auth.clientKey(req), "127.0.0.1");
  } finally {
    if (original === undefined) delete process.env.PI_WEB_TRUST_PROXY;
    else process.env.PI_WEB_TRUST_PROXY = original;
  }
});

test("login rate-limit key ignores X-Forwarded-For from a non-loopback peer even when PI_WEB_TRUST_PROXY=1", () => {
  const original = process.env.PI_WEB_TRUST_PROXY;
  try {
    process.env.PI_WEB_TRUST_PROXY = "1";
    const req = { headers: { "x-forwarded-for": "203.0.113.7" }, socket: { remoteAddress: "10.0.0.5" } };
    assert.equal(auth.clientKey(req), "10.0.0.5");
  } finally {
    if (original === undefined) delete process.env.PI_WEB_TRUST_PROXY;
    else process.env.PI_WEB_TRUST_PROXY = original;
  }
});
```

Run: `node --require ./server/test-env.cjs --test server/agents/auth-hardening.test.cjs`

- [ ] **Step 4: Run the full test suite.**

Run: `npm test`

- [ ] **Step 5: Document the setting.** Update the stale sentence at `AGENTS.md:301` (currently: "Request bodies read by the custom server (login, terminal and Codex APIs) go through `server/http-body.cjs`, which stops buffering once the limit is exceeded. Login rate limiting keys on the socket address; `X-Forwarded-For` is client-controlled when the server is exposed directly.") to:

```
- Request bodies read by the custom server (login, terminal and Codex APIs) go through `server/http-body.cjs`, which stops buffering once the limit is exceeded. Login rate limiting keys on the socket address by default, since `X-Forwarded-For` is client-controlled when the server is exposed directly; behind a local reverse proxy (Tailscale Serve, nginx) the direct peer is always loopback, so set `PI_WEB_TRUST_PROXY=1` to key on `X-Forwarded-For` instead — only honored when the direct peer actually is loopback, so a directly-exposed server ignores the header even with the flag set.
```

Add a new subsection to `README.md`, after "### Allowed hosts" and before "## HTTP Proxy":

```markdown
### Reverse proxy login rate limiting

Failed logins are rate-limited (8 failures locks out further attempts from that client for 15 minutes) keyed on the direct TCP peer address, because `X-Forwarded-For` can be set by anyone when TianForge pi is reachable directly. If you put TianForge pi behind a local reverse proxy (Tailscale Serve, nginx) instead, every request's direct peer becomes the proxy's loopback address, so one person's failed logins would lock out every other user. Set `PI_WEB_TRUST_PROXY=1` to key on `X-Forwarded-For` instead — only honored when the direct peer is loopback, so this has no effect (and is safe to leave set) if the server is ever reached directly:

```bash
PI_WEB_TRUST_PROXY=1 pi-web
```
```

- [ ] **Step 6: Commit.**

```bash
git add server/auth.cjs server/agents/auth-hardening.test.cjs AGENTS.md README.md
git commit -m "fix: honor X-Forwarded-For for login rate limiting only behind a trusted local proxy"
```

---

### Task 8: Attach `projectRoot` to terminal, Codex, and Claude runtime records and notifications

**Problem (part 1 of 2 — deferred item):** Terminal sessions (`server/agents/terminal-manager.cjs`), Codex runtimes (`server/agents/codex-app-server.cjs`), and Claude chat runtimes (`server/agents/claude-chat-runtime.cjs`) all track only `cwd`, never a resolved `projectRoot`. `server/notifications.cjs`'s `add()` already accepts and stores an optional `projectRoot` (only kept when it differs from `cwd`), but none of these three callers ever supply one — so a terminal/Codex/Claude notification from a non-primary worktree can never be matched back to the project it belongs to (`lib/activity-notifications.ts`'s `notificationWorkspace`/`notificationOpenWorkspace` already check both `cwd` and `projectRoot` correctly; they just never receive a `projectRoot` value for these three kinds).

**Files:**
- Create: `server/agents/project-root.cjs`
- Create: `server/agents/project-root.test.cjs`
- Modify: `server/agents/terminal-manager.cjs:118-127` (`setActivity`), `server/agents/terminal-manager.cjs:235-262` (`publicSession`), `server/agents/terminal-manager.cjs:327-380` (`createTerminal`), `server/agents/terminal-manager.cjs:386-399` (`recordExit`)
- Modify: `server/agents/codex-app-server.cjs:109-119` (`recordNotification`), `server/agents/codex-app-server.cjs:120-137` (`failState`), `server/agents/codex-app-server.cjs:139-153` (`spawnRuntime`), `server/agents/codex-app-server.cjs:255-262` (`listRuntimes`)
- Modify: `server/agents/claude-chat-runtime.cjs:157-176` (`open`), `server/agents/claude-chat-runtime.cjs:275-293` (`finishTurn`), `server/agents/claude-chat-runtime.cjs:296-305` (`onExit`), `server/agents/claude-chat-runtime.cjs:498-500` (`listRuntimes`)
- Modify: `lib/workspace-status-store.ts:3-24` (`CodexRuntimeStatus`, `ClaudeRuntimeStatus`)
- Modify: `lib/agents/terminal.ts:34-59` (`TerminalSession`)

**Interfaces:**
- Produces: `resolveProjectRoot(cwd: string): Promise<string>` and `_resetForTests(): void`, exported from `server/agents/project-root.cjs`. Consumed by Task 9's `lib/rail-activity.ts` change indirectly, through the `projectRoot` field this task adds to `TerminalSession`, `CodexRuntimeStatus`, and `ClaudeRuntimeStatus`.
- Produces: `projectRoot?: string` added to `TerminalSession` (`lib/agents/terminal.ts`), `CodexRuntimeStatus`, and `ClaudeRuntimeStatus` (`lib/workspace-status-store.ts`) — the exact same optional-string shape `SessionInfo.projectRoot` already uses.

- [ ] **Step 1: Write the failing test for `resolveProjectRoot`.** Create `server/agents/project-root.test.cjs`, modeled on the real-temp-git-repo pattern already used by `lib/git-exec.test.mjs`:

```js
"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { resolveProjectRoot, _resetForTests } = require("./project-root.cjs");

function initRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-project-root-")));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

test("resolveProjectRoot returns the main checkout for a linked worktree", async () => {
  _resetForTests();
  const main = initRepo();
  const worktreeDir = path.join(os.tmpdir(), `pi-web-project-root-wt-${Date.now()}`);
  execFileSync("git", ["worktree", "add", "-b", "feature/x", worktreeDir], { cwd: main });
  try {
    const root = await resolveProjectRoot(fs.realpathSync(worktreeDir));
    assert.equal(root, main);
    assert.equal(await resolveProjectRoot(main), main);
  } finally {
    execFileSync("git", ["worktree", "remove", "--force", worktreeDir], { cwd: main });
  }
});

test("resolveProjectRoot returns the cwd itself for a non-git directory", async () => {
  _resetForTests();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-project-root-plain-")));
  assert.equal(await resolveProjectRoot(dir), dir);
});

test("resolveProjectRoot caches results for repeated calls", async () => {
  _resetForTests();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-project-root-cache-")));
  const first = await resolveProjectRoot(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  const second = await resolveProjectRoot(dir);
  assert.equal(second, first);
});
```

- [ ] **Step 2: Run it to confirm it fails.**

Run: `node --require ./server/test-env.cjs --test server/agents/project-root.test.cjs`
Expected: FAIL with "Cannot find module './project-root.cjs'"

- [ ] **Step 3: Implement `server/agents/project-root.cjs`.**

```js
"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const { execFile } = require("node:child_process");
const { existsSync, realpathSync } = require("node:fs");
const { dirname } = require("node:path");

const CACHE_TTL_MS = 60_000;
const cache = global.__piWebProjectRootCache || new Map();
global.__piWebProjectRootCache = cache;

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: 10_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

/**
 * Resolves a cwd to its project root: the main checkout directory for a
 * linked Git worktree, or the cwd itself for a main checkout or a non-git
 * directory. Mirrors lib/worktree.ts's resolveProject() for CJS server
 * modules, which cannot require() a TypeScript/ESM module from lib/.
 * Cached for 60s per cwd, same TTL as the TS/ESM version.
 */
async function resolveProjectRoot(cwd) {
  const cached = cache.get(cwd);
  if (cached && cached.expiresAt > Date.now()) return cached.root;
  let root = cwd;
  try {
    if (existsSync(cwd)) {
      const out = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir", "--show-toplevel"]);
      const [commonDir, gitDir, toplevel] = out.split("\n").map((line) => line.trim());
      let realCwd = cwd;
      try { realCwd = realpathSync(cwd); } catch { /* keep as-is */ }
      if (gitDir !== commonDir && toplevel === realCwd) root = dirname(commonDir);
    }
  } catch {
    // Not a git repo, or git unavailable: cwd is its own root.
  }
  cache.set(cwd, { root, expiresAt: Date.now() + CACHE_TTL_MS });
  return root;
}

function _resetForTests() {
  cache.clear();
}

module.exports = { resolveProjectRoot, _resetForTests };
```

- [ ] **Step 4: Run the test to confirm it passes.**

Run: `node --require ./server/test-env.cjs --test server/agents/project-root.test.cjs`
Expected: PASS

- [ ] **Step 5: Add `projectRoot` to the TypeScript record shapes.** In `lib/agents/terminal.ts`, add to the `TerminalSession` interface (`lib/agents/terminal.ts:34-59`):

```ts
  projectRoot?: string;
```

In `lib/workspace-status-store.ts`, add the same field to both `CodexRuntimeStatus` (`lib/workspace-status-store.ts:3-11`) and `ClaudeRuntimeStatus` (`lib/workspace-status-store.ts:14-24`):

```ts
  projectRoot?: string;
```

- [ ] **Step 6: Attach `projectRoot` in `terminal-manager.cjs`.** Add near its other `require`s at the top of the file:

```js
const { resolveProjectRoot } = require("./project-root.cjs");
```

In `createTerminal` (`server/agents/terminal-manager.cjs:327-380`), right after the `session` object is constructed and set into `state.sessions` (currently ending with `state.sessions.set(session.id, session);`), add:

```js
  session.projectRoot = cwd;
  resolveProjectRoot(cwd).then((root) => { session.projectRoot = root; }).catch(() => {});
```

(Set synchronously to `cwd` first so `session.projectRoot` is always defined immediately — never `undefined` while the async resolution is in flight — then corrected once the git lookup resolves.)

Add `projectRoot: session.projectRoot` to `publicSession()`'s returned object (`server/agents/terminal-manager.cjs:235-262`). In `setActivity` (`server/agents/terminal-manager.cjs:118-127`), add `projectRoot: session.projectRoot` to the `base` object (`const base = { kind: "terminal", targetId: session.id, cwd: session.cwd, title: session.title, projectRoot: session.projectRoot };`). In `recordExit` (`server/agents/terminal-manager.cjs:386-399`), add `projectRoot: session.projectRoot` to its inline `notifications.add({...})` call.

- [ ] **Step 7: Attach `projectRoot` in `codex-app-server.cjs`.** Add near its other `require`s:

```js
const { resolveProjectRoot } = require("./project-root.cjs");
```

In `spawnRuntime` (`server/agents/codex-app-server.cjs:139-153`), after `state` is constructed, add:

```js
  state.projectRoot = cwd;
  resolveProjectRoot(cwd).then((root) => { state.projectRoot = root; }).catch(() => {});
```

Add `projectRoot: state.projectRoot` to `listRuntimes()`'s returned object (`server/agents/codex-app-server.cjs:255-262`). Add `projectRoot: state.projectRoot` to `recordNotification`'s `base` object (`server/agents/codex-app-server.cjs:109-119`) and to `failState`'s direct `notifications.add({...})` call (`server/agents/codex-app-server.cjs:120-137`).

- [ ] **Step 8: Attach `projectRoot` in `claude-chat-runtime.cjs`.** Add near its other `require`s:

```js
const { resolveProjectRoot } = require("./project-root.cjs");
```

In `open()` (`server/agents/claude-chat-runtime.cjs:157-176`), after `state` is constructed, add:

```js
  state.projectRoot = cwd;
  resolveProjectRoot(cwd).then((root) => { state.projectRoot = root; }).catch(() => {});
```

Add `projectRoot: state.projectRoot` to `listRuntimes()`'s returned object (`server/agents/claude-chat-runtime.cjs:498-500`). Add `projectRoot: state.projectRoot` to `finishTurn`'s `base` object (`server/agents/claude-chat-runtime.cjs:275-293`) and to `onExit`'s direct `notifications.add({...})` call (`server/agents/claude-chat-runtime.cjs:296-305`).

- [ ] **Step 9: Run the gates.**

Run: `npx tsc --noEmit -p .`
Run: `npx eslint server/agents/project-root.cjs server/agents/terminal-manager.cjs server/agents/codex-app-server.cjs server/agents/claude-chat-runtime.cjs lib/workspace-status-store.ts lib/agents/terminal.ts`
Run: `npm test`

- [ ] **Step 10: Commit.**

```bash
git add server/agents/project-root.cjs server/agents/project-root.test.cjs server/agents/terminal-manager.cjs server/agents/codex-app-server.cjs server/agents/claude-chat-runtime.cjs lib/workspace-status-store.ts lib/agents/terminal.ts
git commit -m "fix: attach resolved projectRoot to terminal, Codex, and Claude runtime records"
```

---

### Task 9: Match rail activity on `projectRoot`, not just `cwd`, and update the PRD

**Problem (part 2 of 2 — deferred item):** `lib/rail-activity.ts`'s `groupRailActivity` places each activity item on a workspace by checking only `item.cwd === candidate.cwd || item.cwd === candidate.projectRoot` — it never looks at a project-root value carried by the item itself. Before Task 8, terminal/Codex/Claude items had no such value at all; now that Task 8 attaches `projectRoot` to their underlying records, this task reads it and matches on it, so chats/terminals running in a non-active worktree of an open project are correctly counted in the close-project warning and the project tab's activity indicator (title/badge). `docs/prd/multi-project-workspaces.md`'s "已知限制" (known limitation) sentence documents the old gap and needs to be corrected to reflect the fix.

**Files:**
- Modify: `lib/rail-activity.ts:185-201` (`groupRailActivity`)
- Modify: `lib/rail-activity.test.mjs` (new test)
- Modify: `docs/prd/multi-project-workspaces.md:24`

**Interfaces:**
- Consumes: `projectRoot?: string` on `TerminalSession`, `CodexRuntimeStatus`, `ClaudeRuntimeStatus` (Task 8), and the pre-existing `projectRoot?: string` on `SessionInfo`.

- [ ] **Step 1: Add an `itemProjectRoot` helper and use it in `groupRailActivity`.** Replace `lib/rail-activity.ts:185-201`:

```ts
/** The project-root value carried by an item's underlying record, when known. */
function itemProjectRoot(item: RailActivityItem): string | undefined {
  if (item.kind === "terminal") return item.terminal.projectRoot;
  if (item.kind === "codex") return item.runtime.projectRoot;
  if (item.kind === "claude") return item.runtime.projectRoot;
  return item.session.projectRoot;
}

/** Groups items onto the workspace whose cwd or project root they belong to. */
export function groupRailActivity(items: RailActivityItem[], workspaces: ProjectWorkspace[]): Record<string, WorkspaceActivity> {
  const activities: Record<string, WorkspaceActivity> = {};
  for (const workspace of workspaces) activities[workspace.id] = { state: "idle", working: 0, approval: 0, failed: 0, completed: 0, items: [] };
  for (const item of items) {
    const root = itemProjectRoot(item);
    const workspace = workspaces.find((candidate) =>
      item.cwd === candidate.cwd ||
      item.cwd === candidate.projectRoot ||
      (root != null && root === candidate.projectRoot));
    if (!workspace) continue;
    const activity = activities[workspace.id];
    activity.items.push(item);
    activity[item.state] += 1;
  }
  for (const activity of Object.values(activities)) {
    activity.items.sort((a, b) => STATE_PRIORITY[a.state] - STATE_PRIORITY[b.state]);
    activity.state = activity.approval ? "approval" : activity.failed ? "failed" : activity.working ? "working" : activity.completed ? "completed" : "idle";
  }
  return activities;
}
```

- [ ] **Step 2: Run the gates.**

Run: `npx tsc --noEmit -p .`
Run: `npx eslint lib/rail-activity.ts`

- [ ] **Step 3: Add a regression test for cross-worktree grouping.** Append to `lib/rail-activity.test.mjs`, reusing its existing `terminal(id, overrides)` and `workspaces` fixture helpers:

```js
test("groups a terminal running in a non-active worktree onto its project's workspace via projectRoot", () => {
  const items = [
    terminal("t1", { cwd: "/repo/worktrees/feature-x", projectRoot: "/repo/a" }),
  ];
  const grouped = groupRailActivity(items, workspaces);
  const workspaceA = workspaces.find((w) => w.projectRoot === "/repo/a");
  assert.ok(workspaceA);
  assert.deepEqual(grouped[workspaceA.id].items.map((item) => item.id), ["t1"]);
  assert.equal(grouped[workspaceA.id].state, "working");
});
```

(If the file's `terminal()` helper doesn't already accept a `projectRoot` override, extend its overrides parameter to pass one through — it already accepts an `overrides` object merged onto the base terminal fixture, per the existing `session(id, overrides)` helper's `projectRoot: "/repo/a"` usage in the same file.)

Run: `node --require ./server/test-env.cjs --test lib/rail-activity.test.mjs` — or the full `npm test` if this file isn't runnable in isolation with the same invocation as the suite.

- [ ] **Step 4: Run the full test suite.**

Run: `npm test`

- [ ] **Step 5: Update the PRD.** In `docs/prd/multi-project-workspaces.md:24`, the current sentence ends with "关闭不停止任何进程。已知限制：项目当前未打开的其他 worktree 中的活动暂不计入这个确认框。" Remove the "已知限制" clause (the limitation is now fixed):

```
- 关闭项目时，如果项目根目录或当前打开的 worktree 中有运行中或等待审批的 Terminal、Codex/Claude 聊天或 Pi 会话，先确认。确认框列出各类数量和等待审批的数量，例如 "2 terminals and 1 chat are still running in acme (1 waiting for approval)"。关闭不停止任何进程。项目未打开的其他 worktree 中的活动（Terminal、Codex/Claude 聊天、Pi 会话）通过其解析后的项目根目录归入同一项目，同样计入这个确认框。
```

- [ ] **Step 6: Commit.**

```bash
git add lib/rail-activity.ts lib/rail-activity.test.mjs docs/prd/multi-project-workspaces.md
git commit -m "fix: count worktree activity in the close-project warning via projectRoot"
```

---

## Self-Review

**Spec coverage against the original 9 audit items:**
1. Explorer touch reachability → Task 1. Covered: a new `useCoarsePointer()` hook and a per-row "File actions" button reusing the existing context menu.
2. Git panel mobile layout → Task 2. Covered: vertical stacking under `useIsMobile()`, list↔diff navigation with an explicit Back button, and no longer auto-selecting the first commit on mobile (which would have skipped the list entirely).
3. QR code expiry → Task 3. Covered: derived `pairingExpired`, fallback to the plain origin QR once expired, explicit "Expired — Refresh" action.
4. Message list virtualization/perf → folded into Task 4 with item 5, since both live in the exact same `components/ChatWindow.tsx` code block (the message-rendering IIFE). Covered: `useMemo` keyed on `streamState.isStreaming` (not `streamingMessage`), plus `content-visibility: auto` CSS on each message wrapper — no library added.
5. Stable keys after "load earlier" → folded into Task 4 (see above). Covered: keys switched from array index to `entryIds[idx] ?? idx`.
6. Hover-only Copy/Edit/Fork buttons → Task 5. Covered: `onFocus`/`onBlur` tracking added alongside the existing `onMouseEnter`/`onMouseLeave`, plus `isCoarsePointer` forcing visibility on touch, in both `UserMessageView` and `AssistantMessageView`.
7. Branch tree keyboard operability → Task 6. Covered: roving tabindex, `data-branch-row`/`data-entry-id` attributes, Arrow key handler, Enter/Space activation — mirroring `FileExplorer.tsx`'s existing pattern.
8. Rate limiting behind a reverse proxy → Task 7. Covered: `PI_WEB_TRUST_PROXY=1` gate, loopback-peer check, tests for both the opt-in and default-off paths, `AGENTS.md` and `README.md` updated.
9. Deferred projectRoot propagation → split into Task 8 (server-side: attach `projectRoot` to terminal/Codex/Claude records via a new CJS-native `resolveProjectRoot`) and Task 9 (client-side: `groupRailActivity` reads it; PRD updated). Split because they touch entirely disjoint files and have independently testable deliverables (a `node --test` unit test for the resolver vs. a `lib/rail-activity.test.mjs` grouping test) — exactly the kind of case the task-right-sizing rule calls out for splitting.

No items were dropped: all nine were re-verified against a fresh read of the current code in this session and none were already fixed. Net task count is 9 (8 numbered items → 7 tasks, since items 4 and 5 share one task; item 9 → 2 tasks).

**Placeholder scan:** every task's code steps contain complete, concrete code — no `TODO`, `TBD`, or "handle this" placeholders. The one place this plan flags uncertainty is Task 4's load-earlier-messages query parameter name (called out explicitly in "Facts the implementer needs" and again in Task 4 Step 3, with an instruction to grep and confirm before writing the mock) — this is a wire-format detail that depends on a large file (`hooks/useAgentSession.ts`) not re-read line-by-line this session, not a placeholder in the production code fix itself.

**Type/signature consistency:**
- `useCoarsePointer(): boolean` (Task 1) is used with the same name and signature in Task 5 and Task 6's design discussion (Task 6 doesn't actually need it — branch tree keyboard support doesn't gate on pointer type — confirmed it is not imported there).
- `projectRoot?: string` is added with the same name and optionality to `TerminalSession`, `CodexRuntimeStatus`, `ClaudeRuntimeStatus` (Task 8) and read back with the same name in `itemProjectRoot` (Task 9) — no renaming across the two tasks.
- `resolveProjectRoot(cwd: string): Promise<string>` (Task 8) is called identically (`resolveProjectRoot(cwd).then((root) => { ... })`) from all three call sites (`terminal-manager.cjs`, `codex-app-server.cjs`, `claude-chat-runtime.cjs`).
- `data-branch-row` / `data-entry-id` (Task 6) match the existing `data-explorer-row` / `data-file-path` naming convention already established in `FileExplorer.tsx`, so a future engineer searching for either pattern finds both.
- `effectivePairingUrl` (Task 3) replaces every read of `pairingUrl` in the render path (QR value, QR title, copy button label, `copyUrl`'s argument) — none were missed; `pairingUrl` itself is left as the underlying (possibly-expired) useMemo, only consumers switch.
- The Changes-tab and History-tab mobile layouts (Task 2) both use the identical `(!isMobile || <no selection>)` / `(!isMobile || <has selection>)` conditional-render pair and an identical inline "Back to ..." button style, so a reader who understands one understands the other.

**Cross-task file overlap:** Task 4 and Task 5 both touch message-rendering code but in different files (`ChatWindow.tsx` vs. `MessageView.tsx`) with no line overlap. Every UI task (1, 2, 3, 4, 5, 6) appends to the same `e2e/mobile-a11y.spec.ts` — implement in task order (as numbered) to avoid merge conflicts within that one file, same caveat as the reference silent-failures plan gave for its shared `e2e/reliability.spec.ts`. Task 8 and Task 9 touch different files entirely and are ordered so Task 8's new fields exist before Task 9 reads them.

## Finish

- [ ] Run the full gate: `npx tsc --noEmit -p . && npm run lint && npm test && npx playwright test`
- [ ] This plan lands on the shared `feat/audit-followups` branch alongside other in-flight work (see `git status`/`git log` at planning time). Coordinate with whoever else is committing to it rather than force-pushing or rebasing away their commits.
