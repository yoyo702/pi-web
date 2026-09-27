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

test("login rate-limit key honors the right-most X-Forwarded-For hop from a loopback peer only when PI_WEB_TRUST_PROXY=1", () => {
  const original = process.env.PI_WEB_TRUST_PROXY;
  try {
    process.env.PI_WEB_TRUST_PROXY = "1";
    const req = { headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" }, socket: { remoteAddress: "127.0.0.1" } };
    assert.equal(auth.clientKey(req), "10.0.0.1");
  } finally {
    if (original === undefined) delete process.env.PI_WEB_TRUST_PROXY;
    else process.env.PI_WEB_TRUST_PROXY = original;
  }
});

test("login rate-limit key ignores a client-supplied left-most X-Forwarded-For hop even when PI_WEB_TRUST_PROXY=1", () => {
  const original = process.env.PI_WEB_TRUST_PROXY;
  try {
    process.env.PI_WEB_TRUST_PROXY = "1";
    const req = { headers: { "x-forwarded-for": "1.2.3.4, 203.0.113.7" }, socket: { remoteAddress: "127.0.0.1" } };
    assert.equal(auth.clientKey(req), "203.0.113.7");
  } finally {
    if (original === undefined) delete process.env.PI_WEB_TRUST_PROXY;
    else process.env.PI_WEB_TRUST_PROXY = original;
  }
});

test("login rate-limit key falls back to the socket address when X-Forwarded-For is empty or blank", () => {
  const original = process.env.PI_WEB_TRUST_PROXY;
  try {
    process.env.PI_WEB_TRUST_PROXY = "1";
    const emptyReq = { headers: { "x-forwarded-for": "" }, socket: { remoteAddress: "127.0.0.1" } };
    assert.equal(auth.clientKey(emptyReq), "127.0.0.1");
    const blankReq = { headers: { "x-forwarded-for": "," }, socket: { remoteAddress: "127.0.0.1" } };
    assert.equal(auth.clientKey(blankReq), "127.0.0.1");
  } finally {
    if (original === undefined) delete process.env.PI_WEB_TRUST_PROXY;
    else process.env.PI_WEB_TRUST_PROXY = original;
  }
});

test("login rate-limit key ignores X-Forwarded-For from a loopback peer when PI_WEB_TRUST_PROXY is unset", () => {
  const original = process.env.PI_WEB_TRUST_PROXY;
  try {
    delete process.env.PI_WEB_TRUST_PROXY;
    const req = { headers: { "x-forwarded-for": "203.0.113.7" }, socket: { remoteAddress: "127.0.0.1" } };
    assert.equal(auth.clientKey(req), "127.0.0.1");
  } finally {
    if (original === undefined) delete process.env.PI_WEB_TRUST_PROXY;
    else process.env.PI_WEB_TRUST_PROXY = original;
  }
});

test("login rate-limit key ignores X-Forwarded-For from a non-loopback peer even when PI_WEB_TRUST_PROXY=1", () => {
  const original = process.env.PI_WEB_TRUST_PROXY;
  try {
    process.env.PI_WEB_TRUST_PROXY = "1";
    const req = { headers: { "x-forwarded-for": "203.0.113.7" }, socket: { remoteAddress: "10.0.0.5" } };
    assert.equal(auth.clientKey(req), "10.0.0.5");
  } finally {
    if (original === undefined) delete process.env.PI_WEB_TRUST_PROXY;
    else process.env.PI_WEB_TRUST_PROXY = original;
  }
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
