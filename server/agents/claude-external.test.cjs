/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const external = require("./claude-external.cjs");

const ID = "33333333-3333-4333-8333-333333333333";
// A process outside this one's tree, as a `claude` in a terminal is: `sh`
// backgrounds it and exits, so it is re-parented.
function outsideProcess(t) {
  const pid = Number(execFileSync("sh", ["-c", "sleep 30 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" }).trim());
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch { /* exited */ } });
  return pid;
}
function useRegistry(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-claude-external-"));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  fs.mkdirSync(path.join(home, "sessions"));
  t.after(() => { process.env.CLAUDE_CONFIG_DIR = previous; fs.rmSync(home, { recursive: true, force: true }); });
  return (entry) => fs.writeFileSync(path.join(home, "sessions", `${entry.pid}.json`), JSON.stringify({ sessionId: ID, kind: "interactive", entrypoint: "cli", ...entry }));
}
const utcStart = (pid) => execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }).trim();

test("outside Claude processes are found by the session they registered, while they run", async (t) => {
  const register = useRegistry(t);
  const running = outsideProcess(t);
  register({ pid: running, name: "pi-web-61", status: "busy", procStart: utcStart(running) });
  const other = outsideProcess(t);
  register({ pid: other, sessionId: "44444444-4444-4444-8444-444444444444" });
  // A file left by a crashed Claude, and one whose pid now runs something that started later.
  register({ pid: 999_999 });
  const reused = outsideProcess(t);
  register({ pid: reused, procStart: "Thu Jan  1 00:00:00 2026" });
  assert.deepEqual(await external.processesForSession(ID), [{ pid: running, name: "pi-web-61", status: "busy", entrypoint: "cli" }]);
  assert.deepEqual(await external.processesForSession("not-a-session"), []);
});

test("pi-web's own Claude processes are not outside ones", async (t) => {
  const register = useRegistry(t);
  // A child of this process, as pi-web's chats and terminals are.
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  register({ pid: child.pid });
  assert.deepEqual(await external.processesForSession(ID), []);
});

test("closing outside Claude asks it to exit and waits for it", async (t) => {
  const register = useRegistry(t);
  const running = outsideProcess(t);
  register({ pid: running });
  assert.equal(await external.stopProcessesForSession(ID), 1);
  assert.deepEqual(await external.processesForSession(ID), []);
});
