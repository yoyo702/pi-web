import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { isComposingKeyEvent } = await jiti.import("./keyboard.ts");

test("isComposingKeyEvent detects IME composition on DOM keyboard events", () => {
  assert.equal(isComposingKeyEvent({ isComposing: true, keyCode: 13 }), true);
  assert.equal(isComposingKeyEvent({ isComposing: false, keyCode: 229 }), true);
  assert.equal(isComposingKeyEvent({ isComposing: false, keyCode: 13 }), false);
});

test("isComposingKeyEvent reads React keyboard events through nativeEvent", () => {
  assert.equal(isComposingKeyEvent({ nativeEvent: { isComposing: true, keyCode: 13 } }), true);
  assert.equal(isComposingKeyEvent({ nativeEvent: { isComposing: false, keyCode: 229 } }), true);
  assert.equal(isComposingKeyEvent({ nativeEvent: { isComposing: false, keyCode: 27 } }), false);
});
