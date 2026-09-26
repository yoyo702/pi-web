import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-models-file-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.once("exit", () => fs.rmSync(agentDir, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { readModelsJson, getModelsPath } = await jiti.import("./models-config-file.ts");

test("a missing models.json reads as an empty config", () => {
  fs.rmSync(getModelsPath(), { force: true });
  assert.deepEqual(readModelsJson(), { providers: {} });
});

test("a valid models.json is returned as parsed", () => {
  fs.writeFileSync(getModelsPath(), JSON.stringify({ providers: { local: { api: "openai-completions" } } }));
  assert.deepEqual(readModelsJson(), { providers: { local: { api: "openai-completions" } } });
});

test("an unparseable models.json is an error, not an empty config", () => {
  fs.writeFileSync(getModelsPath(), "{ \"providers\": ");
  assert.throws(() => readModelsJson(), /models\.json is not valid JSON/);
  assert.equal(fs.readFileSync(getModelsPath(), "utf8"), "{ \"providers\": ");
});
