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

test("file changes carry a unified diff built from Codex's per-file changes", async () => {
  const { reduceCodexEvent } = await import("../../lib/agents/codex-conversation.ts");
  // The shapes Codex 0.155 sends: whole content for add/delete, bare hunks for update.
  const changes = [
    { path: "/w/new.txt", kind: { type: "add" }, diff: "a\nb\n" },
    { path: "/w/old.txt", kind: { type: "delete" }, diff: "x\n" },
    { path: "/w/app.ts", kind: { type: "update", move_path: "/w/main.ts" }, diff: "@@ -1,2 +1,2 @@\n a\n-b\n+c\n" },
  ];
  const [item] = reduceCodexEvent([], { method: "item/completed", params: { turnId: "t1", item: { id: "fc-1", type: "fileChange", status: "completed", changes } } });
  assert.deepEqual(item.files, ["/w/new.txt", "/w/old.txt", "/w/app.ts"]);
  assert.equal(item.diff, [
    "--- /dev/null", "+++ b//w/new.txt", "@@ -0,0 +1,2 @@", "+a", "+b",
    "--- a//w/old.txt", "+++ /dev/null", "@@ -1,1 +0,0 @@", "-x",
    "--- a//w/app.ts", "+++ b//w/main.ts", "@@ -1,2 +1,2 @@", " a", "-b", "+c",
  ].join("\n"));
  const empty = reduceCodexEvent([], { method: "item/started", params: { item: { id: "fc-2", type: "fileChange", changes: [{ path: "/w/a", kind: { type: "update" }, diff: "" }] } } });
  assert.equal(empty[0].diff, undefined);
});

test("plan updates become one task list per turn at the latest position", async () => {
  const { reduceCodexEvent } = await import("../../lib/agents/codex-conversation.ts");
  let items = reduceCodexEvent([], { method: "turn/plan/updated", params: { turnId: "t1", explanation: "Two steps", plan: [{ step: "Read", status: "inProgress" }, { step: "Fix", status: "pending" }] } });
  items = reduceCodexEvent(items, { method: "item/completed", params: { turnId: "t1", item: { id: "msg-1", type: "agentMessage", text: "Reading" } } });
  items = reduceCodexEvent(items, { method: "turn/plan/updated", params: { turnId: "t1", explanation: null, plan: [{ step: "Read", status: "completed" }, { step: "Fix", status: "inProgress" }] } });
  assert.deepEqual(items.map((item) => item.id), ["msg-1", "todo:t1"]);
  assert.deepEqual(items[1], { id: "todo:t1", kind: "todo", steps: [{ text: "Read", status: "completed" }, { text: "Fix", status: "inProgress" }] });
});

test("user messages remember the turn they started, live and optimistic", async () => {
  const { reduceCodexEvent } = await import("../../lib/agents/codex-conversation.ts");
  const pending = [{ id: "client-1", kind: "message", role: "user", text: "hello", pending: true }];
  const items = reduceCodexEvent(pending, { method: "item/started", params: { turnId: "turn-9", item: { id: "server-1", clientId: "client-1", type: "userMessage", content: [{ type: "text", text: "hello" }] } } });
  assert.deepEqual(items, [{ id: "client-1", kind: "message", role: "user", text: "hello", turnId: "turn-9" }]);
});
