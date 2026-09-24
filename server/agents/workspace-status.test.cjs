"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const test = require("node:test");
const assert = require("node:assert/strict");
const status = require("../workspace-status.cjs");

function setup(t) {
  status._resetForTests();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const messages = [];
  const unsubscribe = status.subscribe((message) => messages.push(message));
  t.after(() => { unsubscribe(); status._resetForTests(); });
  return messages;
}

test("unregistered kinds report empty snapshots", () => {
  status._resetForTests();
  assert.deepEqual(status.snapshot("terminals"), { type: "terminals", terminals: [], limits: null });
  assert.deepEqual(status.snapshot("codex_runtimes"), { type: "codex_runtimes", runtimes: [] });
});

test("coalesces bursts into one publish after COALESCE_MS", (t) => {
  const messages = setup(t);
  let calls = 0;
  status.registerProvider("codex_runtimes", () => ({ runtimes: [{ threadId: "t", n: ++calls }] }));
  status.notify("codex_runtimes");
  status.notify("codex_runtimes");
  t.mock.timers.tick(status.COALESCE_MS - 1);
  assert.equal(messages.length, 0);
  t.mock.timers.tick(1);
  assert.equal(messages.length, 1);
  assert.equal(calls, 1);
  assert.equal(messages[0].type, "codex_runtimes");
});

test("throttled notifications publish at most once per THROTTLE_MS; an urgent one upgrades them", (t) => {
  const messages = setup(t);
  let n = 0;
  status.registerProvider("terminals", () => ({ terminals: [{ id: String(++n) }], limits: null }));
  status.notify("terminals", { throttled: true });
  status.notify("terminals", { throttled: true });
  t.mock.timers.tick(status.COALESCE_MS);
  assert.equal(messages.length, 0);
  t.mock.timers.tick(status.THROTTLE_MS - status.COALESCE_MS);
  assert.equal(messages.length, 1);
  status.notify("terminals", { throttled: true });
  status.notify("terminals");
  t.mock.timers.tick(status.COALESCE_MS);
  assert.equal(messages.length, 2);
});

test("identical snapshots are not re-sent", (t) => {
  const messages = setup(t);
  status.registerProvider("codex_runtimes", () => ({ runtimes: [] }));
  status.notify("codex_runtimes");
  t.mock.timers.tick(status.COALESCE_MS);
  status.notify("codex_runtimes");
  t.mock.timers.tick(status.COALESCE_MS);
  assert.equal(messages.length, 1);
});

test("a throwing provider does not break other kinds or listeners", (t) => {
  const messages = setup(t);
  t.mock.method(console, "error", () => {});
  status.registerProvider("terminals", () => { throw new Error("boom"); });
  status.registerProvider("codex_runtimes", () => ({ runtimes: [{ threadId: "ok" }] }));
  status.notify("terminals");
  status.notify("codex_runtimes");
  t.mock.timers.tick(status.COALESCE_MS);
  assert.deepEqual(messages.map((message) => message.type), ["codex_runtimes"]);
});
