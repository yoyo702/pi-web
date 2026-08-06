import assert from "node:assert/strict";
import test from "node:test";
import { parseProjectWorkspaceSnapshot, parseRecentProjects, projectLabel, updateRecentProjects, upsertProjectWorkspace } from "./project-workspaces.ts";

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
