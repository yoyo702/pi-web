import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { collectVisibleRows } = await jiti.import("./BranchNavigator.tsx");

const msg = (id, role, extra = {}) => ({
  entry: { type: "message", id, message: { role, content: id } },
  children: [],
  ...extra,
});
const chain = (...nodes) => {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].children = [nodes[i + 1]];
  return nodes[0];
};

test("a plain linear chain compresses to its terminal node, covering every member's own id", () => {
  const root = chain(msg("a", "user"), msg("b", "assistant"), msg("c", "user"));
  const { ids, repOf } = collectVisibleRows([root]);
  assert.deepEqual(ids, ["c"]);
  assert.equal(repOf.get("a"), "c");
  assert.equal(repOf.get("b"), "c");
  assert.equal(repOf.get("c"), "c");
});

test("a compressedEntryIds id folded into a chain member resolves to that chain's rep", () => {
  // "b" absorbed a server-side-compressed entry "b-compressed-1" into itself;
  // the chain a -> b -> c still compresses down to a single rendered row "c".
  const root = chain(
    msg("a", "user"),
    msg("b", "assistant", { compressedEntryIds: ["b-compressed-1"] }),
    msg("c", "user"),
  );
  const { ids, repOf } = collectVisibleRows([root]);
  assert.deepEqual(ids, ["c"]);
  assert.equal(repOf.get("b-compressed-1"), "c");
});

test("a hiddenEntryIds id folded into a chain member resolves to that chain's rep", () => {
  // "b" folded a non-conversation entry "b-hidden-1" (e.g. a tool message)
  // into itself; it never gets its own row, but should still resolve.
  const root = chain(
    msg("a", "user"),
    msg("b", "assistant", { hiddenEntryIds: ["b-hidden-1"] }),
    msg("c", "user"),
  );
  const { ids, repOf } = collectVisibleRows([root]);
  assert.deepEqual(ids, ["c"]);
  assert.equal(repOf.get("b-hidden-1"), "c");
});

test("an activeLeafId swallowed mid-chain (not the chain's terminal rep) still resolves via repOf", () => {
  // Regression: previously `visibleRowIds.includes(activeLeafId)` would miss
  // this because "mid-chain-hidden" never appears in `ids` (only "leaf" does)
  // — only `repOf` (built from every covered id, not just rep ids) catches it.
  const root = chain(
    msg("a", "user"),
    msg("mid", "assistant", { hiddenEntryIds: ["mid-chain-hidden"] }),
    msg("leaf", "user"),
  );
  const { ids, repOf } = collectVisibleRows([root]);
  assert.deepEqual(ids, ["leaf"]);
  assert.equal(ids.includes("mid-chain-hidden"), false);
  assert.equal(repOf.get("mid-chain-hidden"), "leaf");
});

test("branching stops compression and recurses into each branch independently", () => {
  const left = msg("left", "assistant");
  const right = msg("right", "assistant", { compressedEntryIds: ["right-compressed-1"] });
  const branchPoint = msg("branch", "user");
  branchPoint.children = [left, right];
  const root = chain(msg("a", "user"), branchPoint);

  const { ids, repOf } = collectVisibleRows([root]);
  assert.deepEqual(ids, ["branch", "left", "right"]);
  assert.equal(repOf.get("a"), "branch");
  assert.equal(repOf.get("right-compressed-1"), "right");
});
