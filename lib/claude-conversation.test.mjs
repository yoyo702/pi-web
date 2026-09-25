import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { claudeConversationItems, claudeToolDiff } = await jiti.import("./agents/claude-conversation.ts");

const assistant = (id, piBlockIndex, content) => ({ type: "assistant", uuid: `u-${id}-${piBlockIndex}`, piBlockIndex, message: { id, role: "assistant", content } });
const delta = (index, text) => ({ type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "text_delta", text } } });

test("streamed text is replaced in place by the finished assistant record", () => {
  const streaming = [
    { type: "user", uuid: "q1", message: { role: "user", content: "hi" } },
    { type: "stream_event", event: { type: "message_start", message: { id: "m1" } } },
    { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    delta(0, "Hel"), delta(0, "lo"),
  ];
  const partial = claudeConversationItems(streaming);
  assert.deepEqual(partial.map((item) => [item.id, item.kind, item.text, item.streaming]), [["q1", "message", "hi", undefined], ["m1:0", "message", "Hello", true]]);
  const done = claudeConversationItems([...streaming, assistant("m1", 0, [{ type: "text", text: "Hello!" }]), { type: "result", piSeq: 9 }]);
  assert.deepEqual(done.map((item) => [item.id, item.text, item.streaming]), [["q1", "hi", undefined], ["m1:0", "Hello!", undefined]]);
});

test("tools complete from their tool_result and Bash maps to a command", () => {
  const items = claudeConversationItems([
    assistant("m1", 0, [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]),
    assistant("m1", 1, [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: "/a/x.ts", old_string: "a\n", new_string: "b\n" } }]),
    { type: "user", uuid: "r1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x.ts" }] } },
    { type: "user", uuid: "r2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "denied" }], is_error: true }] } },
  ]);
  assert.deepEqual(items[0], { id: "t1", kind: "command", command: "ls", output: "x.ts", exitCode: 0, done: true });
  assert.equal(items[1].kind, "toolCall");
  assert.equal(items[1].isError, true);
  assert.equal(items[1].output, "denied");
  assert.equal(items[1].diff, "--- a//a/x.ts\n+++ b//a/x.ts\n@@ -1,1 +1,1 @@\n-a\n+b");
  assert.equal(items.length, 2);
});

test("user records show slash commands, command output and interrupts", () => {
  const items = claudeConversationItems([
    { type: "user", uuid: "c", message: { role: "user", content: "<command-name>/model</command-name><command-args>opus</command-args>" } },
    { type: "user", uuid: "o", message: { role: "user", content: "<local-command-stdout>Set model to opus</local-command-stdout>" } },
    { type: "user", uuid: "i", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } },
    { type: "user", uuid: "p", pending: true, message: { role: "user", content: "next" } },
    { type: "result", is_error: true, result: "API error", piSeq: 4 },
  ]);
  assert.deepEqual(items.map((item) => [item.id, item.kind, item.text]), [
    ["c", "message", "/model opus"], ["o", "notice", "Set model to opus"], ["i", "notice", "Interrupted"], ["p", "message", "next"], ["result:4", "notice", "API error"],
  ]);
  assert.equal(items[3].pending, true);
  assert.equal(items[4].tone, "error");
});

test("a turn that ends without a result still stops streaming", () => {
  const items = claudeConversationItems([
    { type: "stream_event", event: { type: "message_start", message: { id: "m" } } },
    { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "Read", input: {} } } },
    { type: "pi/closed", error: "exit 1" },
  ]);
  assert.equal(items[0].done, true);
});

test("claudeToolDiff covers Write and MultiEdit, not other tools", () => {
  assert.equal(claudeToolDiff("Write", { file_path: "f", content: "x\ny\n" }), "--- a/f\n+++ b/f\n@@ -1,0 +1,2 @@\n+x\n+y");
  assert.equal(claudeToolDiff("MultiEdit", { file_path: "f", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "" }] }), "--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@\n-a\n+b\n@@ -1,1 +1,0 @@\n-c");
  assert.equal(claudeToolDiff("Read", { file_path: "f" }), undefined);
});
