"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { Readable } = require("node:stream");

const catalog = require("./claude-sessions.cjs");
const terminalApi = require("./terminal-api.cjs");
const terminalManager = require("./terminal-manager.cjs");
const api = require("./claude-sessions-api.cjs");

const IDS = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"];

// A temp Claude config dir (test-env.cjs already points CLAUDE_CONFIG_DIR at
// one; each test gets its own) with a fake workspace folder.
function claudeHome(t, cwd = "/work/app") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-claude-home-"));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  t.after(() => { process.env.CLAUDE_CONFIG_DIR = previous; fs.rmSync(home, { recursive: true, force: true }); });
  const dir = path.join(home, "projects", catalog.encodeCwd(cwd));
  fs.mkdirSync(dir, { recursive: true });
  let clock = Date.parse("2026-09-01T00:00:00Z");
  const write = (id, records, { directory = dir } = {}) => {
    const target = path.join(directory, `${id}.jsonl`);
    fs.writeFileSync(target, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    clock += 60_000;
    fs.utimesSync(target, clock / 1000, clock / 1000);
    return target;
  };
  return { home, dir, cwd, write };
}
const user = (content, extra = {}) => ({ type: "user", cwd: "/work/app", gitBranch: "main", timestamp: "2026-09-01T00:00:00.000Z", message: { role: "user", content }, ...extra });

test("lists the folder's sessions newest first with prompt, title and size", (t) => {
  const { dir, write } = claudeHome(t);
  write(IDS[0], [
    { type: "permission-mode", permissionMode: "default", sessionId: IDS[0] },
    { type: "attachment", cwd: "/work/app", attachment: { type: "hook_success", content: "x".repeat(100_000) } },
    user("<command-name>/model</command-name>"),
    user("Caveat", { isMeta: true }),
    user([{ type: "tool_result", content: "ok" }]),
    user([{ type: "text", text: "Fix   the\nlogin bug" }]),
    { type: "assistant", message: { content: [{ type: "text", text: "Done" }] } },
  ]);
  write(IDS[1], [user("Add dark mode"), { type: "ai-title", aiTitle: "Old title" }, { type: "custom-title", customTitle: "Theme work" }, { type: "ai-title", aiTitle: "Dark mode" }]);
  write(IDS[2], [user("Tune tests"), { type: "ai-title", aiTitle: "Test tuning" }]);
  // Opened and left without a prompt, or only title records: nothing to resume.
  write(IDS[3], [{ type: "permission-mode", permissionMode: "default" }, { type: "ai-title", aiTitle: "Only a title" }]);
  // Same encoded folder name, different workspace.
  write(IDS[4], [user("Other folder", { cwd: "/work-app" })]);
  fs.writeFileSync(path.join(dir, "notes.jsonl"), "{}\n");
  fs.mkdirSync(path.join(dir, IDS[0]));

  const { sessions, nextCursor } = catalog.listSessions({ cwd: "/work/app" });
  assert.equal(nextCursor, null);
  assert.deepEqual(sessions.map((session) => [session.id, session.title, session.firstMessage]), [
    [IDS[2], "Test tuning", "Tune tests"],
    [IDS[1], "Theme work", "Add dark mode"],
    [IDS[0], "Fix the login bug", "Fix the login bug"],
  ]);
  assert.equal(sessions[2].gitBranch, "main");
  assert.equal(sessions[2].cwd, "/work/app");
  assert.equal(sessions[2].size, fs.statSync(path.join(dir, `${IDS[0]}.jsonl`)).size);
  assert.equal(sessions[2].updatedAt, fs.statSync(path.join(dir, `${IDS[0]}.jsonl`)).mtime.toISOString());
});

