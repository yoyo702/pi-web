/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

/**
 * Rename/archive overlay for Claude Code sessions. Claude owns its own
 * `.jsonl` session files (read-only to pi-web; a live `claude` CLI process
 * may be writing one at any time), so rename/archive state lives in a
 * sidecar file instead of being appended to Claude's own records, mirroring
 * `server/task-templates.cjs`'s `~/.pi-web/*.json` pattern exactly.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

class MetaError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function file() {
  return process.env.PI_WEB_CLAUDE_SESSION_META_FILE || path.join(os.homedir(), ".pi-web", "claude-session-meta.json");
}

function isEntry(value) {
  return value && typeof value === "object"
    && (value.title === undefined || typeof value.title === "string")
    && (value.archived === undefined || typeof value.archived === "boolean");
}

/**
 * Reads the sidecar. `verified` is true only when the file exists and parsed
 * into the expected shape, so a following `save` has nothing to quarantine.
 */
function read() {
  try {
    const parsed = JSON.parse(fs.readFileSync(file(), "utf8"));
    if (!parsed || typeof parsed.sessions !== "object" || parsed.sessions === null) return { sessions: {}, verified: false };
    return { sessions: Object.fromEntries(Object.entries(parsed.sessions).filter(([, value]) => isEntry(value))), verified: true };
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn(`[pi-web] Ignoring unreadable Claude session metadata file: ${error.message}`);
    return { sessions: {}, verified: false };
  }
}

function load() {
  return read().sessions;
}

// Before a save would silently overwrite a file `load()` could not parse (bad
// JSON, or valid JSON in an unexpected shape), move it aside instead of
// discarding it, so whatever was in it can still be recovered by hand.
// Anything else (missing file, or a file `load()` already reads fine) is left
// alone: there is nothing to lose.
function quarantineIfCorrupt(target) {
  let text;
  try { text = fs.readFileSync(target, "utf8"); } catch { return; }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.sessions === "object" && parsed.sessions !== null) return;
  } catch { /* not valid JSON */ }
  const quarantine = `${target}.corrupt-${Date.now()}-${process.pid}`;
  try {
    fs.renameSync(target, quarantine);
    console.warn(`[pi-web] Claude session metadata file was unreadable; moved it aside to ${quarantine}`);
  } catch { /* best effort; a concurrent save may have already moved or replaced it */ }
}

/**
 * `verified` skips the corrupt-file check when the caller just read the file
 * successfully in this same synchronous step (see `read`), so it is not
 * re-read and re-parsed; every other save keeps the protection.
 */
function save(sessions, { verified = false } = {}) {
  const target = file();
  const temp = `${target}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.rmSync(temp, { force: true });
  if (!verified) quarantineIfCorrupt(target);
  fs.writeFileSync(temp, JSON.stringify({ version: 1, sessions }), { mode: 0o600 });
  fs.renameSync(temp, target);
}

/** Stored overlay for one session id, or null when none is stored. */
function get(id) {
  return load()[id] ?? null;
}

/**
 * Every stored overlay entry, keyed by session id. For callers overlaying
 * many sessions at once (e.g. a folder scan): read the sidecar once and look
 * entries up in the returned object, instead of calling `get(id)` (a fresh
 * read) once per session.
 */
function getAll() {
  return load();
}

function rename(id, name) {
  if (typeof name !== "string" || !name.trim() || name.trim().length > 120) {
    throw new MetaError("invalid_name", "Session name must be between 1 and 120 characters");
  }
  const { sessions: all, verified } = read();
  all[id] = { ...all[id], title: name.trim() };
  save(all, { verified });
  return all[id];
}

function setArchived(id, archived) {
  const { sessions: all, verified } = read();
  all[id] = { ...all[id], archived: Boolean(archived) };
  save(all, { verified });
  return all[id];
}

function remove(id) {
  const { sessions: all, verified } = read();
  if (!(id in all)) return;
  delete all[id];
  save(all, { verified });
}

module.exports = { MetaError, get, getAll, rename, setArchived, remove };
