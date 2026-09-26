/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Module = require("node:module");
const { Readable } = require("node:stream");

const notifications = require("../notifications.cjs");
const notificationsApi = require("../notifications-api.cjs");
const workspaceStatus = require("../workspace-status.cjs");
const appServer = require("./codex-app-server.cjs");

const DAY = 24 * 60 * 60 * 1000;

// Each test gets its own notifications file in a temp dir.
function useLog(t, seed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-notifications-"));
  const file = path.join(dir, "notifications.json");
  if (seed !== undefined) fs.writeFileSync(file, typeof seed === "string" ? seed : JSON.stringify(seed));
  const previous = process.env.PI_WEB_NOTIFICATIONS_FILE;
  process.env.PI_WEB_NOTIFICATIONS_FILE = file;
  notifications._resetForTests();
  t.after(() => {
    process.env.PI_WEB_NOTIFICATIONS_FILE = previous;
    notifications._resetForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { file, saved: () => JSON.parse(fs.readFileSync(file, "utf8")).notifications };
}

const entry = (id, extra = {}) => ({ id, kind: "codex", event: "completed", targetId: `t-${id}`, cwd: "/a", title: id, createdAt: Date.now(), read: false, ...extra });

test("add persists entries newest first and pushes a notifications snapshot", (t) => {
  const { saved } = useLog(t);
  const notify = t.mock.method(workspaceStatus, "notify", () => {});
  notifications.add({ kind: "codex", event: "completed", targetId: "a", cwd: "/a", title: "  first\n chat " });
  notifications.add({ kind: "terminal", event: "failed", targetId: "b", cwd: "/a", projectRoot: "/a", title: "", detail: "Exited with code 1" });
  const [latest, first] = notifications.list();
  assert.equal(first.title, "first chat");
  assert.equal(latest.title, "b");
  assert.equal(latest.detail, "Exited with code 1");
  assert.equal("projectRoot" in latest, false);
  assert.deepEqual(saved().map((item) => item.targetId), ["a", "b"]);
  assert.deepEqual(notify.mock.calls.map((call) => call.arguments[0]), ["notifications", "notifications"]);
  const message = workspaceStatus.snapshot("notifications");
  assert.equal(message.unread, 2);
  assert.equal(message.notifications[0].id, latest.id);
});

test("add rejects unknown kinds and events", (t) => {
  useLog(t);
  assert.equal(notifications.add({ kind: "gemini", event: "completed", targetId: "a" }), null);
  assert.equal(notifications.add({ kind: "codex", event: "started", targetId: "a" }), null);
  assert.equal(notifications.add({ kind: "codex", event: "completed", targetId: "" }), null);
  assert.equal(notifications.list().length, 0);
});

test("a new event for a target marks that target's older entries read", (t) => {
  useLog(t);
  const approval = notifications.add({ kind: "codex", event: "approval", targetId: "a", cwd: "/a", title: "Chat" });
  const other = notifications.add({ kind: "pi", event: "completed", targetId: "a", cwd: "/a", title: "Session" });
  notifications.add({ kind: "codex", event: "completed", targetId: "a", cwd: "/a", title: "Chat" });
  const byId = new Map(notifications.list().map((item) => [item.id, item]));
  assert.equal(byId.get(approval.id).read, true);
  assert.equal(byId.get(other.id).read, false);
  assert.equal(workspaceStatus.snapshot("notifications").unread, 2);
});

test("entries older than 7 days and beyond 200 are pruned", (t) => {
  const old = entry("old", { createdAt: Date.now() - 8 * DAY });
  const many = Array.from({ length: notifications.MAX_ENTRIES }, (_, index) => entry(`e${index}`));
  const { saved } = useLog(t, { version: 1, notifications: [old, ...many] });
  assert.equal(notifications.list().length, notifications.MAX_ENTRIES);
  assert.equal(saved().some((item) => item.id === "old"), false);
  notifications.add({ kind: "codex", event: "completed", targetId: "new", cwd: "/a", title: "New" });
  const ids = notifications.list().map((item) => item.id);
  assert.equal(ids.length, notifications.MAX_ENTRIES);
  assert.equal(ids.includes("e0"), false);
  assert.equal(notifications.list()[0].targetId, "new");
});

test("read state is saved and survives a reload", (t) => {
  useLog(t, { version: 1, notifications: [entry("a"), entry("b"), entry("c")] });
  assert.equal(notifications.markRead({ ids: ["a", "missing"] }), 1);
  assert.equal(notifications.markRead({ ids: ["a"] }), 0);
  notifications._resetForTests();
  assert.deepEqual(notifications.list().filter((item) => item.read).map((item) => item.id), ["a"]);
  assert.equal(notifications.markRead({ all: true }), 2);
  notifications._resetForTests();
  assert.equal(workspaceStatus.snapshot("notifications").unread, 0);
});

test("a corrupt or malformed file starts an empty list", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  useLog(t, "{not json");
  assert.deepEqual(notifications.list(), []);
  assert.equal(warn.mock.callCount(), 1);
  notifications.add({ kind: "codex", event: "completed", targetId: "a", cwd: "/a", title: "A" });
  assert.equal(notifications.list().length, 1);
});

test("malformed entries in the file are dropped", (t) => {
  useLog(t, { version: 1, notifications: [entry("good"), { id: "bad", kind: "mail" }, null] });
  assert.deepEqual(notifications.list().map((item) => item.id), ["good"]);
});

function call(method, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))]);
  req.method = method;
  req.url = "/api/notifications/read";
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
      writeHead(status, headers = {}) { this.statusCode = status; Object.assign(this.headers, headers); return this; },
      end(data) { resolve({ status: this.statusCode, body: data ? JSON.parse(String(data)) : null }); },
    };
    notificationsApi.handle(req, res);
  });
}

