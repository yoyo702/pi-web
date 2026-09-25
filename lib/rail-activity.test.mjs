import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  activityTarget,
  computeRailActivity,
  groupRailActivity,
  sessionActivityLabel,
  terminalActivityLabel,
  RECENTLY_COMPLETED_MS,
  ENDED_TERMINAL_MS,
} = await jiti.import("./rail-activity.ts");

const NOW = Date.parse("2026-09-24T12:00:00.000Z");
const terminal = (id, overrides = {}) => ({
  id, title: `Terminal ${id}`, provider: "shell", state: "running", exitCode: null, cwd: "/repo/a",
  pid: 1, permissionMode: "confirm", launchMode: "new", noAltScreen: false, cols: 80, rows: 24,
  createdAt: "2026-09-24T11:00:00.000Z", endedAt: null, signal: null, bufferBytes: 0, bufferTruncated: false, history: [],
  ...overrides,
});
const session = (id, overrides = {}) => ({
  id, path: `/sessions/${id}.jsonl`, cwd: "/repo/a/worktree", projectRoot: "/repo/a", created: "", modified: "", messageCount: 1, firstMessage: "Fix the flaky test", ...overrides,
});
const workspaces = [
  { id: "/repo/a", projectRoot: "/repo/a", cwd: "/repo/a", label: "a", sessionId: null, lastActive: 1 },
  { id: "/repo/b", projectRoot: "/repo/b", cwd: "/repo/b", label: "b", sessionId: null, lastActive: 0 },
];
const empty = { terminals: [], runningSessionIds: [], codexRuntimes: [], sessionsById: new Map(), previousRunning: null, completed: new Map(), now: NOW };

test("lists running terminals, sessions, and Codex runtimes as items on their workspace", () => {
  const result = computeRailActivity({
    ...empty,
    terminals: [terminal("t1", { title: "Dev server" })],
    runningSessionIds: ["s1", "unknown"],
    sessionsById: new Map([["s1", session("s1", { name: "Refactor rail" })]]),
    codexRuntimes: [
      { threadId: "0123456789abcdef", cwd: "/repo/b", state: "approval" },
      { threadId: "fedcba9876543210", cwd: "/repo/b", state: "running" },
      { threadId: "idle-thread", cwd: "/repo/b", state: "idle" },
    ],
  });
  const grouped = groupRailActivity(result.items, workspaces);
  assert.deepEqual(grouped["/repo/a"].items.map((item) => [item.kind, item.label, item.state]), [
    ["terminal", "Dev server", "working"],
    ["pi", "Refactor rail", "working"],
  ]);
  assert.equal(grouped["/repo/a"].working, 2);
  assert.equal(grouped["/repo/a"].state, "working");
  assert.deepEqual(grouped["/repo/b"].items.map((item) => [item.kind, item.label, item.state]), [
    ["codex", "Codex chat · 01234567", "approval"],
    ["codex", "Codex chat · fedcba98", "working"],
  ]);
  assert.equal(grouped["/repo/b"].state, "approval");
  assert.equal(grouped["/repo/b"].approval, 1);
  assert.equal(result.nextExpiry, Infinity);
});

