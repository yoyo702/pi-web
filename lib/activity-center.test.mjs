import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { activityCenterSections, activitySummary, activityTotals, newNotifications, workspaceCloseWarning } = await jiti.import("./activity-center.ts");

const workspace = (id) => ({ id, projectRoot: id, cwd: id, label: id.slice(1), sessionId: null, lastActive: 0 });
const activity = (counts = {}) => {
  const value = { working: 0, approval: 0, failed: 0, completed: 0, items: [], ...counts };
  value.state = value.approval ? "approval" : value.failed ? "failed" : value.working ? "working" : value.completed ? "completed" : "idle";
  return value;
};
const workspaces = [workspace("/a"), workspace("/b"), workspace("/c"), workspace("/d")];

test("the current workspace comes first, even idle; other workspaces only when something is happening", () => {
  const byId = { "/a": activity({ working: 1 }), "/b": activity(), "/c": activity({ approval: 1 }), "/d": activity({ completed: 2 }) };
  const { current, others } = activityCenterSections(workspaces, "/b", byId);
  assert.equal(current.workspace.id, "/b");
  assert.equal(current.activity.state, "idle");
  assert.deepEqual(others.map((section) => section.workspace.id), ["/a", "/c", "/d"]);

  // Before the first computation every workspace is idle; with no active one there is no current section.
  const empty = activityCenterSections(workspaces, null, {});
  assert.equal(empty.current, null);
  assert.deepEqual(empty.others, []);
  assert.equal(activityCenterSections(workspaces, "/c", {}).current.activity.state, "idle");
});

test("summaries and totals count across workspaces", () => {
  assert.equal(activitySummary(activity({ approval: 1, failed: 2, working: 3, completed: 4 })), "1 waiting · 2 failed · 3 working · 4 completed");
  assert.equal(activitySummary(activity()), "");
  assert.deepEqual(activityTotals({ "/a": activity({ working: 2, completed: 1 }), "/b": activity({ approval: 1, failed: 1 }) }), { active: 3, approval: 1 });
  assert.deepEqual(activityTotals({}), { active: 0, approval: 0 });
});

test("only notifications that arrive after the first load are new, oldest first", () => {
  const log = [{ id: "3" }, { id: "2" }, { id: "1" }];
  assert.deepEqual(newNotifications(log, null), []);
  assert.deepEqual(newNotifications(log, new Set(["1"])).map((entry) => entry.id), ["2", "3"]);
  assert.deepEqual(newNotifications(log, new Set(["1", "2", "3"])), []);
});

test("closing a workspace warns about every busy terminal, chat and Pi session", () => {
  const item = (kind, state) => ({ key: `${kind}:${state}:${Math.random()}`, kind, id: "x", label: "x", state, cwd: "/a" });
  assert.equal(workspaceCloseWarning("acme", undefined), null);
  assert.equal(workspaceCloseWarning("acme", { items: [item("terminal", "completed"), item("codex", "failed")] }), null);
  assert.equal(workspaceCloseWarning("acme", { items: [item("terminal", "working")] }), "1 terminal is still running in acme. Close the workspace tab and keep it running?");
  assert.equal(
    workspaceCloseWarning("acme", { items: [item("terminal", "working"), item("terminal", "approval"), item("codex", "approval"), item("claude", "working")] }),
    "2 terminals and 2 chats are still running in acme (2 waiting for approval). Close the workspace tab and keep them running?",
  );
  assert.equal(
    workspaceCloseWarning("acme", { items: [item("claude", "approval"), item("pi", "working"), item("terminal", "working")] }),
    "1 terminal, 1 chat and 1 Pi session are still running in acme (1 waiting for approval). Close the workspace tab and keep them running?",
  );
});
