import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildReviewPrompt, getGitPrecheck, getStagedDiffForReview, parseRawDiff, parseReviewAnswer, scanAddedLines, unquoteGitPath } = await jiti.import("./git-precheck.ts");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepo(t, files) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-precheck-")));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(repo, name), content);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

const summary = (findings) => findings.map((finding) => `${finding.path}:${finding.line ?? "-"} ${finding.message}`);

test("scans only added lines and numbers them on the new side", () => {
  const patch = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -3 +3,2 @@",
    "-console.log(\"old\")",
    "+const x = 1; // TODO tidy",
    "+  console.log(x);",
    "@@ -20,0 +22 @@",
    "+++ counter",
    "diff --git a/notes.md b/notes.md",
    "--- a/notes.md",
    "+++ b/notes.md",
    "@@ -1,0 +1,3 @@",
    "+Title",
    "+=======",
    "+<<<<<<< HEAD",
  ].join("\n");
  const { findings, truncated } = scanAddedLines(patch);
  assert.equal(truncated, false);
  assert.deepEqual(summary(findings), ["src/a.ts:3 New TODO", "src/a.ts:4 Debug statement", "notes.md:3 Conflict marker"]);
  assert.equal(findings[1].text, "console.log(x);");
});

test("reports secrets without their text and stops at the limit", () => {
  const patch = [
    "diff --git a/.env b/.env",
    "--- /dev/null",
    "+++ b/.env",
    "@@ -0,0 +1,3 @@",
    `+KEY=AKIA${"A".repeat(16)}`,
    "+-----BEGIN OPENSSH PRIVATE KEY-----",
    "+debugger",
  ].join("\n");
  const all = scanAddedLines(patch);
  assert.deepEqual(summary(all.findings), [".env:1 Possible AWS access key", ".env:2 Possible private key", ".env:3 Debug statement"]);
  assert.equal(all.findings[0].text, undefined);
  const limited = scanAddedLines(patch, 2);
  assert.equal(limited.findings.length, 2);
  assert.equal(limited.truncated, true);
});

test("reads renamed entries of a raw diff", () => {
  const raw = ":100644 100644 aaa bbb M\0a.txt\0:100644 100644 ccc ddd R090\0old.txt\0new.txt\0:100644 000000 eee 000 D\0gone.txt\0";
  assert.deepEqual(parseRawDiff(raw).map((entry) => `${entry.status} ${entry.path} ${entry.blob}`), ["M a.txt bbb", "R090 new.txt ddd", "D gone.txt 000"]);
});

test("checks the staged changes of a repository", async (t) => {
  const repo = makeRepo(t, { "a.js": "let a = 1;\n", "README.md": "Intro\n" });
  git(repo, ["config", "diff.noprefix", "true"]);
  const empty = await getGitPrecheck(repo);
  assert.deepEqual(empty.findings, []);

  fs.writeFileSync(path.join(repo, "a.js"), "let a = 1;\nconsole.log(a);\n");
  fs.writeFileSync(path.join(repo, "README.md"), "Intro\n=======\n");
  fs.writeFileSync(path.join(repo, "big.bin"), Buffer.alloc(1024 * 1024 + 1));
  fs.writeFileSync(path.join(repo, "unstaged.js"), "debugger;\n");
  git(repo, ["add", "a.js", "README.md", "big.bin"]);
  const result = await getGitPrecheck(repo);
  assert.deepEqual(summary(result.findings), ["big.bin:- Large file (1.0 MB)", "a.js:2 Debug statement"]);
  assert.notEqual(result.stagedFingerprint, empty.stagedFingerprint);

  fs.appendFileSync(path.join(repo, "a.js"), "// more\n");
  assert.equal((await getGitPrecheck(repo)).stagedFingerprint, result.stagedFingerprint, "unstaged edits keep the fingerprint");
  git(repo, ["add", "a.js"]);
  assert.notEqual((await getGitPrecheck(repo)).stagedFingerprint, result.stagedFingerprint);
});

