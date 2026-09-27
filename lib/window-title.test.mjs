import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { windowTitle } = await jiti.import("./window-title.ts");

test("the title is the project, then the product", () => {
  assert.equal(windowTitle({ cwdName: "acme", approvals: 0, unread: 0 }), "acme - TianForge pi");
  assert.equal(windowTitle({ cwdName: null, approvals: 0, unread: 0 }), "TianForge pi");
});

test("waiting approvals come first, else unread notifications", () => {
  assert.equal(windowTitle({ cwdName: "acme", approvals: 2, unread: 5 }), "(2 waiting) acme - TianForge pi");
  assert.equal(windowTitle({ cwdName: "acme", approvals: 0, unread: 3 }), "(3) acme - TianForge pi");
  assert.equal(windowTitle({ cwdName: null, approvals: 1, unread: 0 }), "(1 waiting) TianForge pi");
});
