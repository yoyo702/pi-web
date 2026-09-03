/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function ensureExecutableFile(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Refusing to change non-regular node-pty helper: ${filePath}`);
  }
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return false;
  } catch {
    fs.chmodSync(filePath, stat.mode | 0o111);
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  }
}

function nodePtyRoot() {
  return path.dirname(path.dirname(require.resolve("node-pty")));
}

function helperCandidates(root = nodePtyRoot()) {
  return [
    path.join(root, "build", "Release", "spawn-helper"),
    path.join(root, "build", "Debug", "spawn-helper"),
    path.join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
  ];
}

function ensureNodePtySpawnHelper(root) {
  if (process.platform === "win32") return { found: false, changed: false, path: null };
  const helperPath = helperCandidates(root).find((candidate) => fs.existsSync(candidate));
  if (!helperPath) return { found: false, changed: false, path: null };
  const changed = ensureExecutableFile(helperPath);
  return { found: true, changed, path: helperPath };
}

if (require.main === module) {
  try {
    const result = ensureNodePtySpawnHelper();
    if (result.changed) console.log(`Restored execute permission on ${result.path}`);
  } catch (error) {
    console.error(`Unable to prepare node-pty: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

module.exports = { ensureExecutableFile, helperCandidates, ensureNodePtySpawnHelper };
