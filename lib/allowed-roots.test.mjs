import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("persists explicitly allowed roots across execution contexts", async (t) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-allowed-roots-"));
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const settingsFile = path.join(temporaryDirectory, "allowed-roots.json");
  const allowedDirectory = path.join(temporaryDirectory, "external-project");
  fs.mkdirSync(allowedDirectory);
  process.env.PI_WEB_ALLOWED_ROOTS_FILE = settingsFile;

  const { allowFileRoot, getAdditionalAllowedRoots } = await import("./allowed-roots.ts");
  allowFileRoot(allowedDirectory);

  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, "utf8")), [allowedDirectory]);
  assert.equal(fs.statSync(settingsFile).mode & 0o077, 0);

  globalThis.__piAdditionalAllowedRoots = new Set();
  assert.equal(getAdditionalAllowedRoots().has(allowedDirectory), true);
});
