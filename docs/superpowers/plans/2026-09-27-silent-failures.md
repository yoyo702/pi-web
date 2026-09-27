# Silent Failures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix nine user-facing problems where TianForge either fails silently (console.error only, nothing on screen) or performs a destructive/optimistic action with no confirmation and no rollback.

**Architecture:** Every fix is local to the component or server module that already owns the behavior. There is no shared error/toast component to add: this codebase already has two idiomatic, established patterns and every task reuses whichever one its file already uses —
- `addNotice`/`NoticeShelf` (`hooks/useAgentSession.ts`, rendered in `components/ChatWindow.tsx`) for agent-session actions,
- inline `role="alert"` text with a timed auto-clear (`components/SessionSidebar.tsx`'s `actionError`, `components/GitReviewPanel.tsx`'s `actionError`) for row-scoped actions,
- `window.confirm` for destructive one-click actions (already the pattern in `components/GitReviewPanel.tsx`'s discard flow and `components/agents/AgentsPanel.tsx`'s terminal/session delete flows).

No new shared helper is introduced. Server-side work (Task 6) is a self-contained fix inside `server/agents/terminal-manager.cjs` with matching `node --test` coverage.

**Tech Stack:** Next.js 16 App Router route handlers, the custom Node server (`server/pi-web-server.js`), React 19, TypeScript, `node --test` (TS loaded through `jiti`, `.cjs` tests requiring the module directly), Playwright (`chromium` and `mobile-chromium` projects).

**Spec:** There is no separate spec document. The nine problems come from a product audit done in conversation. The **Problem** line in each task is the requirement. Chinese PRD docs under `docs/prd/*.md` are the closest thing to a living spec and are updated in the same task as the behavior they describe, per `AGENTS.md`.

## Global Constraints

- No new dependencies.
- UI copy is English, matching the rest of the app. PRD edits (`docs/prd/*.md`) are Chinese, matching those files. Every task that changes user-visible behavior edits the PRD bullet in the same task, naming the exact file and line.
- Follow the AGENTS.md rule: when feature behavior changes, update the matching PRD in the same commit as the code.
- Every task ends green on `npx tsc --noEmit -p .`, `npx eslint <touched files>`, and `npm test` (`node --require ./server/test-env.cjs --test server/agents/*.test.cjs lib/*.test.mjs lib/workspace/*.test.mjs components/*.test.mjs`). Tasks that touch UI also run a focused `npx playwright test e2e/reliability.spec.ts`.
- Work on the current branch, `feat/audit-followups` — other audit-followup tasks are already landing on it (see `git log`). Do not create a new branch.
- `hooks/` has no unit-test coverage in this repo (no `hooks/*.test.*` file exists, and the `npm test` glob doesn't cover it). Behavior added to `hooks/useAgentSession.ts` is verified through the e2e suite, not `node --test`.

## Facts the implementer needs

- The audit originally listed 8 items; one of them is already fixed and is dropped from this plan (see "Dropped item" below).
- `docs/prd/secure-lan-access.md` is, despite its name, the de facto PRD location for the Settings panel's Models and Plugins pages: `docs/prd/index.md` lists exactly 7 PRDs and none of them is dedicated to "Models" or "Plugins". `secure-lan-access.md:31` already documents the Models page's load-failure behavior, so this plan's Models/Plugins PRD bullets (Tasks 2 and 3) go in that same file, next to it.
- Dropped item: **"Chat input's model list doesn't refresh after Settings changes."** `components/AppShell.tsx:1558` bumps `modelsRefreshKey` unconditionally on every path that closes Settings (Cancel, backdrop click, Escape, and successful Save all call the same close handler), and `lib/models-cache.ts`'s `invalidateModelsCache()` is called from the same paths that mutate provider/model config. Settings is also a true full-screen blocking modal (`.settings-backdrop` CSS covers the viewport), so there's no way to see a stale model list next to an open Settings panel. Verified in code; no fix needed.
- `e2e/reliability.spec.ts` already exists (created by an earlier plan) and already defines `session` and `mockRunningSession(page, respond?)` at the top of the file. Tasks in this plan add new tests to that file and, in one case (Task 1), extend `mockRunningSession`'s signature with a new optional third parameter — do not create a second helper.
- `components/agents/AgentsPanel.tsx` and `components/agents/ConfirmDialog.tsx` may have local uncommitted changes from other in-flight work on this branch (a separate confirmation-dialog task). Re-read the current file before editing; if line numbers in Task 4 have shifted, use the quoted surrounding code to relocate the edit, not the line numbers.

---

### Task 1: Abort, Fork, branch switch, loading earlier messages, and changing the reasoning level must show errors and roll back

**Problem:** In `hooks/useAgentSession.ts`, `handleAbort`, `handleFork`, and `loadOlderMessages` catch their errors with `console.error` only — nothing appears on screen, so a failed Stop, Fork, or "load earlier messages" looks like it silently did nothing. `handleLeafChange` (branch switch) and `handleThinkingLevelChange` are worse: both update React state optimistically (`setActiveLeafId(leafId)`, `setThinkingLevel(level)`) before the network call, and neither rolls back on failure — the UI shows the new branch/reasoning level as active even though the server never applied it. `handleNavigate` (used for "Edit from here") has the same silent `.catch(() => {})` on its `navigate_tree` command but is out of scope: it isn't named in the audit and touching it risks scope creep into the Fork/edit-from-here flow.

**Files:**
- Modify: `hooks/useAgentSession.ts:461-467` (new ref), `hooks/useAgentSession.ts:651-667` (`loadContext`), `hooks/useAgentSession.ts:669-713` (`loadOlderMessages`), `hooks/useAgentSession.ts:1454-1513` (`handleAbort`, `handleFork`, `handleLeafChange`), `hooks/useAgentSession.ts:1760-1770` (`handleThinkingLevelChange`)
- Modify: `e2e/reliability.spec.ts` (new tests, extend `mockRunningSession`)
- Modify: `docs/prd/session-reliability.md:26` (new bullet after the Steer/Follow-up bullet)

**Interfaces:**
- Changes: `loadContext(sid: string, leafId: string | null): Promise<boolean>` (was `Promise<void>`) — callers must check the return value.
- New ref: `thinkingLevelRef: React.RefObject<ThinkingLevelOption>`, mirrors `thinkingLevel` the same way `activeLeafIdRef` mirrors `activeLeafId`.

- [ ] **Step 1: Add a `thinkingLevelRef` next to the existing `activeLeafIdRef`.** In `hooks/useAgentSession.ts`, in the ref block starting at line 461:

```ts
  const activeLeafIdRef = useRef<string | null>(null);
  const thinkingLevelRef = useRef<ThinkingLevelOption>("auto");
  const entryIdsRef = useRef<string[]>([]);
  const snapshotRef = useRef<SessionSnapshot | null>(initialSnapshot);

  activeLeafIdRef.current = activeLeafId;
  thinkingLevelRef.current = thinkingLevel;
  entryIdsRef.current = entryIds;
```

- [ ] **Step 2: Make `loadContext` report failure instead of only logging it.** Replace the whole function (currently lines 651-667):

```ts
  const loadContext = useCallback(async (sid: string, leafId: string | null): Promise<boolean> => {
    try {
      const params = new URLSearchParams({ deferThinking: "1", deferMedia: "1" });
      params.set("limit", String(contextPageSizeRef.current));
      if (leafId) params.set("leafId", leafId);
      const url = `/api/sessions/${encodeURIComponent(sid)}/context?${params}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as { context: SessionData["context"] };
      setMessages(d.context.messages);
      setEntryIds(d.context.entryIds ?? []);
      setHasOlderMessages(Boolean(d.context.page?.hasMore));
      setData((current) => current ? { ...current, context: d.context } : current);
      return true;
    } catch (e) {
      console.error("Failed to load context:", e);
      addNotice({ type: "error", message: e instanceof Error ? `Could not load messages: ${e.message}` : "Could not load messages" });
      return false;
    }
  }, [addNotice]);
