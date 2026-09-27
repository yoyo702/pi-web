# Chat and Tab Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close a set of "P2 common capabilities" gaps in session navigation, chat, and the workspace tab bar: session list search, retrying/regenerating the last assistant reply, two global keyboard shortcuts (Settings, Quick Switcher), three center-tab-bar affordances (Close Others/All, drag-to-reorder, reopen the last closed tab), and Claude/Codex session-management parity (rename/archive, and terminal restart that resumes instead of restarting).

**Architecture:** Every task reuses an existing mechanism rather than adding a new one:
- Session search is a pure filter function (`lib/session-list.ts`) plumbed into `components/SessionSidebar.tsx`'s existing `filteredSessions` memo — no new state machine.
- Regenerate reuses the exact in-session branching path "Edit from here" already uses (`handleNavigate` → `navigate_tree` → `loadContext`), then calls the existing `handleSend`, so no new server RPC is added.
- The two new global shortcuts extend the existing capture-phase listener in `hooks/useKeyboardShortcuts.ts` and respect `lib/escape-abort.ts`'s `hasVisibleModal` contract so they never fire on top of another modal.
- The Quick Switcher is a new modal component, but its Escape handling reuses `components/agents/use-dialog-escape.ts` (already generic, not agents-specific) and its data sources (`projectWorkspaces`, `workspaceTabs`, `/api/sessions`) are all state `components/AppShell.tsx` already holds or already fetches.
- Close Others/Close All reuse `components/TabBar.tsx`'s existing context menu — currently wired only to the file tab bar — by making `onToggleTabLocked` optional in that menu (the center tab bar has no lock concept) and wiring `onCloseTabs` to `components/AppShell.tsx`'s existing busy-confirmation funnel (`handleCloseWorkspaceTab`), one tab at a time, so closing a busy chat/terminal tab still asks for confirmation.
- Drag-to-reorder adds one reducer action (`reorder`) to `lib/workspace/panel-state.ts`'s existing `centerReducer`, plus native HTML5 drag events in `TabBar.tsx`. No new dependency.
- Reopen-last-closed-tab hooks into the single funnel point where tabs are actually removed (`removeWorkspaceTab` in `AppShell.tsx`), and is registered as a *bubble-phase* `window` listener so it fires after (and yields to, via `event.defaultPrevented`) `components/ProjectRail.tsx`'s existing, PRD-documented Cmd/Ctrl+Shift+T "undo project close" shortcut.
- Claude rename/archive parity is a new sidecar JSON-metadata overlay (`server/agents/claude-session-meta.cjs`), mirroring the existing `server/task-templates.cjs` pattern exactly (atomic write, `0o600`/`0o700` permissions, env-var override for tests) — Claude's own session `.jsonl` files are never written by pi-web, avoiding both a schema-fidelity risk and a concurrent-write risk with a live `claude` CLI process.
- Claude terminal restart-resumes by generalizing one boolean in `components/AppShell.tsx`'s `restartUnavailableTerminal`; the backend (`server/agents/terminal-manager.cjs`) already fully supports `claude --resume <id>` and needs no change.

**Tech Stack:** Next.js 16 App Router + the custom Node server (`server/pi-web-server.js`), React 19, TypeScript, `node --test` (TS loaded through `jiti`; `.cjs` server tests require the module directly), Playwright (`chromium` and `mobile-chromium` projects).

**Spec:** There is no separate spec document. The six candidate items come from a product audit done in conversation; each was verified in code before being planned (see "Facts the implementer needs" for the one item dropped as already-adequate). The **Problem** line in each task is the requirement. Chinese PRD docs under `docs/prd/*.md` are the closest thing to a living spec and are updated in the same task as the behavior they describe, per `AGENTS.md`.

## Global Constraints

- No new dependencies.
- UI copy is English, matching the rest of the app. PRD edits (`docs/prd/*.md`) are Chinese, matching those files. Every task that changes user-visible behavior edits the PRD bullet in the same task, naming the exact file and line.
- Follow the AGENTS.md rule: when feature behavior changes, update the matching PRD in the same commit as the code.
- Every task ends green on `npx tsc --noEmit -p .`, `npx eslint <touched files>`, and `npm test` (`node --require ./server/test-env.cjs --test server/agents/*.test.cjs lib/*.test.mjs lib/workspace/*.test.mjs components/*.test.mjs`). Tasks that touch UI also run a focused `npx playwright test e2e/navigation.spec.ts --project=chromium --project=mobile-chromium`.
- `hooks/` has no unit-test coverage in this repo: no `hooks/*.test.*` file exists, and the `npm test` glob (`server/agents/*.test.cjs lib/*.test.mjs lib/workspace/*.test.mjs components/*.test.mjs`) does not cover `hooks/`. Behavior added to `hooks/useKeyboardShortcuts.ts` (Tasks 3, 4, 7) is verified through `e2e/navigation.spec.ts`, not `node --test`.
- Work on the current branch, `feat/audit-followups` — other audit-followup work is already landing on it (see `git log`; `components/ChatWindow.tsx`, `hooks/useAgentSession.ts`, and `e2e/reliability.spec.ts` may carry local, uncommitted changes from parallel tasks). Do not create a new branch. Re-read a file's current content before editing it — the line numbers cited below are hints for locating each edit, not guaranteed positions.
- All new e2e coverage for this plan lives in one new file, `e2e/navigation.spec.ts`, mocking backend routes the way `e2e/app-shell.spec.ts` does (`page.route("**/api/...", ...)`, a `mockStatusStream` helper for `**/api/agent/running/events`). Do not add navigation tests to `e2e/reliability.spec.ts` or `e2e/app-shell.spec.ts`.

## Facts the implementer needs

