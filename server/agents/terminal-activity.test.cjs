"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

// Claude/Codex terminal activity: Claude hooks, Codex titles, notifications.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { spawn } = require("node:child_process");

const notifications = require("../notifications.cjs");

// A fake node-pty, fake `claude`/`codex` executables on PATH and temp notification files.
function useManager(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-activity-"));
  for (const name of ["claude", "codex"]) fs.writeFileSync(path.join(dir, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const modulePath = require.resolve("./terminal-manager.cjs");
  const previous = { state: global.__piWebTerminalState, load: Module._load, env: { ...process.env } };
  const spawned = [];
  process.env.PATH = `${dir}${path.delimiter}${process.env.PATH}`;
  process.env.PI_WEB_NOTIFICATIONS_FILE = path.join(dir, "notifications.json");
  process.env.PI_WEB_PUSH_FILE = path.join(dir, "push.json");
  process.env.PI_WEB_RUNTIME_HOST = "0.0.0.0";
  process.env.PI_WEB_RUNTIME_PORT = "30999";
  process.env.PI_WEB_RUNTIME_PROTOCOL = "https";
  notifications._resetForTests();
  global.__piWebTerminalState = { sessions: new Map() };
  Module._load = function (request, parent, isMain) {
    if (request === "node-pty") {
      return {
        spawn(executable, args, options) {
          const pty = { pid: 4242, executable, args, options, written: [], write(value) { this.written.push(value); }, resize() {}, kill() {}, onData(callback) { this.emit = callback; }, onExit(callback) { this.exit = callback; } };
          spawned.push(pty);
          return pty;
        },
      };
    }
    return previous.load.call(this, request, parent, isMain);
  };
  delete require.cache[modulePath];
  const manager = require("./terminal-manager.cjs");
  t.after(() => {
    Module._load = previous.load;
    delete require.cache[modulePath];
    for (const key of Object.keys(process.env)) if (!(key in previous.env)) delete process.env[key];
    Object.assign(process.env, previous.env);
    if (previous.state === undefined) delete global.__piWebTerminalState;
    else global.__piWebTerminalState = previous.state;
    notifications._resetForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const entries = () => notifications.list().reverse().map(({ event, detail, targetId }) => ({ event, detail, targetId }));
  return { manager, spawned, entries };
}

test("Claude terminals get hooks that report their turns, and approvals and finished turns are notified", (t) => {
  const { manager, spawned, entries } = useManager(t);
  const terminal = manager.createTerminal({ provider: "claude", cwd: "/tmp", permissionMode: "confirm", launchMode: "new" });
  const [pty] = spawned;
  assert.equal(pty.args[0], "--settings");
  const { hooks } = JSON.parse(pty.args[1]);
  const script = path.join(__dirname, "..", "terminal-hook.cjs");
  assert.equal(hooks.UserPromptSubmit[0].hooks[0].command, `'${process.execPath}' '${script}' working`);
  assert.equal(hooks.Stop[0].hooks[0].command, `'${process.execPath}' '${script}' waiting`);
  assert.equal(hooks.Notification[0].matcher, "permission_prompt|elicitation_dialog");
  assert.equal(hooks.Notification[0].hooks[0].command, `'${process.execPath}' '${script}' approval`);
  assert.equal(hooks.Notification[1].matcher, "idle_prompt");
  assert.equal(hooks.Notification[1].hooks[0].command, `'${process.execPath}' '${script}' idle`);
  assert.equal(pty.options.env.PI_WEB_TERMINAL_HOOK_URL, "https://127.0.0.1:30999/api/terminal-hook");
  const token = pty.options.env.PI_WEB_TERMINAL_HOOK_TOKEN;
  assert.match(token, /^[\w-]{32}$/);
  // A new Claude waits for its first message.
  assert.equal(terminal.activity, "waiting");

  assert.equal(manager.reportHookActivity({ token: "x".repeat(32), activity: "working" }), false);
  // Same length in characters, not in bytes: still just a wrong token.
  assert.equal(manager.reportHookActivity({ token: "é".repeat(32), activity: "working" }), false);
  assert.equal(manager.reportHookActivity({ token, activity: "sleeping" }), false);
  assert.equal(manager.reportHookActivity({ token, activity: "working" }), true);
  assert.equal(manager.getTerminal(terminal.id).activity, "working");
  assert.deepEqual(entries(), []);

  manager.reportHookActivity({ token, activity: "approval", detail: "Claude needs your permission to use Bash" });
  assert.deepEqual(entries(), [{ event: "approval", detail: "Claude needs your permission to use Bash", targetId: terminal.id }]);
  // Moving through the options does not answer the prompt; picking one does.
  manager.inputTerminal(terminal.id, "\x1b[B");
  assert.equal(manager.getTerminal(terminal.id).activity, "approval");
  manager.inputTerminal(terminal.id, "\r");
  assert.equal(manager.getTerminal(terminal.id).activity, "working");
  assert.deepEqual(pty.written, ["\x1b[B", "\r"]);

  manager.reportHookActivity({ token, activity: "waiting", detail: "Done: the tests pass." });
  assert.deepEqual(entries().at(-1), { event: "completed", detail: "Done: the tests pass.", targetId: terminal.id });

  // Escape interrupts a turn: no "finished" notice.
  manager.reportHookActivity({ token, activity: "working" });
  manager.inputTerminal(terminal.id, "\x1b");
  assert.equal(manager.getTerminal(terminal.id).activity, "waiting");
  assert.equal(entries().length, 2);

  // A turn that ends without Stop (a rejected approval) settles quietly once
  // Claude reports its prompt idle.
  manager.reportHookActivity({ token, activity: "approval" });
  manager.inputTerminal(terminal.id, "3");
  assert.equal(manager.getTerminal(terminal.id).activity, "working");
  assert.equal(manager.reportHookActivity({ token, activity: "idle" }), true);
  assert.equal(manager.getTerminal(terminal.id).activity, "waiting");
  assert.deepEqual(entries().map((entry) => entry.event), ["approval", "completed", "approval"]);

  // Quitting from the prompt adds no exit notice.
  pty.exit({ exitCode: 0, signal: 0 });
  assert.equal(entries().length, 3);
  assert.equal(manager.getTerminal(terminal.id).activity, null);
  assert.equal(manager.reportHookActivity({ token, activity: "working" }), false);
});

test("a stopped Claude terminal ignores late hooks, and the hook address follows the listen host", (t) => {
  const { manager, spawned, entries } = useManager(t);
  const terminal = manager.createTerminal({ provider: "claude", cwd: "/tmp", permissionMode: "confirm", launchMode: "new" });
  const token = spawned[0].options.env.PI_WEB_TERMINAL_HOOK_TOKEN;
  manager.stopTerminal(terminal.id);
  manager.reportHookActivity({ token, activity: "approval" });
  assert.notEqual(manager.getTerminal(terminal.id).activity, "approval");
  assert.deepEqual(entries().filter((entry) => entry.event === "approval"), []);

  const urlFor = (host) => {
    process.env.PI_WEB_RUNTIME_HOST = host;
    manager.createTerminal({ provider: "claude", cwd: "/tmp", permissionMode: "confirm", launchMode: "new" });
    return spawned.at(-1).options.env.PI_WEB_TERMINAL_HOOK_URL;
  };
  assert.equal(urlFor("::"), "https://[::1]:30999/api/terminal-hook");
  assert.equal(urlFor("fd7a::1"), "https://[fd7a::1]:30999/api/terminal-hook");
  assert.equal(urlFor("192.168.1.20"), "https://192.168.1.20:30999/api/terminal-hook");
  assert.equal(urlFor("localhost"), "https://localhost:30999/api/terminal-hook");
});

test("Codex terminals follow the terminal title, even when a title is split across output chunks", (t) => {
  const { manager, spawned, entries } = useManager(t);
  const terminal = manager.createTerminal({ provider: "codex", cwd: "/tmp", permissionMode: "on-request", launchMode: "new" });
  const [pty] = spawned;
  assert.equal(pty.options.env.PI_WEB_TERMINAL_HOOK_TOKEN, undefined);
  assert.equal(terminal.activity, null);

  pty.emit("\x1b]0;work\x07> ");
  assert.equal(manager.getTerminal(terminal.id).activity, "waiting");
  pty.emit("output\x1b]0;⠦ Rep");
  assert.equal(manager.getTerminal(terminal.id).activity, "waiting");
  pty.emit("ly OK | work\x1b");
  pty.emit("\\more output");
  assert.equal(manager.getTerminal(terminal.id).activity, "working");
  assert.deepEqual(entries(), []);

  pty.emit("\x1b]2;[ ! ] Action Required | work\x07");
  pty.emit("\x1b]2;[ . ] Action Required | work\x07");
  assert.equal(manager.getTerminal(terminal.id).activity, "approval");
  // Input never guesses for Codex: its title says when the prompt is answered.
  manager.inputTerminal(terminal.id, "y");
  assert.equal(manager.getTerminal(terminal.id).activity, "approval");
  pty.emit("\x1b]0;⠇ Reply OK | work\x07");
  pty.emit("\x1b]0;Reply OK | work\x07");
  assert.equal(manager.getTerminal(terminal.id).activity, "waiting");
  assert.deepEqual(entries(), [
    { event: "approval", detail: "Waiting for your approval", targetId: terminal.id },
    { event: "completed", detail: "Waiting for your next message", targetId: terminal.id },
  ]);

  // Escape interrupts the turn: the plain title that follows is not a finish.
  pty.emit("\x1b]0;⠇ Next | work\x07");
  manager.inputTerminal(terminal.id, "\x1b");
  pty.emit("\x1b]0;Next | work\x07");
  assert.equal(manager.getTerminal(terminal.id).activity, "waiting");
  assert.equal(entries().length, 2);

  // Quitting from the prompt adds no second "finished" notice.
  pty.exit({ exitCode: 0, signal: 0 });
  assert.equal(entries().length, 2);
  // Exiting mid-turn still does.
  const busy = manager.createTerminal({ provider: "codex", cwd: "/tmp", permissionMode: "on-request", launchMode: "new" });
  spawned[1].emit("\x1b]0;⠇ Next | work\x07");
  spawned[1].exit({ exitCode: 0, signal: 0 });
  assert.deepEqual(entries().at(-1), { event: "completed", detail: undefined, targetId: busy.id });
});

function runHook(activity, env, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, "..", "terminal-hook.cjs"), activity], { env: { PATH: process.env.PATH, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("exit", (code) => resolve({ code, output }));
    child.stdin.end(input);
  });
}

test("the hook script posts the state with Claude's reply, and never fails the hook", async (t) => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => { received.push({ url: req.url, type: req.headers["content-type"], body: JSON.parse(body) }); res.writeHead(204); res.end(); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const env = { PI_WEB_TERMINAL_HOOK_URL: `http://127.0.0.1:${server.address().port}/api/terminal-hook`, PI_WEB_TERMINAL_HOOK_TOKEN: "token-1" };

  assert.deepEqual(await runHook("waiting", env, JSON.stringify({ hook_event_name: "Stop", last_assistant_message: "All\n\ndone." })), { code: 0, output: "" });
  assert.deepEqual(await runHook("approval", env, JSON.stringify({ notification_type: "permission_prompt", message: "Claude needs your permission" })), { code: 0, output: "" });
  assert.deepEqual(await runHook("working", env, "not json"), { code: 0, output: "" });
  assert.deepEqual(received, [
    { url: "/api/terminal-hook", type: "application/json", body: { token: "token-1", activity: "waiting", detail: "All done." } },
    { url: "/api/terminal-hook", type: "application/json", body: { token: "token-1", activity: "approval", detail: "Claude needs your permission" } },
    { url: "/api/terminal-hook", type: "application/json", body: { token: "token-1", activity: "working", detail: "" } },
  ]);

  // No server, or not started by TianForge: still a silent success.
  await new Promise((resolve) => server.close(resolve));
  assert.deepEqual(await runHook("waiting", env, "{}"), { code: 0, output: "" });
  assert.deepEqual(await runHook("waiting", {}, "{}"), { code: 0, output: "" });
  assert.equal(received.length, 3);
});
