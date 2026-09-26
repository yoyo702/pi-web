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
  assert.equal(stdin().find((entry) => entry.type === "user").uuid, uuid);
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
  for (let index = 0; index < 2_010; index += 1) chat.handleRecord(state, { type: "system", subtype: "status", permissionMode: index % 2 ? "plan" : "acceptEdits" });
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

test("images go to Claude as base64 blocks before the text; clients only see placeholders", async (t) => {
  const { cwd, stdin } = useFakeClaude(t);
  const png = "iVBORw0KGgo=";
  const created = await request("POST", "/api/claude/chat", { cwd, text: "what is this", images: [`data:image/png;base64,${png}`] });
  assert.equal(created.status, 201);
  const state = chat.get(created.body.sessionId);
  await waitFor(() => state.events.some((event) => event.type === "result"));
  assert.deepEqual(stdin().find((entry) => entry.type === "user").message.content, [{ type: "image", source: { type: "base64", media_type: "image/png", data: png } }, { type: "text", text: "what is this" }]);
  assert.deepEqual(state.events[0].message.content, [{ type: "image" }, { type: "text", text: "what is this" }]);
  assert.equal(state.events.find((event) => event.type === "assistant").message.content[0].text, "Echo: what is this [1 image]");

  // An image alone is a message; its title falls back to "Image".
  const imageOnly = await request("POST", "/api/claude/chat", { cwd, images: [`data:image/gif;base64,${png}`] });
  assert.equal(imageOnly.status, 201);
  assert.equal(chat.get(imageOnly.body.sessionId).title, "Image");
  // Over the API's 5 MB base64 limit per image.
  const tooLarge = `data:image/png;base64,${"A".repeat(5_000_004)}`;
  for (const images of [["data:text/plain;base64,aGk="], "data:image/png;base64,x", Array(6).fill(`data:image/png;base64,${png}`), [tooLarge]]) {
    assert.equal((await request("POST", "/api/claude/chat", { cwd, text: "hi", images })).status, 400);
  }
});

