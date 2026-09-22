"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const assert = require("node:assert/strict");
const test = require("node:test");
const { patchAutolinkSource } = require("../patch-mobile-compat.cjs");

test("replaces the unsupported GFM lookbehind without changing its public API", () => {
  const source = String.raw`export function gfmAutolinkLiteralFromMarkdown() {
  return [[/(?<=^|\s|\p{P}|\p{S})([-.\w+]+)@([-\w]+(?:\.[-\w]+)+)/gu, findEmail]]
}`;
  const patched = patchAutolinkSource(source);
  assert.doesNotMatch(patched, /\(\?</);
  assert.match(patched, /export function gfmAutolinkLiteralFromMarkdown/);
  assert.match(patched, /\[\/\(\[-\./);
  assert.equal(patchAutolinkSource(patched), patched);
});

test("fails loudly when a future dependency no longer matches either known form", () => {
  assert.throws(() => patchAutolinkSource("changed upstream"), /Unsupported mdast-util/);
});
