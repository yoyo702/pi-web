"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const assert = require("node:assert/strict");
const test = require("node:test");
const { Readable } = require("node:stream");
const auth = require("../auth.cjs");
const { readJsonBody } = require("../http-body.cjs");

test("malformed cookie encoding does not throw", () => {
  const req = { headers: { cookie: "x=%E0%A4%A; pi_web_session=abc" } };
  assert.doesNotThrow(() => auth.getSessionFromRequest(req));
});

test("login rate-limit key ignores spoofable X-Forwarded-For", () => {
  const req = { headers: { "x-forwarded-for": "1.2.3.4" }, socket: { remoteAddress: "10.0.0.5" } };
  assert.equal(auth.clientKey(req), "10.0.0.5");
});

test("safeEqual rejects missing or mismatched values", () => {
  assert.equal(auth.safeEqual("abc", "abc"), true);
  assert.equal(auth.safeEqual("abd", "abc"), false);
  assert.equal(auth.safeEqual(undefined, "abc"), false);
  assert.equal(auth.safeEqual("", ""), false);
});

function fakeRequest(chunks, headers = {}) {
  const stream = Readable.from(chunks.map((chunk) => Buffer.from(chunk)));
  stream.headers = headers;
  return stream;
}

test("readJsonBody rejects oversized bodies without buffering them", async () => {
  await assert.rejects(readJsonBody(fakeRequest(["x".repeat(600), "y".repeat(600)]), 1024), /too large/);
  await assert.rejects(readJsonBody(fakeRequest(["{}"], { "content-length": "999999" }), 1024), /too large/);
  assert.deepEqual(await readJsonBody(fakeRequest(['{"a":', "1}"]), 1024), { a: 1 });
});
