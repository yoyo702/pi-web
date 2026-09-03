"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const test = require("node:test"); // Agent terminal lifecycle coverage.
const assert = require("node:assert/strict");
const Module = require("node:module");

test("shell terminals launch the configured login shell without client-controlled arguments", () => {
  const modulePath = require.resolve("./terminal-manager.cjs");
  const previousState = global.__piWebTerminalState;
  const previousShell = process.env.SHELL;
  const previousLoad = Module._load;
  let spawnCall;
  const fakePty = {
    pid: 42,
    onData() {},
    onExit() {},
    write() {},
    resize() {},
    kill() {},
  };
  process.env.SHELL = "/bin/sh";
  global.__piWebTerminalState = { sessions: new Map() };
  Module._load = function (request, parent, isMain) {
    if (request === "node-pty") return { spawn(executable, args, options) { spawnCall = { executable, args, options }; return fakePty; } };
    return previousLoad.call(this, request, parent, isMain);
  };
  delete require.cache[modulePath];
  try {
    const manager = require("./terminal-manager.cjs");
    const terminal = manager.createTerminal({ provider: "shell", cwd: "/tmp", cols: 80, rows: 24, permissionMode: "bypass", launchMode: "fork", initialPrompt: "ignored" });
    assert.equal(terminal.provider, "shell");
    assert.equal(terminal.title, "Terminal 1");
    assert.equal(manager.renameTerminal(terminal.id, "Logs").title, "Logs");
    assert.equal(spawnCall.executable, "/bin/sh");
    assert.deepEqual(spawnCall.args, ["-l"]);
    assert.equal(spawnCall.options.cwd, "/tmp");
    assert.equal(spawnCall.options.env.PI_WEB_PASSWORD, undefined);
    assert.equal(spawnCall.options.env.PI_WEB_INTERNAL_TERMINAL_TOKEN, undefined);
  } finally {
    Module._load = previousLoad;
    delete require.cache[modulePath];
    if (previousShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = previousShell;
    if (previousState === undefined) delete global.__piWebTerminalState;
    else global.__piWebTerminalState = previousState;
  }
});

test("terminal child environments exclude TianForge pi server secrets", () => {
  const modulePath = require.resolve("./terminal-manager.cjs");
  delete require.cache[modulePath];
  const { terminalEnvironment } = require("./terminal-manager.cjs");
  const env = terminalEnvironment({ PATH: "/bin", HOME: "/tmp/home", OPENAI_API_KEY: "agent-key", PI_WEB_PASSWORD: "secret", PI_WEB_INTERNAL_TERMINAL_TOKEN: "capability", PI_WEB_HTTPS_KEY: "/private/key" });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/tmp/home");
  assert.equal(env.OPENAI_API_KEY, "agent-key");
  assert.equal(env.PI_WEB_PASSWORD, undefined);
  assert.equal(env.PI_WEB_INTERNAL_TERMINAL_TOKEN, undefined);
  assert.equal(env.PI_WEB_HTTPS_KEY, undefined);
  assert.equal(env.TERM, "xterm-256color");
  delete require.cache[modulePath];
});

test("terminal creation rejects new processes at the running-session limit", () => {
  const modulePath = require.resolve("./terminal-manager.cjs");
  const previousState = global.__piWebTerminalState;
  const sessions = new Map(Array.from({ length: 20 }, (_, index) => [`running-${index}`, { id: `running-${index}`, state: "running" }]));
  global.__piWebTerminalState = { sessions };
  delete require.cache[modulePath];
  try {
    const manager = require("./terminal-manager.cjs");
    assert.throws(() => manager.createTerminal({ provider: "shell", cwd: "/tmp" }), { code: "terminal_limit" });
  } finally {
    delete require.cache[modulePath];
    if (previousState === undefined) delete global.__piWebTerminalState;
    else global.__piWebTerminalState = previousState;
  }
});

test("terminal creation asks the user to clear ended records at the history limit", () => {
  const modulePath = require.resolve("./terminal-manager.cjs");
  const previousState = global.__piWebTerminalState;
  const sessions = new Map(Array.from({ length: 100 }, (_, index) => [`ended-${index}`, { id: `ended-${index}`, state: "ended" }]));
  global.__piWebTerminalState = { sessions };
  delete require.cache[modulePath];
  try {
    const manager = require("./terminal-manager.cjs");
    assert.throws(() => manager.createTerminal({ provider: "shell", cwd: "/tmp" }), { code: "terminal_record_limit" });
  } finally {
    delete require.cache[modulePath];
    if (previousState === undefined) delete global.__piWebTerminalState;
    else global.__piWebTerminalState = previousState;
  }
});

test("terminal snapshot subscription is registered before the retained buffer is returned", () => {
  const modulePath = require.resolve("./terminal-manager.cjs");
  const previousState = global.__piWebTerminalState;
  const session = { id: "terminal-1", chunks: [Buffer.from("before")], truncated: false, state: "running", subscribers: new Set() };
  global.__piWebTerminalState = { sessions: new Map([[session.id, session]]) };
  delete require.cache[modulePath];
  const manager = require("./terminal-manager.cjs");
  const received = [];
  const { snapshot, unsubscribe } = manager.snapshotAndSubscribeTerminal(session.id, (chunk) => received.push(chunk.toString()));
  assert.equal(session.subscribers.size, 1);
  assert.equal(snapshot.data.toString(), "before");
  for (const subscriber of session.subscribers) subscriber(Buffer.from("after"));
  assert.deepEqual(received, ["after"]);
  unsubscribe();
  assert.equal(session.subscribers.size, 0);
  delete require.cache[modulePath];
  if (previousState === undefined) delete global.__piWebTerminalState;
  else global.__piWebTerminalState = previousState;
});

test("ended terminal records can be removed but running terminals cannot", () => {
  const modulePath = require.resolve("./terminal-manager.cjs");
  const previousState = global.__piWebTerminalState;
  const ended = { id: "ended-1", chunks: [], truncated: false, state: "ended", subscribers: new Set(), createdAt: "2026-01-01T00:00:00Z" };
  const running = { id: "running-1", chunks: [], truncated: false, state: "running", subscribers: new Set(), createdAt: "2026-01-01T00:00:00Z" };
  global.__piWebTerminalState = { sessions: new Map([[ended.id, ended], [running.id, running]]) };
  delete require.cache[modulePath];
  const manager = require("./terminal-manager.cjs");
  assert.equal(manager.removeTerminal(ended.id).id, ended.id);
  assert.throws(() => manager.getTerminal(ended.id), { code: "not_found" });
  assert.throws(() => manager.removeTerminal(running.id), { code: "still_running" });
  delete require.cache[modulePath];
  if (previousState === undefined) delete global.__piWebTerminalState;
  else global.__piWebTerminalState = previousState;
});

test("ended terminal records can be cleared by workspace and provider", () => {
  const modulePath = require.resolve("./terminal-manager.cjs");
  const previousState = global.__piWebTerminalState;
  const record = (id, state, cwd, provider) => ({ id, state, cwd, provider, chunks: [], subscribers: new Set(), createdAt: "2026-01-01T00:00:00Z" });
  const sessions = [record("remove", "ended", "/one", "codex"), record("keep-running", "running", "/one", "codex"), record("keep-provider", "ended", "/one", "claude"), record("keep-cwd", "ended", "/two", "codex")];
  global.__piWebTerminalState = { sessions: new Map(sessions.map((session) => [session.id, session])) };
  delete require.cache[modulePath];
  const manager = require("./terminal-manager.cjs");
  assert.deepEqual(manager.clearEndedTerminals({ cwd: "/one", provider: "codex" }), ["remove"]);
  assert.deepEqual(manager.listTerminals().map((terminal) => terminal.id).sort(), ["keep-cwd", "keep-provider", "keep-running"]);
  delete require.cache[modulePath];
  if (previousState === undefined) delete global.__piWebTerminalState;
  else global.__piWebTerminalState = previousState;
});

test("terminal stats distinguish workspace usage from global limits", () => {
  const modulePath = require.resolve("./terminal-manager.cjs");
  const previousState = global.__piWebTerminalState;
  const record = (id, state, cwd, bufferBytes) => ({ id, state, cwd, bufferBytes, chunks: [], subscribers: new Set(), createdAt: "2026-01-01T00:00:00Z" });
  const sessions = [record("one", "running", "/one", 10), record("two", "ended", "/one", 20), record("three", "running", "/two", 30)];
  global.__piWebTerminalState = { sessions: new Map(sessions.map((session) => [session.id, session])) };
  delete require.cache[modulePath];
  try {
    const stats = require("./terminal-manager.cjs").terminalStats("/one");
    assert.deepEqual(stats.workspace, { running: 1, records: 2, bufferBytes: 30 });
    assert.deepEqual(stats.global, { running: 2, records: 3, bufferBytes: 60 });
    assert.deepEqual(stats.limits, { running: 20, records: 100 });
  } finally {
    delete require.cache[modulePath];
    if (previousState === undefined) delete global.__piWebTerminalState;
    else global.__piWebTerminalState = previousState;
  }
});
