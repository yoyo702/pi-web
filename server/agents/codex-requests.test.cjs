/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { isSupported, responseFor } = require("./codex-requests.cjs");

const invalid = (error) => error.code === "invalid_request";
const command = { method: "item/commandExecution/requestApproval", params: { command: "npm test", proposedExecpolicyAmendment: ["npm", "test"], proposedNetworkPolicyAmendments: [{ host: "a.example", action: "allow" }, { host: "b.example", action: "allow" }] } };

test("only request types with a card are supported", () => {
  assert.equal(isSupported("item/permissions/requestApproval"), true);
  assert.equal(isSupported("item/tool/requestUserInput"), true);
  assert.equal(isSupported("item/tool/call"), false);
  assert.equal(isSupported("execCommandApproval"), false);
});

test("command and file approvals take a decision; amendments come from the request", () => {
  assert.deepEqual(responseFor(command, { decision: "acceptForSession" }), { decision: "acceptForSession" });
  assert.deepEqual(responseFor(command, { decision: "cancel" }), { decision: "cancel" });
  assert.deepEqual(responseFor(command, { decision: "acceptWithExecpolicyAmendment", amendment: ["rm", "-rf"] }), { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["npm", "test"] } } });
  assert.deepEqual(responseFor(command, { decision: "applyNetworkPolicyAmendment", amendmentIndex: 1 }), { decision: { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "b.example", action: "allow" } } } });
  assert.throws(() => responseFor(command, { decision: "applyNetworkPolicyAmendment", amendmentIndex: 5 }), invalid);
  assert.throws(() => responseFor(command, { decision: "yes" }), invalid);
  assert.throws(() => responseFor({ ...command, params: { proposedExecpolicyAmendment: [] } }, { decision: "acceptWithExecpolicyAmendment" }), invalid);
  const file = { method: "item/fileChange/requestApproval", params: {} };
  assert.deepEqual(responseFor(file, { decision: "decline" }), { decision: "decline" });
  assert.throws(() => responseFor(file, { decision: "acceptWithExecpolicyAmendment" }), invalid);
});

test("permission requests grant what was asked for the chosen scope", () => {
  const request = { method: "item/permissions/requestApproval", params: { permissions: { network: { enabled: true }, fileSystem: { read: ["/a"], write: null } } } };
  assert.deepEqual(responseFor(request, { scope: "session" }), { permissions: { network: { enabled: true }, fileSystem: { read: ["/a"], write: null } }, scope: "session" });
  assert.deepEqual(responseFor(request, { decision: "decline" }), { permissions: {}, scope: "turn" });
  assert.throws(() => responseFor(request, { scope: "forever" }), invalid);
  const entries = [{ path: { type: "glob_pattern", pattern: "/a/**" }, access: "write" }];
  const withEntries = { method: "item/permissions/requestApproval", params: { permissions: { fileSystem: { entries, globScanMaxDepth: 3 } } } };
  assert.deepEqual(responseFor(withEntries, { scope: "turn" }).permissions.fileSystem, { entries, globScanMaxDepth: 3 });
});

test("user input answers are keyed by question id", () => {
  const request = { method: "item/tool/requestUserInput", params: { questions: [{ id: "color" }, { id: "size" }] } };
  assert.deepEqual(responseFor(request, { answers: { color: ["Red"], other: ["x"] } }), { answers: { color: { answers: ["Red"] } } });
  assert.throws(() => responseFor(request, { answers: { color: "Red" } }), invalid);
  assert.throws(() => responseFor(request, {}), invalid);
  assert.deepEqual(responseFor(request, { answers: Object.assign(Object.create({ size: ["L"] }), { color: ["Red"] }) }), { answers: { color: { answers: ["Red"] } } });
});

test("elicitations accept form content or just an action for url mode", () => {
  const form = { method: "mcpServer/elicitation/request", params: { mode: "form", requestedSchema: {} } };
  assert.deepEqual(responseFor(form, { action: "accept", content: { name: "a", count: 2, ok: true } }), { action: "accept", content: { name: "a", count: 2, ok: true }, _meta: null });
  assert.deepEqual(responseFor(form, { action: "decline", content: { name: "a" } }), { action: "decline", content: null, _meta: null });
  assert.throws(() => responseFor(form, { action: "accept", content: { nested: { a: 1 } } }), invalid);
  assert.throws(() => responseFor(form, { action: "maybe" }), invalid);
  const url = { method: "mcpServer/elicitation/request", params: { mode: "url", url: "https://example.com" } };
  assert.deepEqual(responseFor(url, { action: "accept" }), { action: "accept", content: null, _meta: null });
});
