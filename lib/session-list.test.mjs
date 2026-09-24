import test from "node:test";
import assert from "node:assert/strict";
import { getSessionDisplayTitle, resolveSessionLineage, sortSessionsByRecent } from "./session-list.ts";

function session(id, modified, parentSessionId, name) {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    cwd: "/workspace",
    created: modified,
    modified,
    messageCount: 1,
    firstMessage: `message ${id}`,
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(name ? { name } : {}),
  };
}

test("sorts the flat session list by latest activity with deterministic ties", () => {
  const sessions = [
    session("b", "2026-09-23T08:00:00.000Z"),
    session("c", "2026-09-23T09:00:00.000Z"),
    session("a", "2026-09-23T08:00:00.000Z"),
  ];
  assert.deepEqual(sortSessionsByRecent(sessions).map((item) => item.id), ["c", "a", "b"]);
  assert.deepEqual(sessions.map((item) => item.id), ["b", "c", "a"]);
});

test("resolves both the direct fork source and the original root", () => {
  const root = session("root", "2026-09-20T08:00:00.000Z", undefined, "Original task");
  const child = session("child", "2026-09-21T08:00:00.000Z", "root", "First fork");
  const leaf = session("leaf", "2026-09-22T08:00:00.000Z", "child", "Second fork");
  const lineage = resolveSessionLineage(leaf, [leaf, root, child]);
  assert.equal(lineage.parent?.id, "child");
  assert.equal(lineage.root.id, "root");
  assert.equal(lineage.depth, 2);
  assert.equal(lineage.missingParent, false);
  assert.equal(lineage.lineageComplete, true);
});

test("keeps a fork visible when its parent session is unavailable", () => {
  const fork = session("fork", "2026-09-22T08:00:00.000Z", "deleted-parent");
  const lineage = resolveSessionLineage(fork, [fork]);
  assert.equal(lineage.isFork, true);
  assert.equal(lineage.parent, null);
  assert.equal(lineage.missingParent, true);
  assert.equal(lineage.lineageComplete, false);
});

test("marks a lineage incomplete when an older ancestor is unavailable", () => {
  const child = session("child", "2026-09-21T08:00:00.000Z", "missing-root", "Available parent");
  const leaf = session("leaf", "2026-09-22T08:00:00.000Z", "child", "Fork");
  const lineage = resolveSessionLineage(leaf, [leaf, child]);
  assert.equal(lineage.parent?.id, "child");
  assert.equal(lineage.root.id, "child");
  assert.equal(lineage.missingParent, false);
  assert.equal(lineage.lineageComplete, false);
});

test("uses the explicit name before message and id fallbacks", () => {
  assert.equal(getSessionDisplayTitle(session("named", "2026-09-22T08:00:00.000Z", undefined, "Named session")), "Named session");
  assert.equal(getSessionDisplayTitle(session("plain", "2026-09-22T08:00:00.000Z")), "message plain");
});
