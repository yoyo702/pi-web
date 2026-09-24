/* eslint-disable @typescript-eslint/no-require-imports */
"use strict"; // Optional Codex session API.

const catalog = require("./codex-sessions.cjs");
const terminalApi = require("./terminal-api.cjs");
const terminalManager = require("./terminal-manager.cjs");
const codexAppServer = require("./codex-app-server.cjs");
const { readBody } = require("../http-body.cjs");

// Session file paths stay on the server.
function withRuntime(session) {
  const result = { ...session, runtime: codexAppServer.runtimeForSession(session.id) || terminalManager.runtimeForSession(session.id) };
  delete result.path;
  return result;
}

const STATUS = { invalid_session: 400, invalid_name: 400, invalid_cwd: 400, invalid_body: 400, forbidden_cwd: 403, not_found: 404, already_archived: 409, not_archived: 409, session_busy: 409, catalog_unavailable: 503, cli_missing: 503 };
function json(res, status, body) { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); }
async function readJson(req) {
  let text;
  try { text = await readBody(req, 16 * 1024); } catch (cause) { throw Object.assign(cause, { code: "invalid_body" }); }
  try { return text ? JSON.parse(text) : {}; } catch { throw Object.assign(new Error("invalid request body"), { code: "invalid_body" }); }
}
async function safeSession(id, cwd) {
  const session = await catalog.requireSession(id);
  if (!session.cwd) throw Object.assign(new Error("Codex session has no workspace metadata"), { code: "invalid_session" });
  const canonical = terminalApi.authorizedCwd(session.cwd);
  if (cwd && canonical !== terminalApi.authorizedCwd(cwd)) throw Object.assign(new Error("Codex session belongs to a different workspace"), { code: "forbidden_cwd" });
  return { ...session, cwd: canonical };
}
// Archiving or deleting moves the session file away from a writer that still
// has it open. Refuse while a chat turn or a resumed terminal is active; an
// idle chat runtime is shut down first.
function assertNotBusy(id) {
  const chat = codexAppServer.runtimeForSession(id);
  if ((chat && chat.state !== "idle") || terminalManager.runtimeForSession(id)) {
    throw Object.assign(new Error("This Codex session is running. Stop the chat turn or terminal first."), { code: "session_busy" });
  }
  return chat;
}
async function releaseForRemoval(id) {
  if (!assertNotBusy(id)) return;
  await codexAppServer.stopAndWait(id);
  // A terminal may have started before the removal lock was taken.
  assertNotBusy(id);
}
function isCodexSessionPath(pathname) { return pathname === "/api/codex/runtime" || pathname === "/api/codex/sessions" || /^\/api\/codex\/sessions\/[^/]+(?:\/(?:archive|unarchive|delete|rename))?$/.test(pathname); }
async function handleCodexSessionRequest(req, res, url) {
  try {
    if (url.pathname === "/api/codex/runtime" && req.method === "GET") {
      return json(res, 200, { runtimes: codexAppServer.listRuntimes() });
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.pathname === "/api/codex/sessions" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const canonical = cwd ? terminalApi.authorizedCwd(cwd) : undefined;
      const { sessions, nextCursor } = await catalog.listSessions({
        cwd: canonical,
        query: url.searchParams.get("q") || "",
        archived: url.searchParams.get("archived") === "true",
        cursor: url.searchParams.get("cursor") || undefined,
        limit: url.searchParams.get("limit") || 50,
      });
      return json(res, 200, { sessions: sessions.map(withRuntime), nextCursor });
    }
    const id = parts[3];
    const action = parts[4];
    if (!id) return json(res, 404, { error: "not found" });
    if (!action && req.method === "GET") {
      await safeSession(id, url.searchParams.get("cwd"));
      const preview = await catalog.getSessionPreview(id);
      return json(res, 200, { ...preview, session: withRuntime(preview.session) });
    }
    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
    const body = await readJson(req);
    const session = await safeSession(id, body.cwd);
    if (action === "archive") {
      if (session.archived) throw Object.assign(new Error("Codex session is already archived"), { code: "already_archived" });
      // The lock keeps chats and resume terminals from starting until the move is done.
      const archived = await codexAppServer.withRemovalLock(id, async () => { await releaseForRemoval(id); return catalog.archive(id); });
      return json(res, 200, { session: withRuntime(archived) });
    }
    if (action === "unarchive") return json(res, 200, { session: withRuntime(await catalog.unarchive(id)) });
    if (action === "delete") {
      const removed = await codexAppServer.withRemovalLock(id, async () => { await releaseForRemoval(id); return catalog.remove(id); });
      return json(res, 200, { session: withRuntime(removed) });
    }
    if (action === "rename") return json(res, 200, { session: withRuntime(await catalog.rename(id, body.name)) });
    return json(res, 404, { error: "unknown action" });
  } catch (cause) {
    const code = cause?.code;
    const status = STATUS[code] || 500;
    if (status >= 500) console.error("[pi-web] Codex session request failed:", cause);
    // Internal details (stderr, stack context) stay in the server log.
    const message = status === 500 ? "Codex session request failed" : status === 503 ? "Codex app-server is unavailable. Try again shortly." : cause?.message;
    return json(res, status, { error: message, code });
  }
}
module.exports = { isCodexSessionPath, handleCodexSessionRequest };
