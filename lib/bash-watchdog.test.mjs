import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  DEFAULT_BASH_TIMEOUT_SECONDS,
  applyDefaultBashTimeout,
  createBashWatchdogExtension,
  resolveDefaultBashTimeoutSeconds,
} = await jiti.import("./bash-watchdog.ts");

test("uses a bounded default bash timeout and supports disabling it", () => {
  assert.equal(resolveDefaultBashTimeoutSeconds(undefined), DEFAULT_BASH_TIMEOUT_SECONDS);
  assert.equal(resolveDefaultBashTimeoutSeconds(""), DEFAULT_BASH_TIMEOUT_SECONDS);
  assert.equal(resolveDefaultBashTimeoutSeconds("not-a-number"), DEFAULT_BASH_TIMEOUT_SECONDS);
  assert.equal(resolveDefaultBashTimeoutSeconds("-1"), DEFAULT_BASH_TIMEOUT_SECONDS);
  assert.equal(resolveDefaultBashTimeoutSeconds("0"), null);
  assert.equal(resolveDefaultBashTimeoutSeconds("12.6"), 13);
  assert.equal(resolveDefaultBashTimeoutSeconds("999999"), 86_400);
});

test("only supplies a timeout when the model omitted one", () => {
  const missing = {};
  assert.equal(applyDefaultBashTimeout(missing, 300), true);
  assert.equal(missing.timeout, 300);

  const explicit = { timeout: 900 };
  assert.equal(applyDefaultBashTimeout(explicit, 300), false);
  assert.equal(explicit.timeout, 900);

  const disabled = {};
  assert.equal(applyDefaultBashTimeout(disabled, null), false);
  assert.equal(disabled.timeout, undefined);
});

test("watchdog extension applies the timeout to bash tool calls", async () => {
  let handler;
  const extension = createBashWatchdogExtension("45");
  extension.factory({
    on(event, nextHandler) {
      assert.equal(event, "tool_call");
      handler = nextHandler;
    },
  });

  const bashEvent = { type: "tool_call", toolName: "bash", toolCallId: "call-1", input: { command: "adb devices" } };
  await handler(bashEvent);
  assert.equal(bashEvent.input.timeout, 45);

  const readEvent = { type: "tool_call", toolName: "read", toolCallId: "call-2", input: { path: "README.md" } };
  await handler(readEvent);
  assert.equal(readEvent.input.timeout, undefined);
});
