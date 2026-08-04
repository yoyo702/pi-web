"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const test = require("node:test");
const assert = require("node:assert/strict");
const appServer = require("./codex-app-server.cjs");

test("interrupt targets the in-memory active turn", async () => {
  let request;
  const state = {
    ready: Promise.resolve(),
    threadId: "thread-1",
    activeTurnId: "turn-active",
    request: async (method, params) => { request = { method, params }; return { ok: true }; },
  };
  await appServer.interrupt(state);
  assert.deepEqual(request, {
    method: "turn/interrupt",
    params: { threadId: "thread-1", turnId: "turn-active" },
  });
});

test("interrupt refuses when no turn is active", async () => {
  await assert.rejects(
    appServer.interrupt({ ready: Promise.resolve(), threadId: "thread-1", activeTurnId: null }),
    /No active turn/,
  );
});

test("interrupt can recover a stale approval with an explicit fallback turn", async () => {
  const requests = [];
  const state = {
    ready: Promise.resolve(),
    threadId: "thread-1",
    activeTurnId: null,
    request(method, params) { requests.push({ method, params }); return Promise.resolve({}); },
  };
  await appServer.interrupt(state, "turn-from-session-file");
  assert.deepEqual(requests, [{ method: "turn/interrupt", params: { threadId: "thread-1", turnId: "turn-from-session-file" } }]);
});

test("server approval requests win when their id collides with a pending client request", () => {
  let pendingResolved = false;
  const received = [];
  const state = {
    pending: new Map([[7, { resolve: () => { pendingResolved = true; }, reject: assert.fail, timer: setTimeout(() => undefined, 10_000) }]]),
    incoming: new Map(),
    listeners: new Set([(event) => received.push(event)]),
    events: [],
    nextEventSeq: 1,
    activeTurnId: "turn-1",
  };
  const approval = { jsonrpc: "2.0", id: 7, method: "item/commandExecution/requestApproval", params: { command: "npm test" } };
  appServer.handleProtocolMessage(state, approval);
  clearTimeout(state.pending.get(7).timer);
  assert.equal(pendingResolved, false);
  assert.equal(state.pending.has(7), true);
  assert.equal(state.incoming.get("7"), approval);
  assert.equal(received[0].piSeq, 1);
});

test("child process failures reject pending requests and notify listeners", async () => {
  let rejectPending;
  const pendingResult = new Promise((resolve) => { rejectPending = (error) => resolve(error); });
  const events = [];
  const state = {
    threadId: "spawn-failure-thread",
    pending: new Map([[1, { resolve: assert.fail, reject: rejectPending, timer: setTimeout(() => undefined, 10_000) }]]),
    listeners: new Set([(event) => events.push(event)]),
    stderrTail: "executable unavailable",
    failure: null,
    idleTimer: null,
  };
  appServer.failState(state, new Error("Unable to start Codex app-server"));
  const error = await pendingResult;
  assert.match(error.message, /Unable to start Codex app-server/);
  assert.match(error.message, /executable unavailable/);
  assert.equal(state.pending.size, 0);
  assert.equal(events[0].method, "codex/closed");
});

test("SSE subscription replays only events after the requested sequence", () => {
  const state = {
    threadId: "thread-1",
    listeners: new Set(),
    events: [{ piSeq: 1 }, { piSeq: 2 }, { piSeq: 3 }],
    idleTimer: null,
  };
  const received = [];
  const off = appServer.subscribe(state, (event) => received.push(event.piSeq), 1);
  assert.deepEqual(received, [2, 3]);
  off();
});

test("prompt forwards model, reasoning, service tier, and approval policy to the next turn", async () => {
  let request;
  const state = {
    ready: Promise.resolve(),
    threadId: "thread-config",
    cwd: "/workspace",
    activeTurnId: null,
    request: async (method, params) => { request = { method, params }; return { turn: { id: "turn-config" } }; },
  };
  await appServer.prompt(state, "ship it", "gpt-5.6-sol", "on-request", [], "client-1", "high", "fast");
  assert.equal(request.method, "turn/start");
  assert.deepEqual(request.params, {
    threadId: "thread-config",
    cwd: "/workspace",
    input: [{ type: "text", text: "ship it" }],
    clientUserMessageId: "client-1",
    approvalPolicy: "on-request",
    model: "gpt-5.6-sol",
    effort: "high",
    serviceTier: "fast",
    summary: "auto",
  });
  assert.equal(state.activeTurnId, "turn-config");
});
