import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { classifyGitGrepError, parseGitGrepOutput, searchContentWithGit, searchContentWithWalk, searchFileContent } =
  await jiti.import("./file-content-search.ts");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

// git grep -z NUL-terminates fields *within* a match record (path, line,
// text) but still newline-terminates the records themselves — confirmed
// against a real repo below with the last three tests in this file.
test("parses git grep -z output into path/line/text matches", () => {
  const output = ["src/a.ts\x003\x00const needle = 1;", "src/b.ts\x0010\x00// needle here too"].join("\n") + "\n";
  assert.deepEqual(parseGitGrepOutput(output), [
    { path: "src/a.ts", line: 3, text: "const needle = 1;" },
    { path: "src/b.ts", line: 10, text: "// needle here too" },
  ]);
});

test("caps parsed matches at the given limit", () => {
  const records = [];
  for (let i = 0; i < 5; i++) records.push(`file${i}.txt\0${i + 1}\0line ${i}`);
  const output = records.join("\n") + "\n";
  assert.equal(parseGitGrepOutput(output, 2).length, 2);
});

test("strips a trailing CR left over from a CRLF file's line", () => {
  const output = "a.ts\x001\x00const needle = 1;\r\n";
  assert.deepEqual(parseGitGrepOutput(output), [{ path: "a.ts", line: 1, text: "const needle = 1;" }]);
});

test("classifyGitGrepError: exit 1 with no output is 'no matches', not a failure", () => {
  assert.deepEqual(classifyGitGrepError({ code: 1 }), { kind: "empty" });
});

test("classifyGitGrepError: exit 128 (not a Git repo) falls back to the walk", () => {
  assert.deepEqual(classifyGitGrepError({ code: 128 }), { kind: "fallback" });
});

test("classifyGitGrepError: ENOENT (git missing) falls back to the walk", () => {
  assert.deepEqual(classifyGitGrepError({ code: "ENOENT" }), { kind: "fallback" });
});

test("classifyGitGrepError: a maxBuffer trip returns the partial stdout instead of falling back", () => {
  const partial = "a.ts\x001\x00needle\n";
  assert.deepEqual(classifyGitGrepError({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stdout: partial }), { kind: "partial", stdout: partial });
});

test("classifyGitGrepError: a timeout kill (killed:true, code:null) returns the partial stdout", () => {
  const partial = "a.ts\x001\x00needle\n";
  assert.deepEqual(classifyGitGrepError({ code: null, killed: true, stdout: partial }), { kind: "partial", stdout: partial });
});

test("classifyGitGrepError: an aborted request (AbortError) returns the partial stdout it already had", () => {
  const partial = "a.ts\x001\x00needle\n";
  assert.deepEqual(classifyGitGrepError({ name: "AbortError", code: "ABORT_ERR", stdout: partial }), { kind: "partial", stdout: partial });
});

test("classifyGitGrepError: an error with no stdout at all falls back to the walk", () => {
  assert.deepEqual(classifyGitGrepError(new Error("boom")), { kind: "fallback" });
});

function makeRepo(t) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-content-search-")));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const needle = 1;\nconst other = 2;\n");
  fs.writeFileSync(path.join(repo, "README.md"), "no match here\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  fs.writeFileSync(path.join(repo, "untracked.txt"), "needle in an untracked file\n");
  return repo;
}

test("git grep finds matches in tracked and untracked files, case-insensitively", async (t) => {
  const repo = makeRepo(t);
  const matches = await searchContentWithGit(repo, "NEEDLE");
  assert.ok(matches);
  assert.deepEqual(matches.map((m) => m.path).sort(), ["src/a.ts", "untracked.txt"]);
});

test("git grep returns an empty array (not null) when nothing matches", async (t) => {
  const repo = makeRepo(t);
  assert.deepEqual(await searchContentWithGit(repo, "totally-absent-needle"), []);
});

test("searchContentWithGit returns null outside a Git repository so the caller can fall back", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-content-search-nogit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "a.txt"), "needle\n");
  assert.equal(await searchContentWithGit(dir, "needle"), null);
});

test("the walk fallback finds matches without git and skips binary files", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-content-search-walk-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "a.txt"), "has needle here\n");
  fs.writeFileSync(path.join(dir, "b.bin"), Buffer.from([0x00, 0x01, 0x02, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65]));
  const matches = searchContentWithWalk(dir, "needle");
  assert.deepEqual(matches.map((m) => m.path), ["a.txt"]);
});

test("a query starting with '-' is searched literally, not parsed as a git-grep flag", async (t) => {
  const repo = makeRepo(t);
  fs.writeFileSync(path.join(repo, "flag.txt"), "value is -needle here\n");
  const matches = await searchContentWithGit(repo, "-needle");
  assert.ok(matches);
  assert.ok(matches.some((m) => m.path === "flag.txt"));
});

test("searchFileContent prefers git grep in a Git repo and falls back otherwise", async (t) => {
  const repo = makeRepo(t);
  const inRepo = await searchFileContent(repo, "needle");
  assert.ok(inRepo.some((m) => m.path === "untracked.txt"));

  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-content-search-plain-"));
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  fs.writeFileSync(path.join(plain, "a.txt"), "needle\n");
  assert.deepEqual((await searchFileContent(plain, "needle")).map((m) => m.path), ["a.txt"]);
});
