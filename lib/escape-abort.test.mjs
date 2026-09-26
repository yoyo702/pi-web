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
