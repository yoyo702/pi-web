import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parsePersistedTab, TAB_KINDS } = await jiti.import("./tab-kinds.ts");

test("center tabs restore only for the matching cwd", () => {
  const raw = { id: "terminal:t1", label: "Terminal", kind: "terminal", terminalId: "t1", cwd: "/a", status: "running" };
  assert.deepEqual(parsePersistedTab(raw, "center", { cwd: "/a" }), raw);
  assert.equal(parsePersistedTab(raw, "center", { cwd: "/b" }), null);
});

test("codex chat tabs restore as idle", () => {
  const raw = { id: "codex-chat:s1", label: "Chat", kind: "codex-chat", cwd: "/a", status: "running" };
  assert.equal(parsePersistedTab(raw, "center", { cwd: "/a" }).status, "idle");
});

test("tabs are only restored into their own slot", () => {
  const file = { id: "file:/a/x.ts", label: "x.ts", kind: "file", filePath: "/a/x.ts" };
  assert.deepEqual(parsePersistedTab(file, "side", {}), file);
  assert.equal(parsePersistedTab(file, "center", { cwd: "/a" }), null);
  assert.equal(parsePersistedTab({ id: "t", label: "T", kind: "terminal", cwd: "/a" }, "side", { cwd: "/a" }), null);
});

test("malformed and unknown tabs are dropped", () => {
  assert.equal(parsePersistedTab(null, "side", {}), null);
  assert.equal(parsePersistedTab({ id: 1, label: "x", kind: "git" }, "side", {}), null);
  assert.equal(parsePersistedTab({ id: "f", label: "f", kind: "file" }, "side", {}), null);
  assert.equal(parsePersistedTab({ id: "x", label: "x", kind: "mystery" }, "side", {}), null);
  assert.equal(parsePersistedTab({ id: "pi", label: "pi", kind: "pi" }, "center", { cwd: "/a" }), null);
});

test("every kind declares a slot", () => {
  for (const [kind, definition] of Object.entries(TAB_KINDS)) {
    assert.equal(definition.kind, kind);
    assert.ok(definition.slot === "center" || definition.slot === "side");
  }
});

test("claude chat tabs restore as idle for their own cwd", () => {
  const raw = { id: "claude-chat:s1", label: "Chat", kind: "claude-chat", cwd: "/a", sourceSessionId: "s1", permissionMode: "plan", status: "approval" };
  assert.deepEqual(parsePersistedTab(raw, "center", { cwd: "/a" }), { ...raw, status: "idle" });
  assert.equal(parsePersistedTab(raw, "center", { cwd: "/b" }), null);
});
