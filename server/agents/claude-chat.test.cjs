/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Readable } = require("node:stream");

const chat = require("./claude-chat-runtime.cjs");
const catalog = require("./claude-sessions.cjs");
const terminalApi = require("./terminal-api.cjs");
const terminalManager = require("./terminal-manager.cjs");
const notifications = require("../notifications.cjs");
const workspaceStatus = require("../workspace-status.cjs");
const api = require("./claude-chat-api.cjs");

const FAKE_CLAUDE = path.join(__dirname, "fixtures", "fake-claude.cjs");
const ID = "11111111-1111-4111-8111-111111111111";
const IDLE_MS = 60;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleep(10);
  }
}
function stub(t, target, name, value) {
  const original = target[name];
  target[name] = value;
  t.after(() => { target[name] = original; });
}

// The fake `claude` runs in a temp workspace and writes its transcripts to a
// temp Claude config dir; nothing touches ~/.claude.
function useFakeClaude(t) {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-claude-chat-")));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-claude-chat-home-"));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  const log = path.join(cwd, "log.jsonl");
  chat.configure({ command: process.execPath, args: [FAKE_CLAUDE], env: { ...process.env, CLAUDE_CONFIG_DIR: home, FAKE_CLAUDE_LOG: log }, idleMs: IDLE_MS });
  fs.rmSync(process.env.PI_WEB_NOTIFICATIONS_FILE, { force: true });
  notifications._resetForTests();
  stub(t, terminalApi, "authorizedCwd", (value) => { if (value !== cwd) throw Object.assign(new Error("not authorized"), { code: "forbidden_cwd" }); return value; });
  t.after(() => {
    chat.shutdownRuntimes();
    chat.configure(null);
    process.env.CLAUDE_CONFIG_DIR = previous;
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  const entries = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  const launches = () => entries().filter((entry) => entry.argv).map((entry) => entry.argv);
  const stdin = () => entries().filter((entry) => entry.stdin).map((entry) => entry.stdin);
  const transcript = (id = ID) => path.join(home, "projects", catalog.encodeCwd(cwd), `${id}.jsonl`);
  return { cwd, home, launches, stdin, transcript };
}
function collect(state) {
  const events = [];
  const off = chat.subscribe(state, (event) => events.push(event));
  return { events, off, types: () => events.map((event) => event.type) };
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

test("a new chat starts Claude with its own session id and keeps the process for the next message", async (t) => {
  const { cwd, launches, stdin, transcript } = useFakeClaude(t);
  const state = chat.open(ID, cwd);
  const { events, off, types } = collect(state);
  t.after(off);
  const uuid = "22222222-2222-4222-8222-222222222222";
  assert.deepEqual(await chat.send(state, { text: "hello", uuid }), { uuid });
  assert.equal(chat.runtimeForSession(ID).state, "running");
  await waitFor(() => types().includes("result"));
  assert.deepEqual(events[0], { type: "user", uuid, timestamp: events[0].timestamp, message: { role: "user", content: "hello" }, piSeq: 1, piRuntime: state.runtimeId });
  const assistant = events.find((event) => event.type === "assistant");
  assert.equal(assistant.message.content[0].text, "Echo: hello");
  assert.equal(assistant.piBlockIndex, 0);
  assert.ok(types().includes("stream_event"));
  assert.equal(chat.runtimeForSession(ID).state, "idle");
  // Deltas are dropped once the turn is recorded.
  assert.equal(state.events.some((event) => event.type === "stream_event"), false);
  assert.ok(fs.existsSync(transcript()));

  await chat.send(state, { text: "again" });
  await waitFor(() => events.filter((event) => event.type === "result").length === 2);
  assert.equal(launches().length, 1);
  assert.ok(launches()[0].includes("--session-id") && launches()[0].includes(ID));
  assert.deepEqual(launches()[0].slice(launches()[0].indexOf("--permission-prompt-tool"), launches()[0].indexOf("--permission-prompt-tool") + 2), ["--permission-prompt-tool", "stdio"]);
  assert.equal(stdin()[0].uuid, uuid);
  assert.deepEqual(notifications.list().map((entry) => [entry.kind, entry.event, entry.title]), [["claude", "completed", "hello"], ["claude", "completed", "hello"]]);
});

test("a stopped chat resumes the session; another model or permission mode restarts Claude", async (t) => {
  const { cwd, launches } = useFakeClaude(t);
  const state = chat.open(ID, cwd);
  const { events, off } = collect(state);
  t.after(off);
  await chat.send(state, { text: "one" });
  await waitFor(() => events.some((event) => event.type === "result"));
  await chat.send(state, { text: "two", model: "haiku", permissionMode: "plan" });
  await waitFor(() => events.filter((event) => event.type === "result").length === 2);
  assert.equal(launches().length, 2);
  const second = launches()[1];
  assert.deepEqual(second.slice(second.indexOf("--resume"), second.indexOf("--resume") + 2), ["--resume", ID]);
  assert.deepEqual(second.slice(second.indexOf("--model"), second.indexOf("--model") + 2), ["--model", "haiku"]);
  assert.deepEqual(second.slice(second.indexOf("--permission-mode"), second.indexOf("--permission-mode") + 2), ["--permission-mode", "plan"]);
  await assert.rejects(chat.send(state, { text: "x", model: "gpt" }), { code: "invalid_request" });
  await assert.rejects(chat.send(state, { text: "x", permissionMode: "yolo" }), { code: "invalid_request" });
});

test("a restart counts as busy and gives up if the server shuts the chat down meanwhile", async (t) => {
  const { cwd, launches } = useFakeClaude(t);
  const state = chat.open(ID, cwd);
  const { events, off } = collect(state);
  t.after(off);
  await chat.send(state, { text: "one" });
  await waitFor(() => events.some((event) => event.type === "result"));
  const restart = chat.send(state, { text: "two", model: "haiku" });
  assert.equal(chat.isBusySession(ID), true);
  await assert.rejects(chat.send(state, { text: "three" }), { code: "session_busy" });
  chat.shutdownRuntimes();
  await assert.rejects(restart, { code: "runtime_unavailable" });
  assert.equal(launches().length, 1);
});

test("a client resuming from events that left the buffer is told to reload", (t) => {
  const { cwd } = useFakeClaude(t);
  const state = chat.open(ID, cwd);
  for (let index = 0; index < 2_010; index += 1) chat.handleRecord(state, { type: "system", subtype: "status", permissionMode: "plan" });
  assert.equal(state.events.length, 2_000);
  const stale = [];
  chat.subscribe(state, (event) => stale.push(event), 5)();
  assert.deepEqual(stale, [{ type: "pi/reset" }]);
  const current = [];
  chat.subscribe(state, (event) => current.push(event), 2_009)();
  assert.deepEqual(current.map((event) => event.piSeq), [2_010]);
});

test("a permission prompt waits for the answer; allow for session applies Claude's suggestion", async (t) => {
  const { cwd, stdin } = useFakeClaude(t);
  const state = chat.open(ID, cwd);
  const first = collect(state);
  await chat.send(state, { text: "please write a file" });
  await waitFor(() => chat.runtimeForSession(ID)?.state === "approval");
  // No viewer: the prompt keeps the process up.
  first.off();
  await sleep(IDLE_MS * 3);
  assert.equal(chat.runtimeForSession(ID).state, "approval");
  const { events, off } = collect(state);
  const request = events.find((event) => event.type === "control_request");
  assert.equal(request.request.tool_name, "Write");
  assert.deepEqual(chat.describe(state).requests.map((entry) => entry.request_id), [request.request_id]);
  assert.throws(() => chat.respond(state, "nope", { decision: "allow" }), { code: "approval_expired" });
  chat.respond(state, request.request_id, { decision: "allowSession" });
  await waitFor(() => events.some((event) => event.type === "result"));
  const answer = stdin().find((entry) => entry.type === "control_response");
  assert.deepEqual(answer.response.response, { behavior: "allow", updatedInput: request.request.input, updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] });
  assert.equal(state.permissionMode, "acceptEdits");
  assert.deepEqual(events.filter((event) => event.type === "pi/resolved").map((event) => event.decision), ["allowSession"]);
  assert.equal(events.find((event) => event.type === "user" && Array.isArray(event.message.content)).message.content[0].tool_use_id, request.request.tool_use_id);
  assert.deepEqual(notifications.list().map((entry) => entry.event), ["completed", "approval"]);
  // With nobody watching, the idle process stops.
  off();
  await waitFor(() => !chat.runtimeForSession(ID));
});

test("a denied prompt reports the reason to Claude", async (t) => {
  const { cwd, stdin } = useFakeClaude(t);
  const state = chat.open(ID, cwd);
  const { events, off } = collect(state);
  t.after(off);
  await chat.send(state, { text: "write it" });
  await waitFor(() => events.some((event) => event.type === "control_request"));
  chat.respond(state, events.find((event) => event.type === "control_request").request_id, { decision: "deny", message: "Not now" });
  await waitFor(() => events.some((event) => event.type === "result"));
  assert.deepEqual(stdin().find((entry) => entry.type === "control_response").response.response, { behavior: "deny", message: "Not now" });
  const result = events.find((event) => event.type === "user" && Array.isArray(event.message.content)).message.content[0];
  assert.equal(result.is_error, true);
});

test("interrupt ends the turn without a notification and keeps the process", async (t) => {
  const { cwd, launches } = useFakeClaude(t);
  const state = chat.open(ID, cwd);
  const { events, off } = collect(state);
  t.after(off);
  await chat.send(state, { text: "long task" });
  await sleep(IDLE_MS * 3);
  assert.equal(chat.runtimeForSession(ID).state, "running");
  await chat.interrupt(state);
  await waitFor(() => events.some((event) => event.type === "result"));
  assert.equal(events.find((event) => event.type === "result").interrupted, true);
  assert.deepEqual(notifications.list(), []);
  await assert.rejects(chat.interrupt(state), { code: "no_active_turn" });
  await chat.send(state, { text: "next" });
  await waitFor(() => events.filter((event) => event.type === "result").length === 2);
  assert.equal(launches().length, 1);
});

test("a crash mid-turn fails the turn; the next message starts Claude again", async (t) => {
  const { cwd, launches } = useFakeClaude(t);
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  t.after(() => { console.warn = warn; });
  const state = chat.open(ID, cwd);
  const { events, off } = collect(state);
  t.after(off);
  await chat.send(state, { text: "crash now" });
  await waitFor(() => events.some((event) => event.type === "pi/closed"));
  // stderr stays in the server log.
  assert.deepEqual(events.find((event) => event.type === "pi/closed"), { type: "pi/closed", error: "Claude exited", piSeq: events.at(-1).piSeq, piRuntime: state.runtimeId });
  assert.match(warnings.join("\n"), /boom in/);
  assert.equal(chat.runtimeForSession(ID), null);
  assert.deepEqual(notifications.list().map((entry) => [entry.event, entry.detail]), [["failed", "Claude exited"]]);
  await chat.send(state, { text: "hello" });
  await waitFor(() => events.some((event) => event.type === "result"));
  assert.equal(launches().length, 2);
});

test("the status stream lists chat processes", async (t) => {
  const { cwd } = useFakeClaude(t);
  const state = chat.open(ID, cwd);
  const { events, off } = collect(state);
  t.after(off);
  assert.deepEqual(workspaceStatus.snapshot("claude_runtimes"), { type: "claude_runtimes", runtimes: [] });
  await chat.send(state, { text: "hello" });
  await waitFor(() => events.some((event) => event.type === "result"));
  assert.deepEqual(workspaceStatus.snapshot("claude_runtimes"), { type: "claude_runtimes", runtimes: [{ sessionId: ID, cwd, title: "hello", owner: "chat", state: "idle", connected: true }] });
});

test("the API creates a chat, reads its history and answers events", async (t) => {
  const { cwd } = useFakeClaude(t);
  const created = await request("POST", "/api/claude/chat", { cwd, text: "first" });
  assert.equal(created.status, 201);
  const id = created.body.sessionId;
  const state = chat.get(id);
  await waitFor(() => state.events.some((event) => event.type === "result"));
  const read = await request("GET", `/api/claude/chat/${id}?cwd=${encodeURIComponent(cwd)}`);
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.history.map((record) => [record.type, typeof record.message.content === "string" ? record.message.content : record.message.content[0].text]), [["user", "first"], ["assistant", "Echo: first"]]);
  assert.equal(read.body.cursor, null);
  assert.equal(read.body.runtime.process, true);
  assert.equal(read.body.terminal, null);
  assert.ok(read.body.events.some((event) => event.type === "result"));

  const sent = await request("POST", `/api/claude/chat/${id}/send`, { cwd, text: "write this" });
  assert.equal(sent.status, 202);
  await waitFor(() => state.incoming.size === 1);
  assert.equal((await request("POST", `/api/claude/chat/${id}/send`, { cwd, text: "more" })).body.code, "session_busy");
  const [requestId] = state.incoming.keys();
  assert.equal((await request("POST", `/api/claude/chat/${id}/respond`, { cwd, requestId, decision: "allow" })).status, 204);
  assert.equal((await request("POST", `/api/claude/chat/${id}/respond`, { cwd, requestId, decision: "allow" })).body.code, "approval_expired");
  await waitFor(() => !state.running);
  assert.equal((await request("POST", `/api/claude/chat/${id}/interrupt`, { cwd })).body.code, "no_active_turn");

  assert.equal((await request("GET", `/api/claude/chat/${id}?cwd=/elsewhere`)).status, 403);
  assert.equal((await request("GET", `/api/claude/chat/${ID}?cwd=${encodeURIComponent(cwd)}`)).status, 404);
  assert.equal((await request("POST", "/api/claude/chat", { cwd, text: " " })).status, 400);
});

