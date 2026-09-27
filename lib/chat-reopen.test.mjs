import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { claudeReopenSettings, codexReopenSettings } = await jiti.import("./chat-reopen.ts");

test("a Codex chat reopens with its runtime's settings, else Restricted and the default model", () => {
  assert.deepEqual(codexReopenSettings({ settings: { model: "gpt-5.5", reasoningEffort: "high", serviceTier: null, approvalPolicy: "never" } }), { approvalPolicy: "never", model: "gpt-5.5", reasoningEffort: "high" });
  assert.deepEqual(codexReopenSettings(undefined), { approvalPolicy: "untrusted" });
  assert.deepEqual(codexReopenSettings({ settings: null }), { approvalPolicy: "untrusted" });
  // The status stream is not validated: an unknown policy falls back.
  assert.deepEqual(codexReopenSettings({ settings: { model: null, reasoningEffort: null, serviceTier: "flex", approvalPolicy: "yolo" } }), { approvalPolicy: "untrusted", serviceTier: "flex" });
});

test("a Claude chat reopens with its runtime's model and permission, else the defaults", () => {
  assert.deepEqual(claudeReopenSettings({ model: "opus", permissionMode: "bypassPermissions" }), { permissionMode: "bypassPermissions", model: "opus" });
  assert.deepEqual(claudeReopenSettings({ model: null, permissionMode: "plan" }), { permissionMode: "plan" });
  assert.deepEqual(claudeReopenSettings(null), { permissionMode: "default" });
  assert.deepEqual(claudeReopenSettings({ model: "", permissionMode: "yolo" }), { permissionMode: "default" });
});
