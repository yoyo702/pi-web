import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { GIT_TIMEOUT_MS, GIT_LONG_TIMEOUT_MS, gitCommandTimeout, gitFailureMessage, runGit } = await jiti.import("./git-exec.ts");

test("commands that run hooks, use the network, or copy whole files get the long timeout", () => {
  for (const command of ["commit", "push", "fetch", "pull", "switch", "stash"]) {
    assert.equal(gitCommandTimeout([command, "--quiet"]), GIT_LONG_TIMEOUT_MS, command);
  }
  for (const command of ["status", "diff", "log", "add", "restore"]) {
    assert.equal(gitCommandTimeout([command]), GIT_TIMEOUT_MS, command);
  }
});

test("failure messages prefer git's stderr", () => {
  const error = Object.assign(new Error("Command failed: git push"), { stderr: "fatal: could not read from remote\n" });
  assert.equal(gitFailureMessage(error, ["push"], GIT_LONG_TIMEOUT_MS), "fatal: could not read from remote");
  assert.equal(gitFailureMessage(new Error("spawn git ENOENT"), ["status"], GIT_TIMEOUT_MS), "spawn git ENOENT");
});

test("a killed git command reports which command timed out and after how long", async (t) => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-git-timeout-")));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  const hook = path.join(repo, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hook, "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  execFileSync("git", ["add", "a.txt"], { cwd: repo });

  const args = ["commit", "-m", "slow hook"];
  const error = await runGit(args, { cwd: repo, timeout: 300 }).then(() => null, (caught) => caught);
  assert.ok(error, "the commit was stopped");
  assert.equal(gitFailureMessage(error, args, 300), "git commit did not finish within 0.3 s and was stopped");
});
