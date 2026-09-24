# AppShell Workspace Panels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move AppShell's tab/panel state into a tested, React-free reducer + storage layer, render tabs through a kind registry, expose "open" actions via context, and extract TopBar — with no behavior change.

**Architecture:** `lib/workspace/` holds pure logic (tab union types, kind registry data half, reducers, storage) tested with `node --test`. `components/workspace/` holds React pieces (tab views, center/side containers, actions context, TopBar). AppShell composes them and keeps cross-module flows (project activation, session restore, URL sync).

**Tech Stack:** Next.js 16, React 19, TypeScript, `node --test` + `jiti` for lib tests, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-09-24-appshell-workspace-panels-design.md`

## Global Constraints

- No visible behavior change; no new dependencies.
- localStorage keys and JSON formats stay exactly: center `pi-web:workspace-tabs:<encodeURIComponent(cwd)>` (fallback read `pi-web:workspace-tabs`) → `{ tabs, activeId, split }` without the Pi tab; side `pi-web:right-panel-tabs:<encodeURIComponent(projectRoot)>` → `{ tabs, activeId, open }`.
- Center state is scoped per **cwd**; side state per **project**.
- `lib/workspace/*` must not import React or `@/` aliases (use relative imports) so `node --test` can load it through `jiti`.
- Every task ends green on: `npx tsc --noEmit -p .`, `npx eslint <touched files>`, `npm test`, `npx playwright test`.

---

### Task 1: Tab union types and kind registry (data half)

**Files:**
- Create: `lib/workspace/tabs.ts`, `lib/workspace/tab-kinds.ts`
- Test: `lib/workspace/tab-kinds.test.mjs`
- Modify: `components/TabBar.tsx` (re-export `Tab`, narrow `filePath` access), `package.json` test glob

**Interfaces:**
- Produces: `Tab`, `CenterTab`, `SideTab`, `PiTab`, `TerminalTab`, `CodexChatTab`, `FileTab`, `GitTab`, `TabStatus`, `PI_TAB`, `GIT_REVIEW_TAB_ID`, `fileTabId(path)`, `terminalTabId(id)`, `codexChatTabId(id)`; `TAB_KINDS`, `TabSlot`, `parsePersistedTab(raw, slot, scope): Tab | null`.

- [ ] **Step 1: Write the failing test** — `lib/workspace/tab-kinds.test.mjs`

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parsePersistedTab, TAB_KINDS } = await jiti.import("./tab-kinds.ts");

test("center tabs restore only for the matching cwd", () => {
  const raw = { id: "terminal:t1", label: "Terminal", kind: "terminal", terminalId: "t1", cwd: "/a", status: "running" };
  assert.deepEqual(parsePersistedTab(raw, "center", { cwd: "/a" }), raw);
  assert.equal(parsePersistedTab(raw, "center", { cwd: "/b" }), null);
});

test("codex chat tabs restore as idle", () => {
  const raw = { id: "codex-chat:s1", label: "Chat", kind: "codex-chat", cwd: "/a", status: "running" };
  assert.equal(parsePersistedTab(raw, "center", { cwd: "/a" }).status, "idle");
});

test("tabs are only restored into their own slot", () => {
  const file = { id: "file:/a/x.ts", label: "x.ts", kind: "file", filePath: "/a/x.ts" };
  assert.deepEqual(parsePersistedTab(file, "side", {}), file);
  assert.equal(parsePersistedTab(file, "center", { cwd: "/a" }), null);
  assert.equal(parsePersistedTab({ id: "t", label: "T", kind: "terminal", cwd: "/a" }, "side", { cwd: "/a" }), null);
});

test("malformed and unknown tabs are dropped", () => {
  assert.equal(parsePersistedTab(null, "side", {}), null);
  assert.equal(parsePersistedTab({ id: 1, label: "x", kind: "git" }, "side", {}), null);
  assert.equal(parsePersistedTab({ id: "f", label: "f", kind: "file" }, "side", {}), null);
  assert.equal(parsePersistedTab({ id: "x", label: "x", kind: "mystery" }, "side", {}), null);
  assert.equal(parsePersistedTab({ id: "pi", label: "pi", kind: "pi" }, "center", { cwd: "/a" }), null);
});

test("every kind declares a slot", () => {
  for (const [kind, definition] of Object.entries(TAB_KINDS)) {
    assert.equal(definition.kind, kind);
    assert.ok(definition.slot === "center" || definition.slot === "side");
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test lib/workspace/tab-kinds.test.mjs`
Expected: FAIL — cannot find `./tab-kinds.ts`.

- [ ] **Step 3: Create `lib/workspace/tabs.ts`**

```ts
import type { TerminalLaunchMode, TerminalPermissionMode, TerminalProvider } from "../agents/terminal";

export type TabStatus = "idle" | "running" | "approval" | "connecting" | "offline" | "failed" | "ended";
export type CodexApprovalPolicy = "untrusted" | "on-request" | "never";

interface TabBase {
  id: string;
  label: string;
  closable?: boolean;
  status?: TabStatus;
  /** Locked tabs are persisted but protected from close buttons and bulk close actions. */
  locked?: boolean;
}

export interface PiTab extends TabBase { kind: "pi" }

export interface TerminalTab extends TabBase {
  kind: "terminal";
  terminalId?: string;
  terminalProvider?: TerminalProvider;
  terminalPermissionMode?: TerminalPermissionMode;
  terminalLaunchMode?: TerminalLaunchMode;
  terminalNoAltScreen?: boolean;
  terminalModel?: string | null;
  terminalWebSearch?: boolean;
  terminalChatMode?: boolean;
  cwd?: string;
  sourceSessionId?: string | null;
}

export interface CodexChatTab extends TabBase {
  kind: "codex-chat";
  terminalId?: string;
  sourceSessionId?: string | null;
  cwd?: string;
  model?: string | null;
  reasoningEffort?: string;
  serviceTier?: string;
  approvalPolicy?: CodexApprovalPolicy;
  sessionName?: string;
}

export interface FileTab extends TabBase { kind: "file"; filePath: string; sourceSessionId?: string | null }
export interface GitTab extends TabBase { kind: "git" }

/** Tabs shown in the center workspace (scoped per cwd). */
export type CenterTab = PiTab | TerminalTab | CodexChatTab;
/** Tabs shown in the right panel (scoped per project). */
export type SideTab = FileTab | GitTab;
export type Tab = CenterTab | SideTab;

export const PI_TAB: PiTab = { id: "pi", label: "TianForge pi", kind: "pi", closable: false };
export const GIT_REVIEW_TAB_ID = "git-review";
export const fileTabId = (filePath: string) => `file:${filePath}`;
export const terminalTabId = (terminalId: string) => `terminal:${terminalId}`;
export const codexChatTabId = (id: string) => `codex-chat:${id}`;
```

- [ ] **Step 4: Create `lib/workspace/tab-kinds.ts`**

```ts
import type { CodexChatTab, FileTab, GitTab, Tab, TerminalTab } from "./tabs";

export type TabSlot = "center" | "side";

export interface TabKindDefinition<T extends Tab = Tab> {
  kind: T["kind"];
  slot: TabSlot;
  /** Validate and normalize a persisted tab; null drops it. */
  parse(raw: Record<string, unknown>, scope: { cwd?: string }): T | null;
}

const hasIdentity = (raw: Record<string, unknown>) => typeof raw.id === "string" && typeof raw.label === "string";

/**
 * Registry of tab kinds (data half). Adding a tab kind means adding an entry
 * here, a type in tabs.ts, and a view in components/workspace/tab-views.tsx.
 */
export const TAB_KINDS: { [K in Tab["kind"]]: TabKindDefinition<Extract<Tab, { kind: K }>> } = {
  // The Pi tab is fixed and never persisted.
  pi: { kind: "pi", slot: "center", parse: () => null },
  terminal: {
    kind: "terminal",
    slot: "center",
    parse: (raw, scope) => hasIdentity(raw) && raw.cwd === scope.cwd ? raw as unknown as TerminalTab : null,
  },
  "codex-chat": {
    kind: "codex-chat",
    slot: "center",
    // A restored chat is not running until its panel reconnects.
    parse: (raw, scope) => hasIdentity(raw) && raw.cwd === scope.cwd ? { ...(raw as unknown as CodexChatTab), status: "idle" } : null,
  },
  file: {
    kind: "file",
    slot: "side",
    parse: (raw) => hasIdentity(raw) && typeof raw.filePath === "string" ? raw as unknown as FileTab : null,
  },
  git: { kind: "git", slot: "side", parse: (raw) => hasIdentity(raw) ? raw as unknown as GitTab : null },
};

