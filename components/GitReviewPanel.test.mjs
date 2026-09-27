import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { commitDraftStorageKey } = await jiti.import("./GitReviewPanel.tsx");

test("commit drafts are keyed per repository so they never leak across repos", () => {
  const first = commitDraftStorageKey("/work/repo-a");
  const second = commitDraftStorageKey("/work/repo-b");
  assert.ok(first && second);
  assert.notEqual(first, second);
  assert.equal(commitDraftStorageKey("/work/repo-a"), first);
});

test("a missing or blank repository has no draft key", () => {
  for (const repository of [undefined, null, "", "   "]) {
    assert.equal(commitDraftStorageKey(repository), null, JSON.stringify(repository));
  }
});