```

(`addNotice` is declared later in the same function body, at line 895, but `loadContext`'s body only reads it when the callback actually runs — after the whole component function, including `addNotice`'s own `const`, has finished executing for that render. This is the same ordering already used elsewhere in this file, e.g. `handleModelChange` at line 1515 is declared before nothing later references it out of order — closures over `const` bindings in the same scope don't require the reference to be declared first, only initialized before the closure is *called*.)

- [ ] **Step 3: Make `handleAbort` and `handleFork` surface their errors.** Replace lines 1454-1491:

```ts
  const handleAbort = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    if (bashRunningRef.current) {
      try {
        await sendAgentCommand(sid, { type: "abort_bash" });
      } catch (e) {
        console.error("Failed to abort bash:", e);
        addNotice({ type: "error", message: e instanceof Error ? `Could not stop the shell command: ${e.message}` : "Could not stop the shell command" });
      }
      return;
    }
    try {
      await sendAgentCommand(sid, { type: "abort" });
    } catch (e) {
      console.error("Failed to abort:", e);
      addNotice({ type: "error", message: e instanceof Error ? `Could not stop the agent: ${e.message}` : "Could not stop the agent" });
    }
  }, [addNotice]);

  const handleFork = useCallback(async (entryId: string) => {
    if (bashRunningRef.current) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    setForkingEntryId(entryId);
    try {
      const result = await sendAgentCommand<{ cancelled?: boolean; newSessionId?: string }>(sid, {
        type: "fork",
        entryId,
      });
      const { cancelled, newSessionId } = result ?? {};
      if (!cancelled && newSessionId) {
        onSessionForked?.(newSessionId);
      }
    } catch (e) {
      console.error("Fork failed:", e);
      addNotice({ type: "error", message: e instanceof Error ? `Could not create a new session: ${e.message}` : "Could not create a new session" });
    } finally {
      setForkingEntryId(null);
    }
  }, [onSessionForked, addNotice]);
```

- [ ] **Step 4: Make `handleLeafChange` (branch switch) roll back on failure.** Leave `handleNavigate` (lines 1493-1501) untouched. Replace `handleLeafChange` (lines 1503-1513):

```ts
  const handleLeafChange = useCallback(async (leafId: string | null) => {
    if (bashRunningRef.current) return;
    const previousLeafId = activeLeafIdRef.current;
    setActiveLeafId(leafId);
    const sid = sessionIdRef.current;
    if (!sid) return;
    rememberActiveLeafId(sid, leafId);
    const loaded = await loadContext(sid, leafId);
    if (!loaded) {
      setActiveLeafId(previousLeafId);
      rememberActiveLeafId(sid, previousLeafId);
      await loadContext(sid, previousLeafId);
      return;
    }
    if (leafId) {
      try {
        await sendAgentCommand(sid, { type: "navigate_tree", targetId: leafId });
      } catch (e) {
        console.error("Failed to switch branch:", e);
        addNotice({ type: "error", message: e instanceof Error ? `Could not switch branch: ${e.message}` : "Could not switch branch" });
        setActiveLeafId(previousLeafId);
        rememberActiveLeafId(sid, previousLeafId);
        await loadContext(sid, previousLeafId);
      }
    }
  }, [loadContext, addNotice]);
```

- [ ] **Step 5: Make `loadOlderMessages` surface its error.** In the `catch` block (currently just `console.error("Failed to load older session messages:", e);` around line 709), add a notice and include `addNotice` in the dependency array:

```ts
    } catch (e) {
      console.error("Failed to load older session messages:", e);
      addNotice({ type: "error", message: e instanceof Error ? `Could not load earlier messages: ${e.message}` : "Could not load earlier messages" });
    } finally {
      setLoadingOlderMessages(false);
    }
  }, [data?.context.page?.beforeEntryId, loadingOlderMessages, addNotice]);
```

- [ ] **Step 6: Make `handleThinkingLevelChange` roll back on failure.** Replace lines 1760-1770:

```ts
  const handleThinkingLevelChange = useCallback(async (level: ThinkingLevelOption) => {
    const previousLevel = thinkingLevelRef.current;
    setThinkingLevel(level);
    if (level === "auto") return; // "auto" leaves pi's current setting untouched
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_thinking_level", level });
    } catch (e) {
      console.error("Failed to set thinking level:", e);
      addNotice({ type: "error", message: e instanceof Error ? `Could not change the reasoning level: ${e.message}` : "Could not change the reasoning level" });
      setThinkingLevel(previousLevel);
    }
  }, [addNotice]);
