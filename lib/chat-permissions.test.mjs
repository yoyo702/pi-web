import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { CLAUDE_CHAT_PERMISSION_OPTIONS, CODEX_CHAT_PERMISSION_OPTIONS, dangerousPermissionWarning } = await jiti.import("./chat-permissions.ts");

test("the terminal warnings keep the template-run wording", () => {
  assert.equal(dangerousPermissionWarning("codex", "terminal"), "Codex skips all approval and sandboxing in this terminal, so it may edit files and run commands without asking.");
  assert.equal(dangerousPermissionWarning("claude", "terminal"), "Claude skips its permission confirmations in this terminal, so it may edit files and run commands without asking.");
});

test("only Full access and Bypass permissions are dangerous in a chat", () => {
  assert.deepEqual(CODEX_CHAT_PERMISSION_OPTIONS.filter((option) => option.danger).map((option) => option.value), ["never"]);
  assert.deepEqual(CLAUDE_CHAT_PERMISSION_OPTIONS.filter((option) => option.danger).map((option) => option.value), ["bypassPermissions"]);
  assert.equal(CODEX_CHAT_PERMISSION_OPTIONS.find((option) => option.value === "never").danger, "Codex stops asking for approval in this chat, so it may edit files and run commands without asking.");
  assert.equal(CLAUDE_CHAT_PERMISSION_OPTIONS.find((option) => option.value === "bypassPermissions").danger, dangerousPermissionWarning("claude", "chat"));
  // Labels and order are unchanged.
  assert.deepEqual(CODEX_CHAT_PERMISSION_OPTIONS.map((option) => option.label), ["Restricted", "Ask when needed", "Full access"]);
  assert.deepEqual(CLAUDE_CHAT_PERMISSION_OPTIONS.map((option) => option.label), ["Ask before edits", "Accept edits", "Plan mode", "Bypass permissions"]);
});
