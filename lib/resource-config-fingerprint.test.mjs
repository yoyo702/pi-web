import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getResourceConfigFingerprint } from "./resource-config-fingerprint.ts";

test("detects global and project Pi resource changes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tianforge-resource-fingerprint-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });

  const initial = getResourceConfigFingerprint(cwd, agentDir);
  await writeFile(join(agentDir, "settings.json"), "{}", "utf8");
  const globalChanged = getResourceConfigFingerprint(cwd, agentDir);
  assert.notEqual(globalChanged, initial);

  await mkdir(join(cwd, ".pi", "npm"), { recursive: true });
  await writeFile(join(cwd, ".pi", "npm", "package-lock.json"), '{"lockfileVersion":3}', "utf8");
  const projectChanged = getResourceConfigFingerprint(cwd, agentDir);
  assert.notEqual(projectChanged, globalChanged);
  assert.equal(getResourceConfigFingerprint(cwd, agentDir), projectChanged);
});
