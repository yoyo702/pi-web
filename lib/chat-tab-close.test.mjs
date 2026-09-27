import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { busyChatForTab } = await jiti.import("./chat-tab-close.ts");

const codexTab = { id: "codex-chat:t1", label: "Fix", kind: "codex-chat", sourceSessionId: "t1", cwd: "/r" };
const claudeTab = { id: "claude-chat:s1", label: "Review", kind: "claude-chat", sourceSessionId: "s1", cwd: "/r" };
const codex = (state) => [{ threadId: "t1", cwd: "/r", owner: "chat", state }];
const claude = (state) => [{ sessionId: "s1", cwd: "/r", owner: "chat", state }];

test("a chat tab is busy while its runtime runs or waits for approval", () => {
  assert.deepEqual(busyChatForTab(codexTab, codex("running"), []), { kind: "codex", id: "t1", cwd: "/r", state: "running" });
  assert.deepEqual(busyChatForTab(claudeTab, [], claude("approval")), { kind: "claude", id: "s1", cwd: "/r", state: "approval" });
});

test("idle runtimes, new chats, other tabs and other sessions are not busy", () => {
  assert.equal(busyChatForTab(codexTab, codex("idle"), []), null);
  assert.equal(busyChatForTab(codexTab, [], claude("running")), null);
  assert.equal(busyChatForTab({ ...codexTab, sourceSessionId: undefined, newChat: true }, codex("running"), []), null);
  assert.equal(busyChatForTab({ id: "pi", label: "Pi", kind: "pi" }, codex("running"), claude("running")), null);
  assert.equal(busyChatForTab({ ...claudeTab, sourceSessionId: "other" }, [], claude("running")), null);
});
