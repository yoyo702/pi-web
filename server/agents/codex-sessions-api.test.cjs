"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");

const catalog = require("./codex-sessions.cjs");
const terminalApi = require("./terminal-api.cjs");
const terminalManager = require("./terminal-manager.cjs");
const codexAppServer = require("./codex-app-server.cjs");
const api = require("./codex-sessions-api.cjs");

const ID = "11111111-1111-1111-1111-111111111111";
const session = { id: ID, name: "Session", cwd: "/workspace", archived: false, path: "/secret/rollout.jsonl" };

function stub(t, target, name, value) {
  const original = target[name];
  target[name] = value;
  t.after(() => { target[name] = original; });
}

// Everything the API reaches outside this module is stubbed: no real Codex
// catalog, terminals, chat runtimes or workspace grants.
function setup(t, { chat = null, terminal = null } = {}) {
  const calls = [];
  stub(t, terminalApi, "authorizedCwd", (cwd) => cwd);
  stub(t, catalog, "requireSession", async () => session);
  stub(t, catalog, "listSessions", async (options) => { calls.push(["list", options]); return { sessions: [session], nextCursor: "next" }; });
  for (const action of ["archive", "remove", "rename", "unarchive"]) stub(t, catalog, action, async () => { calls.push([action]); return session; });
  stub(t, codexAppServer, "runtimeForSession", () => chat);
  stub(t, codexAppServer, "stopAndWait", async () => { calls.push(["stopChat"]); return true; });
  stub(t, terminalManager, "runtimeForSession", () => terminal);
  return calls;
}

async function request(method, pathname, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, headers: {} });
  const res = { status: 0, text: "", writeHead(status) { this.status = status; }, end(text) { this.text = text || ""; } };
  const url = new URL(pathname, "http://localhost");
  assert.equal(api.isCodexSessionPath(url.pathname), true);
  await api.handleCodexSessionRequest(req, res, url);
  return { status: res.status, body: res.text ? JSON.parse(res.text) : null };
}

test("lists one page with its cursor and without file paths", async (t) => {
  const calls = setup(t);
  const response = await request("GET", `/api/codex/sessions?cwd=/workspace&archived=true&cursor=abc&limit=20&q=fix`);
  assert.equal(response.status, 200);
  assert.equal(response.body.nextCursor, "next");
  assert.equal(response.body.sessions[0].path, undefined);
  assert.deepEqual(calls[0], ["list", { cwd: "/workspace", query: "fix", archived: true, cursor: "abc", limit: "20" }]);
});

for (const action of ["archive", "delete"]) {
  test(`refuses to ${action} a session with a running chat turn`, async (t) => {
    const calls = setup(t, { chat: { owner: "chat", state: "running" } });
    const response = await request("POST", `/api/codex/sessions/${ID}/${action}`, { cwd: "/workspace" });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, "session_busy");
    assert.deepEqual(calls, []);
  });

  test(`refuses to ${action} a session a terminal is resuming`, async (t) => {
    const calls = setup(t, { terminal: { owner: "terminal", state: "running", terminalId: "t1" } });
    const response = await request("POST", `/api/codex/sessions/${ID}/${action}`, { cwd: "/workspace" });
    assert.equal(response.status, 409);
    assert.deepEqual(calls, []);
  });

  test(`stops an idle chat runtime before it can ${action} the session`, async (t) => {
    const calls = setup(t, { chat: { owner: "chat", state: "idle" } });
    const response = await request("POST", `/api/codex/sessions/${ID}/${action}`, { cwd: "/workspace" });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [["stopChat"], [action === "delete" ? "remove" : action]]);
  });
}

test("rejects archiving an archived session without stopping its chat runtime", async (t) => {
  const calls = setup(t, { chat: { owner: "chat", state: "idle" } });
  stub(t, catalog, "requireSession", async () => ({ ...session, archived: true }));
  const response = await request("POST", `/api/codex/sessions/${ID}/archive`, {});
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "already_archived");
  assert.deepEqual(calls, []);
});

test("refuses to delete when a writer starts while the chat runtime stops", async (t) => {
  let chat = { owner: "chat", state: "idle" };
  const calls = setup(t);
  stub(t, codexAppServer, "runtimeForSession", () => chat);
  stub(t, codexAppServer, "stopAndWait", async () => { calls.push(["stopChat"]); chat = { owner: "chat", state: "running" }; });
  const response = await request("POST", `/api/codex/sessions/${ID}/delete`, {});
  assert.equal(response.status, 409);
  assert.deepEqual(calls, [["stopChat"]]);
});

test("maps errors to status codes", async (t) => {
  setup(t);
  stub(t, console, "error", () => {});
  stub(t, catalog, "requireSession", async () => { throw Object.assign(new Error("Codex session not found"), { code: "not_found" }); });
  assert.equal((await request("GET", `/api/codex/sessions/${ID}`)).status, 404);
  stub(t, catalog, "requireSession", async () => session);
  stub(t, catalog, "rename", async () => { throw Object.assign(new Error("app-server down: stderr details"), { code: "catalog_unavailable" }); });
  const unavailable = await request("POST", `/api/codex/sessions/${ID}/rename`, { name: "x" });
  assert.equal(unavailable.status, 503);
  assert.doesNotMatch(unavailable.body.error, /stderr/, "internal details stay in the server log");
  stub(t, catalog, "unarchive", async () => { throw Object.assign(new Error("Codex session is not archived"), { code: "not_archived" }); });
  assert.equal((await request("POST", `/api/codex/sessions/${ID}/unarchive`, {})).status, 409);
  stub(t, catalog, "remove", async () => { throw new Error("boom"); });
  assert.equal((await request("POST", `/api/codex/sessions/${ID}/delete`, {})).status, 500);
});
