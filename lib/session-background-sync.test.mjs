import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { reduceSessionSnapshotEvent } = await jiti.import("./session-background-sync.ts");

function snapshot() {
  return {
    sessionId: "session-1",
    updatedAt: 1,
    data: {
      sessionId: "session-1",
      filePath: "/tmp/session.jsonl",
      tree: [],
      leafId: "a1",
      context: {
        messages: [{ role: "user", content: "start", timestamp: 1 }],
        entryIds: ["u1"],
        thinkingLevel: "medium",
        model: null,
      },
    },
    messages: [{ role: "user", content: "start", timestamp: 1 }],
    entryIds: ["u1"],
    activeLeafId: "a1",
    streamState: { isStreaming: true, streamingMessage: null },
    agentRunning: true,
    agentPhase: { kind: "waiting_model" },
  };
}

test("keeps an unmounted running session snapshot current from global events", () => {
  const streaming = reduceSessionSnapshotEvent(snapshot(), {
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text: "working" }], timestamp: 2 },
  });
  assert.equal(streaming.streamState.streamingMessage.content[0].text, "working");
  assert.equal(streaming.agentRunning, true);

  const completedMessage = {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    timestamp: 3,
  };
  const completed = reduceSessionSnapshotEvent(streaming, { type: "message_end", message: completedMessage });
  assert.equal(completed.messages.at(-1).content[0].text, "done");
  assert.equal(completed.streamState.streamingMessage, null);

  const deduplicated = reduceSessionSnapshotEvent(completed, { type: "message_end", message: completedMessage });
  assert.equal(deduplicated.messages.length, completed.messages.length);

  const ended = reduceSessionSnapshotEvent(deduplicated, { type: "agent_end" });
  assert.equal(ended.agentRunning, false);
  assert.equal(ended.streamState.isStreaming, false);
  assert.equal(ended.agentPhase, null);
});

test("tracks background tool activity without requiring a mounted chat", () => {
  const started = reduceSessionSnapshotEvent(snapshot(), {
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "read",
  });
  assert.deepEqual(started.agentPhase, {
    kind: "running_tools",
    tools: [{ id: "call-1", name: "read" }],
  });

  const ended = reduceSessionSnapshotEvent(started, {
    type: "tool_execution_end",
    toolCallId: "call-1",
  });
  assert.deepEqual(ended.agentPhase, { kind: "waiting_model" });
});