test("searches, pages with an offset cursor and picks up file changes", (t) => {
  const { write } = claudeHome(t);
  write(IDS[0], [user("First task")]);
  write(IDS[1], [user("Second task")]);
  write(IDS[2], [user("Third thing")]);

  assert.deepEqual(catalog.listSessions({ cwd: "/work/app", query: "TASK" }).sessions.map((session) => session.id), [IDS[1], IDS[0]]);
  assert.deepEqual(catalog.listSessions({ cwd: "/work/app", query: IDS[2].slice(0, 8) }).sessions.map((session) => session.id), [IDS[2]]);
  const first = catalog.listSessions({ cwd: "/work/app", limit: 2 });
  assert.deepEqual(first.sessions.map((session) => session.id), [IDS[2], IDS[1]]);
  assert.equal(first.nextCursor, "2");
  const second = catalog.listSessions({ cwd: "/work/app", limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.sessions.map((session) => session.id), [IDS[0]]);
  assert.equal(second.nextCursor, null);

  // A rename appends a title record; the cached entry is replaced.
  write(IDS[0], [user("First task"), { type: "custom-title", customTitle: "Renamed" }]);
  assert.equal(catalog.listSessions({ cwd: "/work/app" }).sessions[0].title, "Renamed");
  assert.throws(() => catalog.listSessions({ cwd: "relative" }), { code: "invalid_cwd" });
});

test("finds sessions of a folder whose encoded name Claude shortened", (t) => {
  const cwd = `/${"deep/".repeat(45)}app`;
  const { home, write } = claudeHome(t, "/unused");
  const encoded = catalog.encodeCwd(cwd);
  assert.ok(encoded.length > 200);
  const directory = path.join(home, "projects", `${encoded.slice(0, 200)}-abc123`);
  fs.mkdirSync(directory);
  write(IDS[0], [user("Long path", { cwd })], { directory });
  assert.deepEqual(catalog.listSessions({ cwd }).sessions.map((session) => session.title), ["Long path"]);
  assert.equal(catalog.requireSession(IDS[0], cwd).title, "Long path");
});

test("skips over very long head lines and keeps a found head while the file grows", (t) => {
  const { dir, write } = claudeHome(t);
  const target = write(IDS[0], [{ type: "attachment", cwd: "/work/app", attachment: { content: "x".repeat(3 * 1024 * 1024) } }, user("After a big hook output")]);
  assert.equal(catalog.listSessions({ cwd: "/work/app" }).sessions[0].firstMessage, "After a big hook output");
  // Appended records do not change the head; only the tail is re-read.
  fs.appendFileSync(target, `${JSON.stringify({ type: "ai-title", aiTitle: "Big output" })}\n`);
  const [session] = catalog.listSessions({ cwd: "/work/app" }).sessions;
  assert.deepEqual([session.title, session.firstMessage], ["Big output", "After a big hook output"]);
  assert.equal(session.size, fs.statSync(path.join(dir, `${IDS[0]}.jsonl`)).size);
});

test("hides filesystem errors behind not_found", (t) => {
  const { write } = claudeHome(t);
  const target = write(IDS[0], [user("Locked")]);
  fs.chmodSync(target, 0);
  assert.throws(() => catalog.requireSession(IDS[0], "/work/app"), (cause) => cause.code === "not_found" && !cause.message.includes(target));
});

test("looks up and deletes a session with its sidecar folder", (t) => {
  const { dir, write } = claudeHome(t);
  write(IDS[0], [user("Keep me")]);
  write(IDS[1], [user("Delete me")]);
  fs.mkdirSync(path.join(dir, IDS[1], "subagents"), { recursive: true });

  assert.throws(() => catalog.requireSession("../x", "/work/app"), { code: "invalid_session" });
  assert.throws(() => catalog.requireSession(IDS[2], "/work/app"), { code: "not_found" });
  assert.throws(() => catalog.requireSession(IDS[0], "/elsewhere"), { code: "not_found" });
  assert.equal(catalog.remove(IDS[1], "/work/app").title, "Delete me");
  assert.equal(fs.existsSync(path.join(dir, `${IDS[1]}.jsonl`)), false);
  assert.equal(fs.existsSync(path.join(dir, IDS[1])), false);
  assert.deepEqual(catalog.listSessions({ cwd: "/work/app" }).sessions.map((session) => session.id), [IDS[0]]);
});

function stub(t, target, name, value) {
  const original = target[name];
  target[name] = value;
  t.after(() => { target[name] = original; });
}
async function request(method, pathname, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, headers: {} });
  const res = { status: 0, text: "", writeHead(status) { this.status = status; }, end(text) { this.text = text || ""; } };
  const url = new URL(pathname, "http://localhost");
  assert.equal(api.isPath(url.pathname), true);
  await api.handle(req, res, url);
  return { status: res.status, body: res.text ? JSON.parse(res.text) : null };
}
function apiSetup(t, { terminals = [], runtime = null } = {}) {
  const home = claudeHome(t);
  stub(t, terminalApi, "authorizedCwd", (cwd) => { if (cwd !== "/work/app") throw Object.assign(new Error("not authorized"), { code: "forbidden_cwd" }); return cwd; });
  stub(t, terminalManager, "listTerminals", (cwd) => terminals.filter((terminal) => !cwd || (terminal.cwd || "/work/app") === cwd));
  stub(t, terminalManager, "runtimeForSession", () => runtime);
  return home;
}