test("keeps finished items listed and openable for the recently-completed window", () => {
  const first = computeRailActivity({
    ...empty,
    runningSessionIds: ["s1"],
    sessionsById: new Map([["s1", session("s1")]]),
    codexRuntimes: [{ threadId: "thread-1", cwd: "/repo/a", state: "running" }],
  });
  const second = computeRailActivity({
    ...empty,
    sessionsById: new Map([["s1", session("s1")]]),
    codexRuntimes: [{ threadId: "thread-1", cwd: "/repo/a", state: "idle" }],
    previousRunning: first.running,
    completed: first.completed,
  });
  const activity = groupRailActivity(second.items, workspaces)["/repo/a"];
  assert.deepEqual(activity.items.map((item) => [item.key, item.state]), [["pi:s1", "completed"], ["codex:thread-1", "completed"]]);
  assert.equal(activity.items[0].label, "Fix the flaky test");
  assert.equal(activity.items[0].session.id, "s1");
  assert.equal(activity.items[1].runtime.state, "idle");
  assert.equal(activity.completed, 2);
  assert.equal(activity.state, "completed");
  assert.equal(second.nextExpiry, NOW + RECENTLY_COMPLETED_MS);

  // Still listed while the window lasts, gone once it lapses.
  const later = computeRailActivity({ ...empty, previousRunning: second.running, completed: second.completed, now: NOW + RECENTLY_COMPLETED_MS - 1 });
  assert.equal(later.items.length, 2);
  const expired = computeRailActivity({ ...empty, previousRunning: later.running, completed: later.completed, now: NOW + RECENTLY_COMPLETED_MS });
  assert.equal(expired.items.length, 0);
  assert.equal(expired.nextExpiry, Infinity);
});

test("drops a completed entry when the same item starts running again", () => {
  const first = computeRailActivity({ ...empty, runningSessionIds: ["s1"], sessionsById: new Map([["s1", session("s1")]]) });
  const stopped = computeRailActivity({ ...empty, sessionsById: new Map([["s1", session("s1")]]), previousRunning: first.running });
  assert.equal(stopped.items[0].state, "completed");
  const restarted = computeRailActivity({ ...empty, runningSessionIds: ["s1"], sessionsById: new Map([["s1", session("s1")]]), previousRunning: stopped.running, completed: stopped.completed });
  assert.deepEqual(restarted.items.map((item) => [item.key, item.state]), [["pi:s1", "working"]]);
});

test("reports an ended terminal once, as failed or completed from its exit code", () => {
  const first = computeRailActivity({ ...empty, terminals: [terminal("ok"), terminal("bad")] });
  const endedAt = new Date(NOW).toISOString();
  const second = computeRailActivity({
    ...empty,
    terminals: [terminal("ok", { state: "ended", exitCode: 0, endedAt }), terminal("bad", { state: "ended", exitCode: 2, endedAt })],
    previousRunning: first.running,
    completed: first.completed,
  });
  const activity = groupRailActivity(second.items, workspaces)["/repo/a"];
  assert.deepEqual(activity.items.map((item) => [item.key, item.state]), [["terminal:bad", "failed"], ["terminal:ok", "completed"]]);
  assert.equal(activity.failed, 1);
  assert.equal(activity.completed, 1);
  assert.equal(activity.state, "failed");

  const old = computeRailActivity({ ...empty, terminals: [terminal("old", { state: "ended", exitCode: 1, endedAt: new Date(NOW - ENDED_TERMINAL_MS - 1).toISOString() })] });
  assert.equal(old.items.length, 0);
});

test("labels fall back like the workspace tabs and session list", () => {
  assert.equal(terminalActivityLabel({ title: "", provider: "shell" }), "Terminal");
  assert.equal(terminalActivityLabel({ provider: "codex" }), "codex terminal");
  assert.equal(sessionActivityLabel({ id: "abcdef123456", firstMessage: "" }), "abcdef12");
  assert.equal(sessionActivityLabel({ id: "x", name: "  ", firstMessage: "multi\nline   prompt" }), "multi line prompt");
});

test("activityTarget carries what the opener needs for each kind", () => {
  const result = computeRailActivity({
    ...empty,
    terminals: [terminal("t1")],
    runningSessionIds: ["s1"],
    sessionsById: new Map([["s1", session("s1")]]),
    codexRuntimes: [{ threadId: "th", cwd: "/repo/b", state: "running" }],
  });
  const targets = Object.fromEntries(result.items.map((item) => [item.kind, activityTarget(item)]));
  assert.deepEqual(targets.terminal, { kind: "terminal", id: "t1", cwd: "/repo/a" });
  assert.deepEqual(targets.codex, { kind: "codex", id: "th", cwd: "/repo/b" });
  assert.equal(targets.pi.session.path, "/sessions/s1.jsonl");
});
