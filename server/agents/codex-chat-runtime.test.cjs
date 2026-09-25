/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Readable } = require("node:stream");

const appServer = require("./codex-app-server.cjs");
const catalog = require("./codex-sessions.cjs");
const terminalApi = require("./terminal-api.cjs");
const terminalManager = require("./terminal-manager.cjs");
const api = require("./codex-app-api.cjs");

const FAKE_SERVER = path.join(__dirname, "fixtures", "fake-codex-app-server.cjs");
const ID = "11111111-1111-1111-1111-111111111111";
const IDLE_MS = 60;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Chat runtimes run the fake app-server in a temp dir; nothing touches ~/.codex.
function useFakeRuntime(t, { writer = false, turns } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-codex-runtime-"));
  const log = path.join(dir, "log.jsonl");
  const state = path.join(dir, "state.json");
  fs.writeFileSync(state, JSON.stringify({ threads: [{ id: ID, name: "Chat", cwd: dir, archived: false, writer, turns, path: path.join(dir, "rollout.jsonl") }] }));
  appServer.configure({ command: process.execPath, args: [FAKE_SERVER], env: { ...process.env, FAKE_CODEX_STATE: state, FAKE_CODEX_LOG: log }, idleMs: IDLE_MS });
  t.after(async () => { await appServer.stopAndWait(ID); appServer.configure(null); fs.rmSync(dir, { recursive: true, force: true }); });
  const methods = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  const threads = () => JSON.parse(fs.readFileSync(state, "utf8")).threads;
  return { dir, methods, threads };
}
async function waitFor(check, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleep(10);
  }
}

test("a running turn keeps the runtime up without viewers; it closes after the turn ends", async (t) => {
  const { dir } = useFakeRuntime(t);
  const runtime = appServer.start({ threadId: ID, cwd: dir });
  await appServer.prompt(runtime, "long task");
  await sleep(IDLE_MS * 3);
  assert.equal(appServer.isClaimed(ID), true);
  assert.equal(appServer.runtimeForSession(ID).state, "running");
  await appServer.interrupt(runtime);
  await waitFor(() => !appServer.isClaimed(ID));
});

test("a pending approval keeps the runtime up until it is answered", async (t) => {
  const { dir } = useFakeRuntime(t);
  const runtime = appServer.start({ threadId: ID, cwd: dir });
  await appServer.prompt(runtime, "please approve");
  await waitFor(() => appServer.runtimeForSession(ID)?.state === "approval");
  await sleep(IDLE_MS * 3);
  assert.equal(appServer.isClaimed(ID), true);
  appServer.respond(runtime, "900", { decision: "accept" });
  await waitFor(() => !appServer.isClaimed(ID));
});

test("a request pi-web cannot show is refused at once and the turn keeps running", async (t) => {
  const { dir, methods } = useFakeRuntime(t);
  const warn = console.warn;
  console.warn = () => undefined;
  t.after(() => { console.warn = warn; });
  const runtime = appServer.start({ threadId: ID, cwd: dir });
  const events = [];
  t.after(appServer.subscribe(runtime, (event) => events.push(event)));
  await appServer.prompt(runtime, "tool call");
  await waitFor(() => methods().some((entry) => entry.response === 901));
  assert.equal(methods().find((entry) => entry.response === 901).error.code, -32601);
  assert.equal(appServer.runtimeForSession(ID).state, "running");
  await waitFor(() => events.some((event) => event.method === "codex/unsupportedRequest"));
  assert.equal(events.find((event) => event.method === "codex/unsupportedRequest").params.method, "item/tool/call");
  await appServer.interrupt(runtime);
});

test("answering a user-input question sends the answers and ends the wait", async (t) => {
  const { dir, methods } = useFakeRuntime(t);
  const runtime = appServer.start({ threadId: ID, cwd: dir });
  await appServer.prompt(runtime, "a question");
  await waitFor(() => appServer.runtimeForSession(ID)?.state === "approval");
  assert.throws(() => appServer.respond(runtime, "902", { answers: { color: "Red" } }), (error) => error.code === "invalid_request");
  assert.equal(appServer.runtimeForSession(ID).state, "approval");
  appServer.respond(runtime, "902", { answers: { color: ["Blue"] } });
  await waitFor(() => methods().some((entry) => entry.response === 902));
  assert.deepEqual(methods().find((entry) => entry.response === 902).result, { answers: { color: { answers: ["Blue"] } } });
});

