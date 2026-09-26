"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Load terminal-api against a temp HOME and grants file so authorization never
// sees the real ~/.pi sessions, ~/pi-cwd-* directories, or ~/.pi-web grants.
function loadTerminalApi(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-terminal-auth-")));
  const home = path.join(base, "home");
  fs.mkdirSync(home);
  const grantsFile = path.join(base, "allowed-roots.json");
  const previous = { HOME: process.env.HOME, grants: process.env.PI_WEB_ALLOWED_ROOTS_FILE, state: global.__piWebTerminalAuthorization };
  process.env.HOME = home;
  process.env.PI_WEB_ALLOWED_ROOTS_FILE = grantsFile;
  global.__piWebTerminalAuthorization = { roots: new Set() };
  const modulePath = require.resolve("./terminal-api.cjs");
  delete require.cache[modulePath];
  const api = require("./terminal-api.cjs");
  t.after(() => {
    delete require.cache[modulePath];
    for (const [key, value] of [["HOME", previous.HOME], ["PI_WEB_ALLOWED_ROOTS_FILE", previous.grants]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (previous.state === undefined) delete global.__piWebTerminalAuthorization;
    else global.__piWebTerminalAuthorization = previous.state;
    fs.rmSync(base, { recursive: true, force: true });
  });
  const dir = (name) => {
    const directory = path.join(base, name);
    fs.mkdirSync(directory, { recursive: true });
    return directory;
  };
  // Rewrite with a distinct size so the mtime/size key changes even when the
  // filesystem's mtime resolution is coarse.
  let writes = 0;
  const writeGrants = (roots) => {
    writes += 1;
    fs.writeFileSync(grantsFile, `${JSON.stringify(roots)}${" ".repeat(writes)}`);
  };
  return { api, base, home, dir, writeGrants };
}

function forbidden(fn) {
  assert.throws(fn, (error) => error.code === "forbidden_cwd");
}

test("a grant written to the roots file authorizes on the next request", (t) => {
  const { api, dir, writeGrants } = loadTerminalApi(t);
  const granted = dir("granted");
  const later = dir("later");
  writeGrants([granted]);
  assert.equal(api.authorizedCwd(granted), granted);
  forbidden(() => api.authorizedCwd(later));
  writeGrants([granted, later]);
  assert.equal(api.authorizedCwd(path.join(later, ".")), later);
});

test("a root that appears within the cache TTL is rechecked before denying", (t) => {
  const { api, base, dir, writeGrants } = loadTerminalApi(t);
  const granted = dir("granted");
  const late = path.join(base, "late");
  writeGrants([granted, late]); // `late` does not exist yet, so its realpath fails
  assert.equal(api.authorizedCwd(granted), granted);
  fs.mkdirSync(late);
  assert.equal(api.authorizedCwd(late), late);
});

test("a revoked root stops authorizing as soon as the file changes", (t) => {
  const { api, dir, writeGrants } = loadTerminalApi(t);
  const keep = dir("keep");
  const revoked = dir("revoked");
  writeGrants([keep, revoked]);
  assert.equal(api.authorizedCwd(revoked), revoked);
  writeGrants([keep]);
  forbidden(() => api.authorizedCwd(revoked));
  assert.equal(api.authorizedCwd(keep), keep);
});

test("repeated checks do not realpath every root while the file is unchanged", (t) => {
  const { api, dir, writeGrants } = loadTerminalApi(t);
  const roots = Array.from({ length: 5 }, (_, index) => dir(`root-${index}`));
  writeGrants(roots);
  const target = path.join(roots[3], "nested");
  fs.mkdirSync(target);
  assert.equal(api.authorizedCwd(target), target);
  const realpath = t.mock.method(fs, "realpathSync");
  const readFile = t.mock.method(fs, "readFileSync");
  for (let index = 0; index < 10; index += 1) assert.equal(api.authorizedCwd(target), target);
  // Only the requested cwd itself is resolved; roots come from the cache.
  assert.equal(realpath.mock.callCount(), 10);
  assert.equal(readFile.mock.callCount(), 0);
});

test("addRoot and ~/pi-cwd-* directories still authorize", (t) => {
  const { api, home, dir } = loadTerminalApi(t);
  const added = dir("added");
  forbidden(() => api.authorizedCwd(added));
  api.addRoot(added);
  assert.equal(api.authorizedCwd(added), added);
  const scratch = path.join(home, "pi-cwd-20260924");
  fs.mkdirSync(scratch);
  assert.equal(api.authorizedCwd(scratch), scratch);
});

test("an open Codex Chat blocks input only for a terminal resuming the same session", (t) => {
  const { api } = loadTerminalApi(t);
  const appServer = require("./codex-app-server.cjs");
  const original = appServer.isClaimed;
  appServer.isClaimed = (id) => id === "parent";
  t.after(() => { appServer.isClaimed = original; });
  assert.equal(api.chatOwnsInput({ launchMode: "resume", sourceSessionId: "parent" }), true);
  assert.equal(api.chatOwnsInput({ launchMode: "fork", sourceSessionId: "parent" }), false);
  assert.equal(api.chatOwnsInput({ launchMode: "resume", sourceSessionId: "other" }), false);
});

test("a non-string terminal title is rejected before anything starts", async (t) => {
  const { api } = loadTerminalApi(t);
  const { Readable } = require("node:stream");
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ provider: "claude", cwd: "/nowhere", title: 5 }))]), { method: "POST", headers: { "content-type": "application/json" } });
  const res = { status: 0, body: "", writeHead(status) { this.status = status; }, end(body) { this.body = body ?? ""; } };
  await api.handleTerminalRequest(req, res, new URL("http://localhost/api/terminals"));
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).code, "invalid_title");
});
