import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { splitMarkdownBlocks } = await jiti.import("./markdown-blocks.ts");

test("splits top-level blocks at blank lines", () => {
  assert.deepEqual(splitMarkdownBlocks("# Title\n\nFirst para\nstill first\n\nSecond"), ["# Title", "First para\nstill first", "Second"]);
});

test("keeps fenced code with blank lines in one block", () => {
  const code = "```ts\nconst a = 1;\n\nconst b = 2;\n```";
  assert.deepEqual(splitMarkdownBlocks(`Intro\n\n${code}\n\nAfter`), ["Intro", code, "After"]);
  const tilde = "~~~\nx\n\ny\n~~~";
  assert.deepEqual(splitMarkdownBlocks(`${tilde}\n\nz`), [tilde, "z"]);
});

test("an unterminated fence (still streaming) stays one trailing block", () => {
  assert.deepEqual(splitMarkdownBlocks("Intro\n\n```py\nprint(1)\n\nprint(2)"), ["Intro", "```py\nprint(1)\n\nprint(2)"]);
});

test("a shorter or different fence marker does not close the block", () => {
  const code = "````\n```\n\ninner\n````";
  assert.deepEqual(splitMarkdownBlocks(`${code}\n\nnext`), [code, "next"]);
});

test("keeps display math with blank lines together", () => {
  const math = "$$\na = b\n\nc = d\n$$";
  assert.deepEqual(splitMarkdownBlocks(`${math}\n\ntext`), [math, "text"]);
});

test("does not split before indented continuation lines", () => {
  const list = "1. item\n\n   continued paragraph\n2. next";
  assert.deepEqual(splitMarkdownBlocks(`${list}\n\nAfter`), [list, "After"]);
  const indentedCode = "Para\n\n    code line";
  assert.deepEqual(splitMarkdownBlocks(indentedCode), [indentedCode]);
});

test("collapses repeated blank lines and trims edges", () => {
  assert.deepEqual(splitMarkdownBlocks("\n\nA\n\n\n\nB\n\n"), ["A", "B"]);
  assert.deepEqual(splitMarkdownBlocks(""), []);
});
