import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createEmptySystemPromptExtension } = await jiti.import("./empty-system-prompt.ts");

function beforeAgentStartHandler(shouldForce) {
  const handlers = new Map();
  createEmptySystemPromptExtension(shouldForce).factory({ on: (event, handler) => handlers.set(event, handler) });
  return handlers.get("before_agent_start");
}

test("overrides the system prompt with an empty string only while forced", () => {
  let forced = true;
  const handler = beforeAgentStartHandler(() => forced);
  // The SDK treats `systemPrompt !== undefined` as an override, so "" must be returned explicitly.
  assert.deepEqual(handler({ type: "before_agent_start", prompt: "hi" }), { systemPrompt: "" });
  forced = false;
  assert.equal(handler({ type: "before_agent_start", prompt: "hi" }), undefined);
});