export function parsePersistedTab(raw: unknown, slot: TabSlot, scope: { cwd?: string }): Tab | null {
  if (!raw || typeof raw !== "object") return null;
  const kind = (raw as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !Object.hasOwn(TAB_KINDS, kind)) return null;
  const definition = TAB_KINDS[kind as Tab["kind"]] as TabKindDefinition;
  return definition.slot === slot ? definition.parse(raw as Record<string, unknown>, scope) : null;
}
```

- [ ] **Step 5: Point TabBar at the shared type**

In `components/TabBar.tsx`, delete the local `export interface Tab { … }` (lines 10–34) and add:

```ts
import type { Tab } from "@/lib/workspace/tabs";
export type { Tab };
```

Replace `title={tab.filePath}` with `title={tab.kind === "file" ? tab.filePath : undefined}`. Remove now-unused imports of `TerminalProvider`/`TerminalPermissionMode`/`TerminalLaunchMode` from TabBar if tsc/eslint flag them.

- [ ] **Step 6: Add the test glob and run**

In `package.json` change the `test` script to:
`node --test server/agents/*.test.cjs lib/*.test.mjs lib/workspace/*.test.mjs components/*.test.mjs`

Run: `node --test lib/workspace/tab-kinds.test.mjs` → PASS. Then `npx tsc --noEmit -p .`: AppShell will report narrowing errors where it reads kind-specific fields on `Tab`. Fix each with a kind guard, e.g. `const tab = workspaceTabs.find(…); const terminal = tab?.kind === "terminal" && tab.terminalId ? terminals[tab.terminalId] : null;`, and change `restartUnavailableTerminal`'s parameter to `TerminalTab`. These sites are rewritten again in Task 4; keep fixes minimal.

- [ ] **Step 7: Verify and commit**

Run: `npx tsc --noEmit -p . && npx eslint lib/workspace components/TabBar.tsx components/AppShell.tsx && npm test`
Expected: all pass.

```bash
git add lib/workspace components/TabBar.tsx components/AppShell.tsx package.json
git commit -m "refactor: add workspace tab union types and kind registry"
```

---

### Task 2: Panel state reducers

**Files:**
- Create: `lib/workspace/panel-state.ts`
- Test: `lib/workspace/panel-state.test.mjs`

**Interfaces:**
- Consumes: Task 1 types and ID helpers.
- Produces: `TerminalSplit`, `CenterState`, `SideState`, `initialCenterState()`, `initialSideState()`, `CenterAction`, `SideAction`, `centerReducer(state, action)`, `sideReducer(state, action)`.

- [ ] **Step 1: Write the failing test** — `lib/workspace/panel-state.test.mjs`

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { centerReducer, sideReducer, initialCenterState, initialSideState } = await jiti.import("./panel-state.ts");

const term = (id, extra = {}) => ({ id: `terminal:${id}`, label: id, kind: "terminal", terminalId: id, cwd: "/a", ...extra });
const withTabs = (...ids) => ids.reduce((state, id) => centerReducer(state, { type: "open", tab: term(id) }), initialCenterState());

test("opening a center tab activates and mounts it once", () => {
  let state = withTabs("t1");
  assert.deepEqual(state.tabs.map((tab) => tab.id), ["pi", "terminal:t1"]);
  assert.equal(state.activeId, "terminal:t1");
  assert.deepEqual(state.mountedIds, ["pi", "terminal:t1"]);
  state = centerReducer(state, { type: "open", tab: term("t1", { label: "renamed" }) });
  assert.equal(state.tabs.length, 2);
  assert.equal(state.tabs[1].label, "t1");
});

test("open merges fields into an existing tab when requested", () => {
  const chat = { id: "codex-chat:s1", label: "old", kind: "codex-chat", cwd: "/a" };
  let state = centerReducer(initialCenterState(), { type: "open", tab: chat });
  state = centerReducer(state, { type: "open", tab: chat, mergeExisting: { label: "new", sessionName: "new" } });
  assert.equal(state.tabs[1].label, "new");
  assert.equal(state.tabs[1].sessionName, "new");
});

test("removing the active tab activates its left neighbour, else right, else pi", () => {
  let state = withTabs("t1", "t2", "t3");
  state = centerReducer(state, { type: "activate", id: "terminal:t2" });
  state = centerReducer(state, { type: "remove", id: "terminal:t2" });
  assert.equal(state.activeId, "terminal:t1");
  assert.ok(!state.mountedIds.includes("terminal:t2"));
  assert.equal(centerReducer(state, { type: "remove", id: "pi" }), state);
});

test("removing a split pane clears the split", () => {
  let state = withTabs("t1", "t2");
  state = centerReducer(state, { type: "setSplit", split: { primaryTabId: "terminal:t1", secondaryTerminalId: "t2", direction: "horizontal", ratio: 50, reversed: false } });
  state = centerReducer(state, { type: "remove", id: "terminal:t2" });
  assert.equal(state.split, null);
});

test("selecting the split's secondary pane exits the split", () => {
  let state = withTabs("t1", "t2");
  state = centerReducer(state, { type: "setSplit", split: { primaryTabId: "terminal:t1", secondaryTerminalId: "t2", direction: "vertical", ratio: 50, reversed: false } });
  state = centerReducer(state, { type: "select", id: "terminal:t2" });
  assert.equal(state.split, null);
  assert.equal(state.activeId, "terminal:t2");
});

test("removeWhere falls back to pi when the active tab is removed and never removes pi", () => {
  let state = withTabs("t1", "t2");
  state = centerReducer(state, { type: "removeWhere", predicate: (tab) => tab.kind === "terminal" && tab.terminalId === "t2" });
  assert.equal(state.activeId, "pi");
  assert.deepEqual(state.tabs.map((tab) => tab.id), ["pi", "terminal:t1"]);
  assert.equal(centerReducer(state, { type: "removeWhere", predicate: () => true }).tabs[0].id, "pi");
});

test("update returns the same state when nothing changed", () => {
  const state = withTabs("t1");
  assert.equal(centerReducer(state, { type: "update", update: (tab) => tab }), state);
  const next = centerReducer(state, { type: "update", update: (tab) => tab.kind === "terminal" ? { ...tab, status: "ended" } : tab });
  assert.equal(next.tabs[1].status, "ended");
});

const open = (state, path, sourceSessionId) => sideReducer(state, { type: "openFile", filePath: path, label: path.split("/").at(-1), sourceSessionId });

test("openFile adds once, opens the panel, and updates the source session", () => {
  let state = open(initialSideState(), "/a/x.ts", "s1");
  state = open(state, "/a/x.ts", null);
  assert.equal(state.tabs.length, 1);
  assert.equal(state.tabs[0].sourceSessionId, "s1");
  state = open(state, "/a/x.ts", "s2");
  assert.equal(state.tabs[0].sourceSessionId, "s2");
  assert.equal(state.activeId, "file:/a/x.ts");
  assert.equal(state.open, true);
});

test("closing the active side tab picks the next tab to the right, then left; skips locked", () => {
  let state = ["/a", "/b", "/c"].reduce((current, path) => open(current, path), initialSideState());
  state = sideReducer(state, { type: "toggleLock", id: "file:/a" });
  state = sideReducer(state, { type: "activate", id: "file:/b" });
  state = sideReducer(state, { type: "close", ids: ["file:/a", "file:/b"] });
  assert.deepEqual(state.tabs.map((tab) => tab.id), ["file:/a", "file:/c"]);
  assert.equal(state.activeId, "file:/c");
});

test("closing the last side tab collapses the panel", () => {
  let state = sideReducer(initialSideState(), { type: "openGitReview" });
  state = sideReducer(state, { type: "close", ids: ["git-review"] });
  assert.equal(state.open, false);
  assert.equal(state.activeId, null);
});

test("path rename and delete follow directories", () => {
  let state = open(open(initialSideState(), "/a/dir/one.ts"), "/a/other.ts");
  state = sideReducer(state, { type: "activate", id: "file:/a/dir/one.ts" });
  state = sideReducer(state, { type: "pathRenamed", oldPath: "/a/dir", newPath: "/a/moved", isDir: true });
  assert.equal(state.tabs[0].id, "file:/a/moved/one.ts");
  assert.equal(state.activeId, "file:/a/moved/one.ts");
  state = sideReducer(state, { type: "pathDeleted", path: "/a/moved", isDir: true });
  assert.deepEqual(state.tabs.map((tab) => tab.id), ["file:/a/other.ts"]);
  assert.equal(state.activeId, "file:/a/other.ts");
});

test("renaming a file relabels it", () => {
  let state = open(initialSideState(), "/a/x.ts");
  state = sideReducer(state, { type: "pathRenamed", oldPath: "/a/x.ts", newPath: "/a/y.ts", isDir: false });
  assert.equal(state.tabs[0].label, "y.ts");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test lib/workspace/panel-state.test.mjs` → FAIL (module missing).

- [ ] **Step 3: Implement `lib/workspace/panel-state.ts`**

```ts
import { getFileName } from "../file-paths";
import { GIT_REVIEW_TAB_ID, PI_TAB, fileTabId, terminalTabId, type CenterTab, type CodexChatTab, type SideTab, type TerminalTab } from "./tabs";

export interface TerminalSplit {
  primaryTabId: string;
  secondaryTerminalId: string;
  direction: "horizontal" | "vertical";
  ratio: number;
  reversed: boolean;
}

/** Center workspace for one cwd. The Pi tab is always first. */
export interface CenterState {
  tabs: CenterTab[];
  activeId: string;
  /** Tabs visited since hydration stay mounted (terminal buffers, chat state). */
  mountedIds: string[];
  split: TerminalSplit | null;
}