test("a fork copies a session, whole or up to a message, into a new session id", async (t) => {
  const { cwd, launches, transcript } = useFakeClaude(t);
  const state = chat.open(ID, cwd);
  t.after(collect(state).off);
  const first = "33333333-3333-4333-8333-333333333333";
  const second = "44444444-4444-4444-8444-444444444444";
  await chat.send(state, { text: "one", uuid: first });
  await waitFor(() => !state.running);
  await chat.send(state, { text: "two", uuid: second });
  await waitFor(() => !state.running);
  const source = fs.readFileSync(transcript(), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const beforeSecond = source.find((entry) => entry.uuid === second).parentUuid;
  const sessionArgs = (args) => args.slice(args.indexOf("--resume"), args.indexOf("--session-id") + 2);

  const whole = await request("POST", "/api/claude/chat", { cwd, text: "three", fork: { sessionId: ID } });
  assert.equal(whole.status, 201);
  const wholeState = chat.get(whole.body.sessionId);
  await waitFor(() => wholeState.events.some((event) => event.type === "result"));
  assert.deepEqual(sessionArgs(launches()[1]), ["--resume", ID, "--fork-session", "--session-id", whole.body.sessionId]);
  const wholeCopy = fs.readFileSync(transcript(whole.body.sessionId), "utf8");
  assert.ok(wholeCopy.includes(second) && wholeCopy.includes("three"));

  const partial = await request("POST", "/api/claude/chat", { cwd, text: "again", fork: { sessionId: ID, at: second } });
  assert.equal(partial.status, 201);
  const partialState = chat.get(partial.body.sessionId);
  await waitFor(() => partialState.events.some((event) => event.type === "result"));
  assert.deepEqual(sessionArgs(launches()[2]), ["--resume", ID, "--fork-session", "--resume-session-at", beforeSecond, "--session-id", partial.body.sessionId]);
  const partialCopy = fs.readFileSync(transcript(partial.body.sessionId), "utf8");
  assert.ok(partialCopy.includes(first) && !partialCopy.includes(second));
  // The source is unchanged, and the fork resumes itself from now on.
  assert.equal(fs.readFileSync(transcript(), "utf8").trim().split("\n").length, source.length);
  // It reopens without the fork once idle.
  await chat.stopAndWait(partial.body.sessionId);
  await waitFor(() => !chat.get(partial.body.sessionId));
  assert.equal((await request("POST", `/api/claude/chat/${partial.body.sessionId}/send`, { cwd, text: "later" })).status, 202);
  await waitFor(() => !chat.get(partial.body.sessionId).running);
  assert.deepEqual(launches()[3].slice(launches()[3].indexOf("--resume"), launches()[3].indexOf("--resume") + 2), ["--resume", partial.body.sessionId]);
  assert.equal(launches()[3].includes("--fork-session"), false);

  // The first prompt has nothing before it; unknown sessions and messages fail.
  const noParent = fs.readFileSync(transcript(), "utf8").trim().split("\n").map((line) => JSON.parse(line)).find((entry) => entry.uuid === first);
  assert.equal(noParent.parentUuid, null);
  assert.equal((await request("POST", "/api/claude/chat", { cwd, text: "x", fork: { sessionId: ID, at: first } })).status, 400);
  assert.equal((await request("POST", "/api/claude/chat", { cwd, text: "x", fork: { sessionId: ID, at: "55555555-5555-4555-8555-555555555555" } })).status, 404);
  assert.equal((await request("POST", "/api/claude/chat", { cwd, text: "x", fork: { sessionId: "66666666-6666-4666-8666-666666666666" } })).status, 404);
  assert.equal((await request("POST", "/api/claude/chat", { cwd, text: "x", fork: { sessionId: ID, at: "not-a-uuid" } })).status, 400);
  // A turn in progress is not forked.
  await chat.send(state, { text: "long" });
  assert.equal((await request("POST", "/api/claude/chat", { cwd, text: "x", fork: { sessionId: ID } })).body.code, "session_busy");
});

test("a fork resumes at the last message before the prompt, never before a compaction", async (t) => {
  const { cwd, transcript } = useFakeClaude(t);
  const uuid = (n) => `${String(n).repeat(8)}-0000-4000-8000-000000000000`;
  const write = (entries) => fs.appendFileSync(transcript(), entries.map((entry) => `${JSON.stringify({ sessionId: ID, cwd, ...entry })}\n`).join(""));
  fs.mkdirSync(path.dirname(transcript()), { recursive: true });
  write([
    { type: "user", uuid: uuid(1), parentUuid: null, message: { role: "user", content: "one" } },
    { type: "assistant", uuid: uuid(2), parentUuid: uuid(1), message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    { type: "system", subtype: "turn_duration", uuid: uuid(3), parentUuid: uuid(2) },
    { type: "attachment", uuid: uuid(4), parentUuid: uuid(3) },
    { type: "user", uuid: uuid(5), parentUuid: uuid(4), message: { role: "user", content: "two" } },
  ]);
  // Entries between two messages are skipped.
  assert.equal(await catalog.forkPoint(ID, cwd, uuid(5)), uuid(2));
  write([
    { type: "system", subtype: "compact_boundary", uuid: uuid(6), parentUuid: null },
    { type: "user", uuid: uuid(7), parentUuid: uuid(6), isCompactSummary: true, message: { role: "user", content: "summary" } },
    { type: "user", uuid: uuid(8), parentUuid: uuid(7), message: { role: "user", content: "three" } },
  ]);
  await assert.rejects(catalog.forkPoint(ID, cwd, uuid(5)), { code: "invalid_request", message: /compacted/ });
  assert.equal(await catalog.forkPoint(ID, cwd, uuid(8)), uuid(7));
});

test("a fork that fails before writing its session says so and forks again on the next message", async (t) => {
  const { cwd, launches } = useFakeClaude(t);
  const source = chat.open(ID, cwd);
  t.after(collect(source).off);
  await chat.send(source, { text: "one" });
  await waitFor(() => !source.running);
  const id = "77777777-7777-4777-8777-777777777777";
  const state = chat.open(id, cwd, { fork: { sessionId: ID, resumeAt: "88888888-8888-4888-8888-888888888888" } });
  const { events, off } = collect(state);
  t.after(off);
  // Until Claude writes it, the session reads as just created.
  const read = await request("GET", `/api/claude/chat/${id}?cwd=${encodeURIComponent(cwd)}`);
  assert.deepEqual([read.body.session.created, read.body.history], [true, []]);
  const warn = console.warn;
  console.warn = () => undefined;
  t.after(() => { console.warn = warn; });
  await chat.send(state, { text: "two" }).catch(() => undefined);
  await waitFor(() => events.some((event) => event.type === "pi/closed"));
  assert.equal(events.find((event) => event.type === "pi/closed").code, "fork_failed");
  await chat.send(state, { text: "two" }).catch(() => undefined);
  await waitFor(() => events.filter((event) => event.type === "pi/closed").length === 2);
  assert.deepEqual(launches().slice(1).map((args) => args.includes("--fork-session")), [true, true]);
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

test("slash commands come from Claude's initialize answer, without the ones a chat cannot run", async (t) => {
  const { cwd, launches } = useFakeClaude(t);
  const listed = await request("GET", `/api/claude/chat/commands?cwd=${encodeURIComponent(cwd)}`);
  assert.equal(listed.status, 200);
  // Claude lists a project command after the built-in of the same name; the first wins.
  assert.deepEqual(listed.body.commands.map((command) => command.name), ["superpowers:brainstorming", "compact", "context"]);
  assert.equal(listed.body.commands[2].description, "Show current context usage");
  assert.deepEqual(listed.body.commands[0].aliases, ["brainstorming"]);
  assert.equal(listed.body.commands[1].argumentHint, "<optional custom summarization instructions>");
  // The probe starts no session, and the answer is cached per workspace.
  assert.equal(launches()[0].includes("--session-id") || launches()[0].includes("--resume"), false);
  await request("GET", `/api/claude/chat/commands?cwd=${encodeURIComponent(cwd)}`);
  assert.equal(launches().length, 1);
  assert.equal((await request("GET", "/api/claude/chat/commands?cwd=/nope")).status, 403);

  const state = chat.open(ID, cwd);
  const { events, off } = collect(state);
  t.after(off);
  await chat.send(state, { text: "hello" });
  await waitFor(() => events.some((event) => event.type === "pi/commands"));
  assert.deepEqual(events.find((event) => event.type === "pi/commands").commands, listed.body.commands);
  for (const text of ["/clear", "/reset now", "/new"]) await assert.rejects(chat.send(state, { text }), { code: "invalid_request" });
});

test("a failed command probe lists nothing and is not retried at once", async (t) => {
  const { cwd } = useFakeClaude(t);
  chat.configure({ command: path.join(cwd, "missing-claude"), args: [], env: process.env, idleMs: IDLE_MS });
  const warn = t.mock.method(console, "warn", () => undefined);
  const first = await request("GET", `/api/claude/chat/commands?cwd=${encodeURIComponent(cwd)}`);
  assert.deepEqual([first.status, first.body.commands], [200, []]);
  await request("GET", `/api/claude/chat/commands?cwd=${encodeURIComponent(cwd)}`);
  assert.equal(warn.mock.callCount(), 1);
});

test("the process stops when Claude moves to another session", async (t) => {
  const { cwd } = useFakeClaude(t);
  const state = chat.open(ID, cwd);
  const { events, off } = collect(state);
  t.after(off);
  await chat.send(state, { text: "switch" });
  await waitFor(() => events.some((event) => event.type === "pi/closed"));
  const closed = events.find((event) => event.type === "pi/closed");
  assert.equal(closed.code, "session_changed");
  assert.match(closed.error, /another session/);
  assert.equal(events.some((event) => event.type === "system" && event.subtype === "init"), false);
});

test("/context and /compact show their output live and after a reload", async (t) => {
  const { cwd } = useFakeClaude(t);
  const state = chat.open(ID, cwd);
  const { events, off } = collect(state);
  t.after(off);
  await chat.send(state, { text: "/context" });
  await waitFor(() => events.some((event) => event.type === "result"));
  const live = events.find((event) => event.type === "assistant");
  assert.equal(live.message.content[0].text, "## Context Usage");
  assert.equal(live.message.id, live.uuid);
  const saved = catalog.readHistory(ID, cwd).records.find((record) => record.type === "assistant");
  assert.equal(saved.uuid, live.uuid);
  assert.deepEqual(saved.message, { id: live.uuid, role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "## Context Usage" }] });

  await chat.send(state, { text: "/compact" });
  await waitFor(() => events.filter((event) => event.type === "result").length === 2);
  const statuses = events.filter((event) => event.type === "system" && event.subtype === "status").map((event) => event.compacting);
  assert.deepEqual(statuses, [true, false]);
  const boundary = events.find((event) => event.subtype === "compact_boundary");
  assert.ok(boundary.uuid);
  // The summary Claude writes for itself stays hidden; its "Compacted" note shows.
  assert.equal(events.some((event) => event.type === "user" && JSON.stringify(event.message).includes("being continued")), false);
  const history = catalog.readHistory(ID, cwd).records;
  assert.ok(history.some((record) => record.subtype === "compact_boundary" && record.uuid === boundary.uuid));
  assert.equal(history.some((record) => JSON.stringify(record.message ?? "").includes("being continued")), false);
});

test("a sub-agent's steps stream live under its tool call and load from its own transcript", async (t) => {
  const { cwd } = useFakeClaude(t);
  const state = chat.open(ID, cwd);
  const { events, off } = collect(state);
  t.after(off);
  await chat.send(state, { text: "delegate" });
  await waitFor(() => events.some((event) => event.type === "result"));
  const call = events.find((event) => event.type === "assistant" && event.message.content[0].name === "Agent").message.content[0];
  const sub = events.filter((event) => event.parentToolUseId === call.id);
  assert.deepEqual(sub.map((event) => event.type), ["user", "assistant", "user", "assistant"]);
  assert.equal(sub.some((event) => "piBlockIndex" in event), false);
  assert.equal(events.some((event) => event.type === "stream_event" && event.parent_tool_use_id), false);
  const tasks = events.filter((event) => event.type === "system" && event.subtype?.startsWith("task_"));
  assert.deepEqual(tasks.map((event) => [event.subtype, event.tool_use_id]), [["task_started", call.id], ["task_progress", call.id], ["task_notification", call.id]]);
  assert.equal(tasks[1].last_tool_name, "Bash");
  assert.equal(tasks[2].status, "completed");

  const steps = await request("GET", `/api/claude/chat/${ID}/agents/${call.id}?cwd=${encodeURIComponent(cwd)}`);
  assert.equal(steps.status, 200);
  assert.deepEqual(steps.body.records.map((record) => record.uuid), sub.map((event) => event.uuid));
  assert.ok(steps.body.records.every((record) => record.parentToolUseId === call.id));
  assert.equal(steps.body.records[1].piBlockIndex, undefined);
  // The main history leaves the sub-agent out.
  assert.equal(catalog.readHistory(ID, cwd).records.some((record) => record.parentToolUseId), false);
  assert.equal((await request("GET", `/api/claude/chat/${ID}/agents/bogus?cwd=${encodeURIComponent(cwd)}`)).status, 400);
  assert.equal((await request("GET", `/api/claude/chat/${ID}/agents/toolu_missing?cwd=${encodeURIComponent(cwd)}`)).status, 404);
});
