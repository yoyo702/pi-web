import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { applyGitLineSelection, getGitFileDiff, getGitStatus } = await jiti.import("./git-changes.ts");
const { parsePatch } = await jiti.import("./git-partial-patch.ts");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepo(t, files) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-line-staging-")));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(repo, name), content);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

/** Ids of the changed lines whose text is in `texts`. */
function idsOf(diff, texts) {
  return parsePatch(diff.patch).hunks.flatMap((hunk) => hunk.lines).filter((line) => line.id !== null && texts.includes(line.text)).map((line) => line.id);
}

async function select(repo, name, scope, action, texts) {
  const file = path.join(repo, name);
  const diff = await getGitFileDiff(repo, file, scope);
  assert.ok(diff.fingerprint, `${scope} diff of ${name} offers line actions`);
  return applyGitLineSelection(repo, file, { scope, action, fingerprint: diff.fingerprint, lineIds: idsOf(diff, texts) });
}

test("stages, unstages and discards single lines", async (t) => {
  const repo = makeRepo(t, { "a.txt": "one\ntwo\nthree\n" });
  fs.writeFileSync(path.join(repo, "a.txt"), "one\nTWO\nthree\nfour\n");

  const status = await select(repo, "a.txt", "unstaged", "stage", ["four"]);
  assert.equal(git(repo, ["show", ":a.txt"]), "one\ntwo\nthree\nfour\n");
  assert.deepEqual(status.files.map((file) => file.indexStatus + file.worktreeStatus), ["MM"]);

  await select(repo, "a.txt", "unstaged", "stage", ["two", "TWO"]);
  assert.equal(git(repo, ["show", ":a.txt"]), "one\nTWO\nthree\nfour\n");

  await select(repo, "a.txt", "staged", "unstage", ["four"]);
  assert.equal(git(repo, ["show", ":a.txt"]), "one\nTWO\nthree\n");
  assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "one\nTWO\nthree\nfour\n");

  await select(repo, "a.txt", "unstaged", "discard", ["four"]);
  assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "one\nTWO\nthree\n");
  assert.equal(git(repo, ["show", ":a.txt"]), "one\nTWO\nthree\n");
});

test("stages part of an untracked file without changing the working copy", async (t) => {
  const repo = makeRepo(t, { "keep.txt": "x\n" });
  fs.writeFileSync(path.join(repo, "new.sh"), "#!/bin/sh\necho a\necho b");
  fs.chmodSync(path.join(repo, "new.sh"), 0o755);

  const status = await select(repo, "new.sh", "untracked", "stage", ["#!/bin/sh", "echo b"]);
  assert.equal(git(repo, ["show", ":new.sh"]), "#!/bin/sh\necho b");
  assert.match(git(repo, ["ls-files", "-s", "new.sh"]), /^100755 /);
  assert.equal(fs.readFileSync(path.join(repo, "new.sh"), "utf8"), "#!/bin/sh\necho a\necho b");
  assert.deepEqual(status.files.filter((file) => file.filePath.endsWith("new.sh")).map((file) => file.indexStatus + file.worktreeStatus), ["AM"]);
});

test("unstages part of a staged deletion", async (t) => {
  const repo = makeRepo(t, { "gone.txt": "a\nb\nc\n" });
  git(repo, ["rm", "-q", "gone.txt"]);
  await select(repo, "gone.txt", "staged", "unstage", ["b"]);
  assert.equal(git(repo, ["show", ":gone.txt"]), "b\n");
});

test("stages and discards part of a deletion in the working tree", async (t) => {
  const repo = makeRepo(t, { "gone.txt": "a\nb\nc\n" });
  fs.rmSync(path.join(repo, "gone.txt"));
  await select(repo, "gone.txt", "unstaged", "stage", ["b"]);
  assert.equal(git(repo, ["show", ":gone.txt"]), "a\nc\n");
  await select(repo, "gone.txt", "unstaged", "discard", ["c"]);
  assert.equal(fs.readFileSync(path.join(repo, "gone.txt"), "utf8"), "c\n");
});