```

- [ ] **Step 7: Extend the shared e2e fixture to accept a branch tree and paging info.** In `e2e/reliability.spec.ts`, change `mockRunningSession`'s signature and its session-fetch route:

```ts
async function mockRunningSession(
  page: Page,
  respond?: (body: Record<string, unknown>) => { status: number; json: unknown } | null,
  sessionOverrides?: { tree?: unknown[]; leafId?: string; page?: { hasMore: boolean; beforeEntryId: string } },
) {
  const agentPosts: Array<Record<string, unknown>> = [];
  await page.route(`**/api/sessions/${session.id}/state`, (route) => route.fulfill({ json: {
    running: true,
    state: { isStreaming: true, isPromptRunning: true, isBashRunning: false, isCompacting: false },
  } }));
  await page.route(`**/api/sessions/${session.id}?*`, (route) => route.fulfill({ json: {
    sessionId: session.id,
    filePath: session.path,
    info: session,
    leafId: sessionOverrides?.leafId ?? "tip",
    tree: sessionOverrides?.tree ?? [],
    context: {
      messages: [
        { role: "user", content: "Start the task", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "Working on it" }], stopReason: "stop", timestamp: 2 },
      ],
      entryIds: ["user-1", "tip"],
      thinkingLevel: "medium",
      model: { provider: "openai-codex", modelId: "gpt-5.6-sol" },
      ...(sessionOverrides?.page ? { page: sessionOverrides.page } : {}),
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
```

- [ ] **Step 8: Add the new tests.** Append to `e2e/reliability.spec.ts` (near the other `mockRunningSession`-based tests):

```ts
test("a failed Stop shows why and leaves the agent running", async ({ page }) => {
  const { agentPosts } = await mockRunningSession(page, (body) => {
    if (body.type === "abort") return { status: 500, json: { error: "agent runtime unreachable" } };
    return null;
  });
  await page.getByTitle("Stop agent").click();
  await expect(page.getByText("Could not stop the agent: agent runtime unreachable")).toBeVisible();
  assertPostedTypes(agentPosts, ["abort"]);
});

test("a failed Fork shows why", async ({ page }) => {
  await mockRunningSession(page, (body) => {
    if (body.type === "fork") return { status: 500, json: { error: "disk full" } };
    return null;
  });
  await page.getByTitle("New session — creates an independent copy from here").click();
  await expect(page.getByText("Could not create a new session: disk full")).toBeVisible();
});

test("a failed reasoning-level change rolls back to the previous level", async ({ page }) => {
  await mockRunningSession(page, (body) => {
    if (body.type === "set_thinking_level") return { status: 500, json: { error: "session busy" } };
    return null;
  });
  await page.getByRole("button", { name: "Change reasoning level" }).click();
  await page.getByRole("button", { name: "high", exact: true }).click();
  await expect(page.getByText("Could not change the reasoning level: session busy")).toBeVisible();
  await expect(page.getByRole("button", { name: "Change reasoning level" })).toHaveAttribute("title", "Change reasoning level: medium");
});

test("a failed branch switch rolls back to the previous branch", async ({ page }) => {
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
  await expect(page.getByText("Working on it")).toBeVisible();
});

test("a failed 'load earlier messages' keeps the prompt and says why", async ({ page }) => {
  await mockRunningSession(page, undefined, { page: { hasMore: true, beforeEntryId: "user-1" } });
  await page.route(`**/api/sessions/${session.id}/context?*`, (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("beforeEntryId")) return route.fulfill({ status: 500, json: { error: "disk read failed" } });
    return route.continue();
  });
  await expect(page.getByText("Scroll up to load earlier messages")).toBeVisible();
  await expect(page.getByText("Could not load earlier messages: disk read failed")).toBeVisible();
  await expect(page.getByText("Scroll up to load earlier messages")).toBeVisible();
});
```

`assertPostedTypes` does not exist yet; add it once, next to `mockRunningSession`:

```ts
function assertPostedTypes(agentPosts: Array<Record<string, unknown>>, expected: string[]) {
  expect(agentPosts.map((post) => post.type)).toEqual(expected);
}
```

- [ ] **Step 9: Run the gates.**

Run: `npx tsc --noEmit -p .`
Run: `npx eslint hooks/useAgentSession.ts e2e/reliability.spec.ts`
Run: `npm test`
Run: `npx playwright test e2e/reliability.spec.ts`
Expected: all green; the five new tests pass together with the existing ones in the file.

- [ ] **Step 10: Update the PRD.** In `docs/prd/session-reliability.md`, after line 26 (the Steer/Follow-up bullet), add a new bullet under "Pi Session":

```
- 中断、Fork、切换分支、加载更早消息或调整推理强度失败时会显示具体原因；切换分支和调整推理强度会先乐观更新界面，失败后回滚到之前的状态。
```

---

### Task 2: Confirm before discarding unsaved Models changes

**Problem:** `components/ModelsConfig.tsx` keeps edits in a single `config` state with no separate "saved" snapshot. `components/SettingsPanel.tsx` lets the user switch to another settings section, press Escape, click the header close button, or click the backdrop — all of which unmount or reset the Models page — with no warning that in-progress edits (a new provider, an unsaved base URL, an added model) are discarded.

**Files:**
- Modify: `components/ModelsConfig.tsx:1295-1441` (add dirty tracking + `onDirtyChange` prop)
- Modify: `components/SettingsPanel.tsx` (gate every path that leaves the Models section)
- Modify: `docs/prd/secure-lan-access.md:31` (new bullet after the models.json load-failure bullet)

**Interfaces:**
- New prop: `ModelsConfig({ onClose, closeLabel, embedded, onDirtyChange }: { ...; onDirtyChange?: (dirty: boolean) => void })`

- [ ] **Step 1: Track a saved-config snapshot in `ModelsConfig`.** Change the function signature (line 1295):

```ts
export function ModelsConfig({ onClose, closeLabel = "Cancel", embedded = false, onDirtyChange }: { onClose: () => void; closeLabel?: string; embedded?: boolean; onDirtyChange?: (dirty: boolean) => void }) {
```

Add a ref right after the existing `config` state (line 1297):

```ts
  const [config, setConfig] = useState<ModelsJson>({ providers: {} });
  const savedConfigRef = useRef<ModelsJson>({ providers: {} });
```

In `loadConfig`'s success branch (the `.then((d) => { ... })` block, currently lines 1331-1336), record the snapshot right after `setConfig(normalized)`:

```ts
      .then((d) => {
        const normalized = d.providers ? d : { ...d, providers: {} };
        setConfig(normalized);
        savedConfigRef.current = normalized;
        const keys = Object.keys(normalized.providers ?? {});
        if (keys.length > 0) setSelection({ type: "provider", name: keys[0] });
      })
```

In `handleSave`'s success branch (currently `else { setSavedOk(true); setTimeout(() => setSavedOk(false), 2000); }` around line 1434), record the snapshot on a successful save:

```ts
      if (!res.ok || d.error) setSaveError(d.error ?? `HTTP ${res.status}`);
      else { setSavedOk(true); savedConfigRef.current = config; setTimeout(() => setSavedOk(false), 2000); }
```

- [ ] **Step 2: Compute `dirty` and report it to the parent.** Right after all the `useCallback`s, before `const providers = Object.entries(config.providers ?? {});` (line 1442), add:

```ts
  const dirty = JSON.stringify(config) !== JSON.stringify(savedConfigRef.current);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
```

- [ ] **Step 3: Gate every close/switch path in `SettingsPanel`.** Replace the whole file:

```tsx
"use client";

import { useEffect, useState } from "react";
import { Box, CircleHelp, Moon, Puzzle, Settings, Sparkles, Sun, Volume2, VolumeX, Wifi, X } from "lucide-react";
import { useAudio } from "@/hooks/useAudio";
import { MobileAccessDialog } from "./MobileAccessDialog";
import { ModelsConfig } from "./ModelsConfig";
import { PluginsConfig } from "./PluginsConfig";
import { ProductStatusGuide } from "./ProductStatus";
import { SkillsConfig } from "./SkillsConfig";

type SettingsSection = "general" | "access" | "models" | "skills" | "plugins" | "status";

interface Props {
  isDark: boolean;
  cwd: string | null;
  sessionId: string | null;
  onClose: () => void;
  onToggleTheme: () => void;
  onModelsChanged?: () => void;
  onPluginsReloaded?: () => void;
}

const sections: Array<{ id: SettingsSection; label: string; projectRequired?: boolean; icon: typeof Settings }> = [
  { id: "general", label: "Appearance", icon: Settings },
  { id: "access", label: "Remote access", icon: Wifi },
  { id: "models", label: "Models", icon: Box },
  { id: "skills", label: "Skills", projectRequired: true, icon: Sparkles },
  { id: "plugins", label: "Plugins", projectRequired: true, icon: Puzzle },
  { id: "status", label: "Status & indicators", icon: CircleHelp },
];

const UNSAVED_MODELS_WARNING = "You have unsaved changes to Models. Discard them?";

export function SettingsPanel({ isDark, cwd, sessionId, onClose, onToggleTheme, onModelsChanged, onPluginsReloaded }: Props) {
  const [section, setSection] = useState<SettingsSection>("general");
  const [modelsDirty, setModelsDirty] = useState(false);
  const { soundEnabled, onSoundToggle } = useAudio();

  const confirmDiscardModels = () => section !== "models" || !modelsDirty || window.confirm(UNSAVED_MODELS_WARNING);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape" && confirmDiscardModels()) onClose(); };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, section, modelsDirty]);

  const closeChild = () => setSection("general");
  const embedded = section === "access" || section === "models" || section === "skills" || section === "plugins";

  const requestClose = () => { if (confirmDiscardModels()) onClose(); };
  const requestSection = (id: SettingsSection) => { if (id !== section && confirmDiscardModels()) setSection(id); };

  return <div className="settings-backdrop" role="dialog" aria-modal="true" aria-label="Settings" onMouseDown={(event) => { if (event.target === event.currentTarget && confirmDiscardModels()) onClose(); }}>
    <section className="settings-panel">
      <header className="settings-header"><Settings size={16} /><strong>Settings</strong><button type="button" aria-label="Close settings" onClick={requestClose}><X size={15} /></button></header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {sections.map(({ id, label, projectRequired, icon: Icon }) => <button key={id} type="button" className={section === id ? "is-active" : ""} disabled={projectRequired && !cwd} title={projectRequired && !cwd ? `Open a project to configure ${label.toLowerCase()}` : label} onClick={() => requestSection(id)}><Icon size={14} /><span>{label}</span></button>)}
        </nav>
        <main className={`settings-content${embedded ? " is-embedded" : ""}`}>
          {section === "general" && <>
            <div className="settings-title"><h2>Appearance</h2><p>Changes apply immediately across TianForge.</p></div>
            <section className="settings-section"><h3>Theme</h3><button type="button" className="settings-action-row" onClick={onToggleTheme}>{isDark ? <Moon size={16} /> : <Sun size={16} />}<span><strong>Color theme</strong><small>{isDark ? "Dark" : "Light"}</small></span><span className="settings-value">Switch to {isDark ? "light" : "dark"}</span></button></section>
            <section className="settings-section"><h3>Notifications</h3><button type="button" className="settings-action-row" onClick={onSoundToggle}>{soundEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}<span><strong>Completion sound</strong><small>Play a tone when an agent finishes</small></span><span className="settings-value">{soundEnabled ? "On" : "Off"}</span></button></section>
          </>}
          {section === "access" && <MobileAccessDialog embedded onClose={closeChild} />}
          {section === "models" && <ModelsConfig embedded onClose={() => { onModelsChanged?.(); closeChild(); }} onDirtyChange={setModelsDirty} />}
          {section === "skills" && cwd && <SkillsConfig embedded cwd={cwd} onClose={closeChild} />}
          {section === "plugins" && cwd && <PluginsConfig embedded cwd={cwd} sessionId={sessionId} onClose={closeChild} onReloaded={onPluginsReloaded} />}
          {section === "status" && <>
            <div className="settings-title"><h2>Status & indicators</h2><p>One shared vocabulary is used across projects, tabs, files, sessions, agents, and connections.</p></div>
            <ProductStatusGuide />
            <p className="settings-hint">Color is supplemental: indicators also expose a label or tooltip. A project can show source-control and runtime states at the same time.</p>
          </>}
        </main>
      </div>
    </section>
  </div>;
}
```

(The internal `!embedded && <button onClick={onClose}>{closeLabel}</button>` footer button inside `ModelsConfig` never renders here because `SettingsPanel` always passes `embedded`, so this is the only place that needs gating.)

- [ ] **Step 4: Run the gates.**

Run: `npx tsc --noEmit -p .`
Run: `npx eslint components/ModelsConfig.tsx components/SettingsPanel.tsx`
Run: `npm test`

- [ ] **Step 5: Write a focused Playwright test.** Add to `e2e/reliability.spec.ts`:

```ts
test("switching settings sections warns about unsaved Models changes", async ({ page }) => {
  await page.route("**/api/models-config", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: { providers: { openai: { api: "openai-completions" } } } })
    : route.fulfill({ json: { success: true } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).first().click();
  await page.getByRole("button", { name: "Models" }).click();
  await page.getByPlaceholder("provider-name").fill("openai-renamed");
  let confirmShown = false;
  page.once("dialog", (dialog) => { confirmShown = true; void dialog.dismiss(); });
  await page.getByRole("button", { name: "Appearance" }).click();
  expect(confirmShown).toBe(true);
  await expect(page.getByRole("button", { name: "Models" })).toHaveClass(/is-active/);
});
```

Run: `npx playwright test e2e/reliability.spec.ts`

- [ ] **Step 6: Update the PRD.** In `docs/prd/secure-lan-access.md`, after line 31 (the `models.json` load-failure bullet), add:

```
- 设置面板的 Models 页有未保存的改动时，切换到其他设置分区或关闭面板前会先确认，避免静默丢弃改动。
```

---

### Task 3: Confirm before deleting a provider, an API key, or a plugin

**Problem:** In `components/ModelsConfig.tsx`, `ProviderDetail`'s Delete button and `ApiKeyDetail`'s Disconnect button call their destructive action directly on click. In `components/PluginsConfig.tsx`, `PackageDetail`'s Remove button does the same. None of the three has a confirmation, unlike Git's discard flow or the terminal/session delete flows elsewhere in the app.

**Files:**
- Modify: `components/ModelsConfig.tsx:306-309` (`ProviderDetail` Delete button), `components/ModelsConfig.tsx:1080-1091` (`ApiKeyDetail` Disconnect button)
- Modify: `components/PluginsConfig.tsx:491-497` (`PackageDetail` Remove button)
- Modify: `docs/prd/secure-lan-access.md:31` (second new bullet, added in the same edit as Task 2's)

**Interfaces:** none — each fix wraps an existing `onClick` in `window.confirm`, no signature changes.

- [ ] **Step 1: Confirm before deleting a provider.** In `components/ModelsConfig.tsx`, `ProviderDetail` (function starts at line 289), replace the Delete button (currently lines 306-309):

```tsx
        <button onClick={() => { if (window.confirm(`Delete provider "${name}"? This removes its base URL and API key settings.`)) onDelete(); }}
          style={{ padding: "3px 8px", background: "none", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 4, color: "#ef4444", cursor: "pointer", fontSize: 11 }}>
          Delete
        </button>
```

- [ ] **Step 2: Confirm before removing a saved API key.** In the same file, `ApiKeyDetail` (function starts at line 968), replace the Disconnect button (currently lines 1080-1091):

```tsx
      {provider.configured && (
        <button
          onClick={() => { if (window.confirm(`Remove the saved API key for ${provider.displayName}? Models using it will stop working until you add a new key.`)) handleRemove(); }}
          disabled={removing}
          style={{
            alignSelf: "flex-start", padding: "5px 12px",
            background: "none", border: "1px solid rgba(239,68,68,0.3)",
            borderRadius: 5, color: "#ef4444",
            cursor: removing ? "not-allowed" : "pointer", fontSize: 12,
          }}
        >
          {removing ? "Removing…" : "Disconnect"}
        </button>
      )}
```

- [ ] **Step 3: Confirm before removing a plugin.** In `components/PluginsConfig.tsx`, `PackageDetail` (function starts at line 401), replace the Remove button (currently lines 491-497):

```tsx
          <button
            onClick={() => { if (window.confirm(`Remove "${pkg.packageName ?? pkg.source}"? This uninstalls the plugin from ${pkg.scope === "project" ? "this project" : "your global config"}.`)) onAction("remove", pkg); }}
            disabled={busy || reloadBusy}
            style={buttonStyle(busy || reloadBusy, true)}
          >
            {busyKey === `remove:${key}` ? "Removing..." : "Remove"}
          </button>
```

- [ ] **Step 4: Run the gates.**

Run: `npx tsc --noEmit -p .`
Run: `npx eslint components/ModelsConfig.tsx components/PluginsConfig.tsx`
Run: `npm test`

- [ ] **Step 5: Write a focused Playwright test.** Add to `e2e/reliability.spec.ts`:

```ts
test("deleting a provider asks for confirmation first", async ({ page }) => {
  let deleteCalls = 0;
  await page.route("**/api/models-config", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { providers: { openai: { api: "openai-completions" } } } });
    deleteCalls += 1;
    return route.fulfill({ json: { success: true } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).first().click();
  await page.getByRole("button", { name: "Models" }).click();
  await page.getByRole("button", { name: "openai", exact: true }).click();
  page.once("dialog", (dialog) => void dialog.dismiss());
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByPlaceholder("provider-name")).toHaveValue("openai");
  expect(deleteCalls).toBe(0);
});
```

Run: `npx playwright test e2e/reliability.spec.ts`

- [ ] **Step 6: Update the PRD.** In `docs/prd/secure-lan-access.md`, in the same edit as Task 2 (right after the bullet Task 2 added), add:

```
- 设置面板删除 Provider、移除已保存的 API Key 或卸载插件前都需二次确认。
```

---

### Task 4: Git diff failures show the real error, not "may be binary"

**Problem:** In `components/GitReviewPanel.tsx`, both the main diff-loading effect (lines 241-268) and `CommitFileDiff` (lines 1135-1159) collapse every failure — a thrown HTTP error (401, timeout) as well as a genuinely-unsupported binary/oversized file — into the same `{ supported: false }` state. Both render sites then show "This file may be binary, too large, or unchanged" / "This file may be binary or too large to display", hiding the real reason (e.g. an expired login) and giving the user no way to retry.

**Files:**
- Modify: `components/GitReviewPanel.tsx:165-268` (main diff state + effect), `components/GitReviewPanel.tsx:519-537` (render site), `components/GitReviewPanel.tsx:1135-1159` (`CommitFileDiff`)
- Modify: `docs/prd/git-review.md:20` (new bullet after the Git-command-timeout bullet)

**Interfaces:** New state `diffError: string | null` in both the main panel and `CommitFileDiff`, separate from the existing `diff: GitFileDiffResponse | null` (there is no `error` field on `GitFileDiffResponse` itself — see `lib/git-types.ts:65-89` — so this is intentionally a sibling state, not a new field on the response type).

- [ ] **Step 1: Add `diffError` state next to `diff` in the main panel.** In `components/GitReviewPanel.tsx`, right after `const [diff, setDiff] = useState<GitFileDiffResponse | null>(null);` (line 165):

```ts
  const [diff, setDiff] = useState<GitFileDiffResponse | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
```

- [ ] **Step 2: Separate real errors from "unsupported" in the loading effect.** Replace the effect (currently lines 241-268):

```ts
  useEffect(() => {
    if (!repositoryCwd || !selected) {
      loadedDiffKey.current = null;
      setDiff(null);
      setDiffError(null);
      return;
    }
    const controller = new AbortController();
    // Reloading the file already shown keeps its diff on screen until the new one arrives.
    const key = `${repositoryCwd}\0${selected.file.filePath}\0${selected.scope}`;
    if (loadedDiffKey.current !== key) {
      loadedDiffKey.current = key;
      setLoadingDiff(true);
      setDiff(null);
      setDiffError(null);
    }
    const params = new URLSearchParams({ cwd: repositoryCwd, path: selected.file.filePath, scope: selected.scope });
    void fetch(`/api/git/diff?${params}`, { signal: controller.signal })
      .then(async (res) => {
        const next = await res.json() as GitFileDiffResponse & { error?: string };
        if (!res.ok) throw new Error(next.error ?? `Failed to load diff (${res.status})`);
        setDiff(next);
        setDiffError(null);
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setDiff(null);
        setDiffError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => { if (!controller.signal.aborted) setLoadingDiff(false); });
    return () => controller.abort();
  }, [repositoryCwd, selected, refreshKey, nonce, diffNonce]);
```

- [ ] **Step 3: Show the real error with a Retry action.** Replace the render site (currently lines 519-537):

```tsx
            <main style={{ minWidth: 0, flex: 1, overflow: "auto" }}>
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
              ) : diffError ? (
                <EmptyState title="Could not load diff" detail={diffError} action={() => setDiffNonce((n) => n + 1)} />
              ) : (
                <EmptyState title="Diff unavailable" detail="This file may be binary, too large, or unchanged in this review group." />
              )}
            </main>
```

- [ ] **Step 4: Apply the same split to `CommitFileDiff`.** Replace the whole function (currently lines 1135-1159):

```tsx
function CommitFileDiff({ cwd, hash, path }: { cwd: string; hash: string; path: string }) {
  const [diff, setDiff] = useState<GitFileDiffResponse | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setDiff(null);
    setDiffError(null);
    void fetch(`/api/git/commit?${new URLSearchParams({ cwd, hash, path })}`, { signal: controller.signal })
      .then(async (res) => {
        const next = await res.json() as GitFileDiffResponse & { error?: string };
        if (!res.ok) throw new Error(next.error ?? `Failed to load diff (${res.status})`);
        setDiff(next);
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setDiffError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [cwd, hash, path, nonce]);

  if (loading) return <EmptyState title="Loading diff…" />;
  if (diff?.supported && diff.patch) return <DiffView patch={diff.patch} />;
  if (diffError) return <EmptyState title="Could not load diff" detail={diffError} action={() => setNonce((n) => n + 1)} />;
  return <EmptyState title="Diff unavailable" detail="This file may be binary or too large to display." />;
}
```

- [ ] **Step 5: Run the gates.**

Run: `npx tsc --noEmit -p .`
Run: `npx eslint components/GitReviewPanel.tsx`
Run: `npm test`

- [ ] **Step 6: Write a focused Playwright test.** Add to `e2e/reliability.spec.ts` (or `e2e/git-review.spec.ts` if one already exists and is the established home for Git panel tests — check before adding a new file):

```ts
test("a failed diff request shows the real error and can retry", async ({ page }) => {
  let diffCalls = 0;
  await page.route("**/api/git/status*", (route) => route.fulfill({ json: {
    files: [{ filePath: "src/app.ts", status: "modified", staged: false }],
    branch: "main",
  } }));
  await page.route("**/api/git/repositories*", (route) => route.fulfill({ json: { repositories: [{ path: "/tmp/repo", label: "repo" }] } }));
  await page.route("**/api/git/diff*", (route) => {
    diffCalls += 1;
    return diffCalls === 1
      ? route.fulfill({ status: 401, json: { error: "authentication required" } })
      : route.fulfill({ json: { supported: true, patch: "@@ -1 +1 @@\n-a\n+b\n" } });
  });
  await page.goto("/?cwd=%2Ftmp%2Frepo&panel=git");
  await page.getByText("app.ts").click();
  await expect(page.getByText("Could not load diff")).toBeVisible();
  await expect(page.getByText("authentication required")).toBeVisible();
  await page.getByTitle("Try loading again").click();
  await expect(page.getByText("authentication required")).toHaveCount(0);
});
```

Run: `npx playwright test e2e/reliability.spec.ts` (or the file actually used above)

- [ ] **Step 7: Update the PRD.** In `docs/prd/git-review.md`, after line 20 (the commit/push/timeout bullet), add a new bullet under "已实现范围":

```
- 查看某个文件的 diff 失败（认证过期、超时等）时显示具体错误原因并可 Retry，不与真正不支持预览的二进制/超大文件混淆。
```

---

### Task 5: Close the Chat tab when its Claude session is deleted

**Problem:** In `components/agents/AgentsPanel.tsx`, `deleteClaudeSession` deletes the session and reloads the catalog, but never tells the rest of the app the session is gone. If that Claude session's Chat tab is open elsewhere in the workspace, it stays open pointing at a session that no longer exists — a dead tab.

**Files:**
- Modify: `components/agents/AgentsPanel.tsx:464-481` (`deleteClaudeSession`)
- Modify: `docs/prd/agent-workspace.md:245` (new bullet after the "Close the chat first" bullet)

**Interfaces:** No new prop. `onCodexSessionChanged?: (change: { id: string; action: "rename" | "archive" | "unarchive" | "delete"; name?: string }) => void` already exists on `AgentsPanel`'s `Props` (line 60) and its `"delete"` action is already handled generically by `AppShell.tsx`'s `handleCodexSessionChanged` (it matches on `tab.kind === "codex-chat" || tab.kind === "claude-chat"`, so it already closes a matching Claude Chat tab — it just was never called for a Claude-session delete). `AgentsPanel` is mounted inside `SessionSidebar.tsx` (`<AgentsPanel ... onCodexSessionChanged={onCodexSessionChanged} />` at line 1324), which forwards the same prop it received from `AppShell.tsx` (`<SessionSidebar onCodexSessionChanged={handleCodexSessionChanged}>` at line 1134) — so no prop plumbing changes anywhere else are needed.

- [ ] **Step 1: Fire `onCodexSessionChanged` after a successful Claude session delete.** Before editing, re-read `components/agents/AgentsPanel.tsx` around `deleteClaudeSession` — this file may have shifted from an unrelated in-flight change on this branch; locate the function by its body, not just the line number. Replace it:

```ts
  const deleteClaudeSession = useCallback(async (session: ClaudeSession) => {
    setBusyId(session.id);
    setClaudeError(null);
    try {
      const response = await fetch(`/api/claude/sessions/${encodeURIComponent(session.id)}/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "Unable to delete Claude session");
      await reloadClaudeSessions(true);
      onCodexSessionChanged?.({ id: session.id, action: "delete" });
    } catch (cause) {
      setClaudeError(cause instanceof Error ? cause.message : "Unable to delete Claude session");
    } finally {
      setBusyId(null);
    }
  }, [cwd, reloadClaudeSessions, onCodexSessionChanged]);
```

- [ ] **Step 2: Run the gates.**

Run: `npx tsc --noEmit -p .`
Run: `npx eslint components/agents/AgentsPanel.tsx`
Run: `npm test`

- [ ] **Step 3: Write a focused Playwright test.** Add to `e2e/reliability.spec.ts`:

```ts
test("deleting a Claude session closes its open Chat tab", async ({ page }) => {
  const claudeSession = { id: "claude-1", title: "Refactor the parser", cwd: "/tmp/pi-web-reliability" };
  await page.route("**/api/claude/sessions*", (route) => route.fulfill({ json: { sessions: [claudeSession] } }));
  await page.route(`**/api/claude/chat/${claudeSession.id}*`, (route) => route.fulfill({ json: {
    session: claudeSession, history: [], cursor: null, events: [], runtime: { running: false }, terminal: null,
  } }));
  await page.route(`**/api/claude/sessions/${claudeSession.id}/delete`, (route) => route.fulfill({ json: { success: true } }));
  await page.goto(`/?claudeSession=${claudeSession.id}`);
  await expect(page.getByText("Refactor the parser").first()).toBeVisible();
  await page.getByRole("button", { name: `Delete ${claudeSession.title}` }).click();
  await page.getByRole("button", { name: "Confirm delete" }).click();
  await expect(page.getByRole("tab", { name: new RegExp(claudeSession.title) })).toHaveCount(0);
});
```

Run: `npx playwright test e2e/reliability.spec.ts`. The exact button names/roles for the delete confirmation and the tab strip may not match this repo's markup precisely — adjust the selectors to whatever `AgentsPanel`'s Claude-session delete-confirm control and the workspace tab strip actually render, keeping the assertion ("the tab representing this session is gone after delete") the same.

- [ ] **Step 4: Update the PRD.** In `docs/prd/agent-workspace.md`, after line 247 ("删除 Claude 会话时，聊天进程存在或正在启动返回 409 `session_busy`（"Close the chat first"）。"), add:

```
- 删除成功后，若该 Claude 会话的 Chat 标签仍打开，同时关闭该标签，不留下指向已删除会话的死页面。
```

---

### Task 6: Force-kill a terminal that ignores SIGTERM

**Problem:** `server/agents/terminal-manager.cjs`'s `stopTerminal` sends `SIGTERM` (via `process.kill(-session.pid, "SIGTERM")`) and calls `session.terminal.kill()`, then immediately marks the session `"stopped"` and returns. If the child process (or a grandchild it spawned) ignores `SIGTERM`/`SIGHUP`, nothing follows up: the record can be deleted (`removeTerminal` only checks `session.state !== "running"`) while the real OS process keeps running — an orphan with no record pointing at it.

**Files:**
- Modify: `server/agents/terminal-manager.cjs:13-17` (new constant), `server/agents/terminal-manager.cjs:364-378` (`onExit` handler), `server/agents/terminal-manager.cjs:461-471` (`stopTerminal`), `server/agents/terminal-manager.cjs:548` (export the new constant)
- Modify: `server/agents/terminal-manager.test.cjs` (two new tests)
- Modify: `docs/prd/agent-workspace.md:24` (append to the Terminal bullet)

**Interfaces:**
- New exported constant: `STOP_SIGKILL_DELAY_MS = 3_000`.
- New session field (internal, not in `publicSession()`'s output): `session.stopKillTimer: NodeJS.Timeout | null`.

- [ ] **Step 1: Add the grace-period constant.** In `server/agents/terminal-manager.cjs`, next to the existing limits (lines 13-17):

```js
const MAX_BUFFER_BYTES = 1024 * 1024;
const MAX_RUNNING_TERMINALS = 20;
const MAX_TERMINAL_RECORDS = 100;
const MAX_COMMAND_HISTORY = 50;
const MAX_COMMAND_CHARS = 8_000;
// A CLI (or a child it spawned) that ignores SIGTERM/SIGHUP gets force-killed
// after this grace period, so stopping a terminal can't leave an orphan
// process once its record is gone.
const STOP_SIGKILL_DELAY_MS = 3_000;
```

- [ ] **Step 2: Cancel the pending force-kill when the process exits on its own.** In `createTerminal`'s `terminal.onExit` handler (currently lines 364-378), add a guard at the top:

```js
  terminal.onExit(({ exitCode, signal }) => {
    if (session.stopKillTimer) {
      clearTimeout(session.stopKillTimer);
      session.stopKillTimer = null;
    }
    session.state = session.state === "stopped" ? "stopped" : "ended";
    session.exitCode = exitCode;
    session.signal = signal;
    session.endedAt = new Date().toISOString();
    session.terminal = null;
    const lastActivity = session.activity;
    session.activity = null;
    session.hookToken = null;
    for (const subscriber of session.subscribers) {
      try { subscriber(null); } catch { /* ignore */ }
    }
    workspaceStatus.notify("terminals");
    recordExit(session, lastActivity);
  });
```

- [ ] **Step 3: Arm a force-kill timer in `stopTerminal`.** Replace the function (currently lines 461-471):

```js
function stopTerminal(id) {
  const session = lookup(id);
  if (session.state !== "running" || !session.terminal) return publicSession(session);
  session.state = "stopped";
  workspaceStatus.notify("terminals");
  const pid = session.pid;
  try {
    if (process.platform !== "win32" && pid > 0) process.kill(-pid, "SIGTERM");
  } catch { /* pty.kill is the portable fallback */ }
  try { session.terminal.kill(); } catch { /* process already exited */ }
  // Some CLIs (or a shell child they spawn) ignore SIGTERM/SIGHUP; force the
  // process group if it's still alive after a grace period, so it can't
  // outlive its terminal record. `onExit` clears `stopKillTimer` as soon as
  // the process exits on its own, and this closure checks `session.terminal`
  // (also cleared there) rather than the sessions map, so a record removed
  // in the meantime doesn't stop the force-kill from happening.
  if (process.platform !== "win32" && pid > 0) {
    session.stopKillTimer = setTimeout(() => {
      session.stopKillTimer = null;
      if (!session.terminal) return; // exited naturally before the grace period elapsed
      try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
    }, STOP_SIGKILL_DELAY_MS);
    session.stopKillTimer.unref?.();
  }
  return publicSession(session);
}
```

- [ ] **Step 4: Export the new constant.** Update the `module.exports` line (548):

```js
module.exports = { TerminalError, terminalEnvironment, createTerminal, listTerminals, terminalStats, getTerminal, renameTerminal, getBuffer, runtimeForSession, inputTerminal, resizeTerminal, stopTerminal, removeTerminal, clearEndedTerminals, stopTerminalsForSession, interruptAndStopTerminalsForSession, unknownCodexTerminals, reportHookActivity, subscribeTerminal, snapshotAndSubscribeTerminal, shutdownTerminals, STOP_SIGKILL_DELAY_MS };
```

- [ ] **Step 5: Add the two new unit tests.** Append to `server/agents/terminal-manager.test.cjs`, mirroring the `Module._load`/`fakePty` pattern already used by the first test in the file:

```js
test("stopTerminal force-kills the process group if it ignores SIGTERM", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const modulePath = require.resolve("./terminal-manager.cjs");
  const previousState = global.__piWebTerminalState;
  const previousLoad = Module._load;
  const previousKill = process.kill;
  const killCalls = [];
  process.kill = (pid, signal) => { killCalls.push([pid, signal]); };
  const fakePty = { pid: 4242, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
  global.__piWebTerminalState = { sessions: new Map() };
  Module._load = function (request, parent, isMain) {
    if (request === "node-pty") return { spawn() { return fakePty; } };
    return previousLoad.call(this, request, parent, isMain);
  };
  delete require.cache[modulePath];
  try {
    const manager = require("./terminal-manager.cjs");
    const terminal = manager.createTerminal({ provider: "shell", cwd: "/tmp" });
    manager.stopTerminal(terminal.id);
    assert.deepEqual(killCalls, [[-4242, "SIGTERM"]]);
    t.mock.timers.tick(manager.STOP_SIGKILL_DELAY_MS);
    assert.deepEqual(killCalls, [[-4242, "SIGTERM"], [-4242, "SIGKILL"]]);
  } finally {
    Module._load = previousLoad;
    process.kill = previousKill;
    delete require.cache[modulePath];
    if (previousState === undefined) delete global.__piWebTerminalState;
    else global.__piWebTerminalState = previousState;
  }
});

test("stopTerminal cancels the force-kill timer once the process exits on its own", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const modulePath = require.resolve("./terminal-manager.cjs");
  const previousState = global.__piWebTerminalState;
  const previousLoad = Module._load;
  const previousKill = process.kill;
  const killCalls = [];
  process.kill = (pid, signal) => { killCalls.push([pid, signal]); };
  let exitHandler;
  const fakePty = { pid: 4343, onData() {}, onExit(handler) { exitHandler = handler; }, write() {}, resize() {}, kill() {} };
  global.__piWebTerminalState = { sessions: new Map() };
  Module._load = function (request, parent, isMain) {
    if (request === "node-pty") return { spawn() { return fakePty; } };
    return previousLoad.call(this, request, parent, isMain);
  };
  delete require.cache[modulePath];
  try {
    const manager = require("./terminal-manager.cjs");
    const terminal = manager.createTerminal({ provider: "shell", cwd: "/tmp" });
    manager.stopTerminal(terminal.id);
    assert.deepEqual(killCalls, [[-4343, "SIGTERM"]]);
    exitHandler({ exitCode: 0, signal: null });
    t.mock.timers.tick(manager.STOP_SIGKILL_DELAY_MS);
    assert.deepEqual(killCalls, [[-4343, "SIGTERM"]]);
  } finally {
    Module._load = previousLoad;
    process.kill = previousKill;
    delete require.cache[modulePath];
    if (previousState === undefined) delete global.__piWebTerminalState;
    else global.__piWebTerminalState = previousState;
  }
});
```

- [ ] **Step 6: Run the gates.**

Run: `npx eslint server/agents/terminal-manager.cjs server/agents/terminal-manager.test.cjs`
Run: `npm test`
Expected: both new tests pass along with the existing ones in `terminal-manager.test.cjs`.

- [ ] **Step 7: Update the PRD.** In `docs/prd/agent-workspace.md`, extend line 24 (append to the existing sentence rather than adding a new bullet, since it's the same "Terminal 支持..." bullet):

```
- Terminal 支持停止、重启、删除记录、清理已结束任务和重连缓冲区；停止终端先发送 SIGTERM/SIGHUP，进程若在几秒内未退出则发送 SIGKILL，避免忽略信号的进程在记录被删除后成为孤儿进程。
```

---

### Task 7: Esc closing a context menu must not abort the agent

**Problem:** `lib/escape-abort.ts`'s `hasVisibleModal` only checks `'[aria-modal="true"], dialog[open]'`. Every dropdown/context menu in the app (`TabBar`, `ProjectRail` (×2), `SessionSidebar`'s "TianForge menu", `AppShell`'s right-panel menu, `FileExplorer`, `AgentsPanel`'s action menu) uses `role="menu"`, not `aria-modal`. The global capture-phase Esc listener in `hooks/useKeyboardShortcuts.ts` fires before a menu's own bubble-phase Esc-close listener, so pressing Esc to close one of these menus also aborts the running agent.

**Files:**
- Modify: `lib/escape-abort.ts` (extend the selector + doc comment)
- Modify: `lib/escape-abort.test.mjs` (update the expected selector string)
- Modify: `hooks/useKeyboardShortcuts.ts:42-45,57-61` (doc comments only)
- Modify: `e2e/reliability.spec.ts` (new test)
- Modify: `docs/prd/agent-workspace.md:135` (extend the "对话框" clause)

**Interfaces:** `hasVisibleModal`'s signature is unchanged; only its selector string changes.

- [ ] **Step 1: Extend the selector.** Replace `lib/escape-abort.ts` in full:

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

/**
 * Whether a modal or menu is open on screen: an `aria-modal` dialog, a native
 * `<dialog>` opened via showModal(), or a `role="menu"` dropdown/context menu
 * (TabBar, ProjectRail, SessionSidebar, FileExplorer, AgentsPanel, etc. all
 * use this role). Workspace tabs stay mounted while hidden, so a dialog or
 * menu left open in a background tab doesn't count.
 */
export function hasVisibleModal(root: Pick<ParentNode, "querySelectorAll">): boolean {
  return Array.from(root.querySelectorAll('[aria-modal="true"], dialog[open], [role="menu"]')).some((element) => element.checkVisibility?.() ?? element.getClientRects().length > 0);
}
```

- [ ] **Step 2: Update the unit test's expected selector.** In `lib/escape-abort.test.mjs`, line 30, change:

```js
  const root = (elements) => ({ querySelectorAll: (selector) => { assert.equal(selector, '[aria-modal="true"], dialog[open], [role="menu"]'); return elements; } });
```

- [ ] **Step 3: Update the doc comments in the keyboard-shortcuts hook.** In `hooks/useKeyboardShortcuts.ts`, wherever the comments near lines 42-45 and 57-61 mention "a dialog is open" or similar, extend the wording to also mention menus (e.g. "while a dialog or menu is open"). No logic changes — `hasVisibleModal` already does the work.

- [ ] **Step 4: Run the gates.**

Run: `npx tsc --noEmit -p .`
Run: `npx eslint lib/escape-abort.ts hooks/useKeyboardShortcuts.ts`
Run: `node --require ./server/test-env.cjs --test lib/escape-abort.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the e2e test.** Add to `e2e/reliability.spec.ts`, using the existing "TianForge menu" (`components/SessionSidebar.tsx`'s `TianForgeTitle`, a `button[aria-label="TianForge app menu"]` opening a `div[role="menu"][aria-label="TianForge menu"]`):

```ts
test("Esc closes a context menu without stopping the running agent", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "the TianForge app menu is desktop-only");
  const { agentPosts } = await mockRunningSession(page);
  await page.getByRole("button", { name: "TianForge app menu" }).click();
  const menu = page.getByRole("menu", { name: "TianForge menu" });
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(page.getByText("Working on it", { exact: true })).toBeVisible();
  assertPostedTypes(agentPosts, []);
});
```

Run: `npx playwright test e2e/reliability.spec.ts`

- [ ] **Step 6: Update the PRD.** In `docs/prd/agent-workspace.md`, line 137 (Chat界面 bullet: "Esc 或停止按钮中断这一轮..."), extend the trailing clause:

```
- Esc 或停止按钮中断这一轮（`interrupt` 控制请求）；Claude 以 `result` 结束这一轮，进程保留。有对话框（如 Settings）或下拉/右键菜单打开时，Esc 只关闭它，不中断这一轮。
```

---

### Task 8: A failed session rename keeps the typed name

**Problem:** In `components/SessionSidebar.tsx`, `commitRename` calls `setRenaming(false)` unconditionally before the `fetch`, so a failed PATCH still closes the rename input immediately — the user's typed name is thrown away and they have to retype it to retry, even though `actionError` is set right after.

**Files:**
- Modify: `components/SessionSidebar.tsx:1715-1733` (`commitRename`), `components/SessionSidebar.tsx:1830-1853` (rename input JSX)
- Modify: `e2e/reliability.spec.ts` (extend the existing "a failed session delete keeps the session and says why" area with a matching rename test)

**Interfaces:** none — `commitRename`'s signature is unchanged.

- [ ] **Step 1: Only close the rename input on success (or a no-op).** Replace `commitRename` (currently lines 1715-1733):

```ts
  const commitRename = useCallback(async () => {
    const name = renameValue.trim();
    if (name === (session.name ?? "")) { setRenaming(false); return; }
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
      setRenaming(false);
      onRenamed?.();
    } catch (error) {
      setActionError(`Rename failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [renameValue, session.id, session.name, onRenamed]);
```

- [ ] **Step 2: Show the error next to the still-open input instead of only in the Normal view.** The existing `actionError` block (`role="alert"`) only renders in the Normal (non-renaming) branch, so with Step 1's change it would never show while the input stays open. Replace the renaming branch (currently lines 1830-1853):

```tsx
      ) : renaming ? (
        /* ── Rename: input fills the same row ── */
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
          <input
            ref={inputRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") { setActionError(null); setRenaming(false); }
            }}
            autoFocus
            style={{
              fontSize: 12,
              padding: "5px 8px",
              border: "1px solid var(--accent)",
              borderRadius: 5,
              outline: "none",
              background: "var(--bg)",
              color: "var(--text)",
              height: 30,
            }}
          />
          {actionError && <div role="alert" title={actionError} style={{ color: "#f87171", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{actionError}</div>}
        </div>
      ) : (
```

- [ ] **Step 3: Run the gates.**

Run: `npx tsc --noEmit -p .`
Run: `npx eslint components/SessionSidebar.tsx`
Run: `npm test`

- [ ] **Step 4: Extend the e2e test.** In `e2e/reliability.spec.ts`, find the existing test `"a failed session delete keeps the session and says why"` and add a sibling test right after it:

```ts
test("a failed session rename keeps the typed name and can retry", async ({ page }) => {
  await page.route("**/api/sessions", (route) => route.fulfill({ json: {
    sessions: [{ ...session, firstMessage: "Refactor the parser" }],
    runningSessionIds: [],
  } }));
  await page.route(`**/api/sessions/${session.id}`, (route) => route.request().method() === "PATCH"
    ? route.fulfill({ status: 500, json: { error: "disk full" } })
    : route.continue());
  await page.goto("/");
  await page.getByRole("button", { name: "Rename session" }).click();
  await page.getByDisplayValue(session.firstMessage ?? "").fill("New name");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Rename failed: disk full")).toBeVisible();
  await expect(page.getByDisplayValue("New name")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText("Refactor the parser").first()).toBeVisible();
});
```

The exact accessible name for the rename trigger button ("Rename session") should be checked against `SessionSidebar.tsx`'s actual markup and adjusted if it differs; the behavior under test (typed name survives a failed save, Escape then discards it) is what matters.

Run: `npx playwright test e2e/reliability.spec.ts`

- [ ] **Step 5: Update the PRD.** In `docs/prd/session-reliability.md`, line 27 (the existing rename/delete-failure bullet), append a clause:

```
- 重命名或删除 Session 失败时，该 Session 保留在列表中，并在原有的时间/消息数一行改为显示失败原因（如 “Delete failed: …”），几秒后自动消失；重命名失败时输入框保留已输入的名称，可直接重试或按 Esc 取消。
```

---

### Task 9: Move focus into the "Signed out" dialog

**Problem:** `components/AuthExpiryGuard.tsx`'s `AuthExpiredNotice` renders `role="alertdialog"` with `aria-modal="true"` when the login expires, but never moves keyboard focus into it. A keyboard or screen-reader user has no indication the dialog appeared unless they're looking at the screen; focus stays wherever it was before the app went into this state.

**Files:**
- Modify: `components/AuthExpiryGuard.tsx`
- Modify: `docs/prd/secure-lan-access.md:33` (append a clause)

**Interfaces:** none — `AuthExpiredNotice({ open }: { open: boolean })`'s signature is unchanged.

- [ ] **Step 1: Add a ref and an effect that focuses the dialog when it opens.** Replace the top of `components/AuthExpiryGuard.tsx` (imports and `AuthExpiredNotice`):

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { isPossibleAuthExpiry } from "@/lib/auth-expiry";

export function AuthExpiredNotice({ open }: { open: boolean }) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Hooks must run unconditionally, before the `!open` early return below.
  useEffect(() => {
    if (open) dialogRef.current?.focus();
  }, [open]);

  if (!open) return null;
  return <div ref={dialogRef} tabIndex={-1} role="alertdialog" aria-modal="true" aria-labelledby="auth-expired-title" aria-describedby="auth-expired-detail" style={{ position: "fixed", inset: 0, zIndex: 10000, display: "grid", placeItems: "center", padding: 16, background: "rgba(0,0,0,.45)" }}>
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
```

(`AuthExpiryGuard`, below this in the same file, is unchanged.)

- [ ] **Step 2: Run the gates.**

Run: `npx tsc --noEmit -p .`
Run: `npx eslint components/AuthExpiryGuard.tsx`
Run: `npm test`

- [ ] **Step 3: Extend the existing e2e test.** In `e2e/reliability.spec.ts`, find the existing test `"shows a sign-in prompt..."` (around lines 85-103) and add an assertion that the dialog receives focus:

```ts
  await expect(page.getByRole("alertdialog", { name: "Signed out" })).toBeFocused();
```

placed right after whatever existing assertion confirms the dialog is visible.

Run: `npx playwright test e2e/reliability.spec.ts`

- [ ] **Step 4: Update the PRD.** In `docs/prd/secure-lan-access.md`, line 33, append a clause:

```
- 登录过期后，任何 API 返回 401 都会先向 /api/auth/session 确认，确认已登出后弹出"Signed out"提示，并把焦点移入对话框；"Sign in"在新标签页打开登录页，原标签页回到前台时自动检测，恢复登录后提示自动消失，草稿不丢失。
```

---

## Self-Review

**Spec coverage against the original 8 audit items:**
1. Abort/Fork/switch-branch/load-earlier-messages/thinking-level silent failures and missing rollback → Task 1. Covered in full, including the two optimistic-update rollbacks.
2. Chat input's model list doesn't refresh after Settings changes → dropped, verified already fixed (`AppShell.tsx:1558` + `lib/models-cache.ts` + the blocking `.settings-backdrop` modal). Documented in "Facts the implementer needs".
3. Models config unsaved-changes warning → Task 2.
4. Missing delete confirmation for provider/API key/plugin → Task 3.
5. Git diff failure shown as "may be binary" → Task 4.
6. Chat tab stays open after its Claude session is deleted → Task 5.
7. Terminal stop has no SIGKILL follow-up → Task 6.
8. Deferred P0 minors, split into three tasks since they share no files or deliverables: 8a (Esc/menu vs. abort) → Task 7; 8b (rename discards typed name) → Task 8; 8c (focus into "Signed out" dialog) → Task 9.

All 8 original items are accounted for: 7 implemented as 8 tasks (item 8 split into 3), 1 dropped with evidence. 9 tasks total.

**Placeholder scan:** every task's code steps contain complete, concrete code (no `TODO`, `TBD`, `// ...`, or "implement this" placeholders). Every step names exact files and, where the codebase already has the surrounding code, exact current line numbers pulled from a fresh read of the file in this session. Task 5 and Task 8's e2e steps flag the one place where an exact selector (a delete-confirm button's accessible name, a tab's role) could not be verified without running the app, and tell the implementer what to check instead of guessing silently — this is a call-out of *test-selector* risk, not a placeholder in the production code fix itself.

**Type/signature consistency:**
- `loadContext`'s new `Promise<boolean>` return type is used consistently at both remaining call sites: `handleLeafChange` (Task 1, checks the return value) and `handleNavigate` (left untouched, still discards the return value with a bare `await` — harmless, since `Promise<boolean>` is still awaitable).
- `onDirtyChange` (Task 2) is threaded with the same name and type (`(dirty: boolean) => void`) from `ModelsConfig`'s prop through to `SettingsPanel`'s `setModelsDirty`.
- `onCodexSessionChanged` (Task 5) is used with its existing type unchanged; only a new call site is added, using an action value (`"delete"`) already part of the existing union.
- `STOP_SIGKILL_DELAY_MS` (Task 6) is defined once, exported once, and referenced by name (not duplicated as a literal) in both new tests.
- `thinkingLevelRef` (Task 1) follows the exact same mirroring convention as the pre-existing `activeLeafIdRef` (assigned every render, read inside a `useCallback` with a stable dependency array).
- `hasVisibleModal`'s selector string (Task 7) is changed in exactly two places that must stay in sync: `lib/escape-abort.ts`'s implementation and `lib/escape-abort.test.mjs`'s assertion of that same literal string; both are updated in the same task.

**Cross-task file overlap:** Tasks 2 and 3 both touch `docs/prd/secure-lan-access.md:31` and both touch `components/ModelsConfig.tsx`; Task 3's step explicitly says its PRD bullet is "the second new bullet, added in the same edit as Task 2's" so whoever implements them (in order) doesn't overwrite the other's edit. No other task shares a file edit with another task in a way that could conflict, except the shared `e2e/reliability.spec.ts`, which every UI task appends to — implement these in task order to avoid merge conflicts within that one file.

## Finish

- [ ] Run the full gate: `npx tsc --noEmit -p . && npm run lint && npm test && npx playwright test`
- [ ] Since this plan lands on the shared `feat/audit-followups` branch alongside other in-flight work, coordinate with whoever else is committing to it rather than force-pushing or rebasing away their commits.
