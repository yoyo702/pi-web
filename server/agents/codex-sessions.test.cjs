/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const FAKE_SERVER = path.join(__dirname, "fixtures", "fake-codex-app-server.cjs");
const ACTIVE_ID = "11111111-1111-1111-1111-111111111111";
const ARCHIVED_ID = "22222222-2222-2222-2222-222222222222";
const UNNAMED_ID = "33333333-3333-3333-3333-333333333333";
const FORK_ID = "44444444-4444-4444-4444-444444444444";
const SUBAGENT_ID = "55555555-5555-5555-5555-555555555555";
const record = (payload, type = "response_item") => `${JSON.stringify({ type, payload })}\n`;
const meta = (id, extra = {}) => record({ session_id: id, cwd: "/workspace", cli_version: "1.0.0", model_provider: "openai", source: "cli", ...extra }, "session_meta");
const userMessage = (text) => record({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const assistantMessage = (text) => record({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });

function writeSession(file, content, date) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  fs.utimesSync(file, new Date(date), new Date(date));
}

// A temp CODEX_HOME with session files, plus a fake app-server whose thread
// catalog points at them. Nothing here touches the real ~/.codex.
function installFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-codex-test-"));
  const codex = path.join(home, ".codex");
  const file = (name, archived = false) => path.join(codex, archived ? "archived_sessions" : "sessions", "2026", name);
  fs.mkdirSync(path.join(codex, "archived_sessions"), { recursive: true });
  fs.writeFileSync(path.join(codex, "session_index.jsonl"), [
    JSON.stringify({ id: ACTIVE_ID, thread_name: "Active session", updated_at: "2026-01-02T00:00:00Z" }),
    JSON.stringify({ id: ARCHIVED_ID, thread_name: "Archived session", updated_at: "2026-01-01T00:00:00Z" }),
    "not json",
    "",
  ].join("\n"));
  writeSession(file("active.jsonl"), [
    meta(ACTIVE_ID),
    record({ model: "gpt-test" }, "turn_context"),
    userMessage("Explain this project"),
    assistantMessage("It is a web interface for Pi."),
    record({ type: "function_call_output", output: "x".repeat(160 * 1024) }),
  ].join(""), "2026-01-03T00:00:00Z");
  writeSession(file("stale-resume.jsonl"), meta(ACTIVE_ID, { cli_version: "0.9.0" }) + userMessage("Stale prompt"), "2026-01-02T00:00:00Z");
  writeSession(file("archived.jsonl", true), meta(ARCHIVED_ID), "2026-01-01T00:00:00Z");
  writeSession(file("unnamed.jsonl"), meta(UNNAMED_ID) + userMessage("Unnamed question"), "2026-01-02T12:00:00Z");
  writeSession(file("fork.jsonl"), meta(FORK_ID, { forked_from_id: ACTIVE_ID }) + userMessage("Forked question"), "2026-01-02T06:00:00Z");
  writeSession(file("subagent.jsonl"), meta(SUBAGENT_ID, { source: { subagent: "review" } }), "2026-01-04T00:00:00Z");

  const seconds = (date) => Date.parse(date) / 1000;
  const thread = (id, extra) => ({ id, name: null, preview: "", cwd: "/workspace", model: "gpt-test", modelProvider: "openai", cliVersion: "1.0.0", forkedFromId: null, archived: false, ...extra });
  const state = path.join(home, "fake-state.json");
  fs.writeFileSync(state, JSON.stringify({ threads: [
    thread(ACTIVE_ID, { name: "Active session", updatedAt: seconds("2026-01-03T00:00:00Z"), path: file("active.jsonl") }),
    thread(UNNAMED_ID, { preview: "Unnamed question\nwith more lines", updatedAt: seconds("2026-01-02T12:00:00Z"), path: file("unnamed.jsonl"), model: null }),
    thread(FORK_ID, { name: "Forked", forkedFromId: ACTIVE_ID, updatedAt: seconds("2026-01-02T06:00:00Z"), path: file("fork.jsonl"), cwd: "/elsewhere" }),
    thread(ARCHIVED_ID, { name: "Archived session", archived: true, updatedAt: seconds("2026-01-01T00:00:00Z"), path: file("archived.jsonl", true) }),
  ] }));
  return { home, state, log: path.join(home, "fake-log.jsonl"), activeFile: file("active.jsonl") };
}