/** Right panel for one project. */
export interface SideState {
  tabs: SideTab[];
  activeId: string | null;
  open: boolean;
}

export function initialCenterState(): CenterState {
  return { tabs: [PI_TAB], activeId: PI_TAB.id, mountedIds: [PI_TAB.id], split: null };
}

export function initialSideState(): SideState {
  return { tabs: [], activeId: null, open: false };
}

export type CenterAction =
  | { type: "hydrate"; state: CenterState }
  | { type: "open"; tab: TerminalTab | CodexChatTab; mergeExisting?: Partial<TerminalTab> | Partial<CodexChatTab> }
  | { type: "activate"; id: string }
  /** User tab selection: selecting the split's secondary pane exits the split. */
  | { type: "select"; id: string }
  | { type: "remove"; id: string }
  | { type: "removeWhere"; predicate: (tab: CenterTab) => boolean }
  | { type: "update"; update: (tab: CenterTab) => CenterTab }
  | { type: "setSplit"; split: TerminalSplit | null | ((current: TerminalSplit | null) => TerminalSplit | null) };

function mount(state: CenterState): CenterState {
  return state.mountedIds.includes(state.activeId) ? state : { ...state, mountedIds: [...state.mountedIds, state.activeId] };
}

export function centerReducer(state: CenterState, action: CenterAction): CenterState {
  switch (action.type) {
    case "hydrate":
      return mount({ ...action.state, mountedIds: [PI_TAB.id] });
    case "open": {
      const exists = state.tabs.some((tab) => tab.id === action.tab.id);
      const tabs = !exists
        ? [...state.tabs, action.tab]
        : action.mergeExisting
          ? state.tabs.map((tab) => tab.id === action.tab.id ? { ...tab, ...action.mergeExisting } as CenterTab : tab)
          : state.tabs;
      return mount({ ...state, tabs, activeId: action.tab.id });
    }
    case "activate":
      return mount(state.activeId === action.id ? state : { ...state, activeId: action.id });
    case "select": {
      const split = state.split && action.id === terminalTabId(state.split.secondaryTerminalId) ? null : state.split;
      return mount({ ...state, split, activeId: action.id });
    }
    case "remove": {
      if (action.id === PI_TAB.id) return state;
      const index = state.tabs.findIndex((tab) => tab.id === action.id);
      const activeId = state.activeId !== action.id
        ? state.activeId
        : state.tabs[index - 1]?.id ?? state.tabs[index + 1]?.id ?? PI_TAB.id;
      const split = state.split && (state.split.primaryTabId === action.id || terminalTabId(state.split.secondaryTerminalId) === action.id) ? null : state.split;
      return {
        tabs: state.tabs.filter((tab) => tab.id !== action.id),
        activeId,
        mountedIds: state.mountedIds.filter((id) => id !== action.id),
        split,
      };
    }
    case "removeWhere": {
      const tabs = state.tabs.filter((tab) => tab.id === PI_TAB.id || !action.predicate(tab));
      if (tabs.length === state.tabs.length) return state;
      return { ...state, tabs, activeId: tabs.some((tab) => tab.id === state.activeId) ? state.activeId : PI_TAB.id };
    }
    case "update": {
      let changed = false;
      const tabs = state.tabs.map((tab) => {
        const next = action.update(tab);
        if (next !== tab) changed = true;
        return next;
      });
      return changed ? { ...state, tabs } : state;
    }
    case "setSplit": {
      const split = typeof action.split === "function" ? action.split(state.split) : action.split;
      return split === state.split ? state : { ...state, split };
    }
  }
}

export type SideAction =
  | { type: "hydrate"; state: SideState }
  | { type: "openFile"; filePath: string; label: string; sourceSessionId?: string | null }
  | { type: "openGitReview" }
  | { type: "activate"; id: string }
  | { type: "close"; ids: string[] }
  | { type: "toggleLock"; id: string }
  | { type: "pathRenamed"; oldPath: string; newPath: string; isDir: boolean }
  | { type: "pathDeleted"; path: string; isDir: boolean }
  | { type: "setOpen"; open: boolean };

const isUnder = (value: string, path: string, isDir: boolean) => value === path || (isDir && value.startsWith(`${path}/`));

export function sideReducer(state: SideState, action: SideAction): SideState {
  switch (action.type) {
    case "hydrate":
      return action.state;
    case "openFile": {
      const id = fileTabId(action.filePath);
      const existing = state.tabs.find((tab) => tab.id === id);
      const tabs = !existing
        ? [...state.tabs, { id, label: action.label, kind: "file" as const, filePath: action.filePath, sourceSessionId: action.sourceSessionId }]
        : !action.sourceSessionId || (existing.kind === "file" && existing.sourceSessionId === action.sourceSessionId)
          ? state.tabs
          : state.tabs.map((tab) => tab.id === id ? { ...tab, sourceSessionId: action.sourceSessionId } : tab);
      return { tabs, activeId: id, open: true };
    }
    case "openGitReview": {
      const tabs = state.tabs.some((tab) => tab.id === GIT_REVIEW_TAB_ID)
        ? state.tabs
        : [...state.tabs, { id: GIT_REVIEW_TAB_ID, label: "Git Review", kind: "git" as const }];
      return { tabs, activeId: GIT_REVIEW_TAB_ID, open: true };
    }
    case "activate":
      return state.activeId === action.id ? state : { ...state, activeId: action.id };
    case "close": {
      const requested = new Set(action.ids);
      const removed = new Set(state.tabs.filter((tab) => requested.has(tab.id) && tab.closable !== false && !tab.locked).map((tab) => tab.id));
      if (removed.size === 0) return state;
      const tabs = state.tabs.filter((tab) => !removed.has(tab.id));
      const activeIndex = state.tabs.findIndex((tab) => tab.id === state.activeId);
      const activeId = state.activeId && removed.has(state.activeId)
        ? state.tabs.slice(activeIndex + 1).find((tab) => !removed.has(tab.id))?.id
          ?? state.tabs.slice(0, Math.max(0, activeIndex)).reverse().find((tab) => !removed.has(tab.id))?.id
          ?? null
        : state.activeId;
      // No tabs left means nothing to show — collapse the right panel.
      return { tabs, activeId, open: tabs.length === 0 ? false : state.open };
    }
    case "toggleLock":
      return { ...state, tabs: state.tabs.map((tab) => tab.id === action.id ? { ...tab, locked: !tab.locked } : tab) };
    case "pathRenamed": {
      const renamed = (value: string) => `${action.newPath}${value.slice(action.oldPath.length)}`;
      const tabs = state.tabs.map((tab) => {
        if (tab.kind !== "file" || !isUnder(tab.filePath, action.oldPath, action.isDir)) return tab;
        const filePath = renamed(tab.filePath);
        return { ...tab, id: fileTabId(filePath), filePath, label: tab.filePath === action.oldPath ? getFileName(filePath) : tab.label };
      });
      const activeId = state.activeId?.startsWith("file:") && isUnder(state.activeId.slice(5), action.oldPath, action.isDir)
        ? fileTabId(renamed(state.activeId.slice(5)))
        : state.activeId;
      return { ...state, tabs, activeId };
    }
    case "pathDeleted": {
      const removed = new Set(state.tabs.filter((tab) => tab.kind === "file" && isUnder(tab.filePath, action.path, action.isDir)).map((tab) => tab.id));
      if (removed.size === 0) return state;
      const tabs = state.tabs.filter((tab) => !removed.has(tab.id));
      const activeId = state.activeId && removed.has(state.activeId) ? tabs.at(-1)?.id ?? null : state.activeId;
      return { tabs, activeId, open: tabs.length === 0 ? false : state.open };
    }
    case "setOpen":
      return state.open === action.open ? state : { ...state, open: action.open };
  }
}
```

Before writing, confirm `lib/file-paths.ts` has no `@/` imports (`grep -n "from \"@/" lib/file-paths.ts` → empty); if it does, inline a local `getFileName` (`path.split(/[\\/]/).at(-1) ?? path`).

- [ ] **Step 4: Run to verify it passes**

Run: `node --test lib/workspace/panel-state.test.mjs` → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/workspace/panel-state.ts lib/workspace/panel-state.test.mjs
git commit -m "refactor: add pure workspace panel state reducers"
```

