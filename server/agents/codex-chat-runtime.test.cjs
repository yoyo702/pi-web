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
function useFakeRuntime(t, { writer = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-codex-runtime-"));
  const log = path.join(dir, "log.jsonl");
  const state = path.join(dir, "state.json");
  fs.writeFileSync(state, JSON.stringify({ threads: [{ id: ID, name: "Chat", cwd: dir, archived: false, writer, path: path.join(dir, "rollout.jsonl") }] }));
  appServer.configure({ command: process.execPath, args: [FAKE_SERVER], env: { ...process.env, FAKE_CODEX_STATE: state, FAKE_CODEX_LOG: log }, idleMs: IDLE_MS });
  t.after(async () => { await appServer.stopAndWait(ID); appServer.configure(null); fs.rmSync(dir, { recursive: true, force: true }); });
  const methods = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  return { dir, methods };
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
