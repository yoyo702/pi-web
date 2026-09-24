"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const revokedFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-auth-")), "revoked.json");

function loadFreshAuth() {
  // Simulate a server restart: new module instance and no in-memory state.
  delete global.__piWebAuthState;
  delete require.cache[require.resolve("../auth.cjs")];
  process.env.PI_WEB_PASSWORD = "test-password";
  process.env.PI_WEB_REVOKED_SESSIONS_FILE = revokedFile;
  return require("../auth.cjs");
}

function requestWith(token, auth) {
  return { headers: { cookie: `${auth.COOKIE_NAME}=${encodeURIComponent(token)}` } };
}

test("logout stays effective after a restart and never stores raw tokens", () => {
  let auth = loadFreshAuth();
  const { token } = auth.createSession();
  assert.ok(auth.getSessionFromRequest(requestWith(token, auth)));

  auth.revokeSessionFromRequest(requestWith(token, auth));
  assert.equal(auth.getSessionFromRequest(requestWith(token, auth)), null);
  assert.equal(fs.readFileSync(revokedFile, "utf8").includes(token), false);
  assert.equal((fs.statSync(revokedFile).mode & 0o777).toString(8), "600");

  auth = loadFreshAuth();
  assert.equal(auth.getSessionFromRequest(requestWith(token, auth)), null);

  const other = auth.createSession();
  assert.ok(auth.getSessionFromRequest(requestWith(other.token, auth)));
});
