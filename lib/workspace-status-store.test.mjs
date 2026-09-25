import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createWorkspaceStatusStore, terminalsForCwd, terminalStatsForCwd } = await jiti.import("./workspace-status-store.ts");

const term = (id, cwd, extra = {}) => ({ id, cwd, provider: "shell", state: "running", bufferBytes: 10, ...extra });
const limits = { running: 20, records: 100 };

test("starts empty and applies known messages only", () => {
  const store = createWorkspaceStatusStore();
  assert.deepEqual(store.getSnapshot(), { runningSessionIds: null, terminals: null, terminalLimits: null, codexRuntimes: null, claudeRuntimes: null, notifications: null, unreadNotifications: 0 });
  store.apply({ type: "running", runningSessionIds: ["s1"] });
  store.apply({ type: "codex_runtimes", runtimes: [{ threadId: "t", cwd: "/a", state: "running" }] });
  store.apply({ type: "claude_runtimes", runtimes: [{ sessionId: "c", cwd: "/a", owner: "chat", state: "idle" }] });
  store.apply({ type: "terminals", terminals: [term("1", "/a")], limits });
  store.apply({ type: "session_event", sessionId: "s1", event: {} });
  store.apply("garbage");
  const snapshot = store.getSnapshot();
  assert.deepEqual(snapshot.runningSessionIds, ["s1"]);
  assert.equal(snapshot.codexRuntimes.length, 1);
  assert.equal(snapshot.claudeRuntimes[0].sessionId, "c");
  assert.equal(snapshot.terminals.length, 1);
  assert.deepEqual(snapshot.terminalLimits, limits);
});

test("notifies subscribers and keeps the snapshot identity when nothing changed", () => {
  const store = createWorkspaceStatusStore();
  let calls = 0;
  const unsubscribe = store.subscribe(() => { calls += 1; });
  store.apply({ type: "running", runningSessionIds: [] });
  const first = store.getSnapshot();
  assert.equal(calls, 1);
  assert.equal(store.getSnapshot(), first);
  unsubscribe();
  store.apply({ type: "running", runningSessionIds: ["x"] });
  assert.equal(calls, 1);
});

test("filters terminals and computes stats per cwd", () => {
  const store = createWorkspaceStatusStore();
  store.apply({ type: "terminals", terminals: [term("1", "/a"), term("2", "/a", { state: "ended", bufferBytes: 5 }), term("3", "/b")], limits });
  const snapshot = store.getSnapshot();
  assert.deepEqual(terminalsForCwd(snapshot, "/a").map((t) => t.id), ["1", "2"]);
  assert.deepEqual(terminalStatsForCwd(snapshot, "/a"), {
    workspace: { running: 1, records: 2, bufferBytes: 15 },
    global: { running: 2, records: 3, bufferBytes: 25 },
    limits,
  });
  assert.equal(terminalStatsForCwd(createWorkspaceStatusStore().getSnapshot(), "/a"), null);
});

test("per-cwd replacement and optimistic updates leave other cwds alone; pushes win", () => {
  const store = createWorkspaceStatusStore();
  store.apply({ type: "terminals", terminals: [term("1", "/a"), term("3", "/b")], limits });
  store.replaceTerminalsForCwd("/a", [term("9", "/a")], limits);
  assert.deepEqual(store.getSnapshot().terminals.map((t) => t.id).sort(), ["3", "9"]);
  store.updateTerminalsForCwd("/b", (current) => [...current, term("4", "/b")]);
  assert.deepEqual(terminalsForCwd(store.getSnapshot(), "/b").map((t) => t.id), ["3", "4"]);
  store.apply({ type: "terminals", terminals: [term("3", "/b")], limits });
  assert.deepEqual(store.getSnapshot().terminals.map((t) => t.id), ["3"]);
});

test("replacing before any push initializes the list", () => {
  const store = createWorkspaceStatusStore();
  store.replaceTerminalsForCwd("/a", [term("1", "/a")], null);
  assert.deepEqual(store.getSnapshot().terminals.map((t) => t.id), ["1"]);
});

test("applies notifications snapshots with their unread count", () => {
  const store = createWorkspaceStatusStore();
  const entry = { id: "n1", kind: "codex", event: "completed", targetId: "t", cwd: "/a", title: "Chat", createdAt: 1, read: false };
  store.apply({ type: "notifications", notifications: [entry], unread: 1 });
  assert.deepEqual(store.getSnapshot().notifications, [entry]);
  assert.equal(store.getSnapshot().unreadNotifications, 1);
  store.apply({ type: "notifications", notifications: "bad", unread: 0 });
  assert.equal(store.getSnapshot().unreadNotifications, 1);
  store.apply({ type: "notifications", notifications: [], unread: "x" });
  assert.deepEqual(store.getSnapshot().notifications, []);
  assert.equal(store.getSnapshot().unreadNotifications, 0);
});
