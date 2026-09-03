import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  MAX_BACKGROUND_SESSION_EVENT_BYTES,
  projectBackgroundSessionEvent,
} = await jiti.import("./background-session-event.ts");

test("drops token-level events from the global background stream", () => {
  const growingMessage = { role: "assistant", content: [{ type: "text", text: "x".repeat(24_000) }] };
  for (let i = 0; i < 10_000; i += 1) {
    assert.equal(projectBackgroundSessionEvent({ type: "message_update", message: growingMessage }), null);
  }
  assert.equal(projectBackgroundSessionEvent({ type: "tool_execution_update", delta: "x" }), null);
});

test("projects completion events to a bounded payload", () => {
  const toolStart = projectBackgroundSessionEvent({
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "read",
    args: "x".repeat(200_000),
  });
  assert.deepEqual(toolStart, {
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "read",
  });

  const small = projectBackgroundSessionEvent({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "done" }] },
  });
  assert.equal(small.type, "message_end");
  assert.ok(Buffer.byteLength(JSON.stringify(small)) < MAX_BACKGROUND_SESSION_EVENT_BYTES);

  const large = projectBackgroundSessionEvent({
    type: "message_end",
    message: { role: "toolResult", content: [{ type: "text", text: "x".repeat(200_000) }] },
  });
  assert.deepEqual(large, { type: "session_refresh" });
});
