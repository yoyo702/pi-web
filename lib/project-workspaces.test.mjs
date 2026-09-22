import assert from "node:assert/strict";
import test from "node:test";
import { parseProjectWorkspaceSnapshot, parseRecentProjects, projectLabel, recoverProjectWorkspaceSnapshot, updateRecentProjects, upsertProjectWorkspace } from "./project-workspaces.ts";

test("derives compact project labels", () => {
  assert.equal(projectLabel("/Users/test/project/pi-web/"), "pi-web");
  assert.equal(projectLabel("C:\\work\\pivot-ui"), "pivot-ui");
});

test("upserts and promotes a project without duplicating it", () => {
  const first = upsertProjectWorkspace([], { projectRoot: "/repo", cwd: "/repo", sessionId: "one", lastActive: 1 });
  const next = upsertProjectWorkspace(first, { projectRoot: "/repo", cwd: "/repo-worktrees/feature", sessionId: "two", lastActive: 2 });
  assert.equal(next.length, 1);
  assert.equal(next[0].cwd, "/repo-worktrees/feature");
  assert.equal(next[0].sessionId, "two");
});

test("keeps Chrome-like tab order when activating a project", () => {
  const workspaces = upsertProjectWorkspace(
    upsertProjectWorkspace([], { projectRoot: "/a", cwd: "/a", lastActive: 1 }),
    { projectRoot: "/b", cwd: "/b", lastActive: 2 },
  );
  const activated = upsertProjectWorkspace(workspaces, { projectRoot: "/a", cwd: "/a", lastActive: 3 });
  assert.deepEqual(activated.map((workspace) => workspace.id), ["/a", "/b"]);
});

test("ignores malformed persisted workspaces", () => {
  assert.deepEqual(parseProjectWorkspaceSnapshot("not-json"), { workspaces: [], activeId: null });
  const parsed = parseProjectWorkspaceSnapshot(JSON.stringify({ workspaces: [{ projectRoot: "/repo", cwd: "/repo", sessionId: "s" }, { cwd: "/bad" }], activeId: "/repo" }));
  assert.equal(parsed.workspaces.length, 1);
  assert.equal(parsed.activeId, "/repo");
  assert.equal(parsed.workspaces[0].pinned, false);
});

test("preserves pinned projects and keeps recent projects unique", () => {
  const pinned = upsertProjectWorkspace([], { projectRoot: "/repo", cwd: "/repo", pinned: true });
  assert.equal(pinned[0].pinned, true);
  assert.equal(upsertProjectWorkspace(pinned, { projectRoot: "/repo", cwd: "/repo" })[0].pinned, true);
  const recent = updateRecentProjects(updateRecentProjects([], "/a", "A", 1), "/a", "Renamed", 2);
  assert.deepEqual(recent, [{ path: "/a", label: "Renamed", lastOpened: 2 }]);
  assert.deepEqual(parseRecentProjects(JSON.stringify(recent)), recent);
});

test("recovers one workspace per project from the newest server session", () => {
  const recovered = recoverProjectWorkspaceSnapshot([
    { id: "older", cwd: "/repo-worktrees/old", projectRoot: "/repo", modified: "2026-01-01T00:00:00.000Z" },
    { id: "other", cwd: "/other", projectRoot: "/other", modified: "2026-02-01T00:00:00.000Z" },
    { id: "newer", cwd: "/repo-worktrees/new", projectRoot: "/repo", modified: "2026-03-01T00:00:00.000Z" },
  ]);

  assert.deepEqual(recovered.workspaces.map((workspace) => workspace.id), ["/repo", "/other"]);
  assert.equal(recovered.activeId, "/repo");
  assert.equal(recovered.workspaces[0].cwd, "/repo-worktrees/new");
  assert.equal(recovered.workspaces[0].sessionId, "newer");
});

test("recovers an empty snapshot when the server has no sessions", () => {
  assert.deepEqual(recoverProjectWorkspaceSnapshot([]), { workspaces: [], activeId: null });
});
