"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const api = require("../terminal-hook-api.cjs");

// A local server running the handler with a fake terminal manager.
async function useServer(t, { local = new Set(["127.0.0.1"]) } = {}) {
  const reports = [];
  const manager = { reportHookActivity(body) { reports.push(body); return body.token === "good"; } };
  const server = http.createServer((req, res) => {
    void api.handle(req, res, { isLocalAddress: (name) => local.has(name), manager }).catch((error) => { res.writeHead(500); res.end(error.message); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const call = async (method, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/terminal-hook`, { method, body, headers: body === undefined ? undefined : { "Content-Type": "application/json" } });
    return response.status;
  };
  return { call, reports };
}

test("the terminal hook endpoint takes a POST from this machine with the terminal's token", async (t) => {
  assert.equal(api.isPath("/api/terminal-hook"), true);
  assert.equal(api.isPath("/api/terminal"), false);
  const { call, reports } = await useServer(t);
  assert.equal(await call("GET"), 405);
  assert.equal(await call("POST", "not json"), 400);
  assert.equal(await call("POST", JSON.stringify({ token: "bad", activity: "working" })), 404);
  // A body that is not an object is just an unknown terminal, not a crash.
  assert.equal(await call("POST", "null"), 404);
  assert.equal(await call("POST", JSON.stringify({ token: "good", activity: "working" })), 204);
  assert.deepEqual(reports, [{ token: "bad", activity: "working" }, {}, { token: "good", activity: "working" }]);
});

test("the terminal hook endpoint refuses peers that are not this machine", async (t) => {
  const { call, reports } = await useServer(t, { local: new Set(["[::1]"]) });
  assert.equal(await call("POST", JSON.stringify({ token: "good", activity: "working" })), 403);
  assert.deepEqual(reports, []);
});
