import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { claudeModelLabel, claudeModelMenuLabel } = await jiti.import("./agents/claude-models.ts");

test("the Claude model label shows the alias with the version Claude reports", () => {
  assert.equal(claudeModelLabel("opus", "claude-opus-5-5"), "Opus · claude-opus-5-5");
  assert.equal(claudeModelLabel("opus", null), "Opus");
  // A version reported by a process launched with another model is not shown.
  assert.equal(claudeModelLabel("opus", "claude-haiku-4-5-20251001"), "Opus");
  assert.equal(claudeModelLabel("claude-sonnet-5", "claude-sonnet-5"), "claude-sonnet-5");
  assert.equal(claudeModelLabel("", "claude-sonnet-5"), "claude-sonnet-5");
  assert.equal(claudeModelLabel("", null), "Default model");
});

test("listed Claude models show the model ID behind each alias", () => {
  const options = [{ id: "opus[1m]", label: "Opus (1M context)", resolved: "claude-opus-5[1m]" }, { id: "claude-opus-5-5", label: "claude-opus-5-5", resolved: "claude-opus-5-5" }];
  assert.equal(claudeModelMenuLabel(options[0]), "Opus (1M context) · claude-opus-5[1m]");
  assert.equal(claudeModelMenuLabel(options[1]), "claude-opus-5-5");
  assert.equal(claudeModelLabel("opus[1m]", null, options), "Opus (1M context) · claude-opus-5[1m]");
  assert.equal(claudeModelLabel("opus[1m]", "claude-opus-5-6[1m]", options), "Opus (1M context) · claude-opus-5-6[1m]");
  assert.equal(claudeModelLabel("", null, options, "claude-opus-5[1m]"), "claude-opus-5[1m]");
});