test("the read API validates its body and marks entries read", async (t) => {
  useLog(t, { version: 1, notifications: [entry("a"), entry("b")] });
  assert.equal(notificationsApi.isPath("/api/notifications/read"), true);
  assert.equal(notificationsApi.isPath("/api/notifications"), false);
  assert.equal((await call("GET")).status, 405);
  assert.equal((await call("POST", "{bad")).status, 400);
  assert.equal((await call("POST", { ids: [1] })).status, 400);
  assert.equal((await call("POST", { all: "yes" })).status, 400);
  assert.deepEqual(await call("POST", { ids: ["a"] }), { status: 200, body: { changed: 1 } });
  assert.deepEqual(await call("POST", { all: true }), { status: 200, body: { changed: 1 } });
});

function loadTerminalManagerWithFakePty(t) {
  const modulePath = require.resolve("./terminal-manager.cjs");
  const previousState = global.__piWebTerminalState;
  const previousLoad = Module._load;
  const handlers = [];
  global.__piWebTerminalState = { sessions: new Map() };
  Module._load = function (request, parent, isMain) {
    if (request === "node-pty") {
      return { spawn() { const own = {}; handlers.push(own); return { pid: -1, onData(fn) { own.data = fn; }, onExit(fn) { own.exit = fn; }, write() {}, resize() {}, kill() {} }; } };
    }
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

test("terminal exits are recorded unless stopped or a clean shell exit; finished tasks are", (t) => {
  useLog(t);
  t.mock.method(workspaceStatus, "notify", () => {});
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-fake-codex-"));
  fs.writeFileSync(path.join(bin, "codex"), "#!/bin/sh\n", { mode: 0o755 });
  const previous = { SHELL: process.env.SHELL, PATH: process.env.PATH };
  process.env.SHELL = "/bin/sh";
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  t.after(() => { Object.assign(process.env, previous); fs.rmSync(bin, { recursive: true, force: true }); });
  const { manager, handlers } = loadTerminalManagerWithFakePty(t);

  const failed = manager.createTerminal({ provider: "shell", cwd: "/tmp", title: "Build" });
  handlers[0].exit({ exitCode: 1, signal: 0 });
  manager.createTerminal({ provider: "shell", cwd: "/tmp" });
  handlers[1].exit({ exitCode: 0, signal: 0 });
  const stopped = manager.createTerminal({ provider: "shell", cwd: "/tmp" });
  manager.stopTerminal(stopped.id);
  handlers[2].exit({ exitCode: 0, signal: 15 });
  const codex = manager.createTerminal({ provider: "codex", cwd: "/tmp", title: "Codex" });
  handlers[3].exit({ exitCode: 0, signal: 0 });
  const task = manager.createTerminal({ provider: "shell", cwd: "/tmp", title: "Task: build" });
  handlers[4].exit({ exitCode: 0, signal: 0 });

  const recorded = notifications.list();
  assert.deepEqual(recorded.map((item) => [item.targetId, item.event]), [[task.id, "completed"], [codex.id, "completed"], [failed.id, "failed"]]);
  assert.equal(recorded[2].detail, "Exited with code 1");
  assert.equal(recorded[2].title, "Build");
});

function protocolState() {
  return { threadId: "th", cwd: "/a", title: "", activeTurnId: null, incoming: new Map(), pending: new Map(), events: [], listeners: new Set(), nextEventSeq: 1 };
}

test("Codex turns record completed, failed and approval; interrupted turns do not", (t) => {
  useLog(t);
  t.mock.method(workspaceStatus, "notify", () => {});
  const state = protocolState();
  appServer.handleProtocolMessage(state, { method: "thread/name/updated", params: { threadId: "th", threadName: "Fix tests" } });
  appServer.handleProtocolMessage(state, { method: "turn/started", params: { turn: { id: "1" } } });
  appServer.handleProtocolMessage(state, { id: 900, method: "item/commandExecution/requestApproval", params: { command: "npm test" } });
  appServer.handleProtocolMessage(state, { method: "turn/completed", params: { turn: { id: "1", status: "completed", error: null } } });
  appServer.handleProtocolMessage(state, { method: "turn/started", params: { turn: { id: "2" } } });
  appServer.handleProtocolMessage(state, { method: "turn/completed", params: { turn: { id: "2", status: "interrupted", error: null } } });
  appServer.handleProtocolMessage(state, { method: "turn/started", params: { turn: { id: "3" } } });
  appServer.handleProtocolMessage(state, { method: "turn/completed", params: { turn: { id: "3", status: "failed", error: { message: "Rate limited" } } } });

  const recorded = notifications.list();
  assert.deepEqual(recorded.map((item) => [item.event, item.read]), [["failed", false], ["completed", true], ["approval", true]]);
  assert.equal(recorded[0].detail, "Rate limited");
  assert.ok(recorded.every((item) => item.title === "Fix tests" && item.kind === "codex" && item.targetId === "th" && item.cwd === "/a"));
});

const FAKE_SERVER = path.join(__dirname, "fixtures", "fake-codex-app-server.cjs");
const THREAD = "22222222-2222-2222-2222-222222222222";

test("a Codex runtime that dies mid-turn records a failure; an idle one does not", async (t) => {
  useLog(t);
  t.mock.method(console, "warn", () => {});
  appServer.failState(protocolState(), new Error("exited"));
  assert.equal(notifications.list().length, 0);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-codex-notify-"));
  const stateFile = path.join(dir, "state.json");
  fs.writeFileSync(stateFile, JSON.stringify({ threads: [{ id: THREAD, name: "Deploy", cwd: dir, archived: false, path: path.join(dir, "rollout.jsonl") }] }));
  appServer.configure({ command: process.execPath, args: [FAKE_SERVER], env: { ...process.env, FAKE_CODEX_STATE: stateFile }, idleMs: 60 });
  t.after(() => { appServer.configure(null); fs.rmSync(dir, { recursive: true, force: true }); });
  const runtime = appServer.start({ threadId: THREAD, cwd: dir });
  await appServer.prompt(runtime, "long task");
  runtime.child.kill("SIGKILL");
  await new Promise((resolve) => { const poll = () => (notifications.list().length ? resolve() : setTimeout(poll, 10)); poll(); });
  const [failed] = notifications.list();
  assert.deepEqual([failed.event, failed.title, failed.detail, failed.cwd], ["failed", "Deploy", "Codex app-server exited", dir]);
});

test("runtimes ended by a server shutdown are not recorded as failed", async (t) => {
  useLog(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-codex-notify-"));
  const stateFile = path.join(dir, "state.json");
  fs.writeFileSync(stateFile, JSON.stringify({ threads: [{ id: THREAD, name: "Deploy", cwd: dir, archived: false, path: path.join(dir, "rollout.jsonl") }] }));
  appServer.configure({ command: process.execPath, args: [FAKE_SERVER], env: { ...process.env, FAKE_CODEX_STATE: stateFile }, idleMs: 60 });
  t.after(() => { appServer.configure(null); fs.rmSync(dir, { recursive: true, force: true }); });
  const runtime = appServer.start({ threadId: THREAD, cwd: dir });
  await appServer.prompt(runtime, "long task");
  const exited = new Promise((resolve) => runtime.child.once("exit", resolve));
  appServer.shutdownRuntimes();
  await exited;
  assert.equal(appServer.isClaimed(THREAD), false);
  assert.equal(notifications.list().length, 0);
});
