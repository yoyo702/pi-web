import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MarkdownBody } = await jiti.import("./MarkdownBody.tsx");
const { normalizeDisplayMath } = await jiti.import("../lib/markdown.ts");
const { loadMathRendering } = await jiti.import("../hooks/useMarkdownRehypePlugins.ts");

function renderMarkdown(markdown) {
  return renderToStaticMarkup(
    React.createElement(MarkdownBody, {
      cwd: "/home/me/project",
      onOpenFile() {},
    }, markdown),
  );
}

test("opens non-file markdown links in a safe new tab", () => {
  const html = renderMarkdown("[docs](https://example.com/docs)");

  assert.match(
    html,
    /<a (?=[^>]*href="https:\/\/example\.com\/docs")(?=[^>]*target="_blank")(?=[^>]*rel="noopener noreferrer")[^>]*>docs<\/a>/,
  );
  assert.doesNotMatch(html, /\snode=/);
});

test("keeps local file markdown links in the app", () => {
  const html = renderMarkdown("[file](components/MarkdownBody.tsx)");

  assert.match(html, /<a href="components\/MarkdownBody\.tsx">file<\/a>/);
  assert.doesNotMatch(html, /target=|rel=|\snode=/);
});

test("renders math as plain code until KaTeX has loaded", () => {
  const html = renderMarkdown(String.raw`射线为 \(r_c = K^{-1}p\)。`);

  assert.doesNotMatch(html, /class="katex"/);
  assert.match(html, /math-inline/);
  assert.match(html, /r_c/);
});

test("renders LaTeX parenthesis delimiters as inline math", async () => {
  // In the app the first render with math triggers this load, then re-renders.
  await loadMathRendering();
  const html = renderMarkdown(String.raw`射线为 \(r_c = K^{-1}p\)。`);

  assert.match(html, /class="katex"/);
  assert.match(html, /r_c/);
});

test("renders paired LaTeX bracket delimiters as display math", async () => {
  await loadMathRendering();
  const html = renderMarkdown(String.raw`\[
P(\lambda)=o_b+\lambda r_b
\]`);
  const oneLineHtml = renderMarkdown(String.raw`\[P(\lambda)=o_b+\lambda r_b\]`);

  assert.match(html, /class="katex-display"/);
  assert.match(html, /lambda/);
  assert.match(oneLineHtml, /class="katex-display"/);
});

test("leaves an unmatched LaTeX bracket delimiter unchanged", () => {
  const markdown = String.raw`before
\[
x + y
after`;

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("does not normalize LaTeX delimiters inside Markdown code", () => {
  const markdown = "    \\(indented\\)\n\n`code\n\\(inline\\)`\n\n```text\n\\[\nfenced\n\\]\n```";

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("does not normalize LaTeX delimiters inside raw HTML code", () => {
  const markdown = "<code>\\(inline\\)</code>\n\n<pre>\n\\(block\\)\n</pre>";

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("does not normalize escaped delimiters or link destinations", () => {
  const escaped = String.raw`Literal: \\(x+y\\).`;
  const link = String.raw`[docs](https://example.com/\(manual\))`;

  assert.equal(normalizeDisplayMath(escaped), escaped);
  assert.equal(normalizeDisplayMath(link), link);
});

test("normalizes multiple inline math expressions without regex lookbehind", () => {
  assert.equal(
    normalizeDisplayMath(String.raw`Values \(x+y\) and \(z\).`),
    "Values $x+y$ and $z$.",
  );
});

test("streaming block-by-block rendering matches the one-shot render", () => {
  const markdown = [
    "# Title",
    "",
    "Some **bold** text with `code` and a [link](https://example.com).",
    "",
    "1. first",
    "",
    "   continued paragraph",
    "2. second",
    "",
    "- a",
    "- b",
    "",
    "```ts",
    "const a = 1;",
    "",
    "const b = 2;",
    "```",
    "",
    "$$",
    "x = y",
    "",
    "z = w",
    "$$",
    "",
    "| a | b |",
    "|---|---|",
    "| 1 | 2 |",
    "",
    "> quote",
    "",
    "Final paragraph.",
  ].join("\n");
  const render = (isStreaming) => renderToStaticMarkup(React.createElement(MarkdownBody, { isStreaming }, markdown))
    .replace(/>\s+</g, "><");
  assert.equal(render(true), render(false));
});
