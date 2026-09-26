import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { discardChanges } = await jiti.import("./git-changes.ts");
const { DISCARD_STASH_MESSAGE, discardConfirmMessage } = await jiti.import("./git-discard.ts");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepo(t, { commit = true } = {}) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-discard-")));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  if (commit) {
    fs.writeFileSync(path.join(repo, "tracked.txt"), "original\n");
    fs.writeFileSync(path.join(repo, "other.txt"), "other\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "init"]);
  }
  return repo;
}

test("discarded tracked and new files are saved in one stash and can be restored", async (t) => {
  const repo = makeRepo(t);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "edited\n");
  fs.writeFileSync(path.join(repo, "new.txt"), "brand new\n");
  fs.writeFileSync(path.join(repo, "a[1].txt"), "glob-looking name\n");
  fs.writeFileSync(path.join(repo, "other.txt"), "keep this edit\n");

  const status = await discardChanges(repo, ["tracked.txt", "new.txt", "a[1].txt"].map((name) => path.join(repo, name)));

  assert.deepEqual(status.files.map((file) => file.filePath).sort(), [path.join(repo, "other.txt")]);
  assert.equal(fs.readFileSync(path.join(repo, "tracked.txt"), "utf8"), "original\n");
  assert.equal(fs.existsSync(path.join(repo, "new.txt")), false);
  assert.equal(fs.readFileSync(path.join(repo, "other.txt"), "utf8"), "keep this edit\n");
  assert.match(git(repo, ["stash", "list"]), new RegExp(DISCARD_STASH_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  git(repo, ["stash", "pop", "-q"]);
  assert.equal(fs.readFileSync(path.join(repo, "tracked.txt"), "utf8"), "edited\n");
  assert.equal(fs.readFileSync(path.join(repo, "new.txt"), "utf8"), "brand new\n");
  assert.equal(fs.readFileSync(path.join(repo, "a[1].txt"), "utf8"), "glob-looking name\n");
});

test("discard before the first commit refuses and deletes nothing", async (t) => {
  const repo = makeRepo(t, { commit: false });
  fs.writeFileSync(path.join(repo, "draft.txt"), "unsaved work\n");
  await assert.rejects(discardChanges(repo, [path.join(repo, "draft.txt")]), /at least one commit/);
  assert.equal(fs.readFileSync(path.join(repo, "draft.txt"), "utf8"), "unsaved work\n");
});

test("the confirmation says where discarded changes go", () => {
  assert.match(discardConfirmMessage([{ status: "untracked" }]), /^Discard this file\?/);
  assert.match(discardConfirmMessage([{ status: "modified" }, { status: "untracked" }]), /^Discard changes to 2 files\?/);
  assert.match(discardConfirmMessage([{ status: "modified" }]), /saved as a Git stash/);
  assert.match(discardConfirmMessage([{ status: "conflict" }, { status: "modified" }]), /1 conflicted file is reset to HEAD and cannot be restored/);
  assert.doesNotMatch(discardConfirmMessage([{ status: "conflict" }]), /saved as a Git stash/);
});
