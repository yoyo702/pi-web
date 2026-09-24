/* eslint-disable @typescript-eslint/no-require-imports */
"use strict"; // Codex session catalog for the optional Agents module.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const codexCatalog = require("./codex-catalog.cjs");

// Listing, lookup and management go through the Codex app-server
// (codex-catalog.cjs). Session files are read directly only for the
// last-message summaries and chat history the protocol does not return
// cheaply, and to list sessions while the app-server is unavailable.
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const INDEX_PATH = path.join(CODEX_HOME, "session_index.jsonl");

function error(code, message) { const value = new Error(message); value.code = code; return value; }
function indexEntries() {
  try {
    return fs.readFileSync(INDEX_PATH, "utf8").split("\n").flatMap((line) => { try { return line ? [JSON.parse(line)] : []; } catch { return []; } });
  } catch (cause) {
    if (cause && cause.code === "ENOENT") return [];
    throw error("index_unavailable", "Unable to read the Codex session index");
  }
}
// Session files grow to hundreds of MB and every read here blocks the one
// server process (chat streams, terminals, status SSE). Read only the bytes a
// caller needs, and cache per-file results until the file's size or mtime
// changes. Entries for files that disappear are dropped on the next scan.
const FIRST_LINE_CHUNK = 64 * 1024;
const FIRST_LINE_MAX = 8 * 1024 * 1024;
const metaCache = new Map();
const summaryCache = new Map();

