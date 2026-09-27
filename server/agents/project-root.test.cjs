"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { resolveProjectRoot, _resetForTests } = require("./project-root.cjs");

function initRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-project-root-")));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

test("resolveProjectRoot returns the main checkout for a linked worktree", async () => {
  _resetForTests();
  const main = initRepo();
  const worktreeDir = path.join(os.tmpdir(), `pi-web-project-root-wt-${Date.now()}`);
  execFileSync("git", ["worktree", "add", "-b", "feature/x", worktreeDir], { cwd: main });
  try {
    const root = await resolveProjectRoot(fs.realpathSync(worktreeDir));
    assert.equal(root, main);
    assert.equal(await resolveProjectRoot(main), main);
  } finally {
    execFileSync("git", ["worktree", "remove", "--force", worktreeDir], { cwd: main });
  }
});

test("resolveProjectRoot returns the cwd itself for a non-git directory", async () => {
  _resetForTests();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-project-root-plain-")));
  assert.equal(await resolveProjectRoot(dir), dir);
});

test("resolveProjectRoot caches results for repeated calls", async () => {
  _resetForTests();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-project-root-cache-")));
  const first = await resolveProjectRoot(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  const second = await resolveProjectRoot(dir);
  assert.equal(second, first);
});

test("resolveProjectRoot caps the cache size, dropping the oldest entry first", async () => {
  _resetForTests();
  const limit = 500;
  // Nonexistent paths short-circuit before the git spawn (existsSync is
  // false), so this stays fast while still exercising the cache's set path.
  for (let i = 0; i < limit + 5; i++) {
    await resolveProjectRoot(`/nonexistent/pi-web-project-root-cap-${i}`);
  }
  const cache = global.__piWebProjectRootCache;
  assert.equal(cache.size, limit);
  assert.equal(cache.has("/nonexistent/pi-web-project-root-cap-0"), false);
  assert.equal(cache.has("/nonexistent/pi-web-project-root-cap-4"), false);
  assert.equal(cache.has(`/nonexistent/pi-web-project-root-cap-${limit + 4}`), true);
});

test("attachProjectRoot sets the cwd immediately, then the resolved root", async () => {
  _resetForTests();
  const { attachProjectRoot } = require("./project-root.cjs");
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-project-root-attach-")));
  const state = {};
  attachProjectRoot(state, dir);
  assert.equal(state.projectRoot, dir);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(state.projectRoot, dir);
});