test("a chat never writes a session a terminal is resuming", async (t) => {
  const { cwd } = useFakeClaude(t);
  let terminal = { owner: "terminal", state: "running", terminalId: "t1" };
  stub(t, terminalManager, "runtimeForSession", () => terminal);
  const stopped = [];
  stub(t, terminalManager, "interruptAndStopTerminalsForSession", async (id, options) => { stopped.push([id, options]); terminal = null; return true; });
  const created = await request("POST", "/api/claude/chat", { cwd, text: "first" });
  const id = created.body.sessionId;
  await waitFor(() => !chat.get(id).running);
  chat.shutdownRuntimes();

  const read = await request("GET", `/api/claude/chat/${id}?cwd=${encodeURIComponent(cwd)}`);
  assert.deepEqual(read.body.terminal, { terminalId: "t1" });
  const refused = await request("POST", `/api/claude/chat/${id}/send`, { cwd, text: "hi" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "terminal_owns_session");
  assert.equal(refused.body.terminalId, "t1");
  assert.equal((await request("POST", `/api/claude/chat/${id}/claim`, { cwd })).status, 204);
  assert.deepEqual(stopped, [[id, undefined]]);
  assert.equal((await request("POST", `/api/claude/chat/${id}/send`, { cwd, text: "hi" })).status, 202);
});

test("resuming a session in a terminal stops an idle chat process and refuses a busy one", async (t) => {
  const { cwd, transcript } = useFakeClaude(t);
  terminalApi.addRoot(cwd);
  stub(t, terminalApi, "authorizedCwd", (value) => value);
  stub(t, terminalManager, "createTerminal", (options) => ({ id: "t1", ...options }));
  const post = async (body) => {
    const req = Readable.from([Buffer.from(JSON.stringify({ provider: "claude", cwd, launchMode: "resume", sourceSessionId: ID, ...body }))]);
    Object.assign(req, { method: "POST", headers: {} });
    const res = { status: 0, text: "", writeHead(status) { this.status = status; }, end(text) { this.text = text || ""; } };
    await terminalApi.handleTerminalRequest(req, res, new URL("/api/terminals", "http://localhost"));
    return { status: res.status, body: JSON.parse(res.text) };
  };
  const state = chat.open(ID, cwd);
  const { events, off } = collect(state);
  t.after(off);
  await chat.send(state, { text: "long task" });
  await waitFor(() => fs.existsSync(transcript()));
  const busy = await post({});
  assert.equal(busy.status, 409);
  assert.equal(busy.body.code, "session_busy");
  await chat.interrupt(state);
  await waitFor(() => !state.running);
  assert.equal((await post({})).status, 201);
  assert.equal(chat.runtimeForSession(ID), null);
  assert.ok(events.some((event) => event.type === "pi/stopped"));
});

test("history pages back through the transcript and trims what the browser does not need", (t) => {
  const { cwd, transcript } = useFakeClaude(t);
  fs.mkdirSync(path.dirname(transcript()), { recursive: true });
  const lines = [
    { type: "user", uuid: "u1", message: { role: "user", content: "hello" } },
    { type: "user", uuid: "meta", isMeta: true, message: { role: "user", content: "Caveat" } },
    { type: "assistant", uuid: "side", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "sub-agent" }] } },
    { type: "attachment", attachment: { type: "hook_success", content: "x".repeat(100) } },
    { type: "assistant", uuid: "a1", apiBlockIndex: 1, message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Read", input: { file_path: "/x" } }] } },
    { type: "user", uuid: "r1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "y".repeat(30_000) }, { type: "image", source: { data: "AAAA" } }] }] } },
    { type: "user", uuid: "big", message: { role: "user", content: [{ type: "image", source: { data: "z".repeat(700_000) } }] } },
  ];
  for (let index = 0; index < 400; index += 1) lines.push({ type: "assistant", uuid: `pad${index}`, message: { id: `p${index}`, role: "assistant", content: [{ type: "text", text: "p".repeat(2_000) }] } });
  fs.writeFileSync(transcript(), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

  const first = catalog.readHistory(ID, cwd);
  assert.ok(first.cursor);
  assert.equal(first.records.at(-1).uuid, "pad399");
  const seen = [...first.records];
  let cursor = first.cursor;
  while (cursor) {
    const page = catalog.readHistory(ID, cwd, { before: cursor });
    seen.unshift(...page.records);
    cursor = page.cursor;
  }
  const uuids = seen.map((record) => record.uuid);
  assert.deepEqual(uuids.slice(0, 4), ["u1", "a1", "r1", "big"]);
  assert.equal(new Set(uuids).size, uuids.length);
  assert.equal(uuids.length, 404);
  const toolResult = seen[2].message.content[0];
  assert.ok(toolResult.content[0].text.length < 20_100);
  assert.deepEqual(toolResult.content[1], { type: "image" });
  assert.deepEqual(seen[3].message.content, [{ type: "image" }]);
  assert.equal(seen[1].piBlockIndex, 1);
  assert.throws(() => catalog.readHistory("22222222-2222-4222-8222-222222222222", cwd), { code: "not_found" });
});
