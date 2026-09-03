import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`worker exited ${code}: ${stderr}`)));
  });
}

async function waitUntil(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for workers");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

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

  const inode = fs.statSync(settingsFile).ino;
  allowFileRoot(allowedDirectory);
  assert.equal(fs.statSync(settingsFile).ino, inode, "an existing grant should not rewrite the settings file");

  globalThis.__piAdditionalAllowedRoots = new Set();
  assert.equal(getAdditionalAllowedRoots().has(allowedDirectory), true);
});

test("does not lose roots when execution contexts persist grants concurrently", async (t) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-allowed-roots-concurrent-"));
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const settingsFile = path.join(temporaryDirectory, "allowed-roots.json");
  const startFile = path.join(temporaryDirectory, "start");
  const moduleUrl = pathToFileURL(path.resolve("lib/allowed-roots.ts")).href;
  const roots = Array.from({ length: 8 }, (_, index) => path.join(temporaryDirectory, `project-${index}`));
  for (const root of roots) fs.mkdirSync(root);

  const workers = roots.map((root, index) => {
    const readyFile = path.join(temporaryDirectory, `ready-${index}`);
    const source = `
      import fs from "node:fs";
      process.env.PI_WEB_ALLOWED_ROOTS_FILE = ${JSON.stringify(settingsFile)};
      const { allowFileRoot } = await import(${JSON.stringify(moduleUrl)});
      fs.writeFileSync(${JSON.stringify(readyFile)}, "ready");
      const wait = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(${JSON.stringify(startFile)})) Atomics.wait(wait, 0, 0, 5);
      allowFileRoot(${JSON.stringify(root)});
    `;
    return { child: spawn(process.execPath, ["--input-type=module", "--eval", source], { stdio: ["ignore", "ignore", "pipe"] }), readyFile };
  });

  await waitUntil(() => workers.every(({ readyFile }) => fs.existsSync(readyFile)));
  fs.writeFileSync(startFile, "start");
  await Promise.all(workers.map(({ child }) => waitForExit(child)));

  const persisted = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  assert.deepEqual(new Set(persisted), new Set(roots));
});
