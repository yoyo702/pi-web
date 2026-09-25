/* eslint-disable @typescript-eslint/no-require-imports */
"use strict"; // Claude Code session catalog for the optional Agents module.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Claude Code keeps one JSONL file per session in
// `<config dir>/projects/<encoded cwd>/<session id>.jsonl`, where the encoded
// cwd replaces every non-alphanumeric character with "-" (paths longer than
// 200 characters are cut and get a hash suffix). A sibling `<session id>/`
// directory holds sub-agent transcripts and large tool results.
function claudeHome() { return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"); }
const ENCODED_MAX = 200;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LIMIT = 200;

function error(code, message) { const value = new Error(message); value.code = code; return value; }
function encodeCwd(cwd) { return cwd.replace(/[^a-zA-Z0-9]/g, "-"); }
function projectDirs(cwd) {
  const root = path.join(claudeHome(), "projects");
  const encoded = encodeCwd(cwd);
  if (encoded.length <= ENCODED_MAX) return [path.join(root, encoded)];
  const prefix = encoded.slice(0, ENCODED_MAX);
  try { return fs.readdirSync(root).filter((name) => name.startsWith(prefix)).map((name) => path.join(root, name)); } catch { return []; }
}

// Session files reach tens of MB and every read blocks the one server process.
// Read the head (up to the first prompt) and a 256 KiB tail only. The tail is
// cached per file until its size or mtime changes; a head that found its
// prompt never changes, so it is kept while the file only grows.
const HEAD_CHUNK = 64 * 1024;
const HEAD_MAX = 4 * 1024 * 1024;
// Longer lines (a pasted image, a large hook output) are skipped unparsed.
const LINE_MAX = 1024 * 1024;
const TAIL_BYTES = 256 * 1024;
const headCache = new Map();
const tailCache = new Map();

function cachedFor(cache, target, stat, read) {
  const cached = cache.get(target);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.value;
  const value = read();
  cache.set(target, { size: stat.size, mtimeMs: stat.mtimeMs, value });
  return value;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.some((block) => block?.type === "tool_result")) return "";
  return content.map((block) => block?.type === "text" && typeof block.text === "string" ? block.text : "").join(" ");
}
// Slash commands, their output, task notifications and compaction summaries
// are recorded as user messages; they are not what the user typed.
const INJECTED = /^<(?:command-name|command-message|command-args|local-command-[a-z]+|task-notification|system-reminder|bash-input|bash-stdout)>/;
function promptOf(record) {
  if (record?.type !== "user" || record.isMeta || record.isSidechain || record.isCompactSummary) return "";
  const text = textOf(record.message?.content).replace(/\s+/g, " ").trim();
  return text && !INJECTED.test(text) ? text.slice(0, 300) : "";
}
function titleOf(record, titles) {
  if (record?.type === "custom-title" && typeof record.customTitle === "string" && record.customTitle.trim()) titles.custom = record.customTitle.trim();
  if (record?.type === "ai-title" && typeof record.aiTitle === "string" && record.aiTitle.trim()) titles.ai = record.aiTitle.trim();
}

function readHead(target) {
  const head = { cwd: null, gitBranch: null, createdAt: null, firstMessage: null, titles: {} };
  const handle = fs.openSync(target, "r");
  try {
    let position = 0;
    let carry = Buffer.alloc(0);
    let skipping = false;
    while (position < HEAD_MAX && !head.firstMessage) {
      const buffer = Buffer.alloc(HEAD_CHUNK);
      const read = fs.readSync(handle, buffer, 0, buffer.length, position);
      if (read === 0) break;
      position += read;
      let data = carry.length ? Buffer.concat([carry, buffer.subarray(0, read)]) : buffer.subarray(0, read);
      let newline;
      while (!head.firstMessage && (newline = data.indexOf(10)) !== -1) {
        if (!skipping) visitHeadLine(head, data.subarray(0, newline));
        skipping = false;
        data = data.subarray(newline + 1);
      }
      if (data.length > LINE_MAX) { skipping = true; data = Buffer.alloc(0); }
      carry = skipping ? Buffer.alloc(0) : Buffer.from(data);
    }
    if (!head.firstMessage && !skipping && carry.length && position < HEAD_MAX) visitHeadLine(head, carry);
  } finally { fs.closeSync(handle); }
  return head;
}
function visitHeadLine(head, line) {
  let record;
  try { record = JSON.parse(line.toString("utf8")); } catch { return; }
  if (!head.cwd && typeof record.cwd === "string") head.cwd = record.cwd;
  if (!head.gitBranch && typeof record.gitBranch === "string" && record.gitBranch) head.gitBranch = record.gitBranch;
  if (!head.createdAt && typeof record.timestamp === "string") head.createdAt = record.timestamp;
  titleOf(record, head.titles);
  head.firstMessage = promptOf(record) || null;
}
function readTail(target, size) {
  const titles = {};
  const length = Math.min(size, TAIL_BYTES);
  const handle = fs.openSync(target, "r");
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(handle, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    if (length < size) lines.shift();
    // Claude appends its title records again as the session grows, so the
    // latest ones are near the end.
    for (const line of lines) {
      if (line.indexOf("title") === -1) continue;
      try { titleOf(JSON.parse(line), titles); } catch { /* partial or unrelated record */ }
    }
  } finally { fs.closeSync(handle); }
  return titles;
}