test("the API lists without file paths and requires an authorized folder", async (t) => {
  const { write } = apiSetup(t);
  write(IDS[0], [user("Hello")]);
  const response = await request("GET", "/api/claude/sessions?cwd=/work/app&limit=1");
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body.sessions[0]).sort(), ["createdAt", "cwd", "firstMessage", "gitBranch", "id", "runtime", "size", "title", "updatedAt"]);
  assert.equal((await request("GET", "/api/claude/sessions")).status, 400);
  assert.equal((await request("GET", "/api/claude/sessions?cwd=/other")).status, 403);
  assert.equal((await request("POST", "/api/claude/sessions?cwd=/work/app")).status, 405);
  assert.equal(api.isPath(`/api/claude/sessions/${IDS[0]}`), false);
});

test("the API deletes an idle session and refuses one a terminal may write", async (t) => {
  const { dir, write } = apiSetup(t, {
    terminals: [
      // A resumed session can /clear or /resume another one, so it counts too.
      { provider: "claude", state: "running", launchMode: "resume", sourceSessionId: IDS[4], createdAt: "2026-09-01T00:01:30.000Z" },
      { provider: "claude", state: "ended", launchMode: "new", createdAt: "2026-08-01T00:00:00.000Z" },
      { provider: "shell", state: "running", launchMode: "new", createdAt: "2026-08-01T00:00:00.000Z" },
      { provider: "claude", state: "running", launchMode: "new", cwd: "/work/other", createdAt: "2026-08-01T00:00:00.000Z" },
    ],
  });
  write(IDS[0], [user("Old")]); // 00:01, before the running terminal started
  write(IDS[1], [user("Recent")]); // 00:02, possibly written by it

  const busy = await request("POST", `/api/claude/sessions/${IDS[1]}/delete`, { cwd: "/work/app" });
  assert.equal(busy.status, 409);
  assert.equal(busy.body.code, "session_busy");
  assert.equal(fs.existsSync(path.join(dir, `${IDS[1]}.jsonl`)), true);

  const deleted = await request("POST", `/api/claude/sessions/${IDS[0]}/delete`, { cwd: "/work/app" });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.session.path, undefined);
  assert.equal(fs.existsSync(path.join(dir, `${IDS[0]}.jsonl`)), false);
  assert.equal((await request("POST", `/api/claude/sessions/${IDS[0]}/delete`, { cwd: "/work/app" })).status, 404);
  assert.equal((await request("POST", `/api/claude/sessions/${IDS[1]}/delete`, { cwd: "/other" })).status, 403);
});

test("the API refuses to delete a session resumed in a terminal", async (t) => {
  const { dir, write } = apiSetup(t, { runtime: { owner: "terminal", state: "running", terminalId: "t1" } });
  write(IDS[0], [user("Open")]);
  const response = await request("POST", `/api/claude/sessions/${IDS[0]}/delete`, { cwd: "/work/app" });
  assert.equal(response.status, 409);
  assert.equal(fs.existsSync(path.join(dir, `${IDS[0]}.jsonl`)), true);
});

// A fresh terminal manager with a fake pty and a fake `claude` on PATH that
// advertises the bypass flag in --help.
function fakeClaudeManager(t) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-fake-claude-"));
  fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\necho '--dangerously-skip-permissions'\n", { mode: 0o755 });
  const previous = { PATH: process.env.PATH, state: global.__piWebTerminalState, load: Module._load };
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  global.__piWebTerminalState = { sessions: new Map() };
  const spawns = [];
  Module._load = function (request, parent, isMain) {
    // The --settings hooks are covered by terminal-activity.test.cjs.
    if (request === "node-pty") return { spawn(executable, args) { spawns.push(args[0] === "--settings" ? args.slice(2) : args); return { pid: -1, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} }; } };
    return previous.load.call(this, request, parent, isMain);
  };
  const modulePath = require.resolve("./terminal-manager.cjs");
  delete require.cache[modulePath];
  const manager = require("./terminal-manager.cjs");
  t.after(() => {
    Module._load = previous.load;
    delete require.cache[modulePath];
    process.env.PATH = previous.PATH;
    if (previous.state === undefined) delete global.__piWebTerminalState;
    else global.__piWebTerminalState = previous.state;
    fs.rmSync(bin, { recursive: true, force: true });
  });
  return { manager, spawns };
}

