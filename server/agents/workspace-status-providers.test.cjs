"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const workspaceStatus = require("../workspace-status.cjs");

function loadTerminalManagerWithFakePty(t) {
  const modulePath = require.resolve("./terminal-manager.cjs");
  const previousState = global.__piWebTerminalState;
  const previousLoad = Module._load;
  const handlers = {};
  const fakePty = { pid: 7, onData(fn) { handlers.data = fn; }, onExit(fn) { handlers.exit = fn; }, write() {}, resize() {}, kill() {} };
  global.__piWebTerminalState = { sessions: new Map() };
  Module._load = function (request, parent, isMain) {
    if (request === "node-pty") return { spawn() { return fakePty; } };
    return previousLoad.call(this, request, parent, isMain);
  };
  delete require.cache[modulePath];
  const manager = require("./terminal-manager.cjs");
  t.after(() => {
    Module._load = previousLoad;
    delete require.cache[modulePath];
    if (previousState === undefined) delete global.__piWebTerminalState;
    else global.__piWebTerminalState = previousState;
  });
  return { manager, handlers };
}

test("terminal lifecycle changes notify the status bus; output is throttled", (t) => {
  const previousShell = process.env.SHELL;
  process.env.SHELL = "/bin/sh";
  t.after(() => { process.env.SHELL = previousShell; });
  const notify = t.mock.method(workspaceStatus, "notify", () => {});
  const { manager, handlers } = loadTerminalManagerWithFakePty(t);
  const calls = () => notify.mock.calls.map((call) => [call.arguments[0], call.arguments[1]?.throttled === true]);

  const terminal = manager.createTerminal({ provider: "shell", cwd: "/tmp", cols: 80, rows: 24 });
  assert.deepEqual(calls().at(-1), ["terminals", false]);
  handlers.data("hello");
  assert.deepEqual(calls().at(-1), ["terminals", true]);
  manager.renameTerminal(terminal.id, "Logs");
  assert.deepEqual(calls().at(-1), ["terminals", false]);
  handlers.exit({ exitCode: 0, signal: 0 });
  assert.deepEqual(calls().at(-1), ["terminals", false]);
  const before = notify.mock.callCount();
  manager.removeTerminal(terminal.id);
  assert.equal(notify.mock.callCount(), before + 1);
});

test("the terminals provider snapshot lists every terminal with limits", (t) => {
  const previousShell = process.env.SHELL;
  process.env.SHELL = "/bin/sh";
  t.after(() => { process.env.SHELL = previousShell; });
  t.mock.method(workspaceStatus, "notify", () => {});
  const { manager } = loadTerminalManagerWithFakePty(t);
  manager.createTerminal({ provider: "shell", cwd: "/tmp", cols: 80, rows: 24 });
  const message = workspaceStatus.snapshot("terminals");
  assert.equal(message.type, "terminals");
  assert.equal(message.terminals.length, 1);
  assert.deepEqual(Object.keys(message.limits).sort(), ["records", "running"]);
});

test("codex protocol state changes notify the status bus", (t) => {
  const notify = t.mock.method(workspaceStatus, "notify", () => {});
  const appServer = require("./codex-app-server.cjs");
  const state = { threadId: "th", activeTurnId: null, incoming: new Map(), pending: new Map(), events: [], listeners: new Set(), nextEventSeq: 1 };
  appServer.handleProtocolMessage(state, { method: "turn/started", params: { turn: { id: "turn-1" } } });
  appServer.handleProtocolMessage(state, { method: "item/agentMessage/delta", params: {} });
  appServer.handleProtocolMessage(state, { method: "turn/completed", params: {} });
  const kinds = notify.mock.calls.map((call) => call.arguments[0]);
  assert.deepEqual(kinds, ["codex_runtimes", "codex_runtimes"]);
});