test("steering adds input to the running turn and fails once it has ended", async (t) => {
  const { dir, methods } = useFakeRuntime(t);
  const runtime = appServer.start({ threadId: ID, cwd: dir });
  const { turn } = await appServer.prompt(runtime, "long task");
  assert.deepEqual(await appServer.steer(runtime, "also this", [], "msg-1"), { turnId: turn.id });
  const steer = methods().find((entry) => entry.method === "turn/steer");
  assert.equal(steer.params.expectedTurnId, turn.id);
  assert.deepEqual(steer.params.input, [{ type: "text", text: "also this" }]);
  runtime.activeTurnId = "stale-turn";
  await assert.rejects(appServer.steer(runtime, "late"), (error) => error.code === "no_active_turn");
  runtime.activeTurnId = turn.id;
  await appServer.interrupt(runtime);
  await waitFor(() => !runtime.activeTurnId);
  await assert.rejects(appServer.steer(runtime, "late"), (error) => error.code === "no_active_turn");
});

test("a new chat starts a thread in the folder and runs under the id Codex gives it", async (t) => {
  const { dir, methods } = useFakeRuntime(t);
  const runtime = await appServer.create({ cwd: dir, model: "gpt-test", approvalPolicy: "on-request" });
  t.after(() => appServer.stopAndWait(runtime.threadId));
  assert.notEqual(runtime.threadId, ID);
  assert.equal(appServer.isClaimed(runtime.threadId), true);
  assert.deepEqual(methods().find((entry) => entry.method === "thread/start").params, { cwd: dir, model: "gpt-test", serviceTier: null, approvalPolicy: "on-request" });
  // Before its first message Codex has no turns to read; the thread itself is still returned.
  assert.equal((await appServer.readThread(runtime)).thread.id, runtime.threadId);
  const { turn } = await appServer.prompt(runtime, "hello");
  assert.equal((await appServer.readThread(runtime)).thread.id, runtime.threadId);
  assert.equal(methods().filter((entry) => entry.method === "thread/read").at(-1).params.includeTurns, true);
  assert.equal(methods().find((entry) => entry.method === "turn/start").params.threadId, runtime.threadId);
  assert.equal(appServer.runtimeForSession(runtime.threadId).state, "running");
  await appServer.interrupt(runtime);
  assert.ok(turn.id);
});

test("a new chat that Codex cannot start leaves no runtime behind", async (t) => {
  const { dir } = useFakeRuntime(t);
  appServer.configure({ command: process.execPath, args: [FAKE_SERVER], env: { ...process.env, FAKE_CODEX_STATE: path.join(dir, "state.json"), FAKE_CODEX_INIT_ERROR: "1" }, idleMs: IDLE_MS });
  await assert.rejects(appServer.create({ cwd: dir }), /bad config/);
  assert.deepEqual(appServer.listRuntimes(), []);
});

test("a turn Codex will not steer is reported as no_active_turn", async (t) => {
  const { dir } = useFakeRuntime(t);
  const runtime = appServer.start({ threadId: ID, cwd: dir });
  await appServer.prompt(runtime, "review the diff");
  await assert.rejects(appServer.steer(runtime, "more"), (error) => error.code === "no_active_turn" && /activeTurnNotSteerable/.test(JSON.stringify(error.cause.rpcData)));
});