test("Claude terminals resume or fork a session and own it while resumed", (t) => {
  const { manager, spawns } = fakeClaudeManager(t);
  const resumed = manager.createTerminal({ provider: "claude", cwd: "/tmp", launchMode: "resume", sourceSessionId: IDS[0] });
  manager.createTerminal({ provider: "claude", cwd: "/tmp", launchMode: "fork", sourceSessionId: IDS[1], permissionMode: "bypass" });
  manager.createTerminal({ provider: "claude", cwd: "/tmp" });
  assert.deepEqual(spawns, [["--resume", IDS[0]], ["--resume", IDS[1], "--fork-session", "--dangerously-skip-permissions"], []]);
  assert.deepEqual(manager.runtimeForSession(IDS[0]), { owner: "terminal", state: "running", terminalId: resumed.id });
  assert.equal(manager.runtimeForSession(IDS[1]), null);
  assert.throws(() => manager.createTerminal({ provider: "claude", cwd: "/tmp", launchMode: "resume", sourceSessionId: "--help" }), { code: "invalid_session" });
  assert.throws(() => manager.createTerminal({ provider: "claude", cwd: "/tmp", launchMode: "resume-last" }), { code: "unsupported_launch_mode" });
  assert.throws(() => manager.createTerminal({ provider: "claude", cwd: "/tmp", permissionMode: "never" }), { code: "invalid_permission_mode" });
});

test("Claude terminals start in plan or accept-edits mode, with a model and a first message", (t) => {
  const { manager, spawns } = fakeClaudeManager(t);
  const planned = manager.createTerminal({ provider: "claude", cwd: "/tmp", permissionMode: "plan", model: "opus", initialPrompt: "  Review the diff  ", title: "Review changes" });
  manager.createTerminal({ provider: "claude", cwd: "/tmp", launchMode: "fork", sourceSessionId: IDS[1], permissionMode: "accept-edits", initialPrompt: "-v means verbose" });
  assert.deepEqual(spawns, [
    ["--permission-mode", "plan", "--model", "opus", "Review the diff"],
    ["--resume", IDS[1], "--fork-session", "--permission-mode", "acceptEdits", "--", "-v means verbose"],
  ]);
  assert.equal(planned.title, "Review changes");
  assert.equal(planned.permissionMode, "plan");
  assert.throws(() => manager.createTerminal({ provider: "claude", cwd: "/tmp", model: "opus; rm" }), { code: "invalid_model" });
  assert.throws(() => manager.createTerminal({ provider: "codex", cwd: "/tmp", permissionMode: "plan" }), { code: "invalid_permission_mode" });
});

test("the terminal API resumes only a session of the folder, once at a time", async (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-claude-cwd-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const { write } = claudeHome(t, base);
  write(IDS[0], [user("Resume me", { cwd: base })]);
  terminalApi.addRoot(base);
  const created = [];
  stub(t, terminalManager, "createTerminal", (options) => { created.push(options); return { id: "t1", ...options }; });
  let runtime = null;
  stub(t, terminalManager, "runtimeForSession", () => runtime);
  const post = async (body) => {
    const req = Readable.from([Buffer.from(JSON.stringify({ provider: "claude", cwd: base, ...body }))]);
    Object.assign(req, { method: "POST", headers: {} });
    const res = { status: 0, text: "", writeHead(status) { this.status = status; }, end(text) { this.text = text || ""; } };
    await terminalApi.handleTerminalRequest(req, res, new URL("/api/terminals", "http://localhost"));
    return { status: res.status, body: JSON.parse(res.text) };
  };

  assert.equal((await post({ launchMode: "resume", sourceSessionId: IDS[1] })).status, 404);
  assert.equal((await post({ launchMode: "fork", sourceSessionId: IDS[0] })).status, 201);
  assert.equal((await post({ launchMode: "resume", sourceSessionId: IDS[0] })).status, 201);
  runtime = { owner: "terminal", state: "running", terminalId: "t1" };
  const busy = await post({ launchMode: "resume", sourceSessionId: IDS[0] });
  assert.equal(busy.status, 409);
  assert.equal(busy.body.code, "session_busy");
  // Forking only reads the session, so it may run beside the resumed terminal.
  assert.equal((await post({ launchMode: "fork", sourceSessionId: IDS[0] })).status, 201);
  assert.deepEqual(created.map((options) => [options.launchMode, options.sourceSessionId]), [["fork", IDS[0]], ["resume", IDS[0]], ["fork", IDS[0]]]);
});