---

### Task 3: Panel storage with backward-compatible format

**Files:**
- Create: `lib/workspace/panel-storage.ts`
- Test: `lib/workspace/panel-storage.test.mjs`

**Interfaces:**
- Consumes: Task 1 `parsePersistedTab`, `PI_TAB`; Task 2 state types and initial states.
- Produces: `WORKSPACE_TABS_STORAGE_KEY`, `RIGHT_PANEL_TABS_STORAGE_KEY`, `SideSnapshotCache = Map<string, SideState>`, `loadCenterState(storage, cwd)`, `saveCenterState(storage, cwd, state)`, `loadSideState(storage, projectId, cache)`, `saveSideState(storage, projectId, state, cache)`.

- [ ] **Step 1: Write the failing test** — `lib/workspace/panel-storage.test.mjs`

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const storage = await jiti.import("./panel-storage.ts");

function memoryStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return { getItem: (key) => map.has(key) ? map.get(key) : null, setItem: (key, value) => map.set(key, String(value)), map };
}
const centerKey = (cwd) => `pi-web:workspace-tabs:${encodeURIComponent(cwd)}`;
const sideKey = (root) => `pi-web:right-panel-tabs:${encodeURIComponent(root)}`;

// Snapshot written by the pre-refactor AppShell.
const legacyCenter = {
  tabs: [
    { id: "terminal:t1", label: "Terminal", kind: "terminal", terminalId: "t1", terminalProvider: "shell", cwd: "/p", status: "running" },
    { id: "codex-chat:s1", label: "Chat", kind: "codex-chat", sourceSessionId: "s1", cwd: "/p", status: "running" },
    { id: "terminal:other", label: "Other", kind: "terminal", terminalId: "x", cwd: "/elsewhere" },
  ],
  activeId: "codex-chat:s1",
  split: { primaryTabId: "terminal:t1", secondaryTerminalId: "t9", direction: "vertical", ratio: 95, reversed: true },
};

test("loads the legacy center format for the matching cwd", () => {
  const state = storage.loadCenterState(memoryStorage({ [centerKey("/p")]: JSON.stringify(legacyCenter) }), "/p");
  assert.deepEqual(state.tabs.map((tab) => tab.id), ["pi", "terminal:t1", "codex-chat:s1"]);
  assert.equal(state.tabs[2].status, "idle");
  assert.equal(state.tabs[1].status, "running");
  assert.equal(state.activeId, "codex-chat:s1");
  assert.deepEqual(state.mountedIds, ["pi", "codex-chat:s1"]);
  assert.deepEqual(state.split, { primaryTabId: "terminal:t1", secondaryTerminalId: "t9", direction: "vertical", ratio: 80, reversed: true });
});

test("falls back to the unscoped legacy key and to defaults", () => {
  const fallback = storage.loadCenterState(memoryStorage({ "pi-web:workspace-tabs": JSON.stringify(legacyCenter) }), "/p");
  assert.equal(fallback.tabs.length, 3);
  const empty = storage.loadCenterState(memoryStorage({ [centerKey("/p")]: "{broken" }), "/p");
  assert.deepEqual(empty, { tabs: [{ id: "pi", label: "TianForge pi", kind: "pi", closable: false }], activeId: "pi", mountedIds: ["pi"], split: null });
});

test("an unknown active id falls back to pi", () => {
  const state = storage.loadCenterState(memoryStorage({ [centerKey("/p")]: JSON.stringify({ ...legacyCenter, activeId: "terminal:gone" }) }), "/p");
  assert.equal(state.activeId, "pi");
});

test("saves the center state without the pi tab in the legacy shape", () => {
  const store = memoryStorage();
  const state = storage.loadCenterState(memoryStorage({ [centerKey("/p")]: JSON.stringify(legacyCenter) }), "/p");
  storage.saveCenterState(store, "/p", state);
  const saved = JSON.parse(store.map.get(centerKey("/p")));
  assert.deepEqual(Object.keys(saved).sort(), ["activeId", "split", "tabs"]);
  assert.equal(saved.tabs.some((tab) => tab.id === "pi"), false);
});

const legacySide = {
  tabs: [
    { id: "file:/p/a.ts", label: "a.ts", kind: "file", filePath: "/p/a.ts", locked: true },
    { id: "git-review", label: "Git Review", kind: "git" },
    { id: "terminal:t1", label: "misplaced", kind: "terminal", cwd: "/p" },
  ],
  activeId: "git-review",
  open: true,
};

test("loads the legacy side format, dropping tabs from the other slot", () => {
  const state = storage.loadSideState(memoryStorage({ [sideKey("/p")]: JSON.stringify(legacySide) }), "/p", new Map());
  assert.deepEqual(state.tabs.map((tab) => tab.id), ["file:/p/a.ts", "git-review"]);
  assert.equal(state.tabs[0].locked, true);
  assert.equal(state.activeId, "git-review");
  assert.equal(state.open, true);
});

test("side panel stays closed without tabs and prefers the in-memory cache", () => {
  const closed = storage.loadSideState(memoryStorage({ [sideKey("/p")]: JSON.stringify({ tabs: [], activeId: null, open: true }) }), "/p", new Map());
  assert.equal(closed.open, false);
  const cache = new Map([["/p", { tabs: [{ id: "git-review", label: "Git Review", kind: "git" }], activeId: "git-review", open: true }]]);
  assert.equal(storage.loadSideState(memoryStorage(), "/p", cache).tabs.length, 1);
});

test("saving side state updates the cache and storage", () => {
  const store = memoryStorage();
  const cache = new Map();
  const state = { tabs: [{ id: "git-review", label: "Git Review", kind: "git" }], activeId: "git-review", open: true };
  storage.saveSideState(store, "/p", state, cache);
  assert.equal(cache.get("/p"), state);
  assert.deepEqual(JSON.parse(store.map.get(sideKey("/p"))), state);
});

test("storage failures are ignored", () => {
  const throwing = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("quota"); } };
  assert.equal(storage.loadCenterState(throwing, "/p").activeId, "pi");
  assert.doesNotThrow(() => storage.saveCenterState(throwing, "/p", storage.loadCenterState(throwing, "/p")));
  assert.doesNotThrow(() => storage.saveSideState(throwing, "/p", { tabs: [], activeId: null, open: false }, new Map()));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test lib/workspace/panel-storage.test.mjs` → FAIL (module missing).

- [ ] **Step 3: Implement `lib/workspace/panel-storage.ts`**

```ts
import { initialCenterState, initialSideState, type CenterState, type SideState, type TerminalSplit } from "./panel-state";
import { parsePersistedTab } from "./tab-kinds";
import { PI_TAB, type CenterTab, type SideTab } from "./tabs";

