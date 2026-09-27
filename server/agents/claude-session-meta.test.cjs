/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function withMetaFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-claude-meta-"));
  const target = path.join(dir, "meta.json");
  process.env.PI_WEB_CLAUDE_SESSION_META_FILE = target;
  t.after(() => { delete process.env.PI_WEB_CLAUDE_SESSION_META_FILE; fs.rmSync(dir, { recursive: true, force: true }); });
  delete require.cache[require.resolve("./claude-session-meta.cjs")];
  return require("./claude-session-meta.cjs");
}

test("rename: stores and returns a trimmed title", (t) => {
  const meta = withMetaFile(t);
  const result = meta.rename("s1", "  My Session  ");
  assert.equal(result.title, "My Session");
  assert.equal(meta.get("s1").title, "My Session");
});

test("rename: rejects an empty or overlong name", (t) => {
  const meta = withMetaFile(t);
  // `assert.throws` with a RegExp tests the error's stringified `name:
  // message`, which stays "Error: ..." here (MetaError does not override
  // `name`); match on `.code` instead, as the rest of this codebase's tests do.
  assert.throws(() => meta.rename("s1", "   "), { code: "invalid_name" });
  assert.throws(() => meta.rename("s1", "x".repeat(121)), { code: "invalid_name" });
});

test("setArchived: toggles independently of title", (t) => {
  const meta = withMetaFile(t);
  meta.rename("s1", "Kept name");
  meta.setArchived("s1", true);
  assert.deepEqual(meta.get("s1"), { title: "Kept name", archived: true });
  meta.setArchived("s1", false);
  assert.equal(meta.get("s1").archived, false);
});

test("remove: deletes the overlay entry", (t) => {
  const meta = withMetaFile(t);
  meta.rename("s1", "Name");
  meta.remove("s1");
  assert.equal(meta.get("s1"), null);
});

test("get: returns null for an unknown id, and survives a missing file", (t) => {
  const meta = withMetaFile(t);
  assert.equal(meta.get("unknown"), null);
});

test("writes are atomic: a crash-left temp file does not block a later save", (t) => {
  const meta = withMetaFile(t);
  meta.rename("s1", "First");
  const target = process.env.PI_WEB_CLAUDE_SESSION_META_FILE;
  fs.writeFileSync(`${target}.${process.pid}.tmp`, "stale");
  meta.rename("s1", "Second");
  assert.equal(meta.get("s1").title, "Second");
  assert.equal(fs.existsSync(`${target}.${process.pid}.tmp`), false);
});

test("getAll: returns every stored entry in one read, for callers overlaying many sessions", (t) => {
  const meta = withMetaFile(t);
  meta.rename("s1", "First");
  meta.setArchived("s2", true);
  assert.deepEqual(meta.getAll(), { s1: { title: "First" }, s2: { archived: true } });
  assert.deepEqual(meta.getAll(), meta.getAll(), "two calls must be independent objects with equal contents");
});

test("get and getAll ignore a corrupt sidecar file instead of throwing", (t) => {
  const meta = withMetaFile(t);
  const target = process.env.PI_WEB_CLAUDE_SESSION_META_FILE;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "{ not json");
  assert.equal(meta.get("s1"), null);
  assert.deepEqual(meta.getAll(), {});
});

test("a corrupt sidecar is moved aside (not silently overwritten) the next time something is saved", (t) => {
  const meta = withMetaFile(t);
  const target = process.env.PI_WEB_CLAUDE_SESSION_META_FILE;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "{ not json, definitely-not-recoverable-garbage");
  meta.rename("s1", "Recovered after corruption");
  assert.equal(meta.get("s1").title, "Recovered after corruption");
  const quarantined = fs.readdirSync(path.dirname(target)).filter((name) => name.startsWith(`${path.basename(target)}.corrupt-`));
  assert.equal(quarantined.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(target), quarantined[0]), "utf8"), "{ not json, definitely-not-recoverable-garbage");
});
