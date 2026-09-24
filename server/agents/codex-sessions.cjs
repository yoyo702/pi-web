/* eslint-disable @typescript-eslint/no-require-imports */
"use strict"; // Codex session catalog for the optional Agents module.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const CODEX_HOME = path.join(os.homedir(), ".codex");
const INDEX_PATH = path.join(CODEX_HOME, "session_index.jsonl");

function error(code, message) { const value = new Error(message); value.code = code; return value; }
function resolveCodex() {
  const name = process.platform === "win32" ? "codex.cmd" : "codex";
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    const candidate = path.join(directory, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw error("cli_missing", "codex CLI was not found on PATH");
}
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
            const candidate = { path: target, cwd: payload.cwd, timestamp: payload.timestamp, updatedAt: stat.mtime.toISOString(), updatedAtMs: stat.mtimeMs, size: stat.size, cliVersion: payload.cli_version, modelProvider: payload.model_provider, archived };
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
function listSessions({ cwd, query, archived, limit = 100 } = {}) {
  const details = sessionFiles();
  const normalizedQuery = typeof query === "string" ? query.trim().toLowerCase() : "";
  return indexEntries()
    .map((entry) => {
      const detail = details.get(entry.id) || {};
      return {
        id: entry.id,
        name: typeof entry.thread_name === "string" && entry.thread_name ? entry.thread_name : "Untitled session",
        updatedAt: detail.updatedAt || entry.updated_at || detail.timestamp || null,
        cwd: detail.cwd || null,
        cliVersion: detail.cliVersion || null,
        modelProvider: detail.modelProvider || null,
        archived: detail.archived === true,
        _detail: detail,
      };
    })
    .filter((session) => !cwd || session.cwd === cwd)
    .filter((session) => typeof archived !== "boolean" || session.archived === archived)
    .filter((session) => !normalizedQuery || `${session.name} ${session.id}`.toLowerCase().includes(normalizedQuery))
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .slice(0, Math.min(250, Math.max(1, Number(limit) || 100)))
    .map(({ _detail, ...session }) => ({ ...session, ...sessionSummary(_detail) }));
}
function getSessionPreview(id) {
  const session = requireSession(id);
  const detail = sessionFiles().get(id);
  return { session, recentMessages: readRecentMessages(detail).slice(-6) };
}
function latestTurnId(id) {
  const detail = sessionFiles().get(id);
  if (!detail?.path) return null;
  const turnIdOf = (line) => {
    if (line.indexOf("turn_id") === -1) return null;
    try { const payload = JSON.parse(line.toString("utf8")).payload; return typeof payload?.turn_id === "string" ? payload.turn_id : null; } catch { return null; }
  };
  // The latest turn is near the end: read backward and stop at the last record
  // that carries a turn id. Splitting on the newline byte is UTF-8 safe.
  let handle;
  try {
    handle = fs.openSync(detail.path, "r");
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
function requireSession(id) {
  if (typeof id !== "string" || !/^[0-9a-f-]{16,}$/i.test(id)) throw error("invalid_session", "Invalid Codex session id");
  const session = listSessions({ limit: 250 }).find((entry) => entry.id === id);
  if (!session) throw error("not_found", "Codex session not found");
  return session;
}
function runCli(args, cwd) {
  const result = spawnSync(resolveCodex(), args, { cwd: cwd || process.cwd(), encoding: "utf8", timeout: 15_000, windowsHide: true });
  if (result.error) throw error("cli_failed", result.error.message);
  if (result.status !== 0) throw error("cli_failed", (result.stderr || result.stdout || "Codex command failed").trim());
}
function archive(id) { const session = requireSession(id); if (session.archived) throw error("already_archived", "Codex session is already archived"); runCli(["archive", id], session.cwd); return session; }
function unarchive(id) { const session = requireSession(id); if (!session.archived) throw error("not_archived", "Codex session is not archived"); runCli(["unarchive", id], session.cwd); return session; }
function remove(id) { const session = requireSession(id); runCli(["delete", "--force", id], session.cwd); return session; }
function rename(id, name) {
  if (typeof name !== "string" || !name.trim() || name.length > 120) throw error("invalid_name", "Session name must be between 1 and 120 characters");
  requireSession(id);
  const lines = fs.readFileSync(INDEX_PATH, "utf8").split("\n");
  let found = false;
  const next = lines.map((line) => {
    if (!line) return line;
    try { const entry = JSON.parse(line); if (entry.id === id) { entry.thread_name = name.trim(); found = true; return JSON.stringify(entry); } } catch { /* preserve unknown lines */ }
    return line;
  });
  if (!found) throw error("not_found", "Codex session not found");
  const temporary = `${INDEX_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, next.join("\n"), { mode: 0o600 });
  fs.renameSync(temporary, INDEX_PATH);
  return requireSession(id);
}

module.exports = { listSessions, requireSession, getSessionPreview, latestTurnId, readRecentMessages, archive, unarchive, remove, rename };
