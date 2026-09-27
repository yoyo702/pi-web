import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { syncGitRemote } = await jiti.import("./git-changes.ts");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeOriginAndClone(t) {
  const origin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-sync-origin-")));
  git(origin, ["init", "-q", "-b", "main"]);
  git(origin, ["config", "user.email", "test@example.com"]);
  git(origin, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(origin, "tracked.txt"), "v1\n");
  git(origin, ["add", "."]);
  git(origin, ["commit", "-q", "-m", "init"]);

  const clone = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-sync-clone-")));
  execFileSync("git", ["clone", "-q", origin, clone], { encoding: "utf8" });
  git(clone, ["config", "user.email", "test@example.com"]);
  git(clone, ["config", "user.name", "Test"]);

  t.after(() => {
    fs.rmSync(origin, { recursive: true, force: true });
    fs.rmSync(clone, { recursive: true, force: true });
  });
  return { origin, clone };
}

function commitToOrigin(origin, fileName, content) {
  fs.writeFileSync(path.join(origin, fileName), content);
  git(origin, ["add", fileName]);
  git(origin, ["commit", "-q", "-m", `update ${fileName}`]);
}

test("pull fast-forwards when the clone has no local changes", async (t) => {
  const { origin, clone } = makeOriginAndClone(t);
  commitToOrigin(origin, "tracked.txt", "v2\n");
  await syncGitRemote(clone, "pull");
  assert.equal(fs.readFileSync(path.join(clone, "tracked.txt"), "utf8"), "v2\n");
});

test("pull no longer blocks on unrelated uncommitted changes to tracked files", async (t) => {
  const { origin, clone } = makeOriginAndClone(t);
  commitToOrigin(origin, "other.txt", "new file\n");
  // The old code blocked ANY uncommitted change; this edits a file pull never touches.
  fs.writeFileSync(path.join(clone, "tracked.txt"), "locally edited, unrelated to the incoming change\n");
  await syncGitRemote(clone, "pull");
  assert.equal(fs.readFileSync(path.join(clone, "other.txt"), "utf8"), "new file\n");
  assert.equal(fs.readFileSync(path.join(clone, "tracked.txt"), "utf8"), "locally edited, unrelated to the incoming change\n");
});

test("pull is refused with a 409 when an untracked file would be overwritten", async (t) => {
  const { origin, clone } = makeOriginAndClone(t);
  commitToOrigin(origin, "incoming.txt", "from origin\n");
  fs.writeFileSync(path.join(clone, "incoming.txt"), "local untracked copy\n");
  await assert.rejects(syncGitRemote(clone, "pull"), (error) => {
    assert.equal(error.status, 409);
    assert.match(error.message, /incoming\.txt/);
    return true;
  });
  assert.equal(fs.readFileSync(path.join(clone, "incoming.txt"), "utf8"), "local untracked copy\n");
});

test("pull maps a diverged branch to 409", async (t) => {
  const { origin, clone } = makeOriginAndClone(t);
  commitToOrigin(origin, "tracked.txt", "v2 from origin\n");
  fs.writeFileSync(path.join(clone, "local.txt"), "local commit\n");
  git(clone, ["add", "."]);
  git(clone, ["commit", "-q", "-m", "local"]);
  await assert.rejects(syncGitRemote(clone, "pull"), (error) => {
    assert.equal(error.status, 409);
    assert.match(error.message, /fast-forward/i);
    return true;
  });
});

test("pull maps a remote/network failure to 502 with git's message", async (t) => {
  const { origin, clone } = makeOriginAndClone(t);
  git(clone, ["fetch", "-q"]);
  fs.rmSync(origin, { recursive: true, force: true });
  await assert.rejects(syncGitRemote(clone, "pull"), (error) => {
    assert.equal(error.status, 502);
    assert.match(error.message, /repository|remote/i);
    return true;
  });
});
