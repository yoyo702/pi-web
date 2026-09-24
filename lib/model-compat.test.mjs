import assert from "node:assert/strict";
import test from "node:test";
import { normalizeModelCompat } from "./model-compat.ts";

test("custom Anthropic Opus 5.5 uses adaptive thinking and disallows off", () => {
  const original = { id: "claude-opus-5-5", reasoning: false, compat: { supportsStrictTools: false }, thinkingLevelMap: { off: "off" } };
  const model = normalizeModelCompat(original, "anthropic-messages");
  assert.equal(model.reasoning, true);
  assert.equal(model.compat.forceAdaptiveThinking, true);
  assert.equal(model.compat.supportsStrictTools, false);
  assert.equal(model.thinkingLevelMap.off, null);
  assert.equal(original.reasoning, false);
});

test("other models and API adapters retain their configuration", () => {
  for (const model of [
    { id: "claude-opus-4-8", api: "anthropic-messages" },
    { id: "claude-opus-5-5", api: "openai-completions" },
  ]) assert.equal(normalizeModelCompat(model), model);
});

test("Pi serializes an adaptive request with effort for the model test", async () => {
  const { completeSimple } = await import("@earendil-works/pi-ai/compat");
  const model = normalizeModelCompat({
    id: "claude-opus-5-5", name: "Opus 5.5", provider: "custom",
    api: "anthropic-messages", baseUrl: "https://example.invalid",
    reasoning: true, input: ["text"], contextWindow: 1000000, maxTokens: 128000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  let payload;
  await completeSimple(model, { messages: [{ role: "user", content: "OK", timestamp: Date.now() }] }, {
    apiKey: "test-key", reasoning: "low", maxTokens: 2048, maxRetries: 0,
    onPayload(value) { payload = value; throw new Error("Stop before network request"); },
  });
  assert.equal(payload.thinking.type, "adaptive");
  assert.equal(payload.output_config.effort, "low");
});