test("a fork keeps the turns through the given one, and its own runtime can resume it", async (t) => {
  const { dir, methods, threads } = useFakeRuntime(t, { turns: [{ id: "turn-a", items: [] }, { id: "turn-b", items: [] }, { id: "turn-c", items: [] }] });
  const source = appServer.start({ threadId: ID, cwd: dir });
  await source.ready;
  const { thread } = await appServer.fork({ threadId: ID, cwd: dir }, "turn-b");
  assert.notEqual(thread.id, ID);
  assert.deepEqual(threads().find((item) => item.id === thread.id).turns.map((turn) => turn.id), ["turn-a", "turn-b"]);
  assert.deepEqual(methods().find((entry) => entry.method === "thread/fork").params, { threadId: ID, cwd: dir, excludeTurns: true, lastTurnId: "turn-b" });
  // The fork came from its own process, not the source's runtime, which keeps running.
  assert.equal(appServer.isClaimed(thread.id), false);
  assert.equal(appServer.isClaimed(ID), true);
  const forked = appServer.start({ threadId: thread.id, cwd: dir });
  t.after(() => appServer.stopAndWait(thread.id));
  await forked.ready;
  // Without a turn the whole thread is copied.
  const whole = await appServer.fork({ threadId: ID, cwd: dir });
  assert.equal(threads().find((item) => item.id === whole.thread.id).turns.length, 3);
  assert.equal("lastTurnId" in methods().filter((entry) => entry.method === "thread/fork").at(-1).params, false);
  await appServer.withRemovalLock(ID, async () => {
    await assert.rejects(appServer.fork({ threadId: ID, cwd: dir }), (error) => error.code === "session_busy");
  });
});

test("a fork whose app-server cannot start fails instead of hanging", async (t) => {
  const { dir } = useFakeRuntime(t);
  appServer.configure({ command: path.join(dir, "missing-codex"), args: [], env: process.env, idleMs: IDLE_MS });
  await assert.rejects(appServer.fork({ threadId: ID, cwd: dir }), /Unable to start Codex app-server/);
});

test("closing the last viewer of an idle runtime shuts it down", async (t) => {
  const { dir } = useFakeRuntime(t);
  const runtime = appServer.start({ threadId: ID, cwd: dir });
  await runtime.ready;
  const off = appServer.subscribe(runtime, () => undefined);
  await sleep(IDLE_MS * 3);
  assert.equal(appServer.isClaimed(ID), true);
  off();
  await waitFor(() => !appServer.isClaimed(ID));
});

test("a thread held by another Codex client reports writer_conflict and is not kept", async (t) => {
  const { dir } = useFakeRuntime(t, { writer: true });
  const runtime = appServer.start({ threadId: ID, cwd: dir });
  await assert.rejects(runtime.ready, (error) => error.code === "writer_conflict" && /another Codex client/.test(error.message));
  await waitFor(() => !appServer.isClaimed(ID));
});

test("no runtime starts while the session is being archived or deleted", async (t) => {
  const { dir } = useFakeRuntime(t);
  await appServer.withRemovalLock(ID, async () => {
    assert.throws(() => appServer.start({ threadId: ID, cwd: dir }), (error) => error.code === "session_busy");
  });
  await appServer.stopAndWait(appServer.start({ threadId: ID, cwd: dir }).threadId);
});

// --- HTTP bridge ------------------------------------------------------------

function stub(t, target, name, value) {
  const original = target[name];
  target[name] = value;
  t.after(() => { target[name] = original; });
}
async function request(method, pathname, body, headers = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, headers });
  const res = { status: 0, text: "", writeHead(status) { this.status = status; }, write(text) { this.text += text; }, end(text) { this.text += text || ""; } };
  const url = new URL(pathname, "http://localhost");
  assert.equal(api.isPath(url.pathname), true);
  await api.handle(req, res, url);
  return { status: res.status, text: res.text, body: res.text && res.status !== 200 ? JSON.parse(res.text) : res.text && !res.text.startsWith("data:") && !res.text.startsWith("id:") ? JSON.parse(res.text) : null };
}
// Stubs everything outside the bridge; records which writers were stopped.
function setupApi(t, { resumeTerminal = false, unknownTerminals = [], archived = false } = {}) {
  const calls = [];
  const runtime = { threadId: ID, runtimeId: "run1", events: [], listeners: new Set() };
  stub(t, terminalApi, "authorizedCwd", (cwd) => cwd);
  stub(t, catalog, "requireSession", async () => ({ id: ID, cwd: "/workspace", archived }));
  stub(t, catalog, "getSessionPreview", async () => ({ recentMessages: [] }));
  stub(t, terminalManager, "runtimeForSession", () => resumeTerminal ? { owner: "terminal", state: "running" } : null);
  stub(t, terminalManager, "unknownCodexTerminals", () => unknownTerminals);
  stub(t, terminalApi, "claimCodexSession", async (id, options) => { calls.push(["claim", options?.cwd ?? null]); return resumeTerminal || Boolean(options?.cwd && unknownTerminals.length); });
  stub(t, appServer, "isClaimed", () => false);
  stub(t, appServer, "start", () => { calls.push(["start"]); return runtime; });
  stub(t, appServer, "readThread", async () => ({ thread: { id: ID, path: "/secret", turns: [] } }));
  stub(t, appServer, "snapshot", () => []);
  stub(t, appServer, "prompt", async (_state, text, ...rest) => { calls.push(["prompt", text, rest[2]]); return { turn: { id: "turn-1" } }; });
  return calls;
}