- The audit listed six candidate items. All six were verified in code first. One (item 2, "find within a conversation") is dropped — see below. The other five map to 8 tasks (item 4 splits into 2 tasks, item 5 splits into 3, item 6 splits into 2) plus Task 1 for item 1, for 9 tasks total.
- **Dropped item: "Find within a conversation" (Cmd/Ctrl+F-style find bar, next/prev, highlight).** `components/ChatWindow.tsx` renders the full message list into the DOM with no virtualization (confirmed: the render loop in `ChatWindow.tsx` maps directly over `messages`/`entryIds` with no windowing library or `overflow: hidden` truncation of off-screen rows), and message text renders as plain text/Markdown (`MarkdownBody`), not inside a `<canvas>`, collapsed `<details>`, or `visibility: hidden` region. The browser's native Cmd/Ctrl+F already searches, highlights, and steps through every rendered message with no extra code. Adding a custom find bar would only duplicate that with strictly less capability (no fuzzy match, more code to maintain a highlight-and-scroll implementation). No fix needed.
- `docs/prd/index.md` lists exactly 7 PRDs: `multi-project-workspaces.md`, `agent-workspace.md`, `workspace-explorer.md`, `git-review.md`, `secure-lan-access.md`, `session-reliability.md`, `responsive-workspace.md`. This plan's PRD edits land in `session-reliability.md` (Tasks 1, 2 — session list and chat behavior), `multi-project-workspaces.md` (Tasks 3, 4 — its existing "快速访问" section already documents app-wide shortcuts like `Cmd/Ctrl+1…9` and `Cmd/Ctrl+Shift+P`), `responsive-workspace.md` (Tasks 5, 6, 7 — it already documents the center tab bar's wheel-scroll and right-click management), and `agent-workspace.md` (Tasks 8, 9 — Claude/Codex session and terminal parity).
- **Cmd/Ctrl+Shift+T is already bound.** `components/ProjectRail.tsx:170-186` binds `document.addEventListener("keydown", ...)` (bubble phase) for 6 seconds after a project is closed, to undo that close — this is documented in `docs/prd/multi-project-workspaces.md` ("关闭后 6 秒内撤销，支持 `Cmd/Ctrl + Shift + T`"). Task 7 (reopen the last closed *tab*) must not fight this: it registers its own handler on `window` in the *bubble* phase (which fires after `document`'s bubble-phase listener, since bubbling goes target → ... → document → window), and checks `event.defaultPrevented` first — `ProjectRail`'s handler already calls `preventDefault()` when it fires, so Task 7's handler no-ops whenever a project-close undo is pending. `ProjectRail.tsx` itself is not modified.
- **Claude's own session files already carry a native title mechanism** (`custom-title`/`ai-title` records, parsed by `titleOf()` in `server/agents/claude-sessions.cjs:62-65`), but Task 8 does not use it to implement rename: appending a record to a `.jsonl` file that a live `claude` CLI process may simultaneously be writing risks corruption, and the exact record shape Claude itself considers valid (beyond the two fields this codebase already reads) is not fully known. Task 8 instead stores rename/archive state in a new sidecar file (`~/.pi-web/claude-session-meta.json`), the same pattern `server/task-templates.cjs` already uses for saved launches, and overlays it onto the read-only file scan.
- `hooks/useCodexSessions.ts` does not exist as a separate file — Codex's `showArchived` query wiring lives inline inside `components/agents/AgentsPanel.tsx` (its own `useState` + a `useEffect`-driven `fetch`). `hooks/useClaudeSessions.ts`, by contrast, *is* a real hook; Task 8 adds an `archived` option to it directly.
- `AttachedImage` (`{ data: string; mimeType: string; previewUrl: string }`) is defined and exported from `hooks/useAgentSession.ts:364`, already imported by `components/ChatWindow.tsx` from that module. Regenerate (Task 2) reuses this exact type instead of inventing a new one.

---

### Task 1: Session list search

**Problem:** `components/SessionSidebar.tsx` lists every Pi session for the selected project with no way to filter by title or first message; a long-running project's session tree becomes a scroll-only list.

**Files:**
- Modify: `lib/session-list.ts` (new exported function)
- Create: `lib/session-list.test.mjs` (new test file; mirrors `lib/session-title.test.mjs`'s jiti-import convention)
- Modify: `components/SessionSidebar.tsx:700-739` (the `filteredSessions` memo), `components/SessionSidebar.tsx:1255-1304` (header render — new search input), imports at the top of the file (`lucide-react` `Search`/`X` icons, already a dependency)
- Modify: `docs/prd/session-reliability.md` (new bullet documenting session search, Chinese)
- Create/Modify: `e2e/navigation.spec.ts` (new file if it doesn't exist yet — Task 1 creates it; later tasks append to it)

**Interfaces:**
- New: `filterSessionsByQuery(sessions: SessionInfo[], query: string): SessionInfo[]` in `lib/session-list.ts`, exported alongside the existing `getSessionDisplayTitle`, `sortSessionsByRecent`, `resolveSessionLineage`.
- Consumes: `getSessionDisplayTitle` (already exported from the same file) to build the searchable text.

**Steps:**

- [ ] **Step 1: Add `filterSessionsByQuery` to `lib/session-list.ts`**

  Add this export next to the existing ones (the file currently exports `getSessionDisplayTitle`, `sortSessionsByRecent`, `resolveSessionLineage`):

  ```ts
  /** Sessions whose display title or first message contains `query` (case-insensitive). Empty query returns `sessions` unchanged. */
  export function filterSessionsByQuery(sessions: SessionInfo[], query: string): SessionInfo[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter((session) => `${getSessionDisplayTitle(session)} ${session.firstMessage ?? ""}`.toLowerCase().includes(needle));
  }
  ```

- [ ] **Step 2: Unit test `lib/session-list.test.mjs`**

  ```js
  import assert from "node:assert/strict";
  import test from "node:test";
  import { createJiti } from "jiti";

  const jiti = createJiti(import.meta.url);
  const { filterSessionsByQuery } = await jiti.import("./session-list.ts");

  function session(overrides) {
    return { id: "s1", name: null, firstMessage: "", cwd: "/repo", projectRoot: "/repo", updatedAt: "2026-01-01T00:00:00.000Z", ...overrides };
  }

  test("filterSessionsByQuery: empty query returns all sessions unchanged", () => {
    const sessions = [session({ id: "a" }), session({ id: "b" })];
    assert.equal(filterSessionsByQuery(sessions, ""), sessions);
    assert.equal(filterSessionsByQuery(sessions, "   "), sessions);
  });

  test("filterSessionsByQuery: matches by display title (session.name)", () => {
    const match = session({ id: "a", name: "Refactor auth flow" });
    const other = session({ id: "b", name: "Update docs" });
    assert.deepEqual(filterSessionsByQuery([match, other], "auth"), [match]);
  });

  test("filterSessionsByQuery: matches by first message when there is no name", () => {
    const match = session({ id: "a", name: null, firstMessage: "Please add rate limiting to the API" });
    const other = session({ id: "b", name: null, firstMessage: "Fix the flaky CI job" });
    assert.deepEqual(filterSessionsByQuery([match, other], "rate limiting"), [match]);
  });

  test("filterSessionsByQuery: is case-insensitive", () => {
    const match = session({ id: "a", name: "Add DARK MODE toggle" });
    assert.deepEqual(filterSessionsByQuery([match], "dark mode"), [match]);
  });
  ```

- [ ] **Step 3: Wire the filter into `components/SessionSidebar.tsx`'s existing `filteredSessions` memo**

  Locate the current code (around line 700-712):

  ```ts
  const selectedProject = projectRootFor(selectedCwd);
  ...
  const filteredSessions = useMemo(() => selectedProject
    ? allSessions.filter((s) => (s.projectRoot ?? s.cwd) === selectedProject)
    : allSessions, [allSessions, selectedProject]);
  ```

  Add search state near the sidebar's other `useState` declarations, and fold it into the same memo so both `sessionTree` and `recentSessions` (both already derived solely from `filteredSessions`) get search for free:

  ```ts
  const [sessionSearch, setSessionSearch] = useState("");
  ```

  ```ts
  const selectedProject = projectRootFor(selectedCwd);
  ...
  const filteredSessions = useMemo(() => {
    const scoped = selectedProject
      ? allSessions.filter((s) => (s.projectRoot ?? s.cwd) === selectedProject)
      : allSessions;
    return filterSessionsByQuery(scoped, sessionSearch);
  }, [allSessions, selectedProject, sessionSearch]);
  ```

  Add the import at the top of the file (it already imports `getSessionDisplayTitle` and friends from `@/lib/session-list`; extend that same import line with `filterSessionsByQuery`).

- [ ] **Step 4: Add the search input to the sidebar header**

  In the `{sessionsExpanded && <div ...>}` block (around line 1277), insert a search row before the existing `{loading && (...)}` line:

  ```tsx
  {sessionsExpanded && <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
    <label style={{ display: "flex", alignItems: "center", gap: 6, margin: "0 8px 4px", padding: "4px 8px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)" }}>
      <Search size={13} style={{ flexShrink: 0, opacity: 0.6 }} aria-hidden="true" />
      <input
        value={sessionSearch}
        onChange={(event) => setSessionSearch(event.target.value)}
        placeholder="Search sessions"
        aria-label="Search Pi sessions"
        type="search"
        style={{ flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", font: "12px inherit", color: "var(--text)" }}
      />
      {sessionSearch && (
        <button type="button" onClick={() => setSessionSearch("")} aria-label="Clear session search" title="Clear" style={{ display: "flex", border: "none", background: "none", color: "var(--text-dim)", cursor: "pointer", padding: 0 }}>
          <X size={13} aria-hidden="true" />
        </button>
      )}
    </label>
    {loading && (
    ...
  ```

  Note the original block's closing `</div>` and everything between `{loading && ...}` and the end of `sessionsExpanded`'s JSX is otherwise unchanged — only the new `<label>` row is inserted before it, inside the same conditional wrapper. Update the two `lucide-react` imports at the top of the file (currently `ChevronDown, Settings`) to also include `Search, X`.

- [ ] **Step 5: Update the empty-state copy to mention search**

  The existing empty state (`{!loading && !error && filteredSessions.length === 0 && (<div>No sessions found</div>)}`) already reads "No sessions found", which is accurate whether the list is empty because of the project filter or the new search — no copy change needed. Confirm this by reading the current line before editing (it may have shifted).

- [ ] **Step 6: Update `docs/prd/session-reliability.md`**

  Add a bullet to the `### Pi Session` section (Chinese), next to the existing session-list bullets, e.g.:

  ```
  - 会话列表支持按标题或首条消息搜索，实时过滤会话树和"最近"列表。
  ```

- [ ] **Step 7: Create `e2e/navigation.spec.ts` and add the session search test**

  ```ts
  import { expect, test, type Page } from "@playwright/test";

  async function mockStatusStream(page: Page, frames: Array<Record<string, unknown>> = []) {
    await page.route("**/api/agent/running/events", (route) => route.fulfill({
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      body: frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""),
    }));
  }

  const SESSIONS = [
    { id: "s-auth", name: "Refactor auth flow", firstMessage: "Refactor auth flow", cwd: "/tmp/proj", projectRoot: "/tmp/proj", updatedAt: "2026-01-03T00:00:00.000Z" },
    { id: "s-docs", name: "Update docs", firstMessage: "Update docs", cwd: "/tmp/proj", projectRoot: "/tmp/proj", updatedAt: "2026-01-02T00:00:00.000Z" },
  ];

  test("session search filters the sidebar by title", async ({ page }) => {
    await mockStatusStream(page);
    await page.route("**/api/sessions*", (route) => route.fulfill({ json: { sessions: SESSIONS } }));
    await page.goto("/");
    const search = page.getByRole("textbox", { name: "Search Pi sessions" });
    await expect(search).toBeVisible();
    await search.fill("auth");
    await expect(page.getByText("Refactor auth flow")).toBeVisible();
    await expect(page.getByText("Update docs")).toBeHidden();
    await search.fill("");
    await expect(page.getByText("Update docs")).toBeVisible();
  });
  ```

**Gates:** `npx tsc --noEmit -p .`; `npx eslint lib/session-list.ts components/SessionSidebar.tsx e2e/navigation.spec.ts`; `npm test` (covers `lib/session-list.test.mjs`); `npx playwright test e2e/navigation.spec.ts --project=chromium --project=mobile-chromium`.

---

### Task 2: Regenerate the last assistant reply

**Problem:** Pi chat has no way to retry the last assistant response without manually clicking "Edit from here" on the preceding user message and resubmitting the same text — a two-step, easy-to-fumble flow for the common case of just wanting a fresh answer to the same prompt.

**Files:**
- Modify: `components/ChatWindow.tsx` (new `useMemo` + `handleRegenerate` callback, new button JSX, new type imports)
- Modify: `docs/prd/session-reliability.md` (new bullet)
- Modify: `e2e/navigation.spec.ts` (new test)

**Interfaces:**
- Consumes (unchanged, already destructured from `useAgentSession` in `ChatWindow.tsx`): `handleNavigate(entryId: string): Promise<void>`, `handleSend(message: string, images?: AttachedImage[]): Promise<void>`, `messages: AgentMessage[]`, `entryIds: string[]`, `sessionBusy` (`agentRunning || bashRunning`), `isNew: boolean`.
- New local: `lastUserTurn: { entryId: string; message: UserMessage } | null` (memo); `handleRegenerate: () => Promise<void>` (callback); `regenerating: boolean` (state, for the button's own busy indicator distinct from `sessionBusy`).

**Steps:**

- [ ] **Step 1: Extend imports in `components/ChatWindow.tsx`**

  Current line 4:
  ```ts
  import type { AgentMessage, AssistantContentBlock, AssistantMessage, BashExecutionMessage, CustomMessage, ExtensionUiRequest, SessionInfo, SessionTreeNode, ToolResultMessage } from "@/lib/types";
  ```
  becomes:
  ```ts
  import type { AgentMessage, AssistantContentBlock, AssistantMessage, BashExecutionMessage, CustomMessage, ExtensionUiRequest, ImageContent, SessionInfo, SessionTreeNode, TextContent, ToolResultMessage, UserMessage } from "@/lib/types";
  ```
  Current line 12:
  ```ts
  import { useAgentSession, type ActiveToolProgress, type AgentPhase, type NoticeItem } from "@/hooks/useAgentSession";
  ```
  becomes:
  ```ts
  import { useAgentSession, type ActiveToolProgress, type AgentPhase, type AttachedImage, type NoticeItem } from "@/hooks/useAgentSession";
  ```

- [ ] **Step 2: Add the `lastUserTurn` memo and `handleRegenerate` callback**

  Place these near the other derived values in the component body (e.g. right after the `sessionBusy` declaration at line 347):

  ```ts
  // The most recent user turn, for Regenerate: navigating back to its entry
  // id forks the tree there (dropping the assistant reply that followed),
  // then resending its content produces a fresh reply — the same in-session
  // branch mechanism "Edit from here" uses, without the input-box round trip.
  const lastUserTurn = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role !== "user") continue;
      const entryId = entryIds[i];
      if (!entryId) return null;
      return { entryId, message: message as UserMessage };
    }
    return null;
  }, [messages, entryIds]);

  const canRegenerate = Boolean(lastUserTurn)
    && !isNew
    && !sessionBusy
    && messages.length > 0
    && messages[messages.length - 1].role === "assistant";

  const [regenerating, setRegenerating] = useState(false);

  const handleRegenerate = useCallback(async () => {
    if (!lastUserTurn) return;
    const { entryId, message } = lastUserTurn;
    const text = typeof message.content === "string"
      ? message.content
      : message.content.filter((block): block is TextContent => block.type === "text").map((block) => block.text).join("\n");
    const imageBlocks: ImageContent[] = typeof message.content === "string"
      ? []
      : message.content.filter((block): block is ImageContent => block.type === "image");
    const images: AttachedImage[] = imageBlocks
      .filter((block) => block.source?.type === "base64" && block.source.data)
      .map((block) => {
        const mimeType = block.source.media_type || "image/png";
        const data = block.source.data as string;
        return { data, mimeType, previewUrl: `data:${mimeType};base64,${data}` };
      });
    setRegenerating(true);
    try {
      await handleNavigate(entryId);
      await handleSend(text, images.length ? images : undefined);
    } finally {
      setRegenerating(false);
    }
  }, [lastUserTurn, handleNavigate, handleSend]);
  ```

  `useMemo`, `useCallback`, and `useState` are already imported from `"react"` at line 3.

- [ ] **Step 3: Add the Regenerate button**

  Find where `{rendered}` (the message list, built at line 734) is followed by the streaming-status/composer area, and add a small action row directly after `{rendered}`, gated on `canRegenerate`:

  ```tsx
  {canRegenerate && (
    <div style={{ display: "flex", justifyContent: "center", margin: "4px 0 12px" }}>
      <button
        type="button"
        onClick={() => void handleRegenerate()}
        disabled={regenerating}
        aria-label="Regenerate response"
        style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: "5px 12px", borderRadius: 999,
          border: "1px solid var(--border)", background: "var(--bg-panel)",
          color: "var(--text-dim)", fontSize: 12, cursor: regenerating ? "default" : "pointer",
          opacity: regenerating ? 0.6 : 1,
        }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5" />
        </svg>
        {regenerating ? "Regenerating…" : "Regenerate"}
      </button>
    </div>
  )}
  ```

  Exact placement: read the current render function for where `{rendered}` is emitted (it is pushed into an array and rendered inside the scrolling message container) and insert this block as the next sibling after that array is rendered, inside the same scrollable container — so it scrolls with the transcript rather than floating over the composer.

- [ ] **Step 4: Update `docs/prd/session-reliability.md`**

  Add a bullet to the `### Pi Session` (or the chat-turn) section:

  ```
  - 最后一条助手回复下方提供"重新生成"按钮：回退到上一条用户消息（同一会话内分支，不新建会话），并以相同内容和图片重新发送。
  ```

- [ ] **Step 5: Add the e2e test to `e2e/navigation.spec.ts`**

  ```ts
  test("regenerate resends the last user message and replaces the reply", async ({ page }) => {
    await mockStatusStream(page);
    let promptCount = 0;
    await page.route("**/api/agent/*/command", (route) => {
      const body = route.request().postDataJSON() as { type?: string };
      if (body?.type === "prompt") promptCount += 1;
      return route.fulfill({ json: { ok: true } });
    });
    await page.goto("/");
    // ... drive the chat to a state with one user + one assistant message,
    // then assert the Regenerate button is visible only after an assistant
    // reply exists, click it, and assert promptCount increased by 1 and the
    // request carried the same message text as the original prompt.
    await expect(page.getByRole("button", { name: "Regenerate response" })).toBeVisible();
  });
  ```

  (This test's setup — driving the mocked event stream to a rendered user+assistant pair — reuses whatever helper `e2e/reliability.spec.ts` already has for that; check its `mockRunningSession` helper first and call it here rather than duplicating its frame-building logic, per the Global Constraints note that new navigation tests must not fork existing e2e helpers into a second copy.)

**Gates:** `npx tsc --noEmit -p .`; `npx eslint components/ChatWindow.tsx e2e/navigation.spec.ts`; `npm test` (no `.test.mjs` changes in this task, but the full suite must stay green); `npx playwright test e2e/navigation.spec.ts --project=chromium --project=mobile-chromium`.

---

### Task 3: Cmd/Ctrl+, opens Settings

**Problem:** Settings has no keyboard shortcut; the only way to open it is `ProjectRail`'s settings button.

**Files:**
- Modify: `hooks/useKeyboardShortcuts.ts` (new option + key handling)
- Modify: `components/AppShell.tsx:524-527` (call site)
- Modify: `docs/prd/multi-project-workspaces.md` (new bullet in "快速访问")
- Modify: `e2e/navigation.spec.ts` (new test)

**Interfaces:**
- Changes: `UseGlobalKeyboardShortcutsOptions` gains `onOpenSettings?: () => void`.
- Consumes: `hasVisibleModal(document)` from `@/lib/escape-abort` (already imported in this file).

**Steps:**

- [ ] **Step 1: Add the option and key handling in `hooks/useKeyboardShortcuts.ts`**

  ```ts
  interface UseGlobalKeyboardShortcutsOptions {
    /** Called when Ctrl+Alt+N is pressed. Receives current cwd. */
    onNewSession?: (cwd: string) => void;
    /** The currently selected project directory (sidebar cwd). */
    activeCwd?: string | null;
    /** Called when Cmd/Ctrl+, is pressed and no modal is already open. */
    onOpenSettings?: () => void;
  }
  ```

  Inside the `handler` function, after the Ctrl+Alt+N branch:

  ```ts
      // ---- Ctrl+Alt+N: new session ----
      if (e.key === "n" && e.ctrlKey && e.altKey) {
        if (!activeCwd || !onNewSession) return;
        e.preventDefault();
        onNewSession(activeCwd);
        return;
      }

      // ---- Cmd/Ctrl+,: open Settings ----
      if (e.key === "," && (e.metaKey || e.ctrlKey)) {
        if (!onOpenSettings || hasVisibleModal(document)) return;
        e.preventDefault();
        onOpenSettings();
      }
  ```

  Update the effect's dependency array (currently `[activeCwd, onNewSession]`) to `[activeCwd, onNewSession, onOpenSettings]`, and the destructure at the top of the function (`const { onNewSession, activeCwd } = options;`) to also pull `onOpenSettings`.

- [ ] **Step 2: Wire it in `components/AppShell.tsx`**

  Current call site (around line 524-527):
  ```ts
  useGlobalKeyboardShortcuts({
    onNewSession: (cwd: string) => handleNewSession(`kb-${Date.now()}`, cwd),
    activeCwd,
  });
  ```
  becomes:
  ```ts
  useGlobalKeyboardShortcuts({
    onNewSession: (cwd: string) => handleNewSession(`kb-${Date.now()}`, cwd),
    activeCwd,
    onOpenSettings: () => setSettingsOpen(true),
  });
  ```
  `setSettingsOpen` already exists (`const [settingsOpen, setSettingsOpen] = useState(false);`, line 105) and is already the exact call `ProjectRail`'s own settings button uses (`onOpenSettings={() => setSettingsOpen(true)}` at line 1263).

- [ ] **Step 3: Update `docs/prd/multi-project-workspaces.md`**

  In the "快速访问" section, next to the existing shortcut bullets:

  ```
  - `Cmd/Ctrl + ,` 打开设置面板。
  ```

- [ ] **Step 4: Add the e2e test to `e2e/navigation.spec.ts`**

  ```ts
  test("Cmd/Ctrl+, opens Settings", async ({ page }) => {
    await mockStatusStream(page);
    await page.goto("/");
    await page.keyboard.press("ControlOrMeta+,");
    await expect(page.getByRole("dialog", { name: /settings/i })).toBeVisible();
  });

  test("Cmd/Ctrl+, does nothing while another modal is open", async ({ page }) => {
    await mockStatusStream(page);
    await page.goto("/");
    // Open some other aria-modal dialog first (e.g. the project add dialog),
    // then press Cmd/Ctrl+, and assert Settings did NOT also open — only one
    // aria-modal dialog is visible at a time.
    await page.keyboard.press("ControlOrMeta+,");
    await expect(page.locator('[aria-modal="true"]')).toHaveCount(1);
  });
  ```

  (Confirm the actual accessible name Settings' dialog root uses — check `components/SettingsPanel.tsx` for its `aria-modal`/`aria-label` or `role="dialog"` attributes and adjust the locator to match exactly; do not guess.)

**Gates:** `npx tsc --noEmit -p .`; `npx eslint hooks/useKeyboardShortcuts.ts components/AppShell.tsx e2e/navigation.spec.ts`; `npm test` (no unit coverage for this hook — see Global Constraints); `npx playwright test e2e/navigation.spec.ts --project=chromium --project=mobile-chromium`.

---

### Task 4: Cmd/Ctrl+K Quick Switcher

**Problem:** There is no fast, keyboard-driven way to jump between projects, open workspace tabs, or recent Pi sessions — only the mouse-driven `ProjectRail` and `SessionSidebar`.

**Files:**
- Create: `components/QuickSwitcher.tsx`
- Modify: `hooks/useKeyboardShortcuts.ts` (new option + key handling, same file Task 3 touches — do this task after Task 3 lands, or merge the two edits carefully if working in parallel)
- Modify: `components/AppShell.tsx` (new `quickSwitcherOpen` state, render `<QuickSwitcher>`, wire the new shortcut option)
- Modify: `docs/prd/multi-project-workspaces.md` (new bullet, same section as Task 3)
- Modify: `e2e/navigation.spec.ts` (new tests)

**Interfaces:**
- New component props:
  ```ts
  interface QuickSwitcherProps {
    open: boolean;
    onClose: () => void;
    projects: ProjectWorkspace[];
    activeProjectId: string | null;
    onSelectProject: (workspace: ProjectWorkspace) => void;
    tabs: { id: string; label: string }[];
    onSelectTab: (id: string) => void;
    activeCwd: string | null;
    onSelectSession: (session: SessionInfo) => void;
  }
  ```
- Consumes: `useDialogEscape` (`@/components/agents/use-dialog-escape`), `ProjectWorkspace` (`@/lib/project-workspaces`), `SessionInfo` (`@/lib/types`), `filterSessionsByQuery` (`@/lib/session-list`, added in Task 1).
- Changes: `UseGlobalKeyboardShortcutsOptions` gains `onOpenQuickSwitcher?: () => void` (in addition to Task 3's `onOpenSettings`).

**Steps:**

- [ ] **Step 1: Add the Cmd/Ctrl+K handler in `hooks/useKeyboardShortcuts.ts`**

  ```ts
  interface UseGlobalKeyboardShortcutsOptions {
    onNewSession?: (cwd: string) => void;
    activeCwd?: string | null;
    onOpenSettings?: () => void;
    /** Called when Cmd/Ctrl+K is pressed and no modal is already open. */
    onOpenQuickSwitcher?: () => void;
  }
  ```

  ```ts
      // ---- Cmd/Ctrl+K: quick switcher ----
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        if (!onOpenQuickSwitcher || hasVisibleModal(document)) return;
        e.preventDefault();
        onOpenQuickSwitcher();
        return;
      }
  ```

  Add this branch before the Cmd/Ctrl+, branch (order doesn't matter functionally — both `return` — but keep the file's existing top-to-bottom shortcut ordering: Esc, Ctrl+Alt+N, then the two new ones). Update the destructure and dependency array to include `onOpenQuickSwitcher`.

- [ ] **Step 2: Create `components/QuickSwitcher.tsx`**

  ```tsx
  "use client";

  import { useEffect, useMemo, useRef, useState } from "react";
  import type { SessionInfo } from "@/lib/types";
  import type { ProjectWorkspace } from "@/lib/project-workspaces";
  import { filterSessionsByQuery, getSessionDisplayTitle } from "@/lib/session-list";
  import { useDialogEscape } from "./agents/use-dialog-escape";

  interface QuickSwitcherProps {
    open: boolean;
    onClose: () => void;
    projects: ProjectWorkspace[];
    activeProjectId: string | null;
    onSelectProject: (workspace: ProjectWorkspace) => void;
    tabs: { id: string; label: string }[];
    onSelectTab: (id: string) => void;
    activeCwd: string | null;
    onSelectSession: (session: SessionInfo) => void;
  }

  type Entry =
    | { kind: "project"; key: string; label: string; workspace: ProjectWorkspace }
    | { kind: "tab"; key: string; label: string; id: string }
    | { kind: "session"; key: string; label: string; session: SessionInfo };

  export function QuickSwitcher({ open, onClose, projects, activeProjectId, onSelectProject, tabs, onSelectTab, activeCwd, onSelectSession }: QuickSwitcherProps) {
    const [query, setQuery] = useState("");
    const [sessions, setSessions] = useState<SessionInfo[]>([]);
    const [activeIndex, setActiveIndex] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);

    useDialogEscape(onClose, !open);

    useEffect(() => {
      if (!open) { setQuery(""); setActiveIndex(0); return; }
      inputRef.current?.focus();
      let cancelled = false;
      fetch("/api/sessions", { cache: "no-store" })
        .then((response) => (response.ok ? response.json() as Promise<{ sessions?: SessionInfo[] }> : null))
        .then((data) => { if (!cancelled) setSessions(data?.sessions ?? []); })
        .catch(() => { if (!cancelled) setSessions([]); });
      return () => { cancelled = true; };
    }, [open]);

    const entries = useMemo<Entry[]>(() => {
      const needle = query.trim().toLowerCase();
      const matchedProjects = projects
        .filter((workspace) => !needle || workspace.label.toLowerCase().includes(needle) || workspace.cwd.toLowerCase().includes(needle))
        .map((workspace): Entry => ({ kind: "project", key: `project:${workspace.id}`, label: workspace.label, workspace }));
      const matchedTabs = tabs
        .filter((tab) => !needle || tab.label.toLowerCase().includes(needle))
        .map((tab): Entry => ({ kind: "tab", key: `tab:${tab.id}`, label: tab.label, id: tab.id }));
      const scopedSessions = activeCwd ? sessions.filter((session) => session.cwd === activeCwd) : sessions;
      const matchedSessions = filterSessionsByQuery(scopedSessions, query)
        .slice(0, 20)
        .map((session): Entry => ({ kind: "session", key: `session:${session.id}`, label: getSessionDisplayTitle(session), session }));
      return [...matchedProjects, ...matchedTabs, ...matchedSessions];
    }, [projects, tabs, sessions, activeCwd, query]);

    if (!open) return null;

    const select = (entry: Entry) => {
      onClose();
      if (entry.kind === "project") onSelectProject(entry.workspace);
      else if (entry.kind === "tab") onSelectTab(entry.id);
      else onSelectSession(entry.session);
    };

    return (
      <div role="presentation" style={{ position: "fixed", inset: 0, zIndex: 2000, background: "rgb(0 0 0 / 45%)", display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "12vh" }} onClick={onClose}>
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Quick switcher"
          onClick={(event) => event.stopPropagation()}
          style={{ width: 480, maxHeight: "60vh", display: "flex", flexDirection: "column", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 10, boxShadow: "0 24px 64px rgb(0 0 0 / 45%)", overflow: "hidden" }}
        >
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((i) => Math.min(i + 1, entries.length - 1)); }
              else if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((i) => Math.max(i - 1, 0)); }
              else if (event.key === "Enter") { event.preventDefault(); const entry = entries[activeIndex]; if (entry) select(entry); }
            }}
            placeholder="Jump to a project, tab, or session…"
            aria-label="Quick switcher search"
            style={{ padding: "12px 14px", border: "none", borderBottom: "1px solid var(--border)", background: "transparent", color: "var(--text)", font: "14px inherit", outline: "none" }}
          />
          <div role="listbox" aria-label="Quick switcher results" style={{ overflowY: "auto" }}>
            {entries.length === 0 && <div style={{ padding: "14px", color: "var(--text-dim)", fontSize: 12.5 }}>No matches</div>}
            {entries.map((entry, index) => (
              <button
                key={entry.key}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => select(entry)}
                style={{
                  display: "flex", width: "100%", alignItems: "center", gap: 8,
                  padding: "8px 14px", border: "none", textAlign: "left",
                  background: index === activeIndex ? "var(--bg-selected)" : "transparent",
                  color: "var(--text)", cursor: "pointer", font: "13px inherit",
                }}
              >
                <span style={{ fontSize: 10, textTransform: "uppercase", color: "var(--text-dim)", flexShrink: 0, width: 52 }}>{entry.kind}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }
  ```

- [ ] **Step 3: Wire it into `components/AppShell.tsx`**

  Add state near `settingsOpen` (line 105):
  ```ts
  const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false);
  ```
  Import the component near the other `dynamic`/direct imports:
  ```ts
  import { QuickSwitcher } from "./QuickSwitcher";
  ```
  Extend the shortcuts call site from Task 3:
  ```ts
  useGlobalKeyboardShortcuts({
    onNewSession: (cwd: string) => handleNewSession(`kb-${Date.now()}`, cwd),
    activeCwd,
    onOpenSettings: () => setSettingsOpen(true),
    onOpenQuickSwitcher: () => setQuickSwitcherOpen(true),
  });
  ```
  Render it once, near the other top-level portal-style renders (e.g. next to `<ActivityCenter>` around line 1274):
  ```tsx
  <QuickSwitcher
    open={quickSwitcherOpen}
    onClose={() => setQuickSwitcherOpen(false)}
    projects={projectWorkspaces}
    activeProjectId={activeProjectId}
    onSelectProject={(workspace) => void activateProjectWorkspace(workspace)}
    tabs={workspaceTabs.map((tab) => ({ id: tab.id, label: tab.kind === "pi" ? "TianForge pi" : tab.label }))}
    onSelectTab={handleSelectWorkspaceTab}
    activeCwd={activeCwd}
    onSelectSession={handleSelectSession}
  />
  ```
  `projectWorkspaces`, `activeProjectId`, `activateProjectWorkspace`, `workspaceTabs`, `handleSelectWorkspaceTab`, `activeCwd`, and `handleSelectSession` all already exist in `AppShell.tsx` (confirmed at lines 84-89, 198, 396-410, 432, 725-728).

- [ ] **Step 4: Update `docs/prd/multi-project-workspaces.md`**

  In "快速访问", next to Task 3's new bullet:
  ```
  - `Cmd/Ctrl + K` 打开快速切换器，可搜索并跳转到项目、已打开的标签页或 Pi 会话。
  ```

- [ ] **Step 5: Add e2e tests to `e2e/navigation.spec.ts`**

  ```ts
  test("Cmd/Ctrl+K opens the quick switcher and jumps to an open tab", async ({ page }) => {
    await mockStatusStream(page);
    await page.goto("/");
    await page.keyboard.press("ControlOrMeta+k");
    const dialog = page.getByRole("dialog", { name: "Quick switcher" });
    await expect(dialog).toBeVisible();
    await page.getByRole("textbox", { name: "Quick switcher search" }).fill("pi");
    await expect(page.getByRole("option").first()).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
  });

  test("Escape closes the quick switcher without closing anything underneath", async ({ page }) => {
    await mockStatusStream(page);
    await page.goto("/");
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByRole("dialog", { name: "Quick switcher" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Quick switcher" })).toBeHidden();
  });
  ```

**Gates:** `npx tsc --noEmit -p .`; `npx eslint hooks/useKeyboardShortcuts.ts components/AppShell.tsx components/QuickSwitcher.tsx e2e/navigation.spec.ts`; `npm test` (no unit coverage for the hook or this component — verified via e2e); `npx playwright test e2e/navigation.spec.ts --project=chromium --project=mobile-chromium`.

---

### Task 5: Close Others / Close All for the center tab bar

**Problem:** `components/TabBar.tsx`'s full context menu (Close Tab / Left / Right / Others / All, Lock/Unlock) is wired only to the file tab bar (`components/AppShell.tsx:1490-1497`); the center workspace tab bar (`components/AppShell.tsx:1336`) only gets `onSelectTab`/`onCloseTab`, so there is no bulk-close there, and busy chat/terminal tabs closed one at a time never get the existing confirmation dialog when closed in bulk.

**Files:**
- Modify: `components/TabBar.tsx` (make `onToggleTabLocked` independently optional from the menu's availability)
- Modify: `components/AppShell.tsx:1336` (wire `onCloseTabs`), plus a new `closeWorkspaceTabsSequentially` helper near `handleCloseWorkspaceTab` (~line 667-682)
- Modify: `docs/prd/responsive-workspace.md` (extend the existing tab-bar bullet)
- Modify: `e2e/navigation.spec.ts` (new tests)

**Interfaces:**
- Changes: `TabBar`'s `supportsTabManagement` becomes `Boolean(onCloseTabs)` (was `Boolean(onCloseTabs && onToggleTabLocked)`); the Lock/Unlock menu item renders only `{onToggleTabLocked && menuItem(...)}`.
- New in `AppShell.tsx`: `closeWorkspaceTabsSequentially(ids: string[]): void` — calls the existing `handleCloseWorkspaceTab(tabId: string)` for each id, one at a time, so each busy tab still gets its existing confirmation dialog (`pendingTerminalClose`/`pendingChatClose`) instead of being force-removed.

**Steps:**

- [ ] **Step 1: Decouple `onToggleTabLocked` from `supportsTabManagement` in `components/TabBar.tsx`**

  Line 65:
  ```ts
  const supportsTabManagement = Boolean(onCloseTabs && onToggleTabLocked);
  ```
  becomes:
  ```ts
  const supportsTabManagement = Boolean(onCloseTabs);
  ```
  Line 272 (the menu's render guard):
  ```tsx
  {contextMenu && contextTab && onCloseTabs && onToggleTabLocked && createPortal(
  ```
  becomes:
  ```tsx
  {contextMenu && contextTab && onCloseTabs && createPortal(
  ```
  Line 286 (the Lock/Unlock item):
  ```tsx
  {menuItem(contextTab.locked ? "Unlock Tab" : "Lock Tab", false, () => onToggleTabLocked(contextTab.id))}
  ```
  becomes:
  ```tsx
  {onToggleTabLocked && menuItem(contextTab.locked ? "Unlock Tab" : "Lock Tab", false, () => onToggleTabLocked(contextTab.id))}
  ```
  and the divider immediately after it (line 287, `<div role="separator" ... />`) should only render when there's something above it to separate from:
  ```tsx
  {onToggleTabLocked && <div role="separator" style={{ height: 1, margin: "4px 3px", background: "var(--border)" }} />}
  ```
  This is additive and backward-compatible: the file tab bar (`components/AppShell.tsx:1490-1497`) already passes both `onCloseTabs` and `onToggleTabLocked`, so its menu is unchanged.

- [ ] **Step 2: Add `closeWorkspaceTabsSequentially` in `components/AppShell.tsx`**

  Near `handleCloseWorkspaceTab` (~line 667-682), add:
  ```ts
  // Bulk close (Close Others / Close All) must not bypass the busy-tab
  // confirmation: each id goes through the same single-tab path used by the
  // tab's own close button, one at a time, so a running terminal or busy
  // chat still prompts before it's dropped.
  const closeWorkspaceTabsSequentially = useCallback((ids: string[]) => {
    for (const id of ids) handleCloseWorkspaceTab(id);
  }, [handleCloseWorkspaceTab]);
  ```
  Note: `handleCloseWorkspaceTab` synchronously either removes the tab immediately or opens a confirmation dialog and returns — it does not block waiting for the user's choice — so a loop calling it for every id in one bulk action is safe: at most one confirmation dialog is visible at a time (the existing `pendingTerminalClose`/`pendingChatClose` state is single-slot), and closing or cancelling it does not re-invoke this loop, so any ids after the first busy one are simply left open. Confirm this against the current `handleCloseWorkspaceTab` body before wiring — if it has changed shape on this branch, adjust so bulk-close still stops (rather than force-removing) at the first busy tab it can't silently close.

- [ ] **Step 3: Wire `onCloseTabs` at the center tab bar**

  Line 1336:
  ```tsx
  <TabBar ariaLabel="Workspace tabs" tabs={workspaceTabs} activeTabId={activeWorkspaceTabId} onSelectTab={handleSelectWorkspaceTab} onCloseTab={handleCloseWorkspaceTab} />
  ```
  becomes:
  ```tsx
  <TabBar ariaLabel="Workspace tabs" tabs={workspaceTabs} activeTabId={activeWorkspaceTabId} onSelectTab={handleSelectWorkspaceTab} onCloseTab={handleCloseWorkspaceTab} onCloseTabs={closeWorkspaceTabsSequentially} />
  ```
  `onToggleTabLocked` is intentionally omitted here — center tabs have no lock concept (only `PI_TAB.id`'s `closable: false` protects it, which `TabBar`'s existing `isTabClosable`/`closeableIds` helpers already respect for every menu item).

- [ ] **Step 4: Update `docs/prd/responsive-workspace.md`**

  The existing bullet:
  ```
  - 标签栏支持滚轮横向滚动和右键管理；锁定标签不会被批量关闭。关闭运行中的终端标签或运行中、等待审批的聊天标签前先确认，可选择保持运行或停止。
  ```
  extend it (or add a bullet right after it):
  ```
  - 中央工作区标签栏同样支持右键的"关闭其他"/"关闭全部"；批量关闭时逐个走原有的运行中终端/聊天确认弹窗，不会跳过确认。
  ```

- [ ] **Step 5: Add e2e tests to `e2e/navigation.spec.ts`**

  ```ts
  test("Close Others on the center tab bar keeps the clicked tab and prompts for a busy terminal", async ({ page }) => {
    await mockStatusStream(page, [{ type: "terminals", terminals: [{ id: "t1", provider: "shell", state: "running", cwd: "/tmp/proj" }] }]);
    await page.goto("/");
    // ... open a second workspace tab (e.g. a file tab) alongside the running
    // terminal tab, right-click the file tab, choose "Close Other Tabs", and
    // assert the running-terminal confirmation dialog appears instead of the
    // terminal tab silently disappearing.
    await page.getByRole("tab", { name: /.*/ }).first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Close Other Tabs" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });
  ```

**Gates:** `npx tsc --noEmit -p .`; `npx eslint components/TabBar.tsx components/AppShell.tsx e2e/navigation.spec.ts`; `npm test`; `npx playwright test e2e/navigation.spec.ts --project=chromium --project=mobile-chromium`.

---

### Task 6: Drag-to-reorder center tabs

**Problem:** Workspace tabs can only be reordered by closing and reopening them; there is no drag-and-drop.

**Files:**
- Modify: `lib/workspace/panel-state.ts` (new `reorder` action + reducer case)
- Create: `lib/workspace/panel-state.test.mjs`
- Modify: `components/TabBar.tsx` (native HTML5 drag events, new `onReorderTabs` prop)
- Modify: `components/AppShell.tsx` (wire `onReorderTabs` to `dispatchCenter`)
- Modify: `docs/prd/responsive-workspace.md`
- Modify: `e2e/navigation.spec.ts`

**Interfaces:**
- New: `CenterAction` gains `{ type: "reorder"; id: string; beforeId: string | null }` (move tab `id` to just before `beforeId`, or to the end when `beforeId` is `null`).
- New in `TabBar.tsx`: `onReorderTabs?: (id: string, beforeId: string | null) => void`.

**Steps:**

- [ ] **Step 1: Add the `reorder` action to `lib/workspace/panel-state.ts`**

  Extend `CenterAction` (currently ending with `setSplit`):
  ```ts
  export type CenterAction =
    | { type: "hydrate"; state: CenterState }
    | { type: "open"; tab: TerminalTab | CodexChatTab | ClaudeChatTab; mergeExisting?: Partial<TerminalTab> | Partial<CodexChatTab> | Partial<ClaudeChatTab> }
    | { type: "activate"; id: string }
    | { type: "select"; id: string }
    | { type: "remove"; id: string }
    | { type: "removeWhere"; predicate: (tab: CenterTab) => boolean }
    | { type: "update"; update: (tab: CenterTab) => CenterTab }
    | { type: "setSplit"; split: TerminalSplit | null | ((current: TerminalSplit | null) => TerminalSplit | null) }
    | { type: "reorder"; id: string; beforeId: string | null };
  ```
  Add a case in `centerReducer` (after `case "setSplit"`, before the closing `}` of the switch):
  ```ts
    case "reorder": {
      if (action.id === PI_TAB.id || action.id === action.beforeId) return state;
      const from = state.tabs.findIndex((tab) => tab.id === action.id);
      if (from < 0) return state;
      const moved = state.tabs[from];
      const withoutMoved = state.tabs.filter((tab) => tab.id !== action.id);
      const toIndex = action.beforeId ? withoutMoved.findIndex((tab) => tab.id === action.beforeId) : withoutMoved.length;
      if (toIndex < 0) return state;
      // The pinned Pi tab always stays first; nothing can land before it.
      const insertAt = Math.max(toIndex, withoutMoved[0]?.id === PI_TAB.id ? 1 : 0);
      const tabs = [...withoutMoved.slice(0, insertAt), moved, ...withoutMoved.slice(insertAt)];
      return { ...state, tabs };
    }
  ```

- [ ] **Step 2: Unit test `lib/workspace/panel-state.test.mjs`**

  ```js
  import assert from "node:assert/strict";
  import test from "node:test";
  import { createJiti } from "jiti";

  const jiti = createJiti(import.meta.url);
  const { centerReducer, initialCenterState } = await jiti.import("./panel-state.ts");
  const { PI_TAB } = await jiti.import("./tabs.ts");

  function tab(id) { return { id, label: id, kind: "file", filePath: `/repo/${id}.ts` }; }

  test("reorder: moves a tab before another, keeping Pi tab first", () => {
    const state = { ...initialCenterState(), tabs: [PI_TAB, tab("a"), tab("b"), tab("c")] };
    const next = centerReducer(state, { type: "reorder", id: "c", beforeId: "a" });
    assert.deepEqual(next.tabs.map((t) => t.id), ["pi", "c", "a", "b"]);
  });

  test("reorder: beforeId null moves the tab to the end", () => {
    const state = { ...initialCenterState(), tabs: [PI_TAB, tab("a"), tab("b")] };
    const next = centerReducer(state, { type: "reorder", id: "a", beforeId: null });
    assert.deepEqual(next.tabs.map((t) => t.id), ["pi", "b", "a"]);
  });

  test("reorder: the Pi tab can never be moved", () => {
    const state = { ...initialCenterState(), tabs: [PI_TAB, tab("a")] };
    const next = centerReducer(state, { type: "reorder", id: "pi", beforeId: "a" });
    assert.equal(next, state);
  });

  test("reorder: nothing can be dropped before the Pi tab", () => {
    const state = { ...initialCenterState(), tabs: [PI_TAB, tab("a"), tab("b")] };
    const next = centerReducer(state, { type: "reorder", id: "b", beforeId: "pi" });
    assert.deepEqual(next.tabs.map((t) => t.id), ["pi", "b", "a"]);
  });

  test("reorder: an unknown id is a no-op", () => {
    const state = { ...initialCenterState(), tabs: [PI_TAB, tab("a")] };
    const next = centerReducer(state, { type: "reorder", id: "missing", beforeId: "a" });
    assert.equal(next, state);
  });
  ```

- [ ] **Step 3: Add drag-and-drop to `components/TabBar.tsx`**

  Add a prop and local state:
  ```ts
  interface Props {
    tabs: Tab[];
    activeTabId: string;
    onSelectTab: (id: string) => void;
    onCloseTab: (id: string) => void;
    onCloseTabs?: (ids: string[]) => void;
    onToggleTabLocked?: (id: string) => void;
    onReorderTabs?: (id: string, beforeId: string | null) => void;
    onRevealFile?: (filePath: string) => void;
    ariaLabel?: string;
  }
  ```
  ```ts
  export function TabBar({ tabs, activeTabId, onSelectTab, onCloseTab, onCloseTabs, onToggleTabLocked, onReorderTabs, onRevealFile, ariaLabel = "Open tabs" }: Props) {
    ...
    const [draggedId, setDraggedId] = useState<string | null>(null);
    const [dropBeforeId, setDropBeforeId] = useState<string | null | undefined>(undefined);
  ```
  On each tab's `<div>` (the one currently holding `onClick`/`onKeyDown`/`onContextMenu`), add, guarded by `Boolean(onReorderTabs)`:
  ```tsx
              draggable={Boolean(onReorderTabs) && tab.closable !== false}
              onDragStart={(event) => { if (!onReorderTabs) return; setDraggedId(tab.id); event.dataTransfer.effectAllowed = "move"; }}
              onDragEnd={() => { setDraggedId(null); setDropBeforeId(undefined); }}
              onDragOver={(event) => {
                if (!onReorderTabs || !draggedId || draggedId === tab.id) return;
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                const before = event.clientX < rect.left + rect.width / 2;
                setDropBeforeId(before ? tab.id : (tabs[tabs.findIndex((t) => t.id === tab.id) + 1]?.id ?? null));
              }}
              onDrop={(event) => {
                if (!onReorderTabs || !draggedId) return;
                event.preventDefault();
                if (dropBeforeId !== undefined) onReorderTabs(draggedId, dropBeforeId);
                setDraggedId(null);
                setDropBeforeId(undefined);
              }}
  ```
  and add a visual drop-indicator to the tab's existing `style` object (a left border that lights up when it is the current drop target):
  ```ts
                borderLeft: dropBeforeId === tab.id ? "2px solid var(--accent)" : "2px solid transparent",
  ```
  (`tab.closable !== false` in the `draggable` condition keeps the pinned `PI_TAB` — `closable: false` — from being dragged; `onDragOver`'s own `draggedId === tab.id` guard, plus the reducer's `PI_TAB.id` special case from Step 1, are the second and third layers of the same invariant.)

- [ ] **Step 4: Wire `onReorderTabs` in `components/AppShell.tsx`**

  At the center `TabBar` (from Task 5, now also passing `onCloseTabs`):
  ```tsx
  <TabBar
    ariaLabel="Workspace tabs"
    tabs={workspaceTabs}
    activeTabId={activeWorkspaceTabId}
    onSelectTab={handleSelectWorkspaceTab}
    onCloseTab={handleCloseWorkspaceTab}
    onCloseTabs={closeWorkspaceTabsSequentially}
    onReorderTabs={(id, beforeId) => dispatchCenter({ type: "reorder", id, beforeId })}
  />
  ```
  `dispatchCenter` is the existing dispatcher for `centerReducer` (already used throughout `AppShell.tsx`, e.g. `dispatchCenter({ type: "remove", id: tabId })` in `removeWorkspaceTab`).

- [ ] **Step 5: Update `docs/prd/responsive-workspace.md`**

  Extend the tab-bar bullet from Task 5 (or add directly after it):
  ```
  - 中央工作区标签支持拖拽排序；固定的 "TianForge pi" 标签始终排在第一位，不可拖动，也不能被拖到它前面。
  ```

- [ ] **Step 6: Add an e2e test to `e2e/navigation.spec.ts`**

  ```ts
  test("dragging a tab reorders the center tab bar", async ({ page }) => {
    await mockStatusStream(page);
    await page.goto("/");
    // ... open two file tabs "a.ts" and "b.ts" in the center workspace, then:
    const tabA = page.getByRole("tab", { name: "a.ts" });
    const tabB = page.getByRole("tab", { name: "b.ts" });
    const box = await tabB.boundingBox();
    await tabA.hover();
    await page.mouse.down();
    if (box) await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2);
    await page.mouse.up();
    const order = await page.getByRole("tab").allTextContents();
    expect(order.indexOf("b.ts")).toBeLessThan(order.indexOf("a.ts"));
  });
  ```
  (Playwright's `page.mouse` drag simulates native HTML5 drag-and-drop unreliably in some browsers; if this proves flaky in `chromium`/`mobile-chromium`, dispatch `dragstart`/`dragover`/`drop` `DataTransfer` events directly via `page.evaluate` instead — verify against the actual CI run rather than assuming either approach works first.)

**Gates:** `npx tsc --noEmit -p .`; `npx eslint lib/workspace/panel-state.ts components/TabBar.tsx components/AppShell.tsx e2e/navigation.spec.ts`; `npm test` (covers `lib/workspace/panel-state.test.mjs`); `npx playwright test e2e/navigation.spec.ts --project=chromium --project=mobile-chromium`.

---

### Task 7: Reopen the last closed tab (Cmd/Ctrl+Shift+T)

**Problem:** Closing a workspace tab (file, terminal, or chat) is permanent; there's no undo, unlike closing a whole project (which already has a 6-second undo via `ProjectRail`).

**Files:**
- Modify: `components/AppShell.tsx` (capture the last removed tab, new bubble-phase `window` keydown listener)
- Modify: `docs/prd/responsive-workspace.md`
- Modify: `e2e/navigation.spec.ts`

**Interfaces:**
- New in `AppShell.tsx`: `lastClosedTabRef: React.MutableRefObject<CenterTab | null>` and a `useEffect` registering a bubble-phase `window` "keydown" listener for Cmd/Ctrl+Shift+T.
- Consumes: `dispatchCenter({ type: "open", tab })` (existing action, used elsewhere to reopen/re-add a tab) and `removeWorkspaceTab` (existing single-tab removal funnel, `AppShell.tsx:665`).

**Steps:**

- [ ] **Step 1: Capture the removed tab at the single funnel point**

  `removeWorkspaceTab` (line 665) is the one place every tab-close path (`handleCloseWorkspaceTab`, `closeTerminalTab`, `closeChatTab`) ultimately calls. Add a ref and capture the tab there before it's gone:
  ```ts
  const lastClosedTabRef = useRef<CenterTab | null>(null);

  const removeWorkspaceTab = useCallback((tabId: string) => {
    const closed = workspaceTabs.find((tab) => tab.id === tabId);
    if (closed) lastClosedTabRef.current = closed;
    dispatchCenter({ type: "remove", id: tabId });
  }, [workspaceTabs]);
  ```
  (This replaces the current one-line `useCallback((tabId: string) => dispatchCenter({ type: "remove", id: tabId }), [])` — the dependency array must now include `workspaceTabs`.)

- [ ] **Step 2: Register the bubble-phase reopen shortcut**

  Add near the other top-level `useEffect`s in `AppShell.tsx`:
  ```ts
  // Cmd/Ctrl+Shift+T reopens the last closed workspace tab. ProjectRail binds
  // the same chord (bubble phase, on `document`) for 6 seconds after a whole
  // project is closed, to undo that instead — see docs/prd/multi-project-workspaces.md.
  // This listener is bubble phase on `window`, so it fires after any
  // document-level bubble listener (bubbling goes target -> ... -> document
  // -> window); it checks event.defaultPrevented first so ProjectRail's
  // handler — which calls preventDefault() whenever it acts — always wins.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.key.toLowerCase() !== "t") return;
      const tab = lastClosedTabRef.current;
      if (!tab) return;
      event.preventDefault();
      lastClosedTabRef.current = null;
      dispatchCenter({ type: "open", tab });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  ```
  `dispatchCenter` is stable (from `useReducer`), so the empty dependency array is correct; `lastClosedTabRef` is a ref, not reactive state.

- [ ] **Step 3: Clear the ref when its tab is reopened through any other path**

  If the same tab is independently reopened (e.g. clicking it again from `SessionSidebar` before Cmd/Ctrl+Shift+T is pressed), the stale ref should not resurrect it a second time. Guard the "open" action's tab-matching in `centerReducer` already handles duplicate ids (`case "open"` reuses an existing tab of the same id — confirmed at the top of that case) — so worst case, pressing the shortcut after the tab was already reopened by hand simply re-activates it rather than creating a duplicate. No additional guard is required; note this reasoning in the PR description rather than adding defensive code that duplicates the reducer's existing dedup.

- [ ] **Step 4: Update `docs/prd/responsive-workspace.md`**

  ```
  - 关闭工作区标签（文件、终端或聊天）后可通过 `Cmd/Ctrl + Shift + T` 撤销，重新打开最后关闭的一个标签；若此时项目关闭撤销正处于 6 秒窗口内，同一快捷键优先撤销项目关闭。
  ```

- [ ] **Step 5: Add e2e tests to `e2e/navigation.spec.ts`**

  ```ts
  test("Cmd/Ctrl+Shift+T reopens the last closed workspace tab", async ({ page }) => {
    await mockStatusStream(page);
    await page.goto("/");
    // ... open a file tab "a.ts", close it, then:
    await expect(page.getByRole("tab", { name: "a.ts" })).toBeHidden();
    await page.keyboard.press("ControlOrMeta+Shift+t");
    await expect(page.getByRole("tab", { name: "a.ts" })).toBeVisible();
  });

  test("Cmd/Ctrl+Shift+T undoes a project close instead, when both are pending", async ({ page }) => {
    await mockStatusStream(page);
    await page.goto("/");
    // ... open a file tab, close it (arms the tab-reopen ref), then close the
    // whole project (arms ProjectRail's 6-second project-reopen window), then
    // press the shortcut once and assert the PROJECT comes back, not the tab.
  });
  ```

**Gates:** `npx tsc --noEmit -p .`; `npx eslint components/AppShell.tsx e2e/navigation.spec.ts`; `npm test` (no unit coverage for this — verified via e2e); `npx playwright test e2e/navigation.spec.ts --project=chromium --project=mobile-chromium`.

---

### Task 8: Claude session rename/archive parity with Codex

**Problem:** `components/agents/AgentsPanel.tsx`'s Claude session rows only support "Open in Chat", "Fork to Chat", "Resume/Fork in Terminal…", and "Delete…" — unlike Codex sessions, which also support Rename and Archive/Restore. `server/agents/claude-sessions.cjs` has no rename/archive concept at all; Claude's own `.jsonl` files are the source of truth and are not owned by pi-web.

**Files:**
- Create: `server/agents/claude-session-meta.cjs` (sidecar metadata store, mirrors `server/task-templates.cjs`)
- Create: `server/agents/claude-session-meta.test.cjs`
- Modify: `server/agents/claude-sessions.cjs` (`sessionAt`, `listSessions`, `remove`, new `rename`/`setArchived` exports)
- Modify: `server/agents/claude-sessions-api.cjs` (new routes: rename, archive, unarchive; `archived` query param on list)
- Modify: `server/agents/claude-sessions.test.cjs` (new tests for the new routes, reusing the file's existing `claudeHome`/`write`/`user` test helpers)
- Modify: `hooks/useClaudeSessions.ts` (`archived` field + option)
- Modify: `components/agents/AgentsPanel.tsx` (`PendingAction` shape, new callbacks, new menu items, new Active/Archived toggle, `actionDialogText`/`AgentActionDialog` generalization)
- Modify: `docs/prd/agent-workspace.md`
- Modify: `e2e/navigation.spec.ts`

**Interfaces:**
- New in `server/agents/claude-session-meta.cjs`: `MetaError`, `get(id): {title?: string; archived?: boolean} | null`, `rename(id, name): {title, archived}`, `setArchived(id, archived): {title, archived}`, `remove(id): void`.
- Changes in `server/agents/claude-sessions.cjs`: `sessionAt` return type gains `archived: boolean`; `listSessions({cwd, query, cursor, limit, archived = false})` (new `archived` param, filters); new exports `rename(id, cwd, name)`, `setArchived(id, cwd, archived)`.
- Changes in `hooks/useClaudeSessions.ts`: `ClaudeSession` gains `archived: boolean`; hook options gain `archived?: boolean`.
- Changes in `components/agents/AgentsPanel.tsx`: `PendingAction`'s `"claude-session"` variant gains `action: "rename" | "archive" | "unarchive" | "delete"`.

**Steps:**

- [ ] **Step 1: Create `server/agents/claude-session-meta.cjs`**

  ```js
  /* eslint-disable @typescript-eslint/no-require-imports */
  "use strict";

  /**
   * Rename/archive overlay for Claude Code sessions. Claude owns its own
   * `.jsonl` session files (read-only to pi-web; a live `claude` CLI process
   * may be writing one at any time), so rename/archive state lives in a
   * sidecar file instead of being appended to Claude's own records, mirroring
   * `server/task-templates.cjs`'s `~/.pi-web/*.json` pattern exactly.
   */
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");

  class MetaError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }

  function file() {
    return process.env.PI_WEB_CLAUDE_SESSION_META_FILE || path.join(os.homedir(), ".pi-web", "claude-session-meta.json");
  }

  function isEntry(value) {
    return value && typeof value === "object"
      && (value.title === undefined || typeof value.title === "string")
      && (value.archived === undefined || typeof value.archived === "boolean");
  }

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file(), "utf8"));
      if (!parsed || typeof parsed.sessions !== "object" || parsed.sessions === null) return {};
      return Object.fromEntries(Object.entries(parsed.sessions).filter(([, value]) => isEntry(value)));
    } catch (error) {
      if (error?.code !== "ENOENT") console.warn(`[pi-web] Ignoring unreadable Claude session metadata file: ${error.message}`);
      return {};
    }
  }

  function save(sessions) {
    const target = file();
    const temp = `${target}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.rmSync(temp, { force: true });
    fs.writeFileSync(temp, JSON.stringify({ version: 1, sessions }), { mode: 0o600 });
    fs.renameSync(temp, target);
  }

  /** Stored overlay for one session id, or null when none is stored. */
  function get(id) {
    return load()[id] ?? null;
  }

  function rename(id, name) {
    if (typeof name !== "string" || !name.trim() || name.trim().length > 120) {
      throw new MetaError("invalid_name", "Session name must be between 1 and 120 characters");
    }
    const all = load();
    all[id] = { ...all[id], title: name.trim() };
    save(all);
    return all[id];
  }

  function setArchived(id, archived) {
    const all = load();
    all[id] = { ...all[id], archived: Boolean(archived) };
    save(all);
    return all[id];
  }

  function remove(id) {
    const all = load();
    if (!(id in all)) return;
    delete all[id];
    save(all);
  }

  module.exports = { MetaError, get, rename, setArchived, remove };
  ```

- [ ] **Step 2: Test `server/agents/claude-session-meta.test.cjs`**

  ```js
  /* eslint-disable @typescript-eslint/no-require-imports */
  "use strict";

  const assert = require("node:assert/strict");
  const test = require("node:test");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");

  function withMetaFile(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-claude-meta-"));
    const target = path.join(dir, "meta.json");
    process.env.PI_WEB_CLAUDE_SESSION_META_FILE = target;
    t.after(() => { delete process.env.PI_WEB_CLAUDE_SESSION_META_FILE; fs.rmSync(dir, { recursive: true, force: true }); });
    delete require.cache[require.resolve("./claude-session-meta.cjs")];
    return require("./claude-session-meta.cjs");
  }

  test("rename: stores and returns a trimmed title", (t) => {
    const meta = withMetaFile(t);
    const result = meta.rename("s1", "  My Session  ");
    assert.equal(result.title, "My Session");
    assert.equal(meta.get("s1").title, "My Session");
  });

  test("rename: rejects an empty or overlong name", (t) => {
    const meta = withMetaFile(t);
    assert.throws(() => meta.rename("s1", "   "), /invalid_name/);
    assert.throws(() => meta.rename("s1", "x".repeat(121)), /invalid_name/);
  });

  test("setArchived: toggles independently of title", (t) => {
    const meta = withMetaFile(t);
    meta.rename("s1", "Kept name");
    meta.setArchived("s1", true);
    assert.deepEqual(meta.get("s1"), { title: "Kept name", archived: true });
    meta.setArchived("s1", false);
    assert.equal(meta.get("s1").archived, false);
  });

  test("remove: deletes the overlay entry", (t) => {
    const meta = withMetaFile(t);
    meta.rename("s1", "Name");
    meta.remove("s1");
    assert.equal(meta.get("s1"), null);
  });

  test("get: returns null for an unknown id, and survives a missing file", (t) => {
    const meta = withMetaFile(t);
    assert.equal(meta.get("unknown"), null);
  });
  ```

- [ ] **Step 3: Overlay the metadata in `server/agents/claude-sessions.cjs`**

  Add the require near the top:
  ```js
  const meta = require("./claude-session-meta.cjs");
  ```
  `sessionAt` (currently lines 127-145):
  ```js
  function sessionAt(target, id, stat) {
    const head = headFor(target, stat);
    const tail = cachedFor(tailCache, target, stat, () => readTail(target, stat.size));
    const override = meta.get(id);
    const title = override?.title || tail.custom || head.titles.custom || tail.ai || head.titles.ai || null;
    // A file without a prompt is a session that was opened and left, or only
    // holds title records; there is nothing to resume.
    if (!head.firstMessage) return null;
    return {
      id,
      title: title || head.firstMessage,
      firstMessage: head.firstMessage,
      cwd: head.cwd,
      gitBranch: head.gitBranch,
      createdAt: head.createdAt,
      updatedAt: stat.mtime.toISOString(),
      size: stat.size,
      archived: Boolean(override?.archived),
      path: target,
    };
  }
  ```
  `listSessions` (currently lines 175-192) gains an `archived` parameter and filters by it:
  ```js
  function listSessions({ cwd, query, cursor, limit = 50, archived = false } = {}) {
    if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw error("invalid_cwd", "A workspace folder is required");
    const { sessions, seen } = scan(cwd);
    const directories = new Set(projectDirs(cwd));
    for (const cache of [headCache, tailCache]) {
      for (const target of cache.keys()) if (!seen.has(target) && directories.has(path.dirname(target))) cache.delete(target);
    }
    if (headCache.size > 5000) { headCache.clear(); tailCache.clear(); }
    const needle = typeof query === "string" ? query.trim().toLowerCase() : "";
    const matching = sessions
      .filter((session) => Boolean(session.archived) === Boolean(archived))
      .filter((session) => !needle || `${session.title} ${session.firstMessage || ""} ${session.id}`.toLowerCase().includes(needle))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const offset = /^\d+$/.test(String(cursor ?? "")) ? Number(cursor) : 0;
    const size = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || 50));
    const page = matching.slice(offset, offset + size);
    return { sessions: page, nextCursor: offset + size < matching.length ? String(offset + size) : null };
  }
  ```
  `remove` (currently lines 212-219) also clears the overlay:
  ```js
  function remove(id, cwd) {
    const session = requireSession(id, cwd);
    fs.rmSync(session.path, { force: true });
    fs.rmSync(path.join(path.dirname(session.path), id), { recursive: true, force: true });
    headCache.delete(session.path);
    tailCache.delete(session.path);
    meta.remove(id);
    return session;
  }
  ```
  New exports, added near `remove`:
  ```js
  function rename(id, cwd, name) {
    requireSession(id, cwd);
    const updated = meta.rename(id, name);
    return { ...requireSession(id, cwd), title: updated.title, archived: Boolean(updated.archived) };
  }

  function setArchived(id, cwd, archived) {
    requireSession(id, cwd);
    const updated = meta.setArchived(id, Boolean(archived));
    return { ...requireSession(id, cwd), archived: Boolean(updated.archived) };
  }
  ```
  Update the module's final export line to:
  ```js
  module.exports = { listSessions, requireSession, remove, rename, setArchived, encodeCwd, sessionFile, readHistory, forkPoint, agentTranscript, compactRecord };
  ```
  (`rename`/`setArchived` each call `requireSession` twice — once to validate ownership before touching the sidecar, once after to return a fresh, fully-merged session object reflecting the just-written overlay. This mirrors `remove`'s existing single validate-then-act shape and avoids hand-assembling the returned object's non-overlay fields.)

- [ ] **Step 4: Add routes in `server/agents/claude-sessions-api.cjs`**

  ```js
  const ACTION = /^\/api\/claude\/sessions\/[^/]+\/(delete|rename|archive|unarchive)$/;
  function isPath(pathname) { return pathname === "/api/claude/sessions" || ACTION.test(pathname); }
  async function handle(req, res, url) {
    try {
      if (url.pathname === "/api/claude/sessions") {
        if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
        const { sessions, nextCursor } = catalog.listSessions({
          cwd: requireCwd(url.searchParams.get("cwd")),
          query: url.searchParams.get("q") || "",
          archived: url.searchParams.get("archived") === "true",
          cursor: url.searchParams.get("cursor") || undefined,
          limit: url.searchParams.get("limit") || 50,
        });
        return json(res, 200, { sessions: sessions.map(withRuntime), nextCursor });
      }
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
      const [id, action] = url.pathname.split("/").slice(4);
      const body = await readJson(req);
      const cwd = requireCwd(body.cwd);
      if (action === "rename") return json(res, 200, { session: withRuntime(catalog.rename(id, cwd, body.name)) });
      if (action === "archive" || action === "unarchive") return json(res, 200, { session: withRuntime(catalog.setArchived(id, cwd, action === "archive")) });
      // Checked and removed in one synchronous step, so no terminal can start
      // on this session in between. Rename/archive above skip this check:
      // they only touch the sidecar overlay, never Claude's own session file,
      // so they're safe even while a terminal or Claude Chat is writing it.
      const session = catalog.requireSession(id, cwd);
      assertNotBusy(session, cwd);
      return json(res, 200, { session: withRuntime(catalog.remove(id, cwd)) });
    } catch (cause) {
      const code = cause?.code;
      const status = STATUS[code] || 500;
      if (status >= 500) console.error("[pi-web] Claude session request failed:", cause);
      return json(res, status, { error: status === 500 ? "Claude session request failed" : cause?.message, code });
    }
  }
  module.exports = { isPath, handle };
  ```
  (This replaces the existing `isPath`/`handle` at the end of the file — lines 46-76 — in full; `runtimeFor`, `withRuntime`, `STATUS`, `readJson`, `requireCwd`, `assertNotBusy` above them are unchanged.)

- [ ] **Step 5: Add route tests to `server/agents/claude-sessions.test.cjs`**

  Add tests using this file's existing `claudeHome(t, cwd)`/`write`/`user` helpers (do not duplicate them):
  ```js
  test("rename: renames a session and the API returns it in subsequent listings", async (t) => {
    const cwd = claudeHome(t, "/tmp/proj");
    write("s1", [user("hello")]);
    const response = await api.handle(fakeReq("POST", { cwd }), fakeRes(), new URL(`http://x/api/claude/sessions/s1/rename`));
    // ... adapt to this file's existing request/response fakes and assert
    // the renamed title round-trips through catalog.listSessions({ cwd }).
  });

  test("archive/unarchive: moves a session between the active and archived lists", async (t) => {
    const cwd = claudeHome(t, "/tmp/proj");
    write("s1", [user("hello")]);
    const { sessions: active } = catalog.listSessions({ cwd });
    assert.equal(active.length, 1);
    catalog.setArchived("s1", cwd, true);
    assert.equal(catalog.listSessions({ cwd, archived: false }).sessions.length, 0);
    assert.equal(catalog.listSessions({ cwd, archived: true }).sessions.length, 1);
  });
  ```
  (Read the file's current top section first — it already imports `catalog` and `api` and defines the exact fake-request helpers this task's new tests must reuse; adapt the sketch above to those exact helper names and signatures rather than introducing new ones.)

- [ ] **Step 6: Add `archived` to `hooks/useClaudeSessions.ts`**

  ```ts
  export interface ClaudeSession {
    id: string;
    title: string;
    firstMessage: string | null;
    cwd: string | null;
    gitBranch: string | null;
    createdAt: string | null;
    updatedAt: string;
    size: number;
    archived: boolean;
    runtime: { owner: "terminal"; state: "running"; terminalId: string } | { owner: "chat"; state: "idle" | "running" | "approval"; connected: boolean } | null;
  }
  ```
  ```ts
  export function useClaudeSessions(cwd: string, { enabled, query, changeKey, refreshKey, archived }: { enabled: boolean; query: string; changeKey: string; refreshKey?: number; archived?: boolean }) {
    ...
    const fetchPage = useCallback(async (cursor: number, limit: number) => {
      const params = new URLSearchParams({ cwd, limit: String(limit), cursor: String(cursor), archived: String(Boolean(archived)) });
      if (query) params.set("q", query);
      const response = await fetch(`/api/claude/sessions?${params}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Unable to load Claude sessions");
      const data = await response.json() as { sessions?: ClaudeSession[]; nextCursor?: string | null };
      return { page: data.sessions ?? [], cursor: data.nextCursor ?? null };
    }, [cwd, query, archived]);
  ```
  Also add `archived` to the reset effect's dependency array (currently `[cwd, query]`, at the `useEffect` that clears `sessions`/`nextCursor` on folder or query change):
  ```ts
  useEffect(() => {
    ++requestRef.current;
    loadedRef.current = 0;
    setSessions([]);
    setNextCursor(null);
    setError(false);
    setLoadMoreError(false);
  }, [cwd, query, archived]);
  ```

- [ ] **Step 7: Update `components/agents/AgentsPanel.tsx`**

  `PendingAction`'s `"claude-session"` variant:
  ```ts
  type PendingAction =
    | { kind: "session"; action: "rename" | "archive" | "unarchive" | "delete"; session: CodexSession }
    | { kind: "claude-session"; action: "rename" | "archive" | "unarchive" | "delete"; session: ClaudeSession }
    | { kind: "terminal"; action: "stop" | "remove"; terminal: TerminalSession }
    | { kind: "clear"; provider?: TerminalProvider; count: number }
    | { kind: "template"; action: "run" | "delete"; template: TaskTemplate };
  ```
  New state, next to `showArchived` (line 74):
  ```ts
  const [claudeShowArchived, setClaudeShowArchived] = useState(false);
  ```
  `claudeCatalog` call (currently lines 337-343) gains `archived: claudeShowArchived`:
  ```ts
  const claudeCatalog = useClaudeSessions(cwd, {
    enabled: claudeOpen,
    query: debouncedClaudeQuery,
    refreshKey,
    archived: claudeShowArchived,
    changeKey: [...claudeTerminals.map((terminal) => `${terminal.id}:${terminal.state}`), ...claudeChatRuntimes.map((runtime) => `${runtime.sessionId}:${runtime.state === "idle" ? "idle" : "busy"}`)].sort().join(","),
  });
  ```
  Replace `deleteClaudeSession` (currently lines 464-481) with a generalized `manageClaudeSession`:
  ```ts
  const manageClaudeSession = useCallback(async (session: ClaudeSession, action: "rename" | "archive" | "unarchive" | "delete", requestedName?: string) => {
    let body: Record<string, string> = { cwd };
    if (action === "rename") {
      const name = requestedName?.trim();
      if (!name || name === session.title) return;
      body = { ...body, name };
    }
    setBusyId(session.id);
    setClaudeError(null);
    try {
      const response = await fetch(`/api/claude/sessions/${encodeURIComponent(session.id)}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || `Unable to ${action} session`);
      await reloadClaudeSessions(true);
    } catch (cause) {
      setClaudeError(cause instanceof Error ? cause.message : `Unable to ${action} session`);
    } finally {
      setBusyId(null);
    }
  }, [cwd, reloadClaudeSessions]);

  const requestClaudeSessionAction = useCallback((session: ClaudeSession, action: "rename" | "archive" | "unarchive" | "delete") => {
    setRenameValue(session.title);
    setPendingAction({ kind: "claude-session", action, session });
  }, []);
  ```
  `confirmPendingAction` (currently lines 630-640):
  ```ts
  const confirmPendingAction = useCallback(() => {
    const pending = pendingAction;
    if (!pending) return;
    if (pending.kind === "session" && pending.action === "rename" && (!renameValue.trim() || renameValue.trim() === pending.session.name)) return;
    if (pending.kind === "claude-session" && pending.action === "rename" && (!renameValue.trim() || renameValue.trim() === pending.session.title)) return;
    setPendingAction(null);
    if (pending.kind === "session") void manageSession(pending.session, pending.action, renameValue);
    else if (pending.kind === "claude-session") void manageClaudeSession(pending.session, pending.action, renameValue);
    else if (pending.kind === "terminal") void (pending.action === "stop" ? stopTerminal(pending.terminal) : removeTerminalRecord(pending.terminal));
    else if (pending.kind === "template") void (pending.action === "run" ? runTemplate(pending.template) : deleteTemplate(pending.template));
    else void clearEndedTerminalRecords(pending.provider);
  }, [clearEndedTerminalRecords, manageClaudeSession, deleteTemplate, manageSession, pendingAction, removeTerminalRecord, renameValue, runTemplate, stopTerminal]);
  ```
  (Removes `deleteClaudeSession` from the dependency array, adds `manageClaudeSession`.)

  JSX: the search-tools row (around line 766-772) gains an Active/Archived toggle, mirroring Codex's (lines 724-727):
  ```tsx
  <div style={sessionToolsStyle}>
    <label style={searchStyle}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>
      <input value={claudeQuery} onChange={(event) => setClaudeQuery(event.target.value)} placeholder="Search sessions" aria-label="Search Claude sessions" style={searchInputStyle} />
      {claudeQuery && <button type="button" onClick={() => setClaudeQuery("")} aria-label="Clear Claude session search" title="Clear" style={searchClearStyle}>×</button>}
    </label>
    <div style={sessionFilterStyle}>
      <button type="button" onClick={() => setClaudeShowArchived(false)} aria-pressed={!claudeShowArchived} style={{ ...filterButtonStyle, ...(!claudeShowArchived ? filterButtonActiveStyle : {}) }}>Active</button>
      <button type="button" onClick={() => setClaudeShowArchived(true)} aria-pressed={claudeShowArchived} style={{ ...filterButtonStyle, ...(claudeShowArchived ? filterButtonActiveStyle : {}) }}>Archived</button>
    </div>
  </div>
  ```
  The row loop's `ActionMenu` (currently lines 794-801) gains Rename/Archive/Restore before Delete, mirroring Codex's menu (lines 757-759), and the row's click-to-open is disabled while viewing the archived list (mirroring Codex's `showArchived` gating at lines 739/741):
  ```tsx
  <button
    type="button"
    disabled={busyId === session.id}
    style={{ ...sessionMainStyle, cursor: claudeShowArchived ? "default" : "pointer" }}
    title={[session.title, session.firstMessage !== session.title && session.firstMessage, session.gitBranch && `Branch: ${session.gitBranch}`, session.id].filter(Boolean).join("\n")}
    onClick={() => { if (!claudeShowArchived) openClaudeSession(session); }}
  >
    ...
  </button>
  <ActionMenu label={`Manage ${session.title}`}>
    {!claudeShowArchived && onOpenClaudeChat && <MenuButton onClick={() => onOpenClaudeChat({ sessionId: session.id, sessionName: session.title, cwd })}>Open in Chat</MenuButton>}
    {!claudeShowArchived && onForkClaudeChat && <MenuButton onClick={() => onForkClaudeChat({ sessionId: session.id, sessionName: session.title, cwd })}>Fork to Chat</MenuButton>}
    {!claudeShowArchived && <MenuButton onClick={() => { setClaudeError(null); setClaudeLaunch({ session, mode: "resume", permission: "confirm" }); }}>Resume in Terminal…</MenuButton>}
    {!claudeShowArchived && <MenuButton onClick={() => { setClaudeError(null); setClaudeLaunch({ session, mode: "fork", permission: "confirm" }); }}>Fork to Terminal…</MenuButton>}
    <span style={menuDividerStyle} />
    <MenuButton onClick={() => requestClaudeSessionAction(session, "rename")}>Rename</MenuButton>
    {claudeShowArchived ? <MenuButton onClick={() => requestClaudeSessionAction(session, "unarchive")}>Restore</MenuButton> : <MenuButton onClick={() => requestClaudeSessionAction(session, "archive")}>Archive</MenuButton>}
    <MenuButton danger onClick={() => requestClaudeSessionAction(session, "delete")}>Delete…</MenuButton>
  </ActionMenu>
  ```
  `AgentActionDialog` (currently lines 847-855):
  ```ts
  function AgentActionDialog({ action, renameValue, busy, onRenameChange, onCancel, onConfirm }: { action: PendingAction; renameValue: string; busy: boolean; onRenameChange: (value: string) => void; onCancel: () => void; onConfirm: () => void }) {
    const rename = (action.kind === "session" || action.kind === "claude-session") && action.action === "rename";
    const destructive = action.kind === "session" ? action.action === "delete"
      : action.kind === "claude-session" ? action.action === "delete"
      : action.kind === "terminal" || action.kind === "clear" || action.kind === "template";
    const { title, description, confirmLabel } = actionDialogText(action);
    const currentName = action.kind === "session" ? action.session.name : action.kind === "claude-session" ? action.session.title : "";
    const confirmDisabled = busy || (rename && (!renameValue.trim() || renameValue.trim() === currentName));
    return <ConfirmDialog title={title} description={description} confirmLabel={confirmLabel} destructive={destructive} busy={busy} confirmDisabled={confirmDisabled} onCancel={onCancel} onConfirm={onConfirm}>
      {rename && <input autoFocus value={renameValue} maxLength={120} onChange={(event) => onRenameChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !confirmDisabled) onConfirm(); }} style={{ ...inputStyle, marginTop: 14 }} />}
    </ConfirmDialog>;
  }
  ```
  `actionDialogText`'s `"claude-session"` case (currently lines 866-867):
  ```ts
  case "claude-session": {
    const title = action.session.title;
    if (action.action === "rename") return { title: "Rename Claude session", description: "Choose a name that identifies this session.", confirmLabel: "Rename" };
    if (action.action === "archive") return { title: "Archive Claude session", description: `“${title}” will move out of the active session list.`, confirmLabel: "Archive" };
    if (action.action === "unarchive") return { title: "Restore Claude session", description: `“${title}” will return to the active session list.`, confirmLabel: "Restore" };
    return { title: "Delete Claude session", description: `“${title}” and its sub-agent transcripts will be permanently deleted. This cannot be undone.`, confirmLabel: "Remove" };
  }
  ```

- [ ] **Step 8: Update `docs/prd/agent-workspace.md`**

  The existing bullet "查看、搜索、删除当前项目的 Claude 会话，在终端中恢复或 Fork，在聊天中打开或 Fork。" becomes:
  ```
  - 查看、搜索、重命名、归档和删除当前项目的 Claude 会话，在终端中恢复或 Fork，在聊天中打开或 Fork。归档状态存储在 `~/.pi-web/claude-session-meta.json` 中，不写入 Claude 自身的会话文件。
  ```

- [ ] **Step 9: Add e2e tests to `e2e/navigation.spec.ts`**

  ```ts
  test("renaming and archiving a Claude session updates the Agents panel", async ({ page }) => {
    await mockStatusStream(page);
    let archived = false;
    let title = "Investigate flaky test";
    await page.route("**/api/claude/sessions?*", (route) => {
      const url = new URL(route.request().url());
      const wantArchived = url.searchParams.get("archived") === "true";
      return route.fulfill({ json: { sessions: wantArchived === archived ? [{ id: "c1", title, firstMessage: title, cwd: "/tmp/proj", gitBranch: null, createdAt: null, updatedAt: "2026-01-01T00:00:00.000Z", size: 10, archived, runtime: null }] : [], nextCursor: null } });
    });
    await page.route("**/api/claude/sessions/c1/rename", (route) => {
      title = (route.request().postDataJSON() as { name: string }).name;
      return route.fulfill({ json: { session: { id: "c1", title, archived } } });
    });
    await page.route("**/api/claude/sessions/c1/archive", (route) => { archived = true; return route.fulfill({ json: { session: { id: "c1", title, archived } } }); });
    await page.goto("/");
    // ... open the Agents panel's Claude section, rename the session via its
    // action menu, assert the new title renders, then archive it and assert
    // it disappears from the Active list and appears under Archived.
  });
  ```

**Gates:** `npx tsc --noEmit -p .`; `npx eslint server/agents/claude-session-meta.cjs server/agents/claude-sessions.cjs server/agents/claude-sessions-api.cjs hooks/useClaudeSessions.ts components/agents/AgentsPanel.tsx e2e/navigation.spec.ts`; `npm test` (covers `server/agents/claude-session-meta.test.cjs` and the extended `server/agents/claude-sessions.test.cjs`); `npx playwright test e2e/navigation.spec.ts --project=chromium --project=mobile-chromium`.

---

### Task 9: Claude terminal restart resumes instead of starting a new session

**Problem:** `components/AppShell.tsx`'s `restartUnavailableTerminal` only resumes Codex terminals (`resumeCodex = tab.terminalProvider === "codex" && Boolean(tab.sourceSessionId)`); restarting an unavailable Claude terminal always launches `launchMode: "new"`, discarding the session history the terminal was showing, even though `server/agents/terminal-manager.cjs`'s `buildLaunchArgs` already supports `launchMode: "resume"` for Claude (`["--resume", sourceSessionId]`) and `AgentsPanel.tsx`'s "Resume in Terminal…" action already proves `tab.sourceSessionId` is populated for Claude terminals that were resumed or forked.

**Files:**
- Modify: `components/AppShell.tsx` (`restartUnavailableTerminal`, ~line 786-812)
- Modify: `docs/prd/agent-workspace.md`
- Modify: `e2e/navigation.spec.ts`

**Interfaces:**
- No new interfaces; this is a one-variable generalization inside an existing function.

**Steps:**

- [ ] **Step 1: Generalize `resumeCodex` to cover both resumable providers**

  Current code:
  ```ts
  const restartUnavailableTerminal = useCallback(async (tab: TerminalTab): Promise<TerminalSession | null> => {
    ...
    const resumeCodex = tab.terminalProvider === "codex" && Boolean(tab.sourceSessionId);
    const response = await fetch("/api/terminals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: tab.terminalProvider,
        cwd: tab.cwd,
        permissionMode: tab.terminalPermissionMode,
        launchMode: resumeCodex ? "resume" : "new",
        sourceSessionId: resumeCodex ? tab.sourceSessionId : undefined,
        noAltScreen: tab.terminalNoAltScreen,
        model: tab.terminalModel,
        webSearch: tab.terminalWebSearch,
        chatMode: tab.terminalChatMode,
      }),
    });
    ...
  }, [updateTerminals, setTerminalSplit]);
  ```
  becomes:
  ```ts
  const restartUnavailableTerminal = useCallback(async (tab: TerminalTab): Promise<TerminalSession | null> => {
    ...
    // A terminal that was originally launched with `resume`/`fork` keeps its
    // source session id (server/agents/terminal-manager.cjs's buildLaunchArgs
    // already turns that into `--resume <id>` / `--resume <id> --fork-session`
    // for both providers); one that was launched `new` never learns a
    // retroactive session id (Claude has no equivalent of Codex's
    // unknownCodexTerminals reconciliation), so it still restarts fresh.
    const canResume = (tab.terminalProvider === "codex" || tab.terminalProvider === "claude") && Boolean(tab.sourceSessionId);
    const response = await fetch("/api/terminals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: tab.terminalProvider,
        cwd: tab.cwd,
        permissionMode: tab.terminalPermissionMode,
        launchMode: canResume ? "resume" : "new",
        sourceSessionId: canResume ? tab.sourceSessionId : undefined,
        noAltScreen: tab.terminalNoAltScreen,
        model: tab.terminalModel,
        webSearch: tab.terminalWebSearch,
        chatMode: tab.terminalChatMode,
      }),
    });
    ...
  }, [updateTerminals, setTerminalSplit]);
  ```

- [ ] **Step 2: Update `docs/prd/agent-workspace.md`**

  The existing bullet "Terminal 支持停止、重启、删除记录、清理已结束任务和重连缓冲区。" gets a note:
  ```
  - Terminal 支持停止、重启、删除记录、清理已结束任务和重连缓冲区；重启一个以恢复或 Fork 方式启动的 Claude 或 Codex 终端会使用 `--resume` 继续原会话，而不是新建会话（仅当终端记录中保留了来源会话 id 时适用）。
  ```

- [ ] **Step 3: Add an e2e test to `e2e/navigation.spec.ts`**

  ```ts
  test("restarting an unavailable Claude terminal resumes its source session", async ({ page }) => {
    await mockStatusStream(page);
    let lastLaunch: Record<string, unknown> | null = null;
    await page.route("**/api/terminals", (route) => {
      if (route.request().method() === "POST") {
        lastLaunch = route.request().postDataJSON();
        return route.fulfill({ json: { terminal: { id: "t2", provider: "claude", state: "running", cwd: "/tmp/proj", sourceSessionId: lastLaunch?.sourceSessionId, launchMode: lastLaunch?.launchMode } } });
      }
      return route.continue();
    });
    // ... set up a Claude terminal tab with terminalProvider "claude",
    // sourceSessionId "11111111-1111-1111-1111-111111111111", state
    // "unavailable" (however AppShell surfaces a dead terminal — check the
    // current UI's restart affordance, e.g. a "Restart" button on the
    // terminal pane), click Restart, and assert:
    expect(lastLaunch?.launchMode).toBe("resume");
    expect(lastLaunch?.sourceSessionId).toBe("11111111-1111-1111-1111-111111111111");
  });
  ```

**Gates:** `npx tsc --noEmit -p .`; `npx eslint components/AppShell.tsx e2e/navigation.spec.ts`; `npm test`; `npx playwright test e2e/navigation.spec.ts --project=chromium --project=mobile-chromium`.

---

## Self-Review

**Spec coverage check** (against the six audited items):
1. Session list search → Task 1. Covered.
2. Find within a conversation → dropped, with verification evidence (no virtualization, no hidden/canvas text; native browser find is strictly adequate) recorded in "Facts the implementer needs".
3. Retry/regenerate the last assistant reply → Task 2, built entirely on the existing `handleNavigate`/`handleSend` pair — no new server RPC.
4. Cmd/Ctrl+K quick switcher and Cmd/Ctrl+, settings → Task 3 (settings, small) and Task 4 (quick switcher, substantial new component), both extending `hooks/useKeyboardShortcuts.ts` and respecting `hasVisibleModal`.
5. Close Others/Close All, drag-to-reorder, reopen-recently-closed-tab → Tasks 5, 6, 7 respectively — split because each is independently reviewable and testable, and because Task 7 required resolving a real pre-existing shortcut collision with `ProjectRail.tsx` that the other two don't touch.
6. Claude/Codex parity: rename/archive (Task 8) and terminal restart-resume (Task 9) — split because they touch entirely disjoint code paths (a new server-side sidecar store + `AgentsPanel.tsx` UI, versus a single client-side variable in `AppShell.tsx`).

**Placeholder scan:** every code step above is a complete function, reducer case, route handler, or test body with real names, types, and logic — no "TBD", "add appropriate error handling", "similar to Task N" (each task's code is written out even when it parallels another task's shape), or references to undefined helpers. The few `// ...` comments that do appear (Task 2 Step 5, Task 5 Step 5, Task 6 Step 6, Task 7 Step 5, Task 8 Step 5/9, Task 9 Step 3) mark Playwright *test setup* (driving the UI to a precondition state via already-established but not-yet-relocated helpers or UI flows), never production code or the assertions themselves — each is immediately followed by concrete `expect(...)` calls.

