import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url);
const { writeUnflushedSession } = await jiti.import("./session-write.ts");

function withDir(callback) {
  const directory = mkdtempSync(join(tmpdir(), "pi-web-session-write-"));
  try { return callback(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("a fork before the first message can be reopened by its path with the same id and parent", () => withDir((directory) => {
  const manager = SessionManager.create("/workspace", directory);
  manager.newSession({ parentSession: "/sessions/source.jsonl" });
  const file = manager.getSessionFile();
  assert.equal(existsSync(file), false, "pi has not written the file yet");
  writeUnflushedSession(manager);
  const reopened = SessionManager.open(file, directory);
  assert.equal(reopened.getSessionId(), manager.getSessionId());
  assert.equal(reopened.getHeader()?.parentSession, "/sessions/source.jsonl");
}));

test("a fork of a conversation without an assistant reply keeps its entries", () => withDir((directory) => {
  const source = SessionManager.create("/workspace", directory);
  const first = source.appendMessage({ role: "user", content: [{ type: "text", text: "first" }], timestamp: 0 });
  source.appendMessage({ role: "user", content: [{ type: "text", text: "second" }], timestamp: 0 });
  const forkedPath = source.createBranchedSession(first);
  writeUnflushedSession(source);
  assert.ok(forkedPath && existsSync(forkedPath));
  const reopened = SessionManager.open(forkedPath, directory);
  assert.equal(reopened.getSessionId(), source.getSessionId());
  assert.deepEqual(reopened.getEntries().map((entry) => entry.id), [first]);
}));

test("leaves an already written session file untouched", () => withDir((directory) => {
  const manager = SessionManager.create("/workspace", directory);
  manager.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 0, api: "x", provider: "x", model: "x", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" });
  const file = manager.getSessionFile();
  assert.ok(existsSync(file));
  assert.doesNotThrow(() => writeUnflushedSession(manager));
  assert.equal(SessionManager.open(file, directory).getEntries().length, 2);
}));