test("reading history does not stop terminals and refuses a session a terminal is resuming", async (t) => {
  const calls = setupApi(t, { resumeTerminal: true });
  const response = await request("GET", `/api/codex/chat/${ID}`);
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "terminal_owns_session");
  assert.deepEqual(calls, []);
});

test("reading history starts the runtime without claiming and hides the rollout path", async (t) => {
  const calls = setupApi(t, { unknownTerminals: [{ id: "term-1", title: "codex", launchMode: "new" }] });
  const response = await request("GET", `/api/codex/chat/${ID}`);
  assert.equal(response.status, 200);
  assert.equal(response.body.thread.thread.path, undefined);
  assert.deepEqual(calls, [["start"]]);
});

test("sending stops a terminal resuming the session before starting the turn", async (t) => {
  const calls = setupApi(t, { resumeTerminal: true });
  stub(t, terminalManager, "runtimeForSession", () => null);
  const response = await request("POST", `/api/codex/chat/${ID}`, { text: "hi" });
  assert.equal(response.status, 202);
  assert.deepEqual(calls.map((call) => call[0]), ["claim", "start", "prompt"]);
});

test("sending with an unknown Codex terminal in the folder asks first", async (t) => {
  const unknownTerminals = [{ id: "term-1", title: "codex", launchMode: "resume-last" }];
  const calls = setupApi(t, { unknownTerminals });
  const refused = await request("POST", `/api/codex/chat/${ID}`, { text: "hi" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "terminal_conflict");
  assert.deepEqual(refused.body.terminals, [{ id: "term-1", title: "codex", launchMode: "resume-last" }]);
  assert.deepEqual(calls, []);

  const ignored = await request("POST", `/api/codex/chat/${ID}`, { text: "hi", terminals: "ignore" });
  assert.equal(ignored.status, 202);
  assert.deepEqual(calls.shift(), ["claim", null]);

  calls.length = 0;
  const claimed = await request("POST", `/api/codex/chat/${ID}/claim`, { terminals: "stop" });
  assert.equal(claimed.status, 204);
  assert.deepEqual(calls, [["claim", "/workspace"]]);
});

test("an image-only message is accepted", async (t) => {
  const calls = setupApi(t);
  const image = "data:image/png;base64,AAAA";
  const response = await request("POST", `/api/codex/chat/${ID}`, { images: [image] });
  assert.equal(response.status, 202);
  assert.deepEqual(calls.at(-1), ["prompt", "", [image]]);
});

test("steering needs a turn this chat is running and never starts a runtime", async (t) => {
  const calls = setupApi(t);
  const refused = await request("POST", `/api/codex/chat/${ID}/steer`, { text: "more" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "no_active_turn");
  assert.deepEqual(calls, []);
  stub(t, appServer, "isClaimed", () => true);
  stub(t, appServer, "steer", async (_state, text, images, clientMessageId) => { calls.push(["steer", text, clientMessageId]); return { turnId: "turn-1" }; });
  const accepted = await request("POST", `/api/codex/chat/${ID}/steer`, { text: "more", clientMessageId: "m1" });
  assert.equal(accepted.status, 202);
  assert.deepEqual(accepted.body, { turn: { turnId: "turn-1" } });
  assert.deepEqual(calls.at(-1), ["steer", "more", "m1"]);
});

test("a fork request passes its turn id, starts no runtime and hides the fork's rollout path", async (t) => {
  const calls = setupApi(t);
  const forks = [];
  stub(t, appServer, "fork", async (source, lastTurnId) => { forks.push([source.threadId, lastTurnId]); return { thread: { id: "22222222-2222-2222-2222-222222222222", path: "/secret" } }; });
  const through = await request("POST", `/api/codex/chat/${ID}/fork`, { lastTurnId: "turn-1" });
  assert.equal(through.status, 200);
  assert.deepEqual(through.body, { result: { thread: { id: "22222222-2222-2222-2222-222222222222" } } });
  assert.equal((await request("POST", `/api/codex/chat/${ID}/fork`, {})).status, 200);
  assert.deepEqual(forks, [[ID, "turn-1"], [ID, null]]);
  // No runtime is started for the source.
  assert.deepEqual(calls, []);
  for (const lastTurnId of ["", 7]) {
    const refused = await request("POST", `/api/codex/chat/${ID}/fork`, { lastTurnId });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, "invalid_request");
  }
  assert.equal(forks.length, 2);
});

test("a new chat is created in an authorized folder with its first message", async (t) => {
  const calls = setupApi(t);
  const runtime = { threadId: "22222222-2222-2222-2222-222222222222" };
  stub(t, terminalApi, "authorizedCwd", (cwd) => { if (cwd !== "/workspace") throw Object.assign(new Error("no"), { code: "forbidden_cwd" }); return cwd; });
  stub(t, appServer, "create", async (options) => { calls.push(["create", options]); return runtime; });
  const created = await request("POST", "/api/codex/chat", { cwd: "/workspace", text: "hello", model: "gpt-test", effort: "high" });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body, { threadId: runtime.threadId, turn: { turn: { id: "turn-1" } } });
  assert.deepEqual(calls, [["create", { cwd: "/workspace", model: "gpt-test", serviceTier: null, approvalPolicy: "untrusted" }], ["prompt", "hello", []]]);
  assert.equal((await request("POST", "/api/codex/chat", { cwd: "/elsewhere", text: "hello" })).status, 403);
  assert.equal((await request("POST", "/api/codex/chat", { cwd: "/workspace", text: " " })).status, 400);
  assert.equal((await request("GET", "/api/codex/chat")).status, 405);
  assert.equal(calls.length, 2);
});

