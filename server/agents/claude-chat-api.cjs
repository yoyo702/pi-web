/* eslint-disable @typescript-eslint/no-require-imports */
"use strict"; // Claude Chat HTTP bridge.

const crypto = require("node:crypto");
const chat = require("./claude-chat-runtime.cjs");
const catalog = require("./claude-sessions.cjs");
const terminals = require("./terminal-api.cjs");
const terminalManager = require("./terminal-manager.cjs");
const { readBody } = require("../http-body.cjs");

// Five images at the limit, plus the text.
const MAX_IMAGE_BASE64 = 5_000_000;
const MAX_BODY_BYTES = 26 * 1024 * 1024;
function isPath(pathname) { return pathname === "/api/claude/chat" || pathname === "/api/claude/chat/commands" || /^\/api\/claude\/chat\/[0-9a-f-]+(?:\/(?:events|send|interrupt|respond|claim|agents\/[\w-]+))?$/i.test(pathname); }
function requestError(message, code = "invalid_request") { return Object.assign(new Error(message), { code }); }
async function read(req) {
  let text;
  try { text = await readBody(req, MAX_BODY_BYTES); } catch { throw requestError("request body is too large"); }
  try { return text ? JSON.parse(text) : {}; } catch { throw requestError("invalid request body"); }
}
function send(res, status, body) { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(status === 204 ? undefined : JSON.stringify(body)); }
function requireCwd(cwd) {
  if (typeof cwd !== "string" || !cwd) throw requestError("cwd is required", "invalid_cwd");
  return terminals.authorizedCwd(cwd);
}
// The session exists in this folder, or a chat here just created it (Claude
// writes the file with the first message).
function sessionFor(id, cwd) {
  try { return catalog.requireSession(id, cwd); } catch (error) {
    const created = error?.code === "not_found" && chat.get(id);
    if (!created || created.cwd !== cwd) throw error;
    return { id, cwd, title: created.title, created: true };
  }
}
// Two Claude processes appending to one session file corrupt its history, so
// a chat never writes a session a terminal is resuming.
function assertNoTerminal(id) {
  if (chat.runtimeForSession(id)) return;
  const terminal = terminalManager.runtimeForSession(id);
  if (terminal) throw Object.assign(requestError("This session is open in a Claude terminal. Stop the terminal to continue here.", "terminal_owns_session"), { terminalId: terminal.terminalId });
}
// Images arrive as data URLs, as in Codex Chat.
function imageInputs(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 5) throw requestError("images must contain at most 5 items");
  return value.map((url) => {
    const match = typeof url === "string" ? /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(url) : null;
    if (!match) throw requestError("invalid image attachment");
    // The Anthropic API refuses larger images, and Claude would resend the
    // saved image with every later turn of the session.
    if (match[2].length > MAX_IMAGE_BASE64) throw requestError("An image is too large: the limit is 3.75 MB per image");
    return { mediaType: match[1], data: match[2] };
  });
}
function messageInput(body) {
  if (body.text != null && typeof body.text !== "string") throw requestError("text must be a string");
  const text = body.text ?? "";
  const images = imageInputs(body.images);
  if (!text.trim() && !images.length) throw requestError("A message is required");
  if (text.length > 200_000) throw requestError("The message is too long");
  return { text, images, uuid: body.uuid, model: typeof body.model === "string" ? body.model : "", permissionMode: typeof body.permissionMode === "string" ? body.permissionMode : "default" };
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// `{ sessionId, at }`: copy that session, dropping the prompt `at` and what
// follows it (everything is kept without `at`).
async function forkInput(fork, cwd) {
  if (!fork || typeof fork !== "object" || typeof fork.sessionId !== "string") throw requestError("fork.sessionId is required");
  if (fork.at != null && (typeof fork.at !== "string" || !UUID.test(fork.at))) throw requestError("fork.at must be a message id");
  catalog.requireSession(fork.sessionId, cwd);
  const resumeAt = fork.at ? await catalog.forkPoint(fork.sessionId, cwd, fork.at) : null;
  // A turn in progress would be copied half-finished.
  if (chat.isBusySession(fork.sessionId)) throw requestError("Claude is still working in that session. Fork it when the turn ends.", "session_busy");
  return { sessionId: fork.sessionId, resumeAt };
}
function afterSeq(req, url, state) {
  // Event ids are "<runtimeId>:<seq>"; a different runtime replays from the start.
  const [runtimeId, seq] = String(req.headers["last-event-id"] || url.searchParams.get("after") || "").split(":");
  const value = Number(seq);
  return runtimeId === state.runtimeId && Number.isSafeInteger(value) && value > 0 ? value : 0;
}
const STATUS = { invalid_request: 400, invalid_session: 400, invalid_cwd: 400, forbidden_cwd: 403, not_found: 404, session_busy: 409, terminal_owns_session: 409, approval_expired: 409, no_active_turn: 409, runtime_unavailable: 503, runtime_timeout: 503, rpc_error: 502 };
function sendError(res, cause) {
  const code = cause?.code;
  const status = STATUS[code] || 500;
  if (status >= 500) console.error("[pi-web] Claude chat request failed:", cause);
  const message = status < 500 || code === "rpc_error" ? cause.message : status === 503 ? "Claude is unavailable. Try again shortly." : "Claude chat request failed";
  return send(res, status, { error: message, code, ...(cause?.terminalId ? { terminalId: cause.terminalId } : {}) });
}

async function handle(req, res, url) {
  try {
    if (url.pathname === "/api/claude/chat") {
      // A new chat: the first message creates the session under a new id,
      // empty or (with `fork`) a copy of another session.
      if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
      const body = await read(req);
      const cwd = requireCwd(body.cwd);
      const input = messageInput(body);
      const fork = body.fork == null ? null : await forkInput(body.fork, cwd);
      const sessionId = crypto.randomUUID();
      await chat.send(chat.open(sessionId, cwd, { fork }), input);
      return send(res, 201, { sessionId });
    }
    if (url.pathname === "/api/claude/chat/commands") {
      if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
      return send(res, 200, { commands: await chat.commandsFor(requireCwd(url.searchParams.get("cwd"))) });
    }
    const [, , , , id, action, toolUseId] = url.pathname.split("/");
    if (req.method === "GET") {
      if (action && action !== "events" && action !== "agents") return send(res, 405, { error: "method not allowed" });
      const cwd = requireCwd(url.searchParams.get("cwd"));
      const session = sessionFor(id, cwd);
      // A sub-agent's saved steps, by the Agent tool call that started it.
      if (action === "agents") return send(res, 200, session.created ? { records: [], truncated: false } : catalog.agentTranscript(id, cwd, toolUseId));
      if (!action) {
        const before = url.searchParams.get("before");
        const history = session.created ? { records: [], cursor: null } : catalog.readHistory(id, cwd, { before });
        const state = chat.get(id);
        const terminal = terminalManager.runtimeForSession(id);
        return send(res, 200, {
          // `created`: Claude has not written the session yet (a fork's copied
          // history appears once it has).
          session: { id, title: session.title ?? null, ...(session.created ? { created: true } : {}) },
          history: history.records,
          cursor: history.cursor,
          // Older pages only need the transcript.
          ...(before ? {} : { events: state ? state.events : [], runtime: state ? chat.describe(state) : null, terminal: terminal ? { terminalId: terminal.terminalId } : null }),
        });
      }
      const state = chat.open(id, cwd, { title: session.title });
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ type: "pi/connected", sessionId: id, runtimeId: state.runtimeId })}\n\n`);
      const off = chat.subscribe(state, (event) => { res.write(`${event.piSeq ? `id: ${state.runtimeId}:${event.piSeq}\n` : ""}data: ${JSON.stringify(event)}\n\n`); }, afterSeq(req, url, state));
      req.on("close", off);
      return;
    }
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
    const body = await read(req);
    const cwd = requireCwd(body.cwd);
    const session = sessionFor(id, cwd);
    if (action === "claim") {
      // Stops the terminals resuming this session (Ctrl+C, then stop).
      await terminalManager.interruptAndStopTerminalsForSession(id);
      return send(res, 204, {});
    }
    if (action === "send") {
      const input = messageInput(body);
      assertNoTerminal(id);
      const state = chat.open(id, cwd, { title: session.title });
      return send(res, 202, await chat.send(state, input));
    }
    const state = chat.get(id);
    if (action === "interrupt") {
      if (!state) throw requestError("No active turn was found", "no_active_turn");
      return send(res, 200, { result: await chat.interrupt(state) });
    }
    if (action === "respond") {
      if (!state) throw requestError("Permission request is no longer pending", "approval_expired");
      if (typeof body.requestId !== "string") throw requestError("requestId is required");
      chat.respond(state, body.requestId, body);
      return send(res, 204, {});
    }
    return send(res, 405, { error: "method not allowed" });
  } catch (error) {
    return sendError(res, error);
  }
}

module.exports = { isPath, handle };