// Keys and JSON shapes are shared with already-persisted browser state; do
// not change them without a migration.
export const WORKSPACE_TABS_STORAGE_KEY = "pi-web:workspace-tabs";
export const RIGHT_PANEL_TABS_STORAGE_KEY = "pi-web:right-panel-tabs";
const workspaceTabsStorageKey = (cwd: string) => `${WORKSPACE_TABS_STORAGE_KEY}:${encodeURIComponent(cwd)}`;
const rightPanelTabsStorageKey = (projectRoot: string) => `${RIGHT_PANEL_TABS_STORAGE_KEY}:${encodeURIComponent(projectRoot)}`;

type KeyValueStorage = Pick<Storage, "getItem" | "setItem">;
/** Right-panel state per project kept in memory so quick project switches do not re-read storage. */
export type SideSnapshotCache = Map<string, SideState>;

function parseSplit(value: unknown): TerminalSplit | null {
  if (!value || typeof value !== "object") return null;
  const split = value as Partial<TerminalSplit>;
  if (typeof split.primaryTabId !== "string" || typeof split.secondaryTerminalId !== "string") return null;
  if (split.direction !== "horizontal" && split.direction !== "vertical") return null;
  return {
    primaryTabId: split.primaryTabId,
    secondaryTerminalId: split.secondaryTerminalId,
    direction: split.direction,
    ratio: typeof split.ratio === "number" ? Math.max(20, Math.min(80, split.ratio)) : 50,
    reversed: split.reversed === true,
  };
}

export function loadCenterState(storage: KeyValueStorage, cwd: string): CenterState {
  try {
    const raw = storage.getItem(workspaceTabsStorageKey(cwd)) ?? storage.getItem(WORKSPACE_TABS_STORAGE_KEY);
    const parsed = JSON.parse(raw || "null") as { tabs?: unknown; activeId?: unknown; split?: unknown } | null;
    const restored = Array.isArray(parsed?.tabs)
      ? parsed.tabs.map((tab) => parsePersistedTab(tab, "center", { cwd })).filter((tab): tab is CenterTab => tab !== null)
      : [];
    const tabs: CenterTab[] = [PI_TAB, ...restored];
    const activeId = typeof parsed?.activeId === "string" && tabs.some((tab) => tab.id === parsed.activeId) ? parsed.activeId : PI_TAB.id;
    return { tabs, activeId, mountedIds: activeId === PI_TAB.id ? [PI_TAB.id] : [PI_TAB.id, activeId], split: parseSplit(parsed?.split) };
  } catch {
    return initialCenterState(); // malformed or unavailable browser storage
  }
}

export function saveCenterState(storage: KeyValueStorage, cwd: string, state: CenterState): void {
  try {
    storage.setItem(workspaceTabsStorageKey(cwd), JSON.stringify({ tabs: state.tabs.filter((tab) => tab.id !== PI_TAB.id), activeId: state.activeId, split: state.split }));
  } catch { /* storage quota or privacy mode */ }
}

export function loadSideState(storage: KeyValueStorage, projectId: string, cache: SideSnapshotCache): SideState {
  try {
    const parsed = (cache.get(projectId) ?? JSON.parse(storage.getItem(rightPanelTabsStorageKey(projectId)) || "null")) as { tabs?: unknown; activeId?: unknown; open?: unknown } | null;
    const tabs = Array.isArray(parsed?.tabs)
      ? parsed.tabs.map((tab) => parsePersistedTab(tab, "side", {})).filter((tab): tab is SideTab => tab !== null)
      : [];
    const activeId = typeof parsed?.activeId === "string" && tabs.some((tab) => tab.id === parsed.activeId) ? parsed.activeId : null;
    return { tabs, activeId, open: parsed?.open === true && tabs.length > 0 };
  } catch {
    return initialSideState();
  }
}