test("a new chat whose first message fails stops the thread's runtime", async (t) => {
  setupApi(t);
  const runtime = { threadId: "22222222-2222-2222-2222-222222222222" };
  const stopped = [];
  stub(t, appServer, "create", async () => runtime);
  stub(t, appServer, "prompt", async () => { throw Object.assign(new Error("model not supported"), { code: "invalid_request" }); });
  stub(t, appServer, "stop", (threadId) => stopped.push(threadId));
  assert.equal((await request("POST", "/api/codex/chat", { cwd: "/workspace", text: "hello" })).status, 400);
  assert.deepEqual(stopped, [runtime.threadId]);
});

test("a chat just created here opens before Codex lists it", async (t) => {
  setupApi(t);
  stub(t, catalog, "requireSession", async () => { throw Object.assign(new Error("gone"), { code: "not_found" }); });
  stub(t, catalog, "getSessionPreview", async () => { throw new Error("must not read files for a new chat"); });
  let runtimes = [{ threadId: ID, cwd: "/workspace", state: "running" }];
  stub(t, appServer, "listRuntimes", () => runtimes);
  const response = await request("GET", `/api/codex/chat/${ID}`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.history, []);
  runtimes = [];
  assert.equal((await request("GET", `/api/codex/chat/${ID}`)).status, 404);
});

