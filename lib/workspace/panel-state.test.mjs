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

test("opening a session chat reuses the tab of a new chat that created it", () => {
  let state = centerReducer(initialCenterState(), { type: "open", tab: { id: "codex-chat:new-1", label: "hello", kind: "codex-chat", cwd: "/a", sourceSessionId: "s1" } });
  state = centerReducer(state, { type: "open", tab: term("t1") });
  state = centerReducer(state, { type: "open", tab: { id: "codex-chat:s1", label: "Chat", kind: "codex-chat", cwd: "/a", sourceSessionId: "s1" }, mergeExisting: { sessionName: "Chat" } });
  assert.deepEqual(state.tabs.map((tab) => tab.id), ["pi", "codex-chat:new-1", "terminal:t1"]);
  assert.equal(state.activeId, "codex-chat:new-1");
  assert.equal(state.tabs[1].sessionName, "Chat");
  // A terminal's chat for the same session keeps its own tab.
  state = centerReducer(state, { type: "open", tab: { id: "codex-chat:t2", label: "Codex Chat", kind: "codex-chat", terminalId: "t2", sourceSessionId: "s1" } });
  assert.equal(state.tabs.length, 4);
  // Two tabs already on one session: the tab with the opened id is used.
  state = centerReducer(state, { type: "open", tab: { id: "codex-chat:s2", label: "b", kind: "codex-chat", cwd: "/a", sourceSessionId: "s2" } });
  state = centerReducer(state, { type: "open", tab: { id: "codex-chat:new-2", label: "a", kind: "codex-chat", cwd: "/a", newChat: true } });
  state = centerReducer(state, { type: "update", update: (tab) => tab.id === "codex-chat:new-2" ? { ...tab, sourceSessionId: "s2", newChat: false } : tab });
  state = centerReducer(state, { type: "open", tab: { id: "codex-chat:s2", label: "b", kind: "codex-chat", cwd: "/a", sourceSessionId: "s2" } });
  assert.equal(state.activeId, "codex-chat:s2");
  assert.equal(state.tabs.length, 6);
});

test("removing the active tab activates its left neighbour, else right, else pi", () => {
  let state = withTabs("t1", "t2", "t3");
  state = centerReducer(state, { type: "activate", id: "terminal:t2" });
  state = centerReducer(state, { type: "remove", id: "terminal:t2" });
  assert.equal(state.activeId, "terminal:t1");
  assert.ok(!state.mountedIds.includes("terminal:t2"));
  assert.equal(centerReducer(state, { type: "remove", id: "pi" }), state);
});

test("removing the active tab mounts the fallback tab", () => {
  const hydrated = { tabs: [...withTabs("t1", "t2", "t3").tabs], activeId: "terminal:t2", mountedIds: ["pi"], split: null };
  let state = centerReducer(initialCenterState(), { type: "hydrate", state: hydrated });
  state = centerReducer(state, { type: "remove", id: "terminal:t2" });
  assert.equal(state.activeId, "terminal:t1");
  assert.ok(state.mountedIds.includes(state.activeId));
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

test("hydrate resets mountedIds to pi plus the active tab", () => {
  const hydrated = { tabs: [...withTabs("t1", "t2").tabs], activeId: "terminal:t2", mountedIds: ["pi", "terminal:t1", "terminal:t2"], split: null };
  const state = centerReducer(initialCenterState(), { type: "hydrate", state: hydrated });
  assert.deepEqual(state.mountedIds, ["pi", "terminal:t2"]);
});

test("hydrate with pi active keeps mountedIds to just pi", () => {
  const hydrated = { tabs: [...withTabs("t1").tabs], activeId: "pi", mountedIds: ["pi", "terminal:t1"], split: null };
  const state = centerReducer(initialCenterState(), { type: "hydrate", state: hydrated });
  assert.deepEqual(state.mountedIds, ["pi"]);
});

test("activate mounts the tab", () => {
  let state = withTabs("t1", "t2");
  state = { ...state, mountedIds: ["pi", "terminal:t1"] };
  state = centerReducer(state, { type: "activate", id: "terminal:t2" });
  assert.equal(state.activeId, "terminal:t2");
  assert.deepEqual(state.mountedIds, ["pi", "terminal:t1", "terminal:t2"]);
});

test("setSplit accepts a function updater", () => {
  let state = withTabs("t1", "t2");
  const split = { primaryTabId: "terminal:t1", secondaryTerminalId: "t2", direction: "horizontal", ratio: 50, reversed: false };
  state = centerReducer(state, { type: "setSplit", split });
  state = centerReducer(state, { type: "setSplit", split: (current) => current ? { ...current, reversed: !current.reversed, ratio: 100 - current.ratio } : null });
  assert.equal(state.split.reversed, true);
  assert.equal(state.split.ratio, 50);
});

test("setSplit returns the same state object when the split is unchanged", () => {
  let state = withTabs("t1", "t2");
  const split = { primaryTabId: "terminal:t1", secondaryTerminalId: "t2", direction: "horizontal", ratio: 50, reversed: false };
  state = centerReducer(state, { type: "setSplit", split });
  const unchanged = centerReducer(state, { type: "setSplit", split: state.split });
  assert.equal(unchanged, state);
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

test("openGitReview twice keeps a single git tab", () => {
  let state = sideReducer(initialSideState(), { type: "openGitReview" });
  state = sideReducer(state, { type: "openGitReview" });
  assert.equal(state.tabs.filter((tab) => tab.kind === "git").length, 1);
  assert.equal(state.activeId, "git-review");
  assert.equal(state.open, true);
});

test("pathRenamed of a directory does not touch a sibling with a shared prefix", () => {
  let state = open(initialSideState(), "/a/dir2/x.ts");
  state = sideReducer(state, { type: "pathRenamed", oldPath: "/a/dir", newPath: "/a/moved", isDir: true });
  assert.equal(state.tabs[0].id, "file:/a/dir2/x.ts");
  assert.equal(state.tabs[0].filePath, "/a/dir2/x.ts");
});

test("close returns the same state object when nothing can be removed", () => {
  let state = open(initialSideState(), "/a/x.ts");
  state = sideReducer(state, { type: "toggleLock", id: "file:/a/x.ts" });
  const afterLocked = sideReducer(state, { type: "close", ids: ["file:/a/x.ts"] });
  assert.equal(afterLocked, state);
  const afterUnknown = sideReducer(state, { type: "close", ids: ["file:/does-not-exist.ts"] });
  assert.equal(afterUnknown, state);
});

test("a Claude chat reuses its session tab but never a Codex tab of the same id", () => {
  let state = centerReducer(initialCenterState(), { type: "open", tab: { id: "claude-chat:new-1", label: "hi", kind: "claude-chat", cwd: "/a", newChat: true } });
  state = centerReducer(state, { type: "update", update: (tab) => tab.id === "claude-chat:new-1" ? { ...tab, sourceSessionId: "s1", newChat: false } : tab });
  state = centerReducer(state, { type: "open", tab: { id: "codex-chat:s1", label: "codex", kind: "codex-chat", cwd: "/a", sourceSessionId: "s1" } });
  state = centerReducer(state, { type: "open", tab: { id: "claude-chat:s1", label: "Claude", kind: "claude-chat", cwd: "/a", sourceSessionId: "s1" }, mergeExisting: { sessionName: "Claude" } });
  assert.deepEqual(state.tabs.map((tab) => tab.id), ["pi", "claude-chat:new-1", "codex-chat:s1"]);
  assert.equal(state.activeId, "claude-chat:new-1");
  assert.equal(state.tabs[1].sessionName, "Claude");
});
