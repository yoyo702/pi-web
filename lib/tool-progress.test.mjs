import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_ACTIVE_TOOL_COMMAND_CHARS,
  MAX_ACTIVE_TOOL_OUTPUT_CHARS,
  readActiveToolCommand,
  readActiveToolOutput,
} from "./tool-progress.ts";

test("reads bash commands without exposing unrelated tool arguments", () => {
  assert.equal(readActiveToolCommand("bash", { command: "npm test" }), "npm test");
  assert.equal(readActiveToolCommand("read", { command: "secret" }), undefined);
  assert.equal(readActiveToolCommand("bash", {}), undefined);
});

test("keeps only bounded command and streaming output tails", () => {
  const command = "x".repeat(MAX_ACTIVE_TOOL_COMMAND_CHARS + 50);
  const output = "y".repeat(MAX_ACTIVE_TOOL_OUTPUT_CHARS + 50);
  const boundedCommand = readActiveToolCommand("bash", { command });
  const boundedOutput = readActiveToolOutput({ content: [{ type: "text", text: output }] });

  assert.equal(boundedCommand?.length, MAX_ACTIVE_TOOL_COMMAND_CHARS);
  assert.equal(boundedOutput?.length, MAX_ACTIVE_TOOL_OUTPUT_CHARS);
  assert.equal(boundedCommand?.startsWith("…"), true);
  assert.equal(boundedOutput?.startsWith("…"), true);
});

test("combines text blocks and ignores non-text partial results", () => {
  assert.equal(readActiveToolOutput({
    content: [{ type: "text", text: "one" }, { type: "image" }, { type: "text", text: "two" }],
  }), "one\ntwo");
  assert.equal(readActiveToolOutput({ content: [{ type: "image" }] }), undefined);
});