function headFor(target, stat) {
  const cached = headCache.get(target);
  if (cached?.value.firstMessage && stat.size >= cached.size) return cached.value;
  return cachedFor(headCache, target, stat, () => readHead(target));
}

function sessionAt(target, id, stat) {
  const head = headFor(target, stat);
  const tail = cachedFor(tailCache, target, stat, () => readTail(target, stat.size));
  const title = tail.custom || head.titles.custom || tail.ai || head.titles.ai || null;
  // A file without a prompt is a session that was opened and left, or only
  // holds title records; there is nothing to resume.
  if (!head.firstMessage) return null;
  return {
    id,
    title: title || head.firstMessage,
    firstMessage: head.firstMessage,
    cwd: head.cwd,
    gitBranch: head.gitBranch,
    createdAt: head.createdAt,
    updatedAt: stat.mtime.toISOString(),
    size: stat.size,
    path: target,
  };
}

function scan(cwd) {
  const sessions = [];
  const seen = new Set();
  for (const directory of projectDirs(cwd)) {
    let names = [];
    try { names = fs.readdirSync(directory); } catch { continue; }
    for (const name of names) {
      const id = name.endsWith(".jsonl") ? name.slice(0, -6) : "";
      if (!SESSION_ID.test(id)) continue;
      const target = path.join(directory, name);
      try {
        const stat = fs.statSync(target);
        if (!stat.isFile()) continue;
        seen.add(target);
        const session = sessionAt(target, id, stat);
        // Two folders can share an encoded name (`/a/b-c` and `/a/b/c`).
        if (session && (!session.cwd || session.cwd === cwd)) sessions.push(session);
      } catch { /* skip unreadable or concurrently removed files */ }
    }
  }
  return { sessions, seen };
}

/**
 * One page of the folder's sessions, newest first: `{ sessions, nextCursor }`.
 * The cursor is an offset. Sessions include the file path; strip it before
 * sending them to the browser.
 */
function listSessions({ cwd, query, cursor, limit = 50 } = {}) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw error("invalid_cwd", "A workspace folder is required");
  const { sessions, seen } = scan(cwd);
  // Drop entries of this folder's deleted files; bound the rest.
  const directories = new Set(projectDirs(cwd));
  for (const cache of [headCache, tailCache]) {
    for (const target of cache.keys()) if (!seen.has(target) && directories.has(path.dirname(target))) cache.delete(target);
  }
  if (headCache.size > 5000) { headCache.clear(); tailCache.clear(); }
  const needle = typeof query === "string" ? query.trim().toLowerCase() : "";
  const matching = sessions
    .filter((session) => !needle || `${session.title} ${session.firstMessage || ""} ${session.id}`.toLowerCase().includes(needle))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const offset = /^\d+$/.test(String(cursor ?? "")) ? Number(cursor) : 0;
  const size = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || 50));
  const page = matching.slice(offset, offset + size);
  return { sessions: page, nextCursor: offset + size < matching.length ? String(offset + size) : null };
}

/** The session in this folder, or a `not_found` error. */
function requireSession(id, cwd) {
  if (typeof id !== "string" || !SESSION_ID.test(id)) throw error("invalid_session", "Invalid Claude session id");
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw error("invalid_cwd", "A workspace folder is required");
  for (const directory of projectDirs(cwd)) {
    const target = path.join(directory, `${id}.jsonl`);
    let session = null;
    // Filesystem errors carry the file path; they must not reach the browser.
    try {
      const stat = fs.statSync(target);
      if (stat.isFile()) session = sessionAt(target, id, stat);
    } catch { continue; }
    if (session && (!session.cwd || session.cwd === cwd)) return session;
  }
  throw error("not_found", "Claude session not found in this workspace");
}

/** Deletes the session file and its sub-agent/tool-result folder. */
function remove(id, cwd) {
  const session = requireSession(id, cwd);
  fs.rmSync(session.path, { force: true });
  fs.rmSync(path.join(path.dirname(session.path), id), { recursive: true, force: true });
  headCache.delete(session.path);
  tailCache.delete(session.path);
  return session;
}

module.exports = { listSessions, requireSession, remove, encodeCwd };
