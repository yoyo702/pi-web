import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { shouldAbortOnEscape } = await jiti.import("./escape-abort.ts");

const base = { targetTag: "BODY", defaultPrevented: false, modalOpen: false };

test("Esc on the page stops the agent", () => {
  assert.equal(shouldAbortOnEscape(base), true);
  assert.equal(shouldAbortOnEscape({ ...base, targetTag: "BUTTON" }), true);
});

test("text fields handle their own Esc", () => {
  assert.equal(shouldAbortOnEscape({ ...base, targetTag: "TEXTAREA" }), false);
  assert.equal(shouldAbortOnEscape({ ...base, targetTag: "INPUT" }), false);
});

test("Esc that closes a modal or was already handled does not stop the agent", () => {
  assert.equal(shouldAbortOnEscape({ ...base, targetTag: "BUTTON", modalOpen: true }), false);
  assert.equal(shouldAbortOnEscape({ ...base, defaultPrevented: true }), false);
});

test("only a visible modal counts; dialogs in hidden workspace tabs are ignored", async () => {
  const { hasVisibleModal } = await jiti.import("./escape-abort.ts");
  const el = (visible, viaRects = false) => viaRects
    ? { getClientRects: () => ({ length: visible ? 1 : 0 }) }
    : { checkVisibility: () => visible, getClientRects: () => { throw new Error("not used"); } };
  const root = (elements) => ({ querySelectorAll: (selector) => { assert.equal(selector, '[aria-modal="true"], dialog[open]'); return elements; } });
  assert.equal(hasVisibleModal(root([])), false);
  assert.equal(hasVisibleModal(root([el(false)])), false);
  assert.equal(hasVisibleModal(root([el(false), el(true)])), true);
  assert.equal(hasVisibleModal(root([el(false, true)])), false);
  assert.equal(hasVisibleModal(root([el(true, true)])), true);
});
