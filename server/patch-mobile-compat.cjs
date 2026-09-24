#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const unsupportedEmailPattern = String.raw`[/(?<=^|\s|\p{P}|\p{S})([-.\w+]+)@([-\w]+(?:\.[-\w]+)+)/gu, findEmail]`;
const compatibleEmailPattern = String.raw`[/([-.\w+]+)@([-\w]+(?:\.[-\w]+)+)/g, findEmail]`;

function patchAutolinkSource(source) {
  if (source.includes(compatibleEmailPattern)) return source;
  if (!source.includes(unsupportedEmailPattern)) {
    throw new Error("Unsupported mdast-util-gfm-autolink-literal source; update the mobile compatibility patch");
  }
  return source.replace(unsupportedEmailPattern, compatibleEmailPattern);
}

function patchInstalledAutolink(projectRoot = path.resolve(__dirname, "..")) {
  let gfmEntry;
  try {
    gfmEntry = require.resolve("mdast-util-gfm", { paths: [projectRoot] });
  } catch {
    // Published installs ship a prebuilt .next and omit devDependencies, so
    // the Markdown toolchain is absent and there is nothing to patch. Any
    // other resolution failure below still fails loudly.
    return { sourceFile: null, changed: false, skipped: true };
  }
  const autolinkEntry = require.resolve("mdast-util-gfm-autolink-literal", { paths: [path.dirname(gfmEntry)] });
  const sourceFile = path.join(path.dirname(autolinkEntry), "lib", "index.js");
  const source = fs.readFileSync(sourceFile, "utf8");
  const patched = patchAutolinkSource(source);
  if (patched === source) return { sourceFile, changed: false };
  fs.writeFileSync(sourceFile, patched);
  return { sourceFile, changed: true };
}

if (require.main === module) {
  try {
    const result = patchInstalledAutolink();
    if (result.skipped) console.log("Skipped Safari-compatible GFM autolink patch: mdast-util-gfm is not installed");
    else console.log(`${result.changed ? "Patched" : "Verified"} Safari-compatible GFM autolinks: ${result.sourceFile}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = { patchAutolinkSource, patchInstalledAutolink };