test("an answer is passed through for the request type to validate", async (t) => {
  setupApi(t);
  const answers = [];
  stub(t, appServer, "respond", (_state, requestId, body) => answers.push([requestId, body]));
  const response = await request("POST", `/api/codex/chat/${ID}/approve`, { requestId: "902", answers: { color: ["Red"] } });
  assert.equal(response.status, 204);
  assert.deepEqual(answers, [["902", { requestId: "902", answers: { color: ["Red"] } }]]);
  stub(t, appServer, "respond", () => { throw Object.assign(new Error("invalid answer"), { code: "invalid_request" }); });
  assert.equal((await request("POST", `/api/codex/chat/${ID}/approve`, { requestId: "902", answers: { color: "Red" } })).status, 400);
});

test("chat errors map to status codes", async (t) => {
  setupApi(t, { archived: true });
  assert.equal((await request("GET", `/api/codex/chat/${ID}`)).status, 409);
  stub(t, catalog, "requireSession", async () => { throw Object.assign(new Error("gone"), { code: "not_found" }); });
  assert.equal((await request("GET", `/api/codex/chat/${ID}`)).status, 404);
  stub(t, catalog, "requireSession", async () => ({ id: ID, cwd: "/workspace", archived: false }));
  assert.equal((await request("POST", `/api/codex/chat/${ID}`, { text: "" })).status, 400);
  assert.equal((await request("POST", `/api/codex/chat/${ID}/approve`, { requestId: 1 })).status, 400);
  const originalError = console.error;
  console.error = () => undefined;
  t.after(() => { console.error = originalError; });
  stub(t, appServer, "prompt", async () => { throw new Error("secret detail at /Users/someone"); });
  const hidden = await request("POST", `/api/codex/chat/${ID}`, { text: "hi" });
  assert.equal(hidden.status, 500);
  assert.equal(hidden.body.error, "Codex chat request failed");
  stub(t, appServer, "prompt", async () => { throw Object.assign(new Error("model not available"), { code: "rpc_error" }); });
  const shown = await request("POST", `/api/codex/chat/${ID}`, { text: "hi" });
  assert.equal(shown.status, 500);
  assert.equal(shown.body.error, "model not available");
});

test("an event stream from a different runtime replays from the start", async (t) => {
  setupApi(t);
  const replayed = [];
  stub(t, appServer, "subscribe", (_state, _listener, after) => { replayed.push(after); return () => undefined; });
  const fakeReq = (headers) => { const req = Readable.from([]); Object.assign(req, { method: "GET", headers }); return req; };
  const res = { writeHead() {}, write() {}, end() {} };
  await api.handle(fakeReq({ "last-event-id": "run1:7" }), res, new URL(`http://localhost/api/codex/chat/${ID}/events`));
  await api.handle(fakeReq({ "last-event-id": "old:7" }), res, new URL(`http://localhost/api/codex/chat/${ID}/events`));
  assert.deepEqual(replayed, [7, 0]);
});

test("an event stream for a runtime that cannot resume answers with a JSON error", async (t) => {
  setupApi(t);
  const failed = Promise.reject(Object.assign(new Error("This session is open in another Codex client"), { code: "writer_conflict" }));
  failed.catch(() => undefined);
  stub(t, appServer, "start", () => ({ threadId: ID, runtimeId: "run2", ready: failed }));
  const response = await request("GET", `/api/codex/chat/${ID}/events`);
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "writer_conflict");
});

test("an invalid session id is a 400, and Codex error text shown to the browser has no paths", async (t) => {
  setupApi(t);
  stub(t, catalog, "requireSession", async () => { throw Object.assign(new Error("Invalid Codex session id"), { code: "invalid_session" }); });
  assert.equal((await request("GET", `/api/codex/chat/abc`)).status, 400);
  stub(t, catalog, "requireSession", async () => ({ id: ID, cwd: "/workspace", archived: false }));
  const originalError = console.error;
  console.error = () => undefined;
  t.after(() => { console.error = originalError; });
  stub(t, appServer, "prompt", async () => { throw Object.assign(new Error("failed to read /Users/me/.codex/sessions/x.jsonl: denied in item/tool/call"), { code: "rpc_error" }); });
  const response = await request("POST", `/api/codex/chat/${ID}`, { text: "hi" });
  assert.equal(response.body.error, "failed to read <path>: denied in item/tool/call");
});
