/* eslint-disable @typescript-eslint/no-require-imports */
"use strict"; // Optional Claude Code session API.

const catalog = require("./claude-sessions.cjs");
const terminalApi = require("./terminal-api.cjs");
const terminalManager = require("./terminal-manager.cjs");
const claudeChat = require("./claude-chat-runtime.cjs");
const { readBody } = require("../http-body.cjs");

// Session file paths stay on the server. The runtime is the terminal resuming
// the session or the Claude Chat process writing it.
function runtimeFor(id) { return terminalManager.runtimeForSession(id) ?? claudeChat.runtimeForSession(id); }
function withRuntime(session) {
  const result = { ...session, runtime: runtimeFor(session.id) };
  delete result.path;
  return result;
}

const STATUS = { invalid_session: 400, invalid_cwd: 400, invalid_body: 400, forbidden_cwd: 403, not_found: 404, session_busy: 409 };
function json(res, status, body) { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); }
async function readJson(req) {
  let text;
  try { text = await readBody(req, 16 * 1024); } catch (cause) { throw Object.assign(cause, { code: "invalid_body" }); }
  try { return text ? JSON.parse(text) : {}; } catch { throw Object.assign(new Error("invalid request body"), { code: "invalid_body" }); }
}
function requireCwd(cwd) {
  if (typeof cwd !== "string" || !cwd) throw Object.assign(new Error("cwd is required"), { code: "invalid_cwd" });
  return terminalApi.authorizedCwd(cwd);
}
// Deleting a file a Claude process still writes would leave it recreating a
// broken session. A `resume` terminal writes its source session. Any Claude
// terminal can also write sessions pi-web does not know: a `new` or `fork`
// terminal's own, or one reached with /clear or /resume inside it. So any
// session in its folder that changed after it started counts as possibly in use.
function assertNotBusy(session, cwd) {
  if (terminalManager.runtimeForSession(session.id)) {
    throw Object.assign(new Error("This Claude session is open in a terminal. Stop the terminal first."), { code: "session_busy" });
  }
  if (claudeChat.runtimeForSession(session.id) || claudeChat.isBusySession(session.id)) {
    throw Object.assign(new Error("This Claude session is open in Claude Chat. Close the chat first."), { code: "session_busy" });
  }
  const writer = terminalManager.listTerminals(cwd).find((terminal) => terminal.provider === "claude" && terminal.state === "running" && terminal.createdAt <= session.updatedAt);
  if (writer) throw Object.assign(new Error("A running Claude terminal in this workspace may be writing this session. Stop it first."), { code: "session_busy" });
}

function isPath(pathname) { return pathname === "/api/claude/sessions" || /^\/api\/claude\/sessions\/[^/]+\/delete$/.test(pathname); }
async function handle(req, res, url) {
  try {
    if (url.pathname === "/api/claude/sessions") {
      if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
      const { sessions, nextCursor } = catalog.listSessions({
        cwd: requireCwd(url.searchParams.get("cwd")),
        query: url.searchParams.get("q") || "",
        cursor: url.searchParams.get("cursor") || undefined,
        limit: url.searchParams.get("limit") || 50,
      });
      return json(res, 200, { sessions: sessions.map(withRuntime), nextCursor });
    }
    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
    const id = url.pathname.split("/")[4];
    const body = await readJson(req);
    const cwd = requireCwd(body.cwd);
    // Checked and removed in one synchronous step, so no terminal can start
    // on this session in between.
    const session = catalog.requireSession(id, cwd);
    assertNotBusy(session, cwd);
    return json(res, 200, { session: withRuntime(catalog.remove(id, cwd)) });
  } catch (cause) {
    const code = cause?.code;
    const status = STATUS[code] || 500;
    if (status >= 500) console.error("[pi-web] Claude session request failed:", cause);
    return json(res, status, { error: status === 500 ? "Claude session request failed" : cause?.message, code });
  }
}
module.exports = { isPath, handle };
