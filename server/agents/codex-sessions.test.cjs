/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

function installFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-codex-test-"));
  const codex = path.join(home, ".codex");
  fs.mkdirSync(path.join(codex, "sessions", "2026"), { recursive: true });
  fs.mkdirSync(path.join(codex, "archived_sessions"), { recursive: true });
  fs.writeFileSync(path.join(codex, "session_index.jsonl"), [
    JSON.stringify({ id: "11111111-1111-1111-1111-111111111111", thread_name: "Active session", updated_at: "2026-01-02T00:00:00Z" }),
    JSON.stringify({ id: "22222222-2222-2222-2222-222222222222", thread_name: "Archived session", updated_at: "2026-01-01T00:00:00Z" }),
    "not json",
    "",
  ].join("\n"));
  const activePath = path.join(codex, "sessions", "2026", "active.jsonl");
  fs.writeFileSync(activePath, [
    JSON.stringify({ type: "session_meta", payload: { session_id: "11111111-1111-1111-1111-111111111111", cwd: "/workspace", cli_version: "1.0.0", model_provider: "openai" } }),
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-test" } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Explain this project" }] } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "It is a web interface for Pi." }] } }),
    JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: "x".repeat(160 * 1024) } }),
  ].join("\n") + "\n");
  fs.utimesSync(activePath, new Date("2026-01-03T00:00:00Z"), new Date("2026-01-03T00:00:00Z"));
  const stalePath = path.join(codex, "sessions", "2026", "stale-resume.jsonl");
  fs.writeFileSync(stalePath, [
    JSON.stringify({ type: "session_meta", payload: { session_id: "11111111-1111-1111-1111-111111111111", cwd: "/workspace", cli_version: "0.9.0", model_provider: "openai" } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Stale prompt" }] } }),
  ].join("\n") + "\n");
  fs.utimesSync(stalePath, new Date("2026-01-02T00:00:00Z"), new Date("2026-01-02T00:00:00Z"));
  const archivedPath = path.join(codex, "archived_sessions", "archived.jsonl");
  fs.writeFileSync(archivedPath, `${JSON.stringify({ type: "session_meta", payload: { session_id: "22222222-2222-2222-2222-222222222222", cwd: "/workspace", cli_version: "1.0.0", model_provider: "openai" } })}\n`);
  fs.utimesSync(archivedPath, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
  return home;
}

function withCatalog(callback) {
  const home = installFixture();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  delete require.cache[require.resolve("./codex-sessions.cjs")];
const catalog = require("./codex-sessions.cjs");
  try { callback(catalog); } finally {
    process.env.HOME = oldHome;
    delete require.cache[require.resolve("./codex-sessions.cjs")];
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("lists active and archived Codex sessions separately", () => withCatalog((catalog) => {
  const active = catalog.listSessions({ cwd: "/workspace", archived: false });
  const archived = catalog.listSessions({ cwd: "/workspace", archived: true });
  assert.equal(active.length, 1);
  assert.deepEqual(active[0], { id: "11111111-1111-1111-1111-111111111111", name: "Active session", updatedAt: "2026-01-03T00:00:00.000Z", cwd: "/workspace", cliVersion: "1.0.0", modelProvider: "openai", archived: false, model: "gpt-test", lastUserMessage: "Explain this project", lastAssistantMessage: "It is a web interface for Pi." });
  assert.equal(archived.length, 1);
  assert.equal(archived[0].name, "Archived session");
  assert.equal(archived[0].archived, true);
}));

test("returns bounded recent user and assistant messages for a preview", () => withCatalog((catalog) => {
  const preview = catalog.getSessionPreview("11111111-1111-1111-1111-111111111111");
  assert.deepEqual(preview.recentMessages, [
    { role: "user", text: "Explain this project" },
    { role: "assistant", text: "It is a web interface for Pi." },
  ]);
}));

test("backward message reads preserve UTF-8 characters split across chunk boundaries", () => withCatalog((catalog) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-codex-utf8-"));
  const file = path.join(directory, "session.jsonl");
  const expected = "prefix 你 suffix";
  const prefix = `${JSON.stringify({ type: "session_meta", payload: { session_id: "33333333-3333-3333-3333-333333333333", cwd: "/workspace" } })}\n`;
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

const ACTIVE_ID = "11111111-1111-1111-1111-111111111111";
const activeFile = () => path.join(os.homedir(), ".codex", "sessions", "2026", "active.jsonl");
const record = (payload, type = "response_item") => `${JSON.stringify({ type, payload })}\n`;

test("reads session metadata whose first line is larger than one read chunk", () => withCatalog((catalog) => {
  const file = activeFile();
  const rest = fs.readFileSync(file, "utf8").split("\n").slice(1).join("\n");
  const meta = record({ session_id: ACTIVE_ID, cwd: "/workspace", cli_version: "1.0.0", model_provider: "openai", base_instructions: "界".repeat(100 * 1024) }, "session_meta");
  fs.writeFileSync(file, meta + rest);
  fs.utimesSync(file, new Date("2026-01-03T00:00:00Z"), new Date("2026-01-03T00:00:00Z"));
  const [session] = catalog.listSessions({ cwd: "/workspace", archived: false });
  assert.equal(session?.id, ACTIVE_ID);
  assert.equal(session.lastUserMessage, "Explain this project");
}));

test("cached session details refresh when the session file changes", () => withCatalog((catalog) => {
  assert.equal(catalog.listSessions({ archived: false })[0].lastUserMessage, "Explain this project");
  const file = activeFile();
  fs.appendFileSync(file, record({ type: "message", role: "user", content: [{ type: "input_text", text: "A newer question" }] }));
  fs.utimesSync(file, new Date("2026-01-04T00:00:00Z"), new Date("2026-01-04T00:00:00Z"));
  const [session] = catalog.listSessions({ archived: false });
  assert.equal(session.lastUserMessage, "A newer question");
  assert.equal(session.updatedAt, "2026-01-04T00:00:00.000Z");
}));

test("finds the latest turn id by reading backward across chunk boundaries", () => withCatalog((catalog) => {
  const file = activeFile();
  assert.equal(catalog.latestTurnId(ACTIVE_ID), null);
  fs.appendFileSync(file, record({ type: "task_started", turn_id: "turn-1" }) + record({ type: "task_started", turn_id: "turn-2", note: "界".repeat(100 * 1024) }));
  for (let index = 0; index < 40; index += 1) fs.appendFileSync(file, record({ type: "function_call_output", output: "y".repeat(16 * 1024) }));
  assert.equal(catalog.latestTurnId(ACTIVE_ID), "turn-2");
}));

test("renames only the target Codex session index entry", () => withCatalog((catalog) => {
  const renamed = catalog.rename("11111111-1111-1111-1111-111111111111", "Renamed");
  assert.equal(renamed.name, "Renamed");
  assert.equal(catalog.listSessions({ archived: true })[0].name, "Archived session");
}));
