import assert from "node:assert/strict";
import test from "node:test";

const { streamFailure } = await import("./agents/stream-failure.ts");

function withFetch(t, impl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  t.after(() => { globalThis.fetch = original; });
}

test("reads the error and code of a refused stream", async (t) => {
  withFetch(t, async () => new Response(JSON.stringify({ error: "This session is open in another Codex client.", code: "writer_conflict" }), { status: 409 }));
  assert.deepEqual(await streamFailure("/events"), { message: "This session is open in another Codex client.", code: "writer_conflict" });
});

test("falls back to the status when the body is not JSON", async (t) => {
  withFetch(t, async () => new Response("bad gateway", { status: 502 }));
  assert.deepEqual(await streamFailure("/events"), { message: "HTTP 502" });
});

test("an opened stream or an unreachable server gives no reason, and the stream is closed", async (t) => {
  let signal;
  withFetch(t, async (_url, init) => { signal = init.signal; return new Response(new ReadableStream(), { status: 200, headers: { "Content-Type": "text/event-stream" } }); });
  assert.equal(await streamFailure("/events"), null);
  assert.equal(signal.aborted, true);
  withFetch(t, async () => { throw new TypeError("Failed to fetch"); });
  assert.equal(await streamFailure("/events"), null);
});
