/* eslint-disable @typescript-eslint/no-require-imports */
"use strict"; // External agent terminal API.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const manager = require("./terminal-manager.cjs");
const codexAppServer = require("./codex-app-server.cjs");
const claudeSessions = require("./claude-sessions.cjs");
const { readJsonBody } = require("../http-body.cjs");

const state = global.__piWebTerminalAuthorization || { roots: new Set() };
global.__piWebTerminalAuthorization = state;
const allowedRootsFile = process.env.PI_WEB_ALLOWED_ROOTS_FILE || path.join(os.homedir(), ".pi-web", "allowed-roots.json");

function json(res, status, value, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(value));
}
function errorResponse(res, error) {
  const code = error?.code;
  const status = code === "not_found" ? 404 : code === "terminal_limit" || code === "terminal_record_limit" ? 429 : code === "not_running" || code === "still_running" || code === "chat_input_owned" || code === "session_busy" ? 409 : code === "forbidden_cwd" ? 403 : code === "cli_missing" || code === "runtime_unavailable" ? 503 : 400;
  json(res, status, { error: error?.message || "terminal request failed", code });
}
function readJson(req) {
  return readJsonBody(req, 65536);
}
function addRoot(root) { state.roots.add(path.resolve(root)); resolvedRootsCache = null; }
function registerCwd(cwd) {
  if (typeof cwd !== "string" || !cwd) throw Object.assign(new Error("Path is required"), { code: "invalid_cwd" });
  let canonical;
  try { canonical = fs.realpathSync(path.resolve(cwd)); } catch { throw Object.assign(new Error(`Directory does not exist: ${cwd}`), { code: "invalid_cwd" }); }
  if (!fs.statSync(canonical).isDirectory()) throw Object.assign(new Error(`Path is not a directory: ${cwd}`), { code: "invalid_cwd" });
  addRoot(canonical);
  return canonical;
}
// Session files are append-only and can be tens of MB, and this runs on the
// server's main thread. Read only each file's header line, once per path.
const HEADER_READ_BYTES = 64 * 1024;
const headerCwdCache = global.__piWebSessionHeaderCwdCache || new Map();
global.__piWebSessionHeaderCwdCache = headerCwdCache;
function readSessionHeaderCwd(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(HEADER_READ_BYTES);
    const text = buffer.toString("utf8", 0, fs.readSync(fd, buffer, 0, buffer.length, 0));
    const newline = text.indexOf("\n");
    const header = JSON.parse(newline === -1 ? text : text.slice(0, newline));
    return header?.type === "session" && typeof header.cwd === "string" ? path.resolve(header.cwd) : null;
  } catch {
    return null; // malformed historical session
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
function sessionHeaderRoots() {
  const roots = new Set();
  const seen = new Set();
  const sessionBase = path.join(os.homedir(), ".pi", "agent", "sessions");
  try {
    for (const dir of fs.readdirSync(sessionBase)) {
      const directory = path.join(sessionBase, dir);
      for (const file of fs.readdirSync(directory)) {
        if (!file.endsWith(".jsonl")) continue;
        const filePath = path.join(directory, file);
        seen.add(filePath);
        let cwd = headerCwdCache.get(filePath);
        if (!cwd) {
          // Failures are not cached: a new session file may still be mid-write.
          cwd = readSessionHeaderCwd(filePath);
          if (cwd) headerCwdCache.set(filePath, cwd);
        }
        if (cwd) roots.add(cwd);
      }
    }
  } catch { /* no sessions yet */ }
  for (const filePath of headerCwdCache.keys()) if (!seen.has(filePath)) headerCwdCache.delete(filePath);
  return roots;
}
function grantedRoots() {
  const roots = new Set(state.roots);
  // /api/cwd/validate is handled by the Next route, which persists grants for
  // Files, Git, Worktrees, and terminals in one shared file. This long-lived
  // proxy process reads it (see resolvedGrantedRoots for caching) so it sees
  // grants created by a Next worker without a second registration endpoint.
  try {
    const persisted = JSON.parse(fs.readFileSync(allowedRootsFile, "utf8"));
    if (Array.isArray(persisted)) {
      for (const root of persisted) if (typeof root === "string" && path.isAbsolute(root)) roots.add(root);
    }
  } catch { /* no explicit workspace grants yet */ }
  try {
    for (const name of fs.readdirSync(os.homedir())) if (/^pi-cwd-\d{8}$/.test(name)) roots.add(path.join(os.homedir(), name));
  } catch { /* ignore */ }
  return roots;
}
// Authorization runs on every terminal/Codex request, and realpath on a root
// on a sleeping or unplugged external drive can stall this whole process. Keep
// the realpath'd granted roots, keyed on the grants file's identity (so a
// revocation stops authorizing as soon as the file changes) and bounded by a
// short TTL for the ~/pi-cwd-* scan and realpath results. addRoot() clears it.
const RESOLVED_ROOTS_TTL_MS = 5_000;
let resolvedRootsCache = null; // { key, expiresAt, roots: string[] }
function allowedRootsFileKey() {
  try {
    const stat = fs.statSync(allowedRootsFile);
    return `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
  } catch {
    return "missing";
  }
}
function resolvedGrantedRoots({ fresh = false } = {}) {
  const key = allowedRootsFileKey();
  const now = Date.now();
  if (!fresh && resolvedRootsCache && resolvedRootsCache.key === key && now < resolvedRootsCache.expiresAt) return resolvedRootsCache.roots;
  const roots = [];
  for (const root of grantedRoots()) {
    try { roots.push(fs.realpathSync(root)); } catch { /* root no longer exists */ }
  }
  resolvedRootsCache = { key, expiresAt: now + RESOLVED_ROOTS_TTL_MS, roots };
  return roots;
}
function isWithinResolvedRoot(target, root) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function isWithinAnyRoot(target, roots) {
  for (const root of roots) {
    try {
      if (isWithinResolvedRoot(target, fs.realpathSync(root))) return true;
    } catch { /* root no longer exists */ }
  }
  return false;
}
function isAuthorizedTarget(target) {
  if (resolvedGrantedRoots().some((root) => isWithinResolvedRoot(target, root))) return true;
  // Explicit grants cover almost every request; scan session headers only
  // when they miss.
  if (isWithinAnyRoot(target, sessionHeaderRoots())) return true;
  // Fail closed but fresh: a root granted (or created) since the cache was
  // filled must work immediately, so recheck uncached before denying.
  return resolvedGrantedRoots({ fresh: true }).some((root) => isWithinResolvedRoot(target, root));
}
function authorizedCwd(cwd) {
  if (typeof cwd !== "string" || !cwd) throw Object.assign(new Error("cwd is required"), { code: "invalid_cwd" });
  let target;
  try { target = fs.realpathSync(path.resolve(cwd)); } catch { throw Object.assign(new Error("terminal working directory does not exist"), { code: "invalid_cwd" }); }
  if (!isAuthorizedTarget(target)) {
    throw Object.assign(new Error("terminal working directory is not an authorized workspace"), { code: "forbidden_cwd" });
  }
  return target;
}
async function claimCodexSession(sourceSessionId, options) { return manager.interruptAndStopTerminalsForSession(sourceSessionId, options); }
// A chat runtime owns input only for a terminal resuming the same session.
function chatOwnsInput(terminal) { return terminal.launchMode === "resume" && Boolean(terminal.sourceSessionId) && codexAppServer.isClaimed(terminal.sourceSessionId); }
function isTerminalPath(pathname) { return pathname === "/api/terminals" || /^\/api\/terminals\/[^/]+(?:\/(?:input|resize|stop|buffer))?$/.test(pathname); }

async function handleTerminalRequest(req, res, url) {
  try {
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.pathname === "/api/terminals" && req.method === "GET") {
      const requestedCwd = url.searchParams.get("cwd");
      const cwd = requestedCwd ? authorizedCwd(requestedCwd) : undefined;
      return json(res, 200, { terminals: manager.listTerminals(cwd), stats: manager.terminalStats(cwd), ...(cwd ? { cwd } : {}) });
    }
    if (url.pathname === "/api/terminals" && req.method === "DELETE") {
      const requestedCwd = url.searchParams.get("cwd");
      const provider = url.searchParams.get("provider");
      if (provider && provider !== "shell" && provider !== "codex" && provider !== "claude") throw Object.assign(new Error("invalid terminal provider"), { code: "invalid_provider" });
      return json(res, 200, { removedIds: manager.clearEndedTerminals({ cwd: requestedCwd ? authorizedCwd(requestedCwd) : undefined, provider: provider || undefined }) });
    }
    if (url.pathname === "/api/terminals" && req.method === "POST") {
      const body = await readJson(req);
      const cwd = authorizedCwd(body.cwd);
      // Only `resume` writes the source session; `fork` starts a new one.
      if (body.provider === "codex" && body.launchMode === "resume" && typeof body.sourceSessionId === "string") {
        if (codexAppServer.isRemoving(body.sourceSessionId)) throw Object.assign(new Error("This Codex session is being archived or deleted"), { code: "session_busy" });
        if (codexAppServer.isAttached(body.sourceSessionId)) throw Object.assign(new Error("Close Codex Chat before starting a Terminal for this session"), { code: "chat_input_owned" });
        // A detached chat may still be running a turn (e.g. started from a phone).
        const chat = codexAppServer.runtimeForSession(body.sourceSessionId);
        if (chat && chat.state !== "idle") throw Object.assign(new Error("Codex Chat is still running a turn in this session. Wait for it to finish or stop it first."), { code: "session_busy" });
        await codexAppServer.stopAndWait(body.sourceSessionId);
        if (codexAppServer.isRemoving(body.sourceSessionId)) throw Object.assign(new Error("This Codex session is being archived or deleted"), { code: "session_busy" });
      }
      if (body.provider === "claude" && (body.launchMode === "resume" || body.launchMode === "fork")) {
        // Claude looks sessions up by folder, so the session must belong to this one.
        claudeSessions.requireSession(body.sourceSessionId, cwd);
        // Two Claude processes appending to one session file corrupt its history.
        if (body.launchMode === "resume" && manager.runtimeForSession(body.sourceSessionId)) throw Object.assign(new Error("This Claude session is already open in a terminal"), { code: "session_busy" });
      }
      const terminal = manager.createTerminal({ provider: body.provider, cwd, cols: body.cols ?? 100, rows: body.rows ?? 30, permissionMode: body.permissionMode ?? "confirm", launchMode: body.launchMode ?? "new", noAltScreen: body.noAltScreen ?? body.provider === "codex", sourceSessionId: body.sourceSessionId, model: body.model, webSearch: body.webSearch, initialPrompt: body.initialPrompt, chatMode: body.chatMode === true });
      return json(res, 201, { terminal });
    }
    const id = parts[2];
    const action = parts[3];
    if (!id) return json(res, 404, { error: "not found" });
    if (!action && req.method === "GET") { const terminal = manager.getTerminal(id); return json(res, 200, { terminal: { ...terminal, chatInputOwned: chatOwnsInput(terminal) } }); }
    if (!action && req.method === "DELETE") return json(res, 200, { terminal: manager.removeTerminal(id) });
    if (!action && req.method === "PATCH") { const body = await readJson(req); return json(res, 200, { terminal: manager.renameTerminal(id, body.title) }); }
    if (action === "buffer" && req.method === "GET") {
      const result = manager.getBuffer(id);
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Cache-Control": "no-store", "X-Pi-Terminal-Truncated": result.truncated ? "1" : "0", "X-Pi-Terminal-State": result.state });
      return res.end(result.data);
    }
    if (action === "input" && req.method === "POST") { const body = await readJson(req); if (typeof body.data !== "string") throw Object.assign(new Error("data must be a string"), { code: "invalid_input" }); if (chatOwnsInput(manager.getTerminal(id))) throw Object.assign(new Error("Codex Chat currently owns input for this session"), { code: "chat_input_owned" }); manager.inputTerminal(id, body.data); res.writeHead(204); return res.end(); }
    if (action === "resize" && req.method === "POST") { const body = await readJson(req); manager.resizeTerminal(id, body.cols, body.rows); res.writeHead(204); return res.end(); }
    if (action === "stop" && req.method === "POST") return json(res, 200, { terminal: manager.stopTerminal(id) });
    return json(res, 405, { error: "method not allowed" });
  } catch (error) { return errorResponse(res, error); }
}

module.exports = { isTerminalPath, handleTerminalRequest, addRoot, registerCwd, authorizedCwd, claimCodexSession, chatOwnsInput };
