import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { isModelContextOnlyMessage, isModelContextOnlyMessageEvent } = await jiti.import("./model-context-messages.ts");

const system = { role: "system", content: "", sections: { preamble: "You are..." }, timestamp: 1 };
const user = { role: "user", content: "hi", timestamp: 2 };

test("system messages are model context, not chat history", () => {
  assert.equal(isModelContextOnlyMessage(system), true);
  assert.equal(isModelContextOnlyMessage(user), false);
  assert.equal(isModelContextOnlyMessage(undefined), false);
  assert.equal(isModelContextOnlyMessage("text"), false);
});

test("message events carrying system messages are recognised; other events are not", () => {
  for (const type of ["message_start", "message_update", "message_end"]) {
    assert.equal(isModelContextOnlyMessageEvent({ type, message: system }), true);
    assert.equal(isModelContextOnlyMessageEvent({ type, message: user }), false);
  }
  assert.equal(isModelContextOnlyMessageEvent({ type: "agent_start" }), false);
  assert.equal(isModelContextOnlyMessageEvent({ type: "tool_execution_end", message: system }), false);
});
