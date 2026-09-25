import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { notificationAge, notificationTarget, notificationWorkspace } = await jiti.import("./activity-notifications.ts");
const { piRunOutcome, piSessionTitle } = await jiti.import("./pi-notification.ts");

const workspaces = [
  { id: "/repo/a", projectRoot: "/repo/a", cwd: "/repo/a", label: "a", sessionId: null, lastActive: 1 },
  { id: "/repo/a/wt", projectRoot: "/repo/a", cwd: "/repo/a/wt", label: "a/wt", sessionId: null, lastActive: 0 },
];
const notification = (extra = {}) => ({ id: "n", kind: "codex", event: "completed", targetId: "t", cwd: "/repo/a", title: "Chat", createdAt: 0, read: false, ...extra });

test("a notification belongs to its cwd's workspace, else its project root's", () => {
  assert.equal(notificationWorkspace(notification({ cwd: "/repo/a/wt" }), workspaces).id, "/repo/a/wt");
  assert.equal(notificationWorkspace(notification({ cwd: "/repo/a/other", projectRoot: "/repo/a" }), workspaces).id, "/repo/a");
  assert.equal(notificationWorkspace(notification({ cwd: "/elsewhere" }), workspaces), null);
});

test("notification targets open the session, terminal or chat", () => {
  assert.deepEqual(notificationTarget(notification({ kind: "terminal" })), { kind: "terminal", id: "t", cwd: "/repo/a" });
  const pi = notificationTarget(notification({ kind: "pi", path: "/s/t.jsonl", projectRoot: "/repo" }));
  assert.equal(pi.kind, "pi");
  assert.deepEqual([pi.session.path, pi.session.id, pi.session.cwd, pi.session.projectRoot, pi.session.firstMessage], ["/s/t.jsonl", "t", "/repo/a", "/repo", "Chat"]);
});

test("notification ages are short relative times", () => {
  const now = 10 * 24 * 60 * 60 * 1000;
  assert.equal(notificationAge(now - 30_000, now), "just now");
  assert.equal(notificationAge(now - 5 * 60_000, now), "5m ago");
  assert.equal(notificationAge(now - 3 * 60 * 60_000, now), "3h ago");
  assert.equal(notificationAge(now - 2 * 24 * 60 * 60_000, now), "2d ago");
  assert.equal(notificationAge(now + 60_000, now), "just now");
});

test("a Pi run is completed, failed with its error, or skipped when aborted", () => {
  assert.deepEqual(piRunOutcome([{ role: "user" }, { role: "assistant", stopReason: "stop" }]), { event: "completed" });
  assert.deepEqual(piRunOutcome([{ role: "assistant", stopReason: "error", errorMessage: "429 rate limited" }]), { event: "failed", detail: "429 rate limited" });
  assert.deepEqual(piRunOutcome([{ role: "assistant", stopReason: "error" }]), { event: "failed", detail: "The model request failed" });
  assert.equal(piRunOutcome([{ role: "assistant", stopReason: "aborted" }, { role: "user" }]), null);
  assert.deepEqual(piRunOutcome(undefined), { event: "completed" });
});

test("a Pi session title is its name, else its first user message", () => {
  const entries = [
    { type: "session" },
    { type: "message", message: { role: "assistant", content: "hi" } },
    { type: "message", message: { role: "user", content: [{ type: "image" }, { type: "text", text: " Fix\n the build " }] } },
  ];
  assert.equal(piSessionTitle(" Release ", entries), "Release");
  assert.equal(piSessionTitle(undefined, entries), "Fix the build");
  assert.equal(piSessionTitle("", []), "Pi session");
});