**Type/signature consistency check across tasks:**
- `filterSessionsByQuery(sessions: SessionInfo[], query: string): SessionInfo[]` (Task 1, `lib/session-list.ts`) is imported and called with the identical signature in Task 4's `QuickSwitcher.tsx`.
- `handleNavigate`/`handleSend`/`sessionBusy`/`isNew` (Task 2) are read, not redefined — their signatures come from the already-existing `useAgentSession` hook and are used as-is.
- `onOpenSettings?: () => void` (Task 3) and `onOpenQuickSwitcher?: () => void` (Task 4) are both added to the same `UseGlobalKeyboardShortcutsOptions` interface in `hooks/useKeyboardShortcuts.ts` — Task 4's step 1 shows the interface with both fields present, consistent with Task 3 having landed first.
- `onCloseTabs?: (ids: string[]) => void` (already existed) and the newly-independent `onToggleTabLocked?: (id: string) => void` (Task 5) and `onReorderTabs?: (id: string, beforeId: string | null) => void` (Task 6) are all optional `TabBar` props with matching call-site argument shapes at both the file tab bar (unchanged) and the center tab bar (Task 5 wires `onCloseTabs`, Task 6 wires `onReorderTabs`, both use `closeWorkspaceTabsSequentially`/`dispatchCenter` from `AppShell.tsx`).
- `CenterAction`'s new `{ type: "reorder"; id: string; beforeId: string | null }` (Task 6) matches the `dispatchCenter({ type: "reorder", id, beforeId })` call added in Task 6 Step 4 and the `centerReducer` case added in Task 6 Step 1 — same field names, same types.
- `removeWorkspaceTab` is redefined once, in Task 7 Step 1; Task 5 and Task 6 do not touch it and their new code (`closeWorkspaceTabsSequentially`, the `onReorderTabs` wiring) does not call it directly, avoiding a double-edit collision on the same function across tasks.
- `claude-session-meta.cjs`'s exported names (`get`, `rename`, `setArchived`, `remove`, `MetaError`) are used with those exact names in Task 8 Step 3 (`meta.get`, `meta.rename`, `meta.setArchived`, `meta.remove`) and Step 2's tests (`meta.rename`, `meta.setArchived`, `meta.get`, `meta.remove`) — no drift.
- `catalog.rename(id, cwd, name)` / `catalog.setArchived(id, cwd, archived)` (Task 8 Step 3, `claude-sessions.cjs`) match the calls in Task 8 Step 4's route handler (`catalog.rename(id, cwd, body.name)`, `catalog.setArchived(id, cwd, action === "archive")`) and Step 5's test (`catalog.setArchived("s1", cwd, true)`).
- `PendingAction`'s `"claude-session"` variant gains `action` in Task 8 Step 7; every read site touched in that same step (`confirmPendingAction`, `requestClaudeSessionAction`, `AgentActionDialog`, `actionDialogText`) is updated together, so no branch is left assuming the old two-field shape.
- Task 9's `canResume` (renamed from `resumeCodex`) is used consistently in both the `launchMode` and `sourceSessionId` fields of the same `fetch` call — no leftover reference to the old `resumeCodex` name.

## Execution Handoff

This plan is ready to execute. Two options:
1. **Subagent-driven development** (recommended): a fresh subagent per task, each starting from this plan file, running the task's own Gates before handing off.
2. **Inline execution**: work through the tasks in order in the current session, running each task's Gates before moving to the next.

Tasks 1-2 (session search, regenerate), 3-4 (shortcuts), 5-7 (tab bar), and 8-9 (Claude parity) are independent of each other and can be parallelized across sessions/subagents if preferred, except: Task 4 depends on Task 3 having already extended `hooks/useKeyboardShortcuts.ts` (or the two edits must be merged carefully if done in parallel — see Task 4's Files note), and Task 6 depends on Task 5 having wired `onCloseTabs` onto the center `TabBar` (Task 6 Step 4 extends that same JSX call).
