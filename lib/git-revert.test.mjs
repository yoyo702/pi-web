import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { revertCommit } = await jiti.import("./git-changes.ts");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepo(t) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-revert-")));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  return repo;
}

test("reverts a clean commit and creates a new commit undoing it", async (t) => {
  const repo = makeRepo(t);
  fs.writeFileSync(path.join(repo, "a.txt"), "v1\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "add a.txt"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "v2\n");
  git(repo, ["commit", "-q", "-am", "update a.txt"]);
  const target = git(repo, ["rev-parse", "HEAD"]).trim();

  const status = await revertCommit(repo, target);

  assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "v1\n");
  assert.equal(status.files.length, 0);
  assert.match(git(repo, ["log", "--format=%s", "-3"]), /^Revert "update a\.txt"/m);
});

test("rejects an invalid commit hash without running git", async (t) => {
  const repo = makeRepo(t);
  await assert.rejects(revertCommit(repo, "not-a-hash"), { status: 400 });
});

test("a conflicting revert is aborted cleanly and returns 409", async (t) => {
  const repo = makeRepo(t);
  fs.writeFileSync(path.join(repo, "a.txt"), "base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "base"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "changed by commit 2\n");
  git(repo, ["commit", "-q", "-am", "change 2"]);
  const change2 = git(repo, ["rev-parse", "HEAD"]).trim();
  fs.writeFileSync(path.join(repo, "a.txt"), "changed again by commit 3, touching the same line\n");
  git(repo, ["commit", "-q", "-am", "change 3"]);

  await assert.rejects(revertCommit(repo, change2), (error) => {
    assert.equal(error.status, 409);
    assert.match(error.message, /revert/i);
    return true;
  });

  assert.equal(git(repo, ["status", "--porcelain=v1"]).trim(), "");
  assert.equal(fs.existsSync(path.join(repo, ".git", "REVERT_HEAD")), false);
});

test("refuses with 409 and leaves an in-progress revert untouched", async (t) => {
  const repo = makeRepo(t);
  fs.writeFileSync(path.join(repo, "a.txt"), "base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "base"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "changed by commit 2\n");
  git(repo, ["commit", "-q", "-am", "change 2"]);
  const change2 = git(repo, ["rev-parse", "HEAD"]).trim();
  fs.writeFileSync(path.join(repo, "a.txt"), "changed again by commit 3\n");
  git(repo, ["commit", "-q", "-am", "change 3"]);
  fs.writeFileSync(path.join(repo, "b.txt"), "b\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "add b"]);
  const addB = git(repo, ["rev-parse", "HEAD"]).trim();
  // The user starts a conflicting revert on the CLI and partially resolves it.
  assert.throws(() => execFileSync("git", ["revert", "--no-edit", change2], { cwd: repo, stdio: "pipe" }));
  fs.writeFileSync(path.join(repo, "a.txt"), "resolved\n");

  await assert.rejects(revertCommit(repo, addB), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.message, "Another git operation is in progress");
    return true;
  });

  assert.equal(fs.existsSync(path.join(repo, ".git", "REVERT_HEAD")), true);
  assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "resolved\n");
  assert.equal(fs.existsSync(path.join(repo, "b.txt")), true);
});

test("refuses with 409 while a cherry-pick is in progress", async (t) => {
  const repo = makeRepo(t);
  fs.writeFileSync(path.join(repo, "a.txt"), "base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "base"]);
  const base = git(repo, ["rev-parse", "HEAD"]).trim();
  git(repo, ["switch", "-q", "-c", "side"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "side\n");
  git(repo, ["commit", "-q", "-am", "side"]);
  const side = git(repo, ["rev-parse", "HEAD"]).trim();
  git(repo, ["switch", "-q", "main"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "main\n");
  git(repo, ["commit", "-q", "-am", "main"]);
  assert.throws(() => execFileSync("git", ["cherry-pick", side], { cwd: repo, stdio: "pipe" }));

  await assert.rejects(revertCommit(repo, base), { status: 409, message: "Another git operation is in progress" });
  assert.equal(fs.existsSync(path.join(repo, ".git", "CHERRY_PICK_HEAD")), true);
});

test("refuses to revert a merge commit with a 400", async (t) => {
  const repo = makeRepo(t);
  fs.writeFileSync(path.join(repo, "a.txt"), "base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "base"]);
  git(repo, ["switch", "-q", "-c", "side"]);
  fs.writeFileSync(path.join(repo, "b.txt"), "side\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "side"]);
  git(repo, ["switch", "-q", "main"]);
  fs.writeFileSync(path.join(repo, "c.txt"), "main\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "main"]);
  git(repo, ["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
  const merge = git(repo, ["rev-parse", "HEAD"]).trim();

  await assert.rejects(revertCommit(repo, merge), { status: 400, message: "Reverting merge commits is not supported" });
  assert.equal(git(repo, ["rev-parse", "HEAD"]).trim(), merge);
});

test("works in a linked worktree (operation markers resolved via --git-path)", async (t) => {
  const repo = makeRepo(t);
  fs.writeFileSync(path.join(repo, "a.txt"), "v1\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "v1"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "v2\n");
  git(repo, ["commit", "-q", "-am", "v2"]);
  const target = git(repo, ["rev-parse", "HEAD"]).trim();
  const worktree = `${repo}-wt`;
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  git(repo, ["worktree", "add", "-q", worktree]);

  await revertCommit(worktree, target);
  assert.equal(fs.readFileSync(path.join(worktree, "a.txt"), "utf8"), "v1\n");
});