test("refuses a selection made on a diff that has changed since", async (t) => {
  const repo = makeRepo(t, { "a.txt": "one\n" });
  fs.writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");
  const file = path.join(repo, "a.txt");
  const diff = await getGitFileDiff(repo, file, "unstaged");
  fs.writeFileSync(file, "one\ntwo\nthree\n");
  await assert.rejects(
    applyGitLineSelection(repo, file, { scope: "unstaged", action: "stage", fingerprint: diff.fingerprint, lineIds: [0] }),
    (error) => error.status === 409 && /changed/.test(error.message),
  );
  assert.deepEqual((await getGitStatus(repo)).files.map((file) => file.indexStatus + file.worktreeStatus), [" M"]);
});

test("rejects actions that do not fit the scope", async (t) => {
  const repo = makeRepo(t, { "a.txt": "one\n" });
  fs.writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");
  await assert.rejects(
    applyGitLineSelection(repo, path.join(repo, "a.txt"), { scope: "staged", action: "discard", fingerprint: "x", lineIds: [0] }),
    (error) => error.status === 400,
  );
});

test("renamed files and combined diffs offer no line actions", async (t) => {
  const repo = makeRepo(t, { "old.txt": "a\nb\nc\nd\n" });
  git(repo, ["mv", "old.txt", "new.txt"]);
  fs.appendFileSync(path.join(repo, "new.txt"), "e\n");
  git(repo, ["add", "new.txt"]);
  const renamed = await getGitFileDiff(repo, path.join(repo, "new.txt"), "staged");
  assert.equal(renamed.supported, true);
  assert.equal(renamed.fingerprint, undefined);
  fs.appendFileSync(path.join(repo, "new.txt"), "f\n");
  assert.equal((await getGitFileDiff(repo, path.join(repo, "new.txt"), "combined")).fingerprint, undefined);
});

test("partial patches leave a mode change for whole-file staging", async (t) => {
  const repo = makeRepo(t, { "run.sh": "a\nb\n" });
  fs.chmodSync(path.join(repo, "run.sh"), 0o755);
  fs.writeFileSync(path.join(repo, "run.sh"), "a\nb\nc\nd\n");
  await select(repo, "run.sh", "unstaged", "stage", ["c"]);
  assert.equal(git(repo, ["show", ":run.sh"]), "a\nb\nc\n");
  assert.match(git(repo, ["ls-files", "-s", "run.sh"]), /^100644 /);
});

test("works whatever diff prefixes the user configured", async (t) => {
  const repo = makeRepo(t, { "a.txt": "one\n" });
  git(repo, ["config", "diff.noprefix", "true"]);
  git(repo, ["config", "diff.mnemonicPrefix", "true"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "one\ntwo\nthree\n");
  await select(repo, "a.txt", "unstaged", "stage", ["two"]);
  assert.equal(git(repo, ["show", ":a.txt"]), "one\ntwo\n");
});

test("text that is not UTF-8 keeps whole-file actions only", async (t) => {
  const repo = makeRepo(t, { "latin.txt": Buffer.from("caf\xe9\n", "latin1") });
  fs.writeFileSync(path.join(repo, "latin.txt"), Buffer.from("caf\xe9\nna\xefve\n", "latin1"));
  const file = path.join(repo, "latin.txt");
  const diff = await getGitFileDiff(repo, file, "unstaged");
  assert.equal(diff.supported, true);
  assert.equal(diff.fingerprint, undefined);
  await assert.rejects(
    applyGitLineSelection(repo, file, { scope: "unstaged", action: "stage", fingerprint: "x", lineIds: [0] }),
    (error) => error.status === 400,
  );
});

test("rejects line ids outside the diff", async (t) => {
  const repo = makeRepo(t, { "keep.txt": "x\n" });
  fs.writeFileSync(path.join(repo, "new.txt"), "a\nb\n");
  const file = path.join(repo, "new.txt");
  const diff = await getGitFileDiff(repo, file, "untracked");
  await assert.rejects(
    applyGitLineSelection(repo, file, { scope: "untracked", action: "stage", fingerprint: diff.fingerprint, lineIds: [5] }),
    (error) => error.status === 400,
  );
  assert.equal(git(repo, ["ls-files", "new.txt"]), "");
});
