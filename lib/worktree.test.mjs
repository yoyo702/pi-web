import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { resolveProject, invalidateProjectCache } = await jiti.import("./worktree.ts");

test("resolveProject caches results and caps the cache, dropping the oldest entry first", async () => {
  invalidateProjectCache();
  const first = await resolveProject("/nonexistent/pi-web-worktree-cap-0");
  assert.equal(first.projectRoot, "/nonexistent/pi-web-worktree-cap-0");
  const cache = globalThis.__piProjectCache;
  assert.equal(cache.get("/nonexistent/pi-web-worktree-cap-0").info, first);
  for (let i = 1; i < 505; i++) await resolveProject(`/nonexistent/pi-web-worktree-cap-${i}`);
  assert.equal(cache.size, 500);
  assert.equal(cache.has("/nonexistent/pi-web-worktree-cap-0"), false);
  assert.equal(cache.has("/nonexistent/pi-web-worktree-cap-4"), false);
  assert.equal(cache.has("/nonexistent/pi-web-worktree-cap-504"), true);
  invalidateProjectCache();
});
