import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./terminal-restore.ts");
}

const tabs = [
  { id: "terminal:one", kind: "terminal", terminalId: "one" },
  { id: "terminal:two", kind: "terminal", terminalId: "two" },
];
const split = { primaryTabId: "terminal:one", secondaryTerminalId: "two" };

test("split recovery selects only unavailable panes", async () => {
  const { getMissingSplitTerminalTabs } = await loadSubject();
  assert.deepEqual(getMissingSplitTerminalTabs(tabs, split, new Set(["one"])).map((tab) => tab.terminalId), ["two"]);
  assert.deepEqual(getMissingSplitTerminalTabs(tabs, split, new Set(["one", "two"])), []);
});

test("split recovery restores both panes after a server restart", async () => {
  const { getMissingSplitTerminalTabs } = await loadSubject();
  assert.deepEqual(getMissingSplitTerminalTabs(tabs, split, new Set()).map((tab) => tab.terminalId), ["one", "two"]);
});

test("split recovery ignores malformed or absent layouts", async () => {
  const { getMissingSplitTerminalTabs } = await loadSubject();
  assert.deepEqual(getMissingSplitTerminalTabs(tabs, null, new Set()), []);
  assert.deepEqual(getMissingSplitTerminalTabs(tabs, { primaryTabId: "missing", secondaryTerminalId: "missing" }, new Set()), []);
});
