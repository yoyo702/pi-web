import assert from "node:assert/strict";
import test from "node:test";

import { REDACTED_SECRET, redactModelsConfig, restoreModelsConfigSecrets, restoreProviderSecrets } from "./models-config-secrets.ts";

const stored = {
  providers: {
    acme: { apiKey: "sk-live-123", headers: { "X-Token": "tok", "X-Env": "$ACME_HEADER" }, models: [] },
    envOnly: { apiKey: "$OPENAI_API_KEY", models: [] },
    command: { apiKey: "!op read op://vault/key", models: [] },
  },
};

test("redacts literal keys but keeps env and command references visible", () => {
  const redacted = redactModelsConfig(stored);
  assert.equal(redacted.providers.acme.apiKey, REDACTED_SECRET);
  assert.equal(redacted.providers.acme.headers["X-Token"], REDACTED_SECRET);
  assert.equal(redacted.providers.acme.headers["X-Env"], "$ACME_HEADER");
  assert.equal(redacted.providers.envOnly.apiKey, "$OPENAI_API_KEY");
  assert.equal(redacted.providers.command.apiKey, "!op read op://vault/key");
  assert.equal(stored.providers.acme.apiKey, "sk-live-123");
});

test("round-trips redacted config back to stored secrets", () => {
  assert.deepEqual(restoreModelsConfigSecrets(redactModelsConfig(stored), stored), stored);
});

test("keeps newly entered keys and drops placeholders for unknown providers", () => {
  const incoming = { providers: { acme: { apiKey: "sk-new" }, fresh: { apiKey: REDACTED_SECRET } } };
  const restored = restoreModelsConfigSecrets(incoming, stored);
  assert.equal(restored.providers.acme.apiKey, "sk-new");
  assert.equal(restored.providers.fresh.apiKey, undefined);
  assert.equal(restoreProviderSecrets({ apiKey: REDACTED_SECRET }, "acme", stored).apiKey, "sk-live-123");
});
