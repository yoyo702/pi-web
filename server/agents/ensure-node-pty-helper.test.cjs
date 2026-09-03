/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ensureExecutableFile, ensureNodePtySpawnHelper } = require("./ensure-node-pty-helper.cjs");

test("restores the executable bit on a packaged node-pty spawn helper", (t) => {
  if (process.platform === "win32") return t.skip("POSIX permissions only");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-node-pty-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const helper = path.join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
  fs.mkdirSync(path.dirname(helper), { recursive: true });
  fs.writeFileSync(helper, "helper", { mode: 0o644 });

  const result = ensureNodePtySpawnHelper(root);

  assert.deepEqual(result, { found: true, changed: true, path: helper });
  assert.doesNotThrow(() => fs.accessSync(helper, fs.constants.X_OK));
  assert.equal(ensureExecutableFile(helper), false);
});

test("does not chmod a symlink in place of the node-pty helper", (t) => {
  if (process.platform === "win32") return t.skip("POSIX permissions only");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-node-pty-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "target");
  const helper = path.join(root, "spawn-helper");
  fs.writeFileSync(target, "target", { mode: 0o644 });
  fs.symlinkSync(target, helper);

  assert.throws(() => ensureExecutableFile(helper), /non-regular node-pty helper/);
});
