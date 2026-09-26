import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { parsePatch, buildPartialPatch, hunkLineIds, selectedAddedContent } = await import("./git-partial-patch.ts");

const PATCH = [
  "diff --git a/a.txt b/a.txt",
  "index 1111111..2222222 100644",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1,3 +1,3 @@ intro",
  " one",
  "-two",
  "+TWO",
  " three",
  "@@ -10,2 +10,3 @@",
  " ten",
  "+ten and a half",
  " eleven",
  "",
].join("\n");

test("numbers changed lines across hunks and tracks line numbers", () => {
  const parsed = parsePatch(PATCH);
  assert.equal(parsed.changeCount, 3);
  assert.deepEqual(parsed.hunks.map(hunkLineIds), [[0, 1], [2]]);
  assert.equal(parsed.hunks[0].section, " intro");
  const added = parsed.hunks[1].lines[1];
  assert.deepEqual([added.kind, added.text, added.newLineNo, added.oldLineNo], ["added", "ten and a half", 11, null]);
});

// Blob ids in the "index" line only fit the full change, so partial patches drop it.
test("forward partial patch keeps unselected removals as context and drops unselected additions", () => {
  const parsed = parsePatch(PATCH);
  assert.equal(buildPartialPatch(parsed, [0, 2], "forward"), [
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,3 +1,2 @@ intro",
    " one",
    "-two",
    " three",
    "@@ -10,2 +9,3 @@",
    " ten",
    "+ten and a half",
    " eleven",
    "",
  ].join("\n"));
  assert.equal(buildPartialPatch(parsed, [], "forward"), null);
});

test("reverse partial patch keeps unselected additions as context and drops unselected removals", () => {
  const parsed = parsePatch(PATCH);
  assert.equal(buildPartialPatch(parsed, [1], "reverse"), [
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,2 +1,3 @@ intro",
    " one",
    "+TWO",
    " three",
    "",
  ].join("\n"));
});

test("part of a new file names the file on both sides", () => {
  const parsed = parsePatch([
    "diff --git a/n.txt b/n.txt",
    "new file mode 100644",
    "index 0000000..3333333",
    "--- /dev/null",
    "+++ b/n.txt",
    "@@ -0,0 +1,2 @@",
    "+a",
    "+b",
    "\\ No newline at end of file",
  ].join("\n"));
  // Unstaging one line of a staged new file leaves the file with the other line.
  assert.equal(buildPartialPatch(parsed, [1], "reverse"), [
    "diff --git a/n.txt b/n.txt",
    "--- a/n.txt",
    "+++ b/n.txt",
    "@@ -1 +1,2 @@",
    " a",
    "+b",
    "\\ No newline at end of file",
    "",
  ].join("\n"));
  assert.equal(selectedAddedContent(parsed, [0, 1]), "a\nb");
  assert.equal(selectedAddedContent(parsed, [0]), "a\n");
  assert.match(buildPartialPatch(parsed, [0, 1], "forward"), /^new file mode 100644$/m);
});

test("rejects lines that are not part of a unified diff", () => {
  assert.throws(() => parsePatch("@@ -1 +1 @@\n*oops\n"), /Unexpected line/);
});

// Applies random selections to real diffs with `git apply` and checks the result.

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: cwd } });
}

function rng(seed) {
  let state = seed;
  return () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648; };
}

/** Lines of `content`, each with whether it ends in a newline. */
function tokens(content) {
  const lines = content.split("\n");
  const last = lines.pop();
  return [...lines.map((text) => ({ text, nl: true })), ...(last ? [{ text: last, nl: false }] : [])];
}

/** Content after taking only the selected changes of `parsed` from `base`. */
function expected(parsed, base, selected, direction) {
  const out = [];
  let cursor = 0;
  const baseLines = tokens(base);
  const fromSide = direction === "forward" ? "removed" : "added";
  for (const hunk of parsed.hunks) {
    const start = (direction === "forward" ? (hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1) : (hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1));
    while (cursor < start) out.push(baseLines[cursor++]);
    for (const line of hunk.lines) {
      const chosen = line.id !== null && selected.has(line.id);
      const token = { text: line.text, nl: !line.noNewline };
      if (line.kind === "context") { out.push(token); cursor++; }
      else if (line.kind === fromSide) { cursor++; if (!chosen) out.push(token); }
      else if (chosen) out.push(token);
    }
  }
  while (cursor < baseLines.length) out.push(baseLines[cursor++]);
  // Only the last line of a file can lack its newline.
  return out.map((token, index) => token.text + (token.nl || index < out.length - 1 ? "\n" : "")).join("");
}

test("random selections apply cleanly in all directions", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-partial-patch-"));
  try {
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    const patchFile = path.join(repo, ".git", "selection.patch");
    const file = path.join(repo, "f.txt");
    const random = rng(7);
    const ids = (parsed) => new Set(Array.from({ length: parsed.changeCount }, (_, id) => id).filter(() => random() < 0.5));
    const endLine = () => (random() < 0.5 ? "\n" : "");
    for (let round = 0; round < 60; round++) {
      const original = Array.from({ length: 12 + (round % 3) * 14 }, (_, index) => `line ${index}`);
      const changed = [];
      for (const line of original) {
        const roll = random();
        if (roll < 0.1) continue;
        changed.push(roll < 0.2 ? `${line} edited` : line);
        if (random() < 0.08) changed.push(`new ${round}-${changed.length}`);
      }
      if (random() < 0.3) changed.push(`tail ${round}`);
      const base = original.join("\n") + endLine();
      const next = changed.join("\n") + endLine();
      fs.writeFileSync(file, base);
      git(repo, ["add", "f.txt"]);
      git(repo, ["commit", "-q", "--allow-empty", "-m", `round ${round}`]);
      fs.writeFileSync(file, next);

      const unstaged = parsePatch(git(repo, ["diff", "--no-color", "--unified=3", "--", "f.txt"]));
      const stage = ids(unstaged);
      if (stage.size > 0) {
        fs.writeFileSync(patchFile, buildPartialPatch(unstaged, stage, "forward"));
        git(repo, ["apply", "--cached", patchFile]);
        assert.equal(git(repo, ["show", ":f.txt"]), expected(unstaged, base, stage, "forward"), `stage round ${round}`);
      }

      const rest = parsePatch(git(repo, ["diff", "--no-color", "--unified=3", "--", "f.txt"]));
      const discard = ids(rest);
      if (discard.size > 0) {
        fs.writeFileSync(patchFile, buildPartialPatch(rest, discard, "reverse"));
        git(repo, ["apply", "-R", patchFile]);
        assert.equal(fs.readFileSync(file, "utf8"), expected(rest, next, discard, "reverse"), `discard round ${round}`);
      }

      const current = fs.readFileSync(file, "utf8");
      git(repo, ["add", "f.txt"]);
      const staged = parsePatch(git(repo, ["diff", "--cached", "--no-color", "--unified=3", "--", "f.txt"]));
      const unstage = ids(staged);
      if (unstage.size > 0) {
        fs.writeFileSync(patchFile, buildPartialPatch(staged, unstage, "reverse"));
        git(repo, ["apply", "--cached", "-R", patchFile]);
        assert.equal(git(repo, ["show", ":f.txt"]), expected(staged, current, unstage, "reverse"), `unstage round ${round}`);
      }
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