test("reviews need staged changes and treat the diff as data", async (t) => {
  const repo = makeRepo(t, { "a.txt": "one\n" });
  await assert.rejects(getStagedDiffForReview(repo), (error) => error.status === 400);
  fs.writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");
  git(repo, ["add", "a.txt"]);
  const staged = await getStagedDiffForReview(repo);
  assert.match(staged.diff, /^\+two$/m);
  assert.equal(staged.truncated, false);
  const prompt = buildReviewPrompt(staged.diff, false);
  assert.match(prompt, /untrusted data/);
  const fence = /BEGIN (DIFF-[0-9a-f]+)\n/.exec(prompt)?.[1];
  assert.ok(fence);
  assert.ok(prompt.endsWith(`BEGIN ${fence}\n${staged.diff}\nEND ${fence}`));
});

test("reads quoted paths and paths with spaces from diff headers", () => {
  assert.equal(unquoteGitPath("\"b/tab\\there\""), "b/tab\there");
  assert.equal(unquoteGitPath("\"b/caf\\303\\251 \\\"q\\\"\""), "b/café \"q\"");
  assert.equal(unquoteGitPath("b/plain"), "b/plain");
  const patch = [
    "diff --git a/my file.js b/my file.js",
    "--- a/my file.js\t",
    "+++ b/my file.js\t",
    "@@ -0,0 +1 @@",
    "+debugger",
    "diff --git \"a/new\\nline.js\" \"b/new\\nline.js\"",
    "--- /dev/null",
    "+++ \"b/new\\nline.js\"",
    "@@ -0,0 +1 @@",
    "+debugger",
  ].join("\n");
  assert.deepEqual(scanAddedLines(patch).findings.map((finding) => finding.path), ["my file.js", "new\nline.js"]);
});

test("checks a repository in the middle of a conflicted merge", async (t) => {
  const repo = makeRepo(t, { "a.txt": "base\n" });
  git(repo, ["checkout", "-q", "-b", "other"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "other\n");
  git(repo, ["commit", "-q", "-am", "other"]);
  git(repo, ["checkout", "-q", "-"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "main\n");
  fs.writeFileSync(path.join(repo, "b.js"), "debugger;\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "main"]);
  assert.throws(() => execFileSync("git", ["merge", "-q", "other"], { cwd: repo, stdio: "ignore" }));
  fs.appendFileSync(path.join(repo, "b.js"), "console.log(1);\n");
  git(repo, ["add", "b.js"]);
  const result = await getGitPrecheck(repo);
  assert.deepEqual(summary(result.findings), ["b.js:2 Debug statement"]);
});

test("keeps the checks to the workspace subfolder", async (t) => {
  const repo = makeRepo(t, { "root.js": "\n" });
  fs.mkdirSync(path.join(repo, "app"));
  fs.writeFileSync(path.join(repo, "app", "a.js"), "debugger;\n");
  fs.writeFileSync(path.join(repo, "root.js"), "debugger;\n");
  git(repo, ["add", "."]);
  assert.deepEqual(summary((await getGitPrecheck(path.join(repo, "app"))).findings), ["app/a.js:1 Debug statement"]);
  assert.equal((await getGitPrecheck(repo)).findings.length, 2);
  const staged = await getStagedDiffForReview(path.join(repo, "app"));
  assert.match(staged.diff, /app\/a\.js/);
  assert.doesNotMatch(staged.diff, /root\.js/);
});

test("reads the model's review answer", () => {
  assert.deepEqual(
    parseReviewAnswer("Sure!\n```json\n{\"summary\": \" Adds x. \", \"issues\": [{\"path\": \"a.ts\", \"note\": \"Check y\"}, {\"note\": \"No path\"}, {\"path\": 3}]}\n```"),
    { summary: "Adds x.", issues: [{ path: "a.ts", note: "Check y" }, { path: null, note: "No path" }] },
  );
  assert.deepEqual(parseReviewAnswer("Looks fine."), { summary: "Looks fine.", issues: [] });
});