async function withCatalog(callback, { server = "fake" } = {}) {
  const fixture = installFixture();
  const previous = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };
  process.env.HOME = fixture.home;
  delete process.env.CODEX_HOME;
  for (const name of ["./codex-sessions.cjs", "./codex-catalog.cjs"]) delete require.cache[require.resolve(name)];
  const codexCatalog = require("./codex-catalog.cjs");
  codexCatalog.configure(server === "fake"
    ? { command: process.execPath, args: [FAKE_SERVER], env: { ...process.env, FAKE_CODEX_STATE: fixture.state, FAKE_CODEX_LOG: fixture.log } }
    : { command: path.join(fixture.home, "missing-codex") });
  const catalog = require("./codex-sessions.cjs");
  const requests = () => fs.existsSync(fixture.log) ? fs.readFileSync(fixture.log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  try {
    await callback({ catalog, codexCatalog, fixture, requests });
  } finally {
    codexCatalog.configure(null);
    process.env.HOME = previous.HOME;
    if (previous.CODEX_HOME === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous.CODEX_HOME;
    fs.rmSync(fixture.home, { recursive: true, force: true });
  }
}

test("lists sessions from the app-server, including unnamed and forked ones", () => withCatalog(async ({ catalog, requests }) => {
  const { sessions, nextCursor } = await catalog.listSessions({ archived: false });
  assert.equal(nextCursor, null);
  assert.deepEqual(sessions.map((session) => session.id), [ACTIVE_ID, UNNAMED_ID, FORK_ID]);
  const [active, unnamed, fork] = sessions;
  assert.equal(active.name, "Active session");
  assert.equal(active.updatedAt, "2026-01-03T00:00:00.000Z");
  assert.equal(active.lastUserMessage, "Explain this project");
  assert.equal(active.lastAssistantMessage, "It is a web interface for Pi.");
  assert.equal(active.archived, false);
  assert.equal(unnamed.name, "Unnamed question with more lines", "an unnamed session is titled by its first message");
  assert.equal(unnamed.model, null);
  assert.equal(fork.forkedFromId, ACTIVE_ID);
  const list = requests().find((request) => request.method === "thread/list");
  assert.deepEqual(list.params.modelProviders, [], "all model providers are listed");
  assert.equal(list.params.archived, false);
  assert.equal(list.params.sortKey, "updated_at");
}));

test("filters by workspace and archive state and pages with a cursor", () => withCatalog(async ({ catalog }) => {
  const first = await catalog.listSessions({ cwd: "/workspace", limit: 1 });
  assert.deepEqual(first.sessions.map((session) => session.id), [ACTIVE_ID]);
  assert.ok(first.nextCursor);
  const second = await catalog.listSessions({ cwd: "/workspace", limit: 1, cursor: first.nextCursor });
  assert.deepEqual(second.sessions.map((session) => session.id), [UNNAMED_ID]);
  assert.equal(second.nextCursor, null);
  const archived = await catalog.listSessions({ archived: true });
  assert.deepEqual(archived.sessions.map((session) => [session.id, session.archived]), [[ARCHIVED_ID, true]]);
}));

test("finds a session by title search or by its full id", () => withCatalog(async ({ catalog }) => {
  assert.deepEqual((await catalog.listSessions({ query: "Active" })).sessions.map((session) => session.id), [ACTIVE_ID]);
  assert.deepEqual((await catalog.listSessions({ query: FORK_ID })).sessions.map((session) => session.id), [FORK_ID]);
  assert.deepEqual((await catalog.listSessions({ query: FORK_ID, cwd: "/workspace" })).sessions, [], "an id match still respects the workspace filter");
}));

test("drops duplicate threads returned by the app-server", () => withCatalog(async ({ catalog, fixture }) => {
  const state = JSON.parse(fs.readFileSync(fixture.state, "utf8"));
  state.threads.push({ ...state.threads[0] });
  fs.writeFileSync(fixture.state, JSON.stringify(state));
  const { sessions } = await catalog.listSessions({});
  assert.equal(sessions.filter((session) => session.id === ACTIVE_ID).length, 1);
}));

test("falls back to scanning session files when the app-server is unavailable", () => withCatalog(async ({ catalog }) => {
  const { sessions, nextCursor } = await catalog.listSessions({ cwd: "/workspace", archived: false });
  assert.equal(nextCursor, null);
  assert.deepEqual(sessions.map((session) => [session.id, session.name]), [
    [ACTIVE_ID, "Active session"],
    [UNNAMED_ID, "Untitled session"],
    [FORK_ID, "Untitled session"],
  ], "unnamed sessions are listed; sub-agent threads and duplicate files are not");
  assert.equal(sessions[0].lastUserMessage, "Explain this project");
  assert.equal(sessions[0].updatedAt, "2026-01-03T00:00:00.000Z", "the newest file for an id wins");
  assert.equal(sessions[2].forkedFromId, ACTIVE_ID);
  assert.deepEqual((await catalog.listSessions({ archived: true })).sessions.map((session) => session.id), [ARCHIVED_ID]);
  assert.equal((await catalog.requireSession(UNNAMED_ID)).id, UNNAMED_ID);
  await assert.rejects(catalog.listSessions({ cursor: "50" }), { code: "catalog_unavailable" }, "a cursor from the app-server cannot continue in the file scan");
}, { server: "missing" }));

test("looks up single sessions through the app-server", () => withCatalog(async ({ catalog }) => {
  const fork = await catalog.requireSession(FORK_ID);
  assert.equal(fork.forkedFromId, ACTIVE_ID);
  assert.equal(fork.cwd, "/elsewhere");
  await assert.rejects(catalog.requireSession("99999999-9999-9999-9999-999999999999"), { code: "not_found" });
  await assert.rejects(catalog.requireSession("../etc"), { code: "invalid_session" });
  const preview = await catalog.getSessionPreview(ACTIVE_ID);
  assert.deepEqual(preview.recentMessages, [
    { role: "user", text: "Explain this project" },
    { role: "assistant", text: "It is a web interface for Pi." },
  ]);
}));

test("renames, archives, restores and deletes through the protocol", () => withCatalog(async ({ catalog, requests }) => {
  assert.equal((await catalog.rename(UNNAMED_ID, "  Named now  ")).name, "Named now");
  assert.equal((await catalog.requireSession(UNNAMED_ID)).name, "Named now");
  await assert.rejects(catalog.rename(UNNAMED_ID, " "), { code: "invalid_name" });

  assert.equal((await catalog.archive(UNNAMED_ID)).archived, true);
  assert.equal((await catalog.requireSession(UNNAMED_ID)).archived, true);
  await assert.rejects(catalog.archive(UNNAMED_ID), { code: "already_archived" });
  assert.equal((await catalog.unarchive(UNNAMED_ID)).archived, false);
  await assert.rejects(catalog.unarchive(UNNAMED_ID), { code: "not_archived" });

  await catalog.remove(UNNAMED_ID);
  await assert.rejects(catalog.requireSession(UNNAMED_ID), { code: "not_found" });
  const methods = requests().map((request) => request.method);
  for (const method of ["thread/name/set", "thread/archive", "thread/unarchive", "thread/delete"]) assert.ok(methods.includes(method), method);
}));

function withClient(options, callback) {
  const fixture = installFixture();
  const client = require("./codex-catalog.cjs").createClient({ command: process.execPath, args: [FAKE_SERVER], env: { ...process.env, FAKE_CODEX_STATE: fixture.state }, ...options });
  return Promise.resolve().then(() => callback(client)).finally(() => {
    client.close();
    fs.rmSync(fixture.home, { recursive: true, force: true });
  });
}

test("a client restarts the app-server on the next request after it exits", () => withClient({}, async (client) => {
  assert.equal((await client.request("thread/read", { threadId: ACTIVE_ID })).thread.id, ACTIVE_ID);
  await assert.rejects(client.request("test/crash", {}), { code: "catalog_unavailable" });
  assert.equal((await client.request("thread/read", { threadId: ACTIVE_ID })).thread.id, ACTIVE_ID);
}));

test("a request that never gets an answer times out and the next one reconnects", () => withClient({ timeoutMs: 200 }, async (client) => {
  await assert.rejects(client.request("test/hang", {}), { code: "catalog_unavailable", message: /timed out/ });
  assert.equal((await client.request("thread/read", { threadId: ACTIVE_ID })).thread.id, ACTIVE_ID);
}));

test("a server that fails to initialize is dropped and not restarted on every request", async () => {
  const fixture = installFixture();
  const client = require("./codex-catalog.cjs").createClient({ command: process.execPath, args: [FAKE_SERVER], retryMs: 150, env: { ...process.env, FAKE_CODEX_STATE: fixture.state, FAKE_CODEX_LOG: fixture.log, FAKE_CODEX_INIT_ERROR: "1" } });
  const starts = () => fs.existsSync(fixture.log) ? fs.readFileSync(fixture.log, "utf8").trim().split("\n").length : 0;
  try {
    await assert.rejects(client.request("thread/list", {}), { code: "catalog_unavailable", message: /failed to initialize/ });
    await assert.rejects(client.request("thread/list", {}), { code: "catalog_unavailable", message: /retrying shortly/ });
    assert.equal(starts(), 1, "no new process during the retry delay");
    await new Promise((resolve) => setTimeout(resolve, 200));
    await assert.rejects(client.request("thread/list", {}), { code: "catalog_unavailable", message: /failed to initialize/ });
    assert.equal(starts(), 2, "the next request after the delay starts a new process");
  } finally {
    client.close();
    fs.rmSync(fixture.home, { recursive: true, force: true });
  }
});

test("protocol errors are reported without dropping the connection", () => withClient({}, async (client) => {
  await assert.rejects(client.request("thread/read", { threadId: "missing" }), { code: "rpc_error", rpcCode: -32600 });
  assert.equal((await client.request("thread/read", { threadId: ACTIVE_ID })).thread.id, ACTIVE_ID);
}));

test("reads session metadata whose first line is larger than one read chunk", () => withCatalog(async ({ catalog, fixture }) => {
  const rest = fs.readFileSync(fixture.activeFile, "utf8").split("\n").slice(1).join("\n");
  const bigMeta = meta(ACTIVE_ID, { base_instructions: "界".repeat(100 * 1024) });
  writeSession(fixture.activeFile, bigMeta + rest, "2026-01-03T00:00:00Z");
  const [session] = (await catalog.listSessions({ cwd: "/workspace" })).sessions;
  assert.equal(session?.id, ACTIVE_ID);
  assert.equal(session.name, "Active session");
  assert.equal(session.lastUserMessage, "Explain this project");
}, { server: "missing" }));

test("cached session summaries refresh when the session file changes", () => withCatalog(async ({ catalog, fixture }) => {
  assert.equal((await catalog.listSessions({})).sessions[0].lastUserMessage, "Explain this project");
  fs.appendFileSync(fixture.activeFile, userMessage("A newer question"));
  fs.utimesSync(fixture.activeFile, new Date("2026-01-04T00:00:00Z"), new Date("2026-01-04T00:00:00Z"));
  assert.equal((await catalog.listSessions({})).sessions[0].lastUserMessage, "A newer question");
}));

test("backward message reads preserve UTF-8 characters split across chunk boundaries", () => withCatalog(async ({ catalog }) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-codex-utf8-"));
  const file = path.join(directory, "session.jsonl");
  const expected = "prefix 你 suffix";
  const prefix = `${JSON.stringify({ type: "session_meta", payload: { session_id: UNNAMED_ID, cwd: "/workspace" } })}\n`;
  const user = JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: expected }] } });
  const assistant = JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] } });
  const base = Buffer.from(`${prefix}${user}\n${assistant}\n`);
  const characterOffset = Buffer.from(prefix).length + Buffer.from(user.slice(0, user.indexOf("你"))).length;
  const suffixLength = 128 * 1024 + characterOffset + 1 - base.length;
  fs.writeFileSync(file, Buffer.concat([base, Buffer.from("x".repeat(suffixLength))]));
  try {
    const messages = catalog.readRecentMessages({ path: file }, 256 * 1024, 2);
    assert.equal(messages.find((message) => message.role === "user")?.text, expected);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}));

test("finds the latest turn id by reading backward across chunk boundaries", () => withCatalog(async ({ catalog, fixture }) => {
  assert.equal(await catalog.latestTurnId(ACTIVE_ID), null);
  fs.appendFileSync(fixture.activeFile, record({ type: "task_started", turn_id: "turn-1" }) + record({ type: "task_started", turn_id: "turn-2", note: "界".repeat(100 * 1024) }));
  for (let index = 0; index < 40; index += 1) fs.appendFileSync(fixture.activeFile, record({ type: "function_call_output", output: "y".repeat(16 * 1024) }));
  assert.equal(await catalog.latestTurnId(ACTIVE_ID), "turn-2");
}));
