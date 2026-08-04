"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const test = require("node:test");
const assert = require("node:assert/strict");

test("conversation reducer merges command output and completion", async () => {
  const { reduceCodexEvent } = await import("../../lib/agents/codex-conversation.ts");
  let items = reduceCodexEvent([], { method: "item/started", params: { item: { id: "cmd-1", type: "commandExecution", command: "npm test" } } });
  items = reduceCodexEvent(items, { method: "item/commandExecution/outputDelta", params: { itemId: "cmd-1", delta: "ok\n" } });
  items = reduceCodexEvent(items, { method: "item/completed", params: { item: { id: "cmd-1", type: "commandExecution", command: "npm test", aggregatedOutput: "ok\n", exitCode: 0, durationMs: 1250, status: "completed" } } });
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], { id: "cmd-1", kind: "command", command: "npm test", cwd: undefined, output: "ok\n", exitCode: 0, durationMs: 1250, status: "completed", done: true });
});

test("conversation reducer reconciles optimistic user messages by client id", async () => {
  const { reduceCodexEvent } = await import("../../lib/agents/codex-conversation.ts");
  const pending = [{ id: "client-1", kind: "message", role: "user", text: "hello", pending: true }];
  const items = reduceCodexEvent(pending, { method: "item/completed", params: { item: { id: "server-1", clientId: "client-1", type: "userMessage", content: [{ type: "text", text: "hello" }] } } });
  assert.deepEqual(items, [{ id: "client-1", kind: "message", role: "user", text: "hello" }]);
});