function readFirstLine(target) {
  const handle = fs.openSync(target, "r");
  try {
    const buffers = [];
    let bytes = 0;
    while (bytes < FIRST_LINE_MAX) {
      const buffer = Buffer.alloc(FIRST_LINE_CHUNK);
      const read = fs.readSync(handle, buffer, 0, buffer.length, bytes);
      if (read === 0) break;
      const newline = buffer.subarray(0, read).indexOf(10);
      if (newline !== -1) { buffers.push(buffer.subarray(0, newline)); break; }
      buffers.push(buffer.subarray(0, read));
      bytes += read;
    }
    return Buffer.concat(buffers).toString("utf8");
  } finally { fs.closeSync(handle); }
}
function cachedFor(cache, target, stat, read) {
  const cached = cache.get(target);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.value;
  const value = read();
  cache.set(target, { size: stat.size, mtimeMs: stat.mtimeMs, value });
  return value;
}
function sessionMeta(target) {
  const meta = JSON.parse(readFirstLine(target));
  return meta.type === "session_meta" ? meta.payload : null;
}
function sessionFiles() {
  const roots = [[path.join(CODEX_HOME, "sessions"), false], [path.join(CODEX_HOME, "archived_sessions"), true]];
  const result = new Map();
  const seen = new Set();
  const visit = (directory, archived) => {
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target, archived);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const stat = fs.statSync(target);
          seen.add(target);
          const payload = cachedFor(metaCache, target, stat, () => { try { return sessionMeta(target); } catch { return null; } });
          const id = payload?.session_id || payload?.id;
          if (typeof id === "string") {
            // Sub-agent threads (object `source`) are not user sessions.
            const interactive = payload.source === undefined || payload.source === "cli" || payload.source === "vscode";
            const candidate = { path: target, cwd: payload.cwd, timestamp: payload.timestamp, updatedAt: stat.mtime.toISOString(), updatedAtMs: stat.mtimeMs, size: stat.size, cliVersion: payload.cli_version, modelProvider: payload.model_provider, forkedFromId: payload.forked_from_id || null, interactive, archived };
            const current = result.get(id);
            if (!current || candidate.updatedAtMs > current.updatedAtMs) result.set(id, candidate);
          }
        } catch { /* skip unreadable or concurrently-removed files */ }
      }
    }
  };
  for (const [root, archived] of roots) visit(root, archived);
  for (const cache of [metaCache, summaryCache]) for (const target of cache.keys()) if (!seen.has(target)) cache.delete(target);
  return result;
}
function readRecentMessages(detail, maxBytes = 2 * 1024 * 1024, desiredMessages = 6) {
  if (!detail?.path) return [];
  let handle;
  try {
    const stat = fs.statSync(detail.path);
    handle = fs.openSync(detail.path, "r");
    const chunkSize = 128 * 1024;
    let bytes = 0;
    const buffers = [];
    while (bytes < Math.min(stat.size, maxBytes)) {
      const length = Math.min(chunkSize, stat.size - bytes, maxBytes - bytes);
      const position = stat.size - bytes - length;
      const buffer = Buffer.alloc(length);
      fs.readSync(handle, buffer, 0, length, position);
      buffers.unshift(buffer);
      bytes += length;
      const text = Buffer.concat(buffers).toString("utf8");
      const messages = parseMessages(text, position > 0);
      if (messages.length >= desiredMessages && messages.some((message) => message.role === "user") && messages.some((message) => message.role === "assistant")) return messages;
    }
    return parseMessages(Buffer.concat(buffers).toString("utf8"), stat.size > bytes);
  } catch { return []; }
  finally { if (handle !== undefined) try { fs.closeSync(handle); } catch { /* already closed */ } }
}
function parseMessages(text, startsMidRecord = false) {
  const messageText = (content) => (Array.isArray(content) ? content : []).flatMap((part) => {
    if (typeof part === "string") return [part];
    if (!part || typeof part !== "object") return [];
    return typeof part.text === "string" ? [part.text] : typeof part.content === "string" ? [part.content] : [];
  }).join("\n").replace(/\s+/g, " ").trim();
  const messages = [];
  const lines = text.split("\n");
  if (startsMidRecord) lines.shift();
  for (const line of lines) {
    try {
      const payload = JSON.parse(line).payload;
      if (payload?.type !== "message" || (payload.role !== "user" && payload.role !== "assistant")) continue;
      const content = messageText(payload.content);
      // Codex persists several injected instruction documents as role:user. They are not conversation turns.
      const injectedUserText = /^(# AGENTS\.md|# .*instructions|<(?:environment_context|permissions instructions|collaboration_mode|apps_instructions|plugins_instructions|skills_instructions)>|You are [`“]|Filesystem sandboxing|# Collaboration Mode)/i.test(content);
      if (!content || (payload.role === "user" && injectedUserText)) continue;
      messages.push({ role: payload.role, text: content.slice(0, 600) });
    } catch { /* ignore partial line and non-message events */ }
  }
  return messages;
}
function sessionSummary(detail) {
  if (!detail?.path) return readSessionSummary(detail);
  return cachedFor(summaryCache, detail.path, { size: detail.size, mtimeMs: detail.updatedAtMs }, () => readSessionSummary(detail));
}
function readSessionSummary(detail) {
  const messages = readRecentMessages(detail, 2 * 1024 * 1024, 2);
  let model = null;
  if (detail?.path) {
    try {
      const stat = fs.statSync(detail.path);
      const bytes = Math.min(stat.size, 256 * 1024);
      const handle = fs.openSync(detail.path, "r");
      const buffer = Buffer.alloc(bytes);
      fs.readSync(handle, buffer, 0, bytes, Math.max(0, stat.size - bytes));
      fs.closeSync(handle);
      for (const line of buffer.toString("utf8").split("\n")) {
        try {
          const record = JSON.parse(line);
          if (record.type === "turn_context" && typeof record.payload?.model === "string") model = record.payload.model;
        } catch { /* skip partial and unrelated records */ }
      }
    } catch { /* model remains unknown */ }
  }
  return {
    model,
    lastUserMessage: [...messages].reverse().find((message) => message.role === "user")?.text.slice(0, 180) || null,
    lastAssistantMessage: [...messages].reverse().find((message) => message.role === "assistant")?.text.slice(0, 180) || null,
  };
}
const ARCHIVED_PATH = /[\\/]archived_sessions[\\/]/;
const SESSION_ID = /^[0-9a-f-]{16,}$/i;
const FULL_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FALLBACK_LIMIT = 250;

function isoFromSeconds(seconds) { return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null; }
function titleFromPreview(preview) { return typeof preview === "string" ? preview.replace(/\s+/g, " ").trim().slice(0, 120) : ""; }
function fromThread(thread) {
  return {
    id: thread.id,
    name: (typeof thread.name === "string" && thread.name.trim()) || titleFromPreview(thread.preview) || "Untitled session",
    updatedAt: isoFromSeconds(thread.updatedAt),
    cwd: thread.cwd || null,
    cliVersion: thread.cliVersion || null,
    modelProvider: thread.modelProvider || null,
    model: thread.model || null,
    forkedFromId: thread.forkedFromId || null,
    archived: ARCHIVED_PATH.test(thread.path || ""),
    path: thread.path || null,
  };
}
function withSummary(session) {
  // Stale entries are pruned by sessionFiles(), which now runs only in
  // fallback mode; bound the cache instead.
  if (summaryCache.size > 2000) summaryCache.clear();
  let detail = null;
  if (session.path) try { const stat = fs.statSync(session.path); detail = { path: session.path, size: stat.size, updatedAtMs: stat.mtimeMs }; } catch { /* file moved or removed */ }
  const summary = detail ? sessionSummary(detail) : { model: null, lastUserMessage: null, lastAssistantMessage: null };
  return { ...session, ...summary, model: session.model || summary.model };
}

// Used only while the app-server is unavailable: every interactive session
// file (not only the ones Codex has named in session_index.jsonl), newest
// first, without pagination.
function fromFile(id, detail, names) {
  return { id, name: names.get(id) || "Untitled session", updatedAt: detail.updatedAt || detail.timestamp || null, cwd: detail.cwd || null, cliVersion: detail.cliVersion || null, modelProvider: detail.modelProvider || null, model: null, forkedFromId: detail.forkedFromId || null, archived: detail.archived === true, path: detail.path };
}
function indexNames() {
  const names = new Map();
  let entries = [];
  try { entries = indexEntries(); } catch { /* list sessions without names */ }
  for (const entry of entries) if (typeof entry.id === "string" && typeof entry.thread_name === "string" && entry.thread_name) names.set(entry.id, entry.thread_name);
  return names;
}
// A short cache so chat requests and polls during an outage do not each walk
// the whole sessions tree.
let fallbackFiles = { at: 0, files: null };
function recentSessionFiles() {
  if (!fallbackFiles.files || Date.now() - fallbackFiles.at > 5000) fallbackFiles = { at: Date.now(), files: sessionFiles() };
  return fallbackFiles.files;
}
function listSessionsFromFiles({ cwd, query, archived, limit }) {
  const names = indexNames();
  const normalizedQuery = typeof query === "string" ? query.trim().toLowerCase() : "";
  return [...recentSessionFiles()].filter(([, detail]) => detail.interactive)
    .map(([id, detail]) => fromFile(id, detail, names))
    .filter((session) => !cwd || session.cwd === cwd)
    .filter((session) => session.archived === (archived === true))
    .filter((session) => !normalizedQuery || `${session.name} ${session.id}`.toLowerCase().includes(normalizedQuery))
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .slice(0, Math.min(FALLBACK_LIMIT, Math.max(1, Number(limit) || FALLBACK_LIMIT)));
}

/**
 * One page of sessions, newest first: `{ sessions, nextCursor }`. Sessions
 * include the file path; strip it before sending them to the browser.
 */
async function listSessions({ cwd, query, archived = false, cursor, limit = 50 } = {}) {
  const searchTerm = typeof query === "string" ? query.trim() : "";
  let page;
  try {
    page = await codexCatalog.listThreads({ cwd, archived, searchTerm, cursor, limit });
  } catch (cause) {
    if (!warnedFallback) { warnedFallback = true; console.warn(`[pi-web] Codex catalog unavailable, scanning session files instead: ${cause.message}`); }
    // The fallback cannot continue an app-server cursor; report the outage
    // rather than end the list early.
    if (cursor) throw error("catalog_unavailable", "Codex app-server is unavailable; reload the session list");
    return { sessions: listSessionsFromFiles({ cwd, query: searchTerm, archived, limit: FALLBACK_LIMIT }).map(withSummary), nextCursor: null };
  }
  warnedFallback = false;
  const threads = page.data;
  // searchTerm matches titles only; also accept a pasted session id.
  if (!cursor && FULL_SESSION_ID.test(searchTerm) && !threads.some((thread) => thread.id === searchTerm)) {
    const thread = await codexCatalog.readThread(searchTerm).catch(() => null);
    if (thread) {
      const session = fromThread(thread);
      if (session.archived === (archived === true) && (!cwd || session.cwd === cwd)) threads.unshift(thread);
    }
  }
  const seen = new Set();
  const sessions = threads.filter((thread) => typeof thread?.id === "string" && !seen.has(thread.id) && seen.add(thread.id)).map((thread) => withSummary(fromThread(thread)));
  return { sessions, nextCursor: page.nextCursor };
}
let warnedFallback = false;

async function requireSession(id) {
  if (typeof id !== "string" || !SESSION_ID.test(id)) throw error("invalid_session", "Invalid Codex session id");
  let thread;
  try {
    thread = await codexCatalog.readThread(id);
  } catch (cause) {
    if (cause?.code !== "catalog_unavailable") throw cause;
    const detail = recentSessionFiles().get(id);
    if (!detail) throw error("not_found", "Codex session not found");
    return fromFile(id, detail, indexNames());
  }
  if (!thread) throw error("not_found", "Codex session not found");
  return fromThread(thread);
}
async function getSessionPreview(id) {
  const session = withSummary(await requireSession(id));
  return { session, recentMessages: readRecentMessages(session).slice(-6) };
}
async function latestTurnId(id) {
  const { path: file } = await requireSession(id);
  if (!file) return null;
  const turnIdOf = (line) => {
    if (line.indexOf("turn_id") === -1) return null;
    try { const payload = JSON.parse(line.toString("utf8")).payload; return typeof payload?.turn_id === "string" ? payload.turn_id : null; } catch { return null; }
  };
  // The latest turn is near the end: read backward and stop at the last record
  // that carries a turn id. Splitting on the newline byte is UTF-8 safe.
  let handle;
  try {
    handle = fs.openSync(file, "r");
    let position = fs.fstatSync(handle).size;
    let carry = Buffer.alloc(0);
    while (position > 0) {
      const length = Math.min(256 * 1024, position);
      position -= length;
      const buffer = Buffer.alloc(length);
      fs.readSync(handle, buffer, 0, length, position);
      const data = Buffer.concat([buffer, carry]);
      let end = data.length;
      let newline;
      while ((newline = end > 0 ? data.lastIndexOf(10, end - 1) : -1) !== -1) {
        const turnId = turnIdOf(data.subarray(newline + 1, end));
        if (turnId) return turnId;
        end = newline;
      }
      carry = data.subarray(0, end);
    }
    return turnIdOf(carry);
  } catch { return null; }
  finally { if (handle !== undefined) try { fs.closeSync(handle); } catch { /* already closed */ } }
}
async function archive(id) {
  const session = await requireSession(id);
  if (session.archived) throw error("already_archived", "Codex session is already archived");
  await codexCatalog.archive(id);
  return { ...session, archived: true };
}
async function unarchive(id) {
  const session = await requireSession(id);
  if (!session.archived) throw error("not_archived", "Codex session is not archived");
  await codexCatalog.unarchive(id);
  return { ...session, archived: false };
}
async function remove(id) {
  const session = await requireSession(id);
  await codexCatalog.remove(id);
  return session;
}
async function rename(id, name) {
  if (typeof name !== "string" || !name.trim() || name.length > 120) throw error("invalid_name", "Session name must be between 1 and 120 characters");
  const session = await requireSession(id);
  await codexCatalog.setName(id, name.trim());
  return { ...session, name: name.trim() };
}

module.exports = { listSessions, requireSession, getSessionPreview, latestTurnId, readRecentMessages, archive, unarchive, remove, rename };