export function saveSideState(storage: KeyValueStorage, projectId: string, state: SideState, cache: SideSnapshotCache): void {
  cache.set(projectId, state);
  try {
    storage.setItem(rightPanelTabsStorageKey(projectId), JSON.stringify(state));
  } catch { /* storage may be unavailable */ }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test lib/workspace/panel-storage.test.mjs` → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/workspace/panel-storage.ts lib/workspace/panel-storage.test.mjs
git commit -m "refactor: add backward-compatible workspace panel storage"
```

---

### Task 4: Wire AppShell to the reducers and storage

**Files:**
- Modify: `components/AppShell.tsx`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces (inside AppShell, used by Tasks 5–7): `center`, `dispatchCenter`, `side`, `dispatchSide`, and the existing handler names (`handleOpenFile`, `openGitReview`, `handleOpenGitReview`, `handleCloseFileTab(s)`, `handleToggleFileTabLocked`, `removeWorkspaceTab`, `handleSelectWorkspaceTab`, `handleTerminalCreated`, `handleOpenCodexChat`, `handleOpenCodexSessionChat`, …) with unchanged signatures.

- [ ] **Step 1: Replace the tab state declarations**

Delete the `workspaceTabs`, `activeWorkspaceTabId`, `mountedWorkspaceTabIds`, `workspaceTabsHydratedCwd`, `terminalSplit` `useState`s and their hydrate/persist/mount effects (the block starting `const [workspaceTabs, setWorkspaceTabs]` through the `setMountedWorkspaceTabIds` effect), and the `fileTabs`, `activeFileTabId`, `rightPanelOpen`, `fileTabsHydratedProject`, `rightPanelStateCacheRef` state plus its two `useLayoutEffect`s, `currentProjectPanelsRef`, `persistCurrentProjectPanels`, and the misplaced-tab migration effect (`const misplaced = fileTabs.filter(…)`). Also delete the file-level `WORKSPACE_TABS_STORAGE_KEY`, `RIGHT_PANEL_TABS_STORAGE_KEY` and key helper constants. Insert:

```tsx
  // Center workspace (per cwd) and right panel (per project) state. See
  // lib/workspace/panel-state.ts for the transitions.
  const [center, dispatchCenter] = useReducer(centerReducer, undefined, initialCenterState);
  const [side, dispatchSide] = useReducer(sideReducer, undefined, initialSideState);
  const [centerHydratedCwd, setCenterHydratedCwd] = useState<string | null>(null);
  const [sideHydratedProject, setSideHydratedProject] = useState<string | null>(null);
  const sideCacheRef = useRef<SideSnapshotCache>(new Map());
  const { tabs: workspaceTabs, activeId: activeWorkspaceTabId, split: terminalSplit } = center;
  const { tabs: fileTabs, activeId: activeFileTabId, open: rightPanelOpen } = side;
  const setRightPanelOpen = useCallback((open: boolean) => dispatchSide({ type: "setOpen", open }), []);
  const setTerminalSplit = useCallback((split: TerminalSplit | null | ((current: TerminalSplit | null) => TerminalSplit | null)) => dispatchCenter({ type: "setSplit", split }), []);
  const activateWorkspaceTab = useCallback((id: string) => dispatchCenter({ type: "activate", id }), []);
  const splitRestoreAttemptRef = useRef<string | null>(null);

  useEffect(() => {
    splitRestoreAttemptRef.current = null;
    dispatchCenter({ type: "hydrate", state: activeCwd ? loadCenterState(localStorage, activeCwd) : initialCenterState() });
    setCenterHydratedCwd(activeCwd);
  }, [activeCwd]);
  useEffect(() => {
    if (activeCwd && centerHydratedCwd === activeCwd) saveCenterState(localStorage, activeCwd, center);
  }, [activeCwd, center, centerHydratedCwd]);
  // Layout effects so a project switch never paints the previous project's tabs.
  useLayoutEffect(() => {
    dispatchSide({ type: "hydrate", state: activeProjectId ? loadSideState(localStorage, activeProjectId, sideCacheRef.current) : initialSideState() });
    setSideHydratedProject(activeProjectId);
  }, [activeProjectId]);
  useLayoutEffect(() => {
    if (activeProjectId && sideHydratedProject === activeProjectId) saveSideState(localStorage, activeProjectId, side, sideCacheRef.current);
  }, [activeProjectId, side, sideHydratedProject]);
  // Project switches save synchronously before the scope changes.
  const panelSnapshotRef = useRef({ activeCwd, activeProjectId, center, side, centerHydratedCwd, sideHydratedProject });
  panelSnapshotRef.current = { activeCwd, activeProjectId, center, side, centerHydratedCwd, sideHydratedProject };
  const persistCurrentProjectPanels = useCallback(() => {
    const current = panelSnapshotRef.current;
    if (current.activeCwd && current.centerHydratedCwd === current.activeCwd) saveCenterState(localStorage, current.activeCwd, current.center);
    if (current.activeProjectId && current.sideHydratedProject === current.activeProjectId) saveSideState(localStorage, current.activeProjectId, current.side, sideCacheRef.current);
  }, []);
```

Add imports: `useReducer` from react; `centerReducer, sideReducer, initialCenterState, initialSideState, type TerminalSplit` from `@/lib/workspace/panel-state`; `loadCenterState, saveCenterState, loadSideState, saveSideState, type SideSnapshotCache` from `@/lib/workspace/panel-storage`; `codexChatTabId, fileTabId, terminalTabId, GIT_REVIEW_TAB_ID, type TerminalTab` from `@/lib/workspace/tabs`.

- [ ] **Step 2: Rewrite the tab handlers to dispatch actions**

Replace each handler body (keep names, signatures, and non-tab side effects such as `setSidebarOpen`, `updateTerminals`, `setActiveTopPanel`):

```tsx
  const handleOpenFile = useCallback((filePath: string, fileName: string, sourceSessionId?: string | null) => {
    dispatchSide({ type: "openFile", filePath, label: fileName, sourceSessionId });
    // On mobile the file panel is full-screen; close the drawer so it shows.
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);

  const handleExplorerPathRenamed = useCallback((oldPath: string, newPath: string, isDir: boolean) => {
    dispatchSide({ type: "pathRenamed", oldPath, newPath, isDir });
  }, []);

  const handleExplorerPathDeleted = useCallback((deletedPath: string, isDir: boolean) => {
    dispatchSide({ type: "pathDeleted", path: deletedPath, isDir });
  }, []);

  const handleCloseFileTabs = useCallback((tabIds: string[]) => dispatchSide({ type: "close", ids: tabIds }), []);
  const handleCloseFileTab = useCallback((tabId: string) => dispatchSide({ type: "close", ids: [tabId] }), []);
  const handleToggleFileTabLocked = useCallback((tabId: string) => dispatchSide({ type: "toggleLock", id: tabId }), []);

  const removeWorkspaceTab = useCallback((tabId: string) => dispatchCenter({ type: "remove", id: tabId }), []);

  const handleCloseWorkspaceTab = useCallback((tabId: string) => {
    const tab = workspaceTabs.find((item) => item.id === tabId);
    const terminal = tab && tab.kind !== "pi" && tab.terminalId ? terminals[tab.terminalId] : null;
    if (terminal?.state === "running") {
      setTerminalCloseError(null);
      setPendingTerminalClose({ tabId, terminal });
      return;
    }
    removeWorkspaceTab(tabId);
  }, [removeWorkspaceTab, terminals, workspaceTabs]);

  const handleSelectWorkspaceTab = useCallback((tabId: string) => {
    dispatchCenter({ type: "select", id: tabId });
    setActiveTopPanel(null);
  }, []);

  const handleCodexSessionChanged = useCallback((change: { id: string; action: "rename" | "archive" | "unarchive" | "delete"; name?: string }) => {
    if (change.action === "rename" && change.name) {
      const name = change.name;
      dispatchCenter({ type: "update", update: (tab) => tab.kind !== "pi" && tab.sourceSessionId === change.id ? { ...tab, label: name, ...(tab.kind === "codex-chat" ? { sessionName: name } : {}) } : tab });
      return;
    }
    if (change.action !== "archive" && change.action !== "delete") return;
    dispatchCenter({ type: "removeWhere", predicate: (tab) => tab.kind === "codex-chat" && tab.sourceSessionId === change.id });
  }, []);

  const handleAgentTerminalRemoved = useCallback((terminalId: string) => {
    updateTerminals((current) => current.filter((terminal) => terminal.id !== terminalId));
    dispatchCenter({ type: "removeWhere", predicate: (tab) => tab.kind !== "pi" && tab.terminalId === terminalId });
  }, [updateTerminals]);

  const openGitReview = useCallback(() => {
    if (!activeCwd) return;
    dispatchSide({ type: "openGitReview" });
    if (isMobile) setSidebarOpen(false);
  }, [activeCwd, isMobile]);

  const handleOpenGitReview = useCallback(() => {
    if (rightPanelOpen && activeFileTabId === GIT_REVIEW_TAB_ID) {
      handleCloseFileTab(GIT_REVIEW_TAB_ID);
      return;
    }
    openGitReview();
  }, [rightPanelOpen, activeFileTabId, handleCloseFileTab, openGitReview]);

  const handleTerminalCreated = useCallback((terminal: TerminalSession, preferredLabel?: string) => {
    updateTerminals((current) => [...current.filter((item) => item.id !== terminal.id), terminal]);
    dispatchCenter({ type: "open", tab: { id: terminalTabId(terminal.id), label: preferredLabel || terminal.title || (terminal.provider === "shell" ? "Terminal" : `${terminal.provider} terminal`), kind: "terminal", terminalId: terminal.id, terminalProvider: terminal.provider, terminalPermissionMode: terminal.permissionMode, terminalLaunchMode: terminal.launchMode, terminalNoAltScreen: terminal.noAltScreen, terminalModel: terminal.model, terminalWebSearch: terminal.webSearch, terminalChatMode: terminal.chatMode, cwd: terminal.cwd, sourceSessionId: terminal.sourceSessionId, status: terminal.state === "running" ? "running" : "ended" } });
    setNewTerminalProvider(null);
    if (isMobile) setSidebarOpen(false);
  }, [isMobile, updateTerminals]);

  const handleOpenCodexChat = useCallback((terminal: TerminalSession) => {
    dispatchCenter({ type: "open", tab: { id: codexChatTabId(terminal.id), label: "Codex Chat", kind: "codex-chat", terminalId: terminal.id, sourceSessionId: terminal.sourceSessionId, cwd: terminal.cwd, model: terminal.model } });
  }, []);

  const handleOpenCodexSessionChat = useCallback((target: { sessionId: string; sessionName: string; cwd: string; model?: string; reasoningEffort?: string; serviceTier?: string; approvalPolicy: "untrusted" | "on-request" | "never" }) => {
    const fields = { label: target.sessionName, sessionName: target.sessionName, cwd: target.cwd, model: target.model, reasoningEffort: target.reasoningEffort, serviceTier: target.serviceTier, approvalPolicy: target.approvalPolicy };
    dispatchCenter({ type: "open", tab: { id: codexChatTabId(target.sessionId), kind: "codex-chat", sourceSessionId: target.sessionId, ...fields }, mergeExisting: fields });
  }, []);

  const handleTerminalChanged = useCallback((terminal: TerminalSession) => {
    updateTerminals((current) => [...current.filter((item) => item.id !== terminal.id), terminal]);
    dispatchCenter({ type: "update", update: (tab) => tab.kind === "terminal" && tab.terminalId === terminal.id ? { ...tab, label: terminal.title || tab.label, terminalPermissionMode: terminal.permissionMode, terminalLaunchMode: terminal.launchMode, terminalNoAltScreen: terminal.noAltScreen, terminalModel: terminal.model, terminalWebSearch: terminal.webSearch, terminalChatMode: terminal.chatMode, sourceSessionId: terminal.sourceSessionId, status: terminal.state === "running" ? "running" : "ended" } : tab });
  }, [updateTerminals]);

  const handleTerminalConnection = useCallback((terminalId: string, connection: TerminalConnectionState) => {
    const status: TabStatus = connection === "connected" ? "running" : connection === "offline" ? "offline" : connection === "disconnected" ? "failed" : "connecting";
    dispatchCenter({ type: "update", update: (tab) => tab.kind === "terminal" && tab.terminalId === terminalId && tab.status !== status ? { ...tab, status } : tab });
  }, []);

  const handleCodexTabStatus = useCallback((tabId: string, status: "idle" | "running" | "approval") => {
    dispatchCenter({ type: "update", update: (tab) => tab.id === tabId && tab.status !== status ? { ...tab, status } : tab });
  }, []);

  const handleCodexTabConfiguration = useCallback((tabId: string, configuration: { model?: string; reasoningEffort?: string; serviceTier?: string; approvalPolicy?: "untrusted" | "on-request" | "never" }) => {
    dispatchCenter({ type: "update", update: (tab) => tab.id === tabId && tab.kind === "codex-chat" ? { ...tab, ...configuration } : tab });
  }, []);
```

In `restartUnavailableTerminal(tab: TerminalTab)`, replace its `setWorkspaceTabs(…map…)` with `dispatchCenter({ type: "update", update: (item) => item.id === tab.id && item.kind === "terminal" ? { ...item, terminalId: restarted.id, … same fields …, status: "running" } : item })` and keep `setTerminalSplit(…)` (now the dispatching wrapper). In the terminal-availability effect, replace `setWorkspaceTabs((current) => …)` with `dispatchCenter({ type: "update", update: (tab) => tab.kind === "terminal" && tab.terminalId && !available.has(tab.terminalId) && tab.status !== "ended" ? { ...tab, status: "ended" } : tab })` and its `workspaceTabsHydratedCwd` dependency with `centerHydratedCwd`; pass `workspaceTabs.filter((tab): tab is TerminalTab => tab.kind === "terminal")` to `getMissingSplitTerminalTabs`.

Replace every remaining `setActiveWorkspaceTabId(x)` with `activateWorkspaceTab(x)`, every `setActiveFileTabId` passed to TabBar with `(id) => dispatchSide({ type: "activate", id })`, and `mountedWorkspaceTabIds.has(tab.id)` with `center.mountedIds.includes(tab.id)`. Import `type TabStatus` from `@/lib/workspace/tabs`.

- [ ] **Step 3: Verify no stale setters remain**

Run: `grep -nE "setWorkspaceTabs|setFileTabs|setActiveWorkspaceTabId|setActiveFileTabId|setMountedWorkspaceTabIds|workspaceTabsHydratedCwd|fileTabsHydratedProject|rightPanelStateCacheRef|workspaceTabsStorageKey|rightPanelTabsStorageKey" components/AppShell.tsx`
Expected: no output.

- [ ] **Step 4: Full verification**

Run: `npx tsc --noEmit -p . && npx eslint components/AppShell.tsx lib/workspace && npm test && npx playwright test`
Expected: tsc/eslint clean, all unit tests pass, e2e 17 passed / 0 failed.

- [ ] **Step 5: Manual check of the two risk areas** (`npm run dev`, then in the browser)

1. Open a file and Git Review in project A, open a terminal; switch to project B and back — A's right-panel tabs and terminal tab reappear exactly, with no flash of B's tabs.
2. Split two terminals, reload the page — the split restores (or offers "Restoring this pane…").

- [ ] **Step 6: Commit**

```bash
git add components/AppShell.tsx
git commit -m "refactor: drive AppShell tabs through workspace panel reducers"
```

---

### Task 5: Tab views registry, CenterWorkspace, SidePanel

**Files:**
- Create: `components/workspace/tab-views.tsx`, `components/workspace/CenterWorkspace.tsx`, `components/workspace/SidePanel.tsx`
- Modify: `components/AppShell.tsx`

**Interfaces:**
- Consumes: Task 4 state/handlers.
- Produces:
  - `TerminalTabView`, `CodexChatTabView`, `FileTabView`, `GitTabView` components and `CENTER_TAB_VIEWS: { terminal, "codex-chat" }`, `SIDE_TAB_VIEWS: { file, git }` maps keyed by kind.
  - `CenterWorkspace({ state, renderTab })` renders every mounted non-Pi center tab, absolutely positioned, visible only when active, skipping the split's secondary pane.
  - `SidePanel({ tab, context })` renders the active side tab's view or the "No file open" placeholder.

- [ ] **Step 1: Create `components/workspace/tab-views.tsx`** — move the per-kind JSX out of AppShell verbatim:
  - `TerminalTabView`: the body of the `terminal ? (split && secondaryTab ? … : primaryPanel) : (<div …>Terminal process is unavailable…</div>)` branch, including `primaryPanel`/`secondaryPanel` construction (currently inside the `workspaceTabs.filter(...).map((tab) => { … })` loop in AppShell's center column). Its props are exactly the values that code reads: `tab: TerminalTab`, `terminals: Record<string, TerminalSession>`, `split: TerminalSplit | null`, `workspaceTabs: CenterTab[]`, `isMobile`, `activeTerminalPaneId`, `onActivatePane(id)`, `terminalRestartingId`, `terminalRestartError`, `terminalRestoreErrors`, `isActive`, and callbacks `onConnectionChange(terminalId, connection)`, `onSetSplit(update)`, `onActivateTab(id)`, `onRestart(tab)`, `onTerminalChange`, `onTerminalStarted`, `onOpenCodexChat`, `onBeginSplitResize`.
  - `CodexChatTabView`: the `<CodexChatPanel … />` element; props `tab: CodexChatTab`, `terminal: TerminalSession | null`, `activeCwd`, `onStatusChange`, `onConfigurationChange`, `onOpenFile(absolutePath, sourceSessionId)`. Render nothing when neither `terminal` nor `tab.sourceSessionId` exists (fall through to the unavailable view, as today).
  - `FileTabView`: the `<FileViewer … />` element; `GitTabView`: the `<GitReviewPanel … />` element.
  - Import `AgentTerminalPanel`, `CodexChatPanel`, `FileViewer`, `GitReviewPanel` here with the same `next/dynamic(..., { ssr: false })` declarations AppShell uses today, and remove them from AppShell. Move `terminalRecoveryButtonStyle` here.
  - Export `CENTER_TAB_VIEWS` and `SIDE_TAB_VIEWS` maps from kind to component.

- [ ] **Step 2: Create `CenterWorkspace.tsx` and `SidePanel.tsx`**

```tsx
// components/workspace/CenterWorkspace.tsx
"use client";

import type { ReactNode } from "react";
import type { CenterState } from "@/lib/workspace/panel-state";
import { terminalTabId, type CodexChatTab, type TerminalTab } from "@/lib/workspace/tabs";

/** Mounted external-agent tabs; the Pi tab is rendered by the caller. */
export function CenterWorkspace({ state, renderTab }: { state: CenterState; renderTab: (tab: TerminalTab | CodexChatTab) => ReactNode }) {
  const splitSecondaryId = state.split ? terminalTabId(state.split.secondaryTerminalId) : null;
  return <>
    {state.tabs.map((tab) => {
      if (tab.kind === "pi" || !state.mountedIds.includes(tab.id) || tab.id === splitSecondaryId) return null;
      return <div key={tab.id} style={{ position: "absolute", inset: 0, display: state.activeId === tab.id ? "block" : "none" }}>{renderTab(tab)}</div>;
    })}
  </>;
}
```

```tsx
// components/workspace/SidePanel.tsx
"use client";

import type { ReactNode } from "react";
import type { SideTab } from "@/lib/workspace/tabs";

export function SidePanel({ tab, renderTab }: { tab: SideTab | null; renderTab: (tab: SideTab) => ReactNode }) {
  if (!tab) {
    return <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>No file open</div>;
  }
  return <>{renderTab(tab)}</>;
}
```

- [ ] **Step 3: Use them in AppShell.** Replace the `workspaceTabs.filter(...).map(...)` loop with `<CenterWorkspace state={center} renderTab={(tab) => tab.kind === "codex-chat" && (…terminal or sourceSessionId…) ? <CodexChatTabView …/> : <TerminalTabView …/>} />`, and the `activeFileTab?.kind === "file" ? … : activeFileTab?.kind === "git" ? … : placeholder` block with `<SidePanel tab={activeFileTab} renderTab={(tab) => tab.kind === "file" ? <FileTabView …/> : <GitTabView …/>} />`. The kind switch now lives in exactly these two render callbacks; `tab-views.tsx` holds everything kind-specific.

- [ ] **Step 4: Verify** — `npx tsc --noEmit -p . && npx eslint components/workspace components/AppShell.tsx && npm test && npx playwright test` → all green; `wc -l components/AppShell.tsx` drops by ~150.

- [ ] **Step 5: Commit**

```bash
git add components/workspace components/AppShell.tsx
git commit -m "refactor: render workspace tabs through per-kind views"
```

---

### Task 6: WorkspaceActions context

**Files:**
- Create: `components/workspace/WorkspaceActions.tsx`
- Modify: `components/AppShell.tsx`, `components/SessionSidebar.tsx`, `components/ChatWindow.tsx`, `components/workspace/tab-views.tsx`

**Interfaces:**
- Consumes: AppShell handlers from Task 4.
- Produces: `WorkspaceActions`, `WorkspaceActionsProvider`, `useWorkspaceActions()`.

- [ ] **Step 1: Create the context**

```tsx
// components/workspace/WorkspaceActions.tsx
"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { TerminalSession } from "@/lib/agents/terminal";

export interface CodexChatTarget {
  sessionId: string;
  sessionName: string;
  cwd: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  approvalPolicy: "untrusted" | "on-request" | "never";
}

/**
 * Commands that open or close workspace tabs. Any component under AppShell
 * (sidebar, chat, viewers, and future status/command UIs) calls these instead
 * of receiving callbacks through props.
 */
export interface WorkspaceActions {
  openFile(filePath: string, options?: { sourceSessionId?: string | null }): void;
  toggleGitReview(): void;
  openTerminal(terminal: TerminalSession, label?: string): void;
  openCodexChat(target: CodexChatTarget): void;
  closeTab(tabId: string): void;
  revealInExplorer(filePath: string): void;
}

const WorkspaceActionsContext = createContext<WorkspaceActions | null>(null);

export function WorkspaceActionsProvider({ value, children }: { value: WorkspaceActions; children: ReactNode }) {
  return <WorkspaceActionsContext.Provider value={value}>{children}</WorkspaceActionsContext.Provider>;
}

export function useWorkspaceActions(): WorkspaceActions {
  const actions = useContext(WorkspaceActionsContext);
  if (!actions) throw new Error("useWorkspaceActions must be used inside WorkspaceActionsProvider");
  return actions;
}
```

- [ ] **Step 2: Provide it from AppShell** — build a memoized value and wrap the returned JSX:

```tsx
  const workspaceActions = useMemo<WorkspaceActions>(() => ({
    openFile: (filePath, options) => handleOpenFile(filePath, getFileName(filePath), options?.sourceSessionId),
    toggleGitReview: handleOpenGitReview,
    openTerminal: handleTerminalCreated,
    openCodexChat: handleOpenCodexSessionChat,
    closeTab: (tabId) => (fileTabs.some((tab) => tab.id === tabId) ? handleCloseFileTab(tabId) : handleCloseWorkspaceTab(tabId)),
    revealInExplorer: handleRevealFileInExplorer,
  }), [fileTabs, handleCloseFileTab, handleCloseWorkspaceTab, handleOpenCodexSessionChat, handleOpenFile, handleOpenGitReview, handleRevealFileInExplorer, handleTerminalCreated]);
```

- [ ] **Step 3: Migrate consumers, deleting the props they replace**
  - `SessionSidebar`: remove props `onOpenFile`, `onOpenGitReview`, `onOpenCodexSession`, `onOpenAgentTerminal`; inside, `const actions = useWorkspaceActions();` and pass `actions.openFile`-based adapters where it forwards to `FileExplorer`/`AgentsPanel` (e.g. `onOpenFile={(path) => actions.openFile(path)}`, `onOpenCodexSession={actions.openCodexChat}`, `onOpenAgentTerminal={actions.openTerminal}`), and `actions.toggleGitReview` for Git Review.
  - `ChatWindow`: remove `onOpenFile` prop; use `actions.openFile(path, { sourceSessionId: session?.id ?? null })` where `handleOpenLinkedFile` was used; delete `handleOpenLinkedFile` from AppShell.
  - `tab-views.tsx`: `FileTabView` and `CodexChatTabView` call `useWorkspaceActions().openFile(...)` instead of receiving `onOpenFile`; `TabBar`'s `onRevealFile` gets `actions.revealInExplorer`.
  - Keep `FileExplorer`, `AgentsPanel`, `FileViewer` prop APIs unchanged (they are leaf components also reusable outside the provider).

- [ ] **Step 4: Verify no dangling props** — `grep -nE "onOpenGitReview=|onOpenCodexSession=|onOpenAgentTerminal=|handleOpenLinkedFile" components/AppShell.tsx` → no output; then `npx tsc --noEmit -p . && npx eslint components && npm test && npx playwright test` → green.

- [ ] **Step 5: Commit**

```bash
git add components
git commit -m "refactor: expose workspace open actions through context"
```

---

### Task 7: Extract TopBar

**Files:**
- Create: `components/workspace/TopBar.tsx`
- Modify: `components/AppShell.tsx`

**Interfaces:**
- Consumes: `useSessionMeta` values (`sessionStats`, `contextUsage`, `copiedSessionField`, `handleCopySessionField`, `autoNameStatus`, `handleAutoName`), branch state (`branchTree`, `branchActiveLeafId`, `handleBranchLeafChange`), `systemPrompt`, `selectedSession`, `showChat`, `activeTopPanel`/`toggleTopPanel`/`topPanelPos`, `activityPanelOpen`/activity data, `handleViewFullHistory`, `handleSidebarToggle`, `sidebarOpen`, `isMobile`.
- Produces: `TopBar(props)`; AppShell renders `<TopBar … />` where the element starting at `<div ref={topBarRef}` was.

- [ ] **Step 1: Move JSX** — cut the element that begins `<div ref={topBarRef} style={{ display: activeWorkspaceTabId === "pi" ? "flex" : "none", …` through its matching closing tag (use the editor's bracket matching), plus the dropdown panels it positions (`activeTopPanel === "branches" | "system" | "session"` blocks rendered via `topPanelPos`), into `TopBar.tsx`. Move `topBarRef`, `systemBtnRef`, `activityPanelRef`, `topPanelPos` and the effects that measure/close panels (the two `useEffect`s after `handleSidebarToggle` that depend on `activeTopPanel`) into TopBar. Keep `activeTopPanel` state in AppShell (project switching and mobile back-navigation close it) and pass `activeTopPanel`/`onActiveTopPanelChange`.
- [ ] **Step 2: Type the props** as an explicit `TopBarProps` interface listing exactly the values the moved JSX reads; import `SessionCopyField`, `AutoNameStatus`, `ContextUsage` from `@/hooks/useSessionMeta` and `SessionStatsInfo` from `@/lib/pi-types`.
- [ ] **Step 3: Verify** — `npx tsc --noEmit -p . && npx eslint components && npm test && npx playwright test` → green. Manual: open each top-bar dropdown (Branches, System prompt, Session), copy file path/ID, run Auto-name — same behavior as before.
- [ ] **Step 4: Commit**

```bash
git add components/workspace/TopBar.tsx components/AppShell.tsx
git commit -m "refactor: extract Pi session top bar from AppShell"
```

---

### Task 8: Document extension points

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Add a section under "Key Design Decisions & Traps"**

```markdown
### Workspace panels and tab kinds
- Center tabs (Pi, Terminal, Codex Chat, terminal split) persist per **cwd**; right-panel tabs (File, Git Review) persist per **project**. State lives in `lib/workspace/panel-state.ts` (pure reducers) and `lib/workspace/panel-storage.ts` (localStorage, legacy-compatible keys/shapes — never change them without a migration).
- To add a tab kind: add its type to `lib/workspace/tabs.ts`, an entry with `slot` and `parse` in `lib/workspace/tab-kinds.ts`, a view in `components/workspace/tab-views.tsx`, and the kind branch in the matching `CenterWorkspace`/`SidePanel` render callback in AppShell. Add reducer/storage tests in `lib/workspace/*.test.mjs`.
- Components open tabs with `useWorkspaceActions()` (`components/workspace/WorkspaceActions.tsx`) instead of callback props. New entry points (status center, command palette) should use it too.
```

- [ ] **Step 2: Final verification and commit**

Run: `npx tsc --noEmit -p . && npx eslint . && npm test && npx playwright test && wc -l components/AppShell.tsx`
Expected: all green.

```bash
git add AGENTS.md
git commit -m "docs: document workspace panel modules and tab kind extension"
```
