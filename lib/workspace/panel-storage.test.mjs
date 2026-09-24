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
