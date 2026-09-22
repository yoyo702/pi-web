"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const assert = require("node:assert/strict");
const test = require("node:test");
const auth = require("../auth.cjs");

test("pairing tokens create a normal session and can only be used once", () => {
  const pairing = auth.createPairingToken();
  assert.match(pairing.token, /^[A-Za-z0-9_-]{32}$/);
  assert.ok(pairing.expiresAt > Date.now());

  const session = auth.redeemPairingToken(pairing.token);
  assert.ok(session?.token);
  assert.ok(session.expiresAt > Date.now());
  assert.equal(auth.redeemPairingToken(pairing.token), null);
});

test("pairing rejects malformed or unknown tokens", () => {
  assert.equal(auth.redeemPairingToken("short"), null);
  assert.equal(auth.redeemPairingToken("x".repeat(32)), null);
  assert.equal(auth.redeemPairingToken(null), null);
});
