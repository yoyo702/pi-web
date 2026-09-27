import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { getGitLog, isHeadPushed } = await jiti.import("./git-changes.ts");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeBareRemoteAndClone(t) {
  const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-pushed-bare-")));
  git(bare, ["init", "-q", "--bare", "-b", "main"]);
  const clone = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-pushed-clone-")));
  git(clone, ["init", "-q", "-b", "main"]);
  git(clone, ["config", "user.email", "test@example.com"]);
  git(clone, ["config", "user.name", "Test"]);
  git(clone, ["remote", "add", "origin", bare]);
  t.after(() => {
    fs.rmSync(bare, { recursive: true, force: true });
    fs.rmSync(clone, { recursive: true, force: true });
  });
  return { bare, clone };
}

function commit(cwd, fileName, content) {
  fs.writeFileSync(path.join(cwd, fileName), content);
  git(cwd, ["add", fileName]);
  git(cwd, ["commit", "-q", "-m", `update ${fileName}`]);
}

test("HEAD without an upstream is not pushed", async (t) => {
  const { clone } = makeBareRemoteAndClone(t);
  commit(clone, "a.txt", "a\n");
  assert.equal(await isHeadPushed(clone), false);
});

test("HEAD reachable from its upstream is pushed", async (t) => {
  const { clone } = makeBareRemoteAndClone(t);
  commit(clone, "a.txt", "a\n");
  git(clone, ["push", "-q", "-u", "origin", "main"]);
  assert.equal(await isHeadPushed(clone), true);
});

test("a local commit ahead of the upstream is not pushed", async (t) => {
  const { clone } = makeBareRemoteAndClone(t);
  commit(clone, "a.txt", "a\n");
  git(clone, ["push", "-q", "-u", "origin", "main"]);
  commit(clone, "b.txt", "b\n");
  assert.equal(await isHeadPushed(clone), false);
});

test("HEAD behind its upstream is still pushed", async (t) => {
  const { clone } = makeBareRemoteAndClone(t);
  commit(clone, "a.txt", "a\n");
  commit(clone, "b.txt", "b\n");
  git(clone, ["push", "-q", "-u", "origin", "main"]);
  git(clone, ["reset", "-q", "--hard", "HEAD~1"]);
  assert.equal(await isHeadPushed(clone), true);
});

test("a repository without commits is not pushed", async (t) => {
  const { clone } = makeBareRemoteAndClone(t);
  assert.equal(await isHeadPushed(clone), false);
});

test("getGitLog reports headPushed only when requested", async (t) => {
  const { clone } = makeBareRemoteAndClone(t);
  commit(clone, "a.txt", "a\n");
  git(clone, ["push", "-q", "-u", "origin", "main"]);
  assert.equal((await getGitLog(clone, { limit: 1 })).headPushed, undefined);
  assert.equal((await getGitLog(clone, { limit: 1, includeHeadPushed: true })).headPushed, true);
});
