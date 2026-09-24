import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { withoutNonConversationEntries } = await jiti.import("./session-tree.ts");

const msg = (id, role) => ({ entry: { type: "message", id, message: { role } }, children: [] });
const usage = (id) => ({ entry: { type: "usage", id }, children: [] });
const chain = (...nodes) => {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].children = [nodes[i + 1]];
  return nodes[0];
};
const shape = (nodes) => nodes.map((node) => ({
  id: node.entry.id,
  ...(node.hiddenEntryIds ? { hidden: node.hiddenEntryIds } : {}),
  children: shape(node.children),
}));

test("splices system messages and usage entries out of the conversation tree", () => {
  const root = chain(msg("sys1", "system"), msg("u1", "user"), msg("a1", "assistant"), msg("sys2", "system"), msg("u2", "user"), usage("us1"), msg("a2", "assistant"));
  assert.deepEqual(shape(withoutNonConversationEntries([root])), [
    { id: "u1", children: [{ id: "a1", children: [{ id: "u2", children: [{ id: "a2", children: [] }] }] }] },
  ]);
});

test("keeps branches under a removed node in order", () => {
  const sys = msg("sys1", "system");
  sys.children = [msg("u1", "user"), msg("u2", "user")];
  assert.deepEqual(shape(withoutNonConversationEntries([sys])), [{ id: "u1", children: [] }, { id: "u2", children: [] }]);
});

test("a hidden leaf is recorded on its nearest visible ancestor so it can stay the active leaf", () => {
  const root = chain(msg("u1", "user"), msg("a1", "assistant"), usage("warm"));
  assert.deepEqual(shape(withoutNonConversationEntries([root])), [
    { id: "u1", children: [{ id: "a1", hidden: ["warm"], children: [] }] },
  ]);
});

test("does not mutate the input tree", () => {
  const root = chain(msg("sys1", "system"), msg("u1", "user"));
  withoutNonConversationEntries([root]);
  assert.equal(root.entry.id, "sys1");
  assert.equal(root.children[0].entry.id, "u1");
});
