/* eslint-disable @typescript-eslint/no-require-imports */
"use strict"; // Optional Codex session API.

const catalog = require("./codex-sessions.cjs");
const terminalApi = require("./terminal-api.cjs");
const terminalManager = require("./terminal-manager.cjs");
const codexAppServer = require("./codex-app-server.cjs");

function withRuntime(session) {
  return { ...session, runtime: codexAppServer.runtimeForSession(session.id) || terminalManager.runtimeForSession(session.id) };
}

function json(res, status, body) { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); }
function readJson(req) { return new Promise((resolve, reject) => { let text = ""; req.on("data", (chunk) => { text += chunk; if (text.length > 16 * 1024) reject(new Error("request too large")); }); req.on("end", () => { try { resolve(text ? JSON.parse(text) : {}); } catch { reject(new Error("invalid request body")); } }); req.on("error", reject); }); }
function safeSession(id, cwd) {
  const session = catalog.requireSession(id);
  if (!session.cwd) throw Object.assign(new Error("Codex session has no workspace metadata"), { code: "invalid_session" });
  const canonical = terminalApi.authorizedCwd(session.cwd);
  if (cwd && canonical !== terminalApi.authorizedCwd(cwd)) throw Object.assign(new Error("Codex session belongs to a different workspace"), { code: "forbidden_cwd" });
  return { ...session, cwd: canonical };
}
function isCodexSessionPath(pathname) { return pathname === "/api/codex/sessions" || /^\/api\/codex\/sessions\/[^/]+(?:\/(?:archive|unarchive|delete|rename))?$/.test(pathname); }
async function handleCodexSessionRequest(req, res, url) {
  try {
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.pathname === "/api/codex/sessions" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const canonical = cwd ? terminalApi.authorizedCwd(cwd) : undefined;
      const archived = url.searchParams.get("archived");
      return json(res, 200, { sessions: catalog.listSessions({ cwd: canonical, query: url.searchParams.get("q") || "", archived: archived === "true" ? true : archived === "false" ? false : undefined, limit: url.searchParams.get("limit") || 100 }).map(withRuntime) });
    }
    const id = parts[3];
    const action = parts[4];
    if (!id) return json(res, 404, { error: "not found" });
    if (!action && req.method === "GET") {
      safeSession(id, url.searchParams.get("cwd"));
      const preview = catalog.getSessionPreview(id);
      return json(res, 200, { ...preview, session: withRuntime(preview.session) });
    }
    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
    const body = await readJson(req);
    const session = safeSession(id, body.cwd);
    if (action === "archive") { catalog.archive(id); return json(res, 200, { session }); }
    if (action === "unarchive") { catalog.unarchive(id); return json(res, 200, { session }); }
    if (action === "delete") { catalog.remove(id); return json(res, 200, { session }); }
    if (action === "rename") return json(res, 200, { session: catalog.rename(id, body.name) });
    return json(res, 404, { error: "unknown action" });
  } catch (cause) {
    const code = cause?.code;
    const status = code === "not_found" ? 404 : code === "forbidden_cwd" ? 403 : code === "cli_missing" ? 503 : 400;
    return json(res, status, { error: cause?.message || "Codex session request failed", code });
  }
}
module.exports = { isCodexSessionPath, handleCodexSessionRequest };
