/* eslint-disable @typescript-eslint/no-require-imports */
"use strict"; // Optional Codex agent HTTP bridge.

const appServer = require("./codex-app-server.cjs");
const catalog = require("./codex-sessions.cjs");
const terminals = require("./terminal-api.cjs");
const terminalManager = require("./terminal-manager.cjs");
const { readBody } = require("../http-body.cjs");

const MAX_BODY_BYTES = 20 * 1024 * 1024;
function isPath(pathname) { return pathname === "/api/codex/models" || /^\/api\/codex\/chat\/[0-9a-f-]+(?:\/(?:events|approve|command|interrupt|fork|claim|steer))?$/i.test(pathname); }
function requestError(message, code = "invalid_request") { return Object.assign(new Error(message), { code }); }
async function read(req) {
  let text;
  try { text = await readBody(req, MAX_BODY_BYTES); } catch { throw requestError("request body is too large"); }
  try { return text ? JSON.parse(text) : {}; } catch { throw requestError("invalid request body"); }
}
function send(res, status, body) { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(status === 204 ? undefined : JSON.stringify(body)); }
function imageInputs(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 5) throw requestError("images must contain at most 5 items");
  return value.map((url) => {
    if (typeof url !== "string" || !/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(url)) throw requestError("invalid image attachment");
    if (url.length > 8 * 1024 * 1024) throw requestError("an image attachment is too large");
    return url;
  });
}
// Session file paths stay on the server.
function withoutPath(result) {
  if (!result?.thread) return result;
  const thread = { ...result.thread };
  delete thread.path;
  return { ...result, thread };
}
async function sessionFor(id) {
  const session = await catalog.requireSession(id);
  // Resuming would write to a rollout that archive has moved away (an open
  // chat tab keeps polling after its session is archived elsewhere).
  if (session.archived) throw requestError("This Codex session is archived. Restore it to continue.", "session_archived");
  return { ...session, cwd: terminals.authorizedCwd(session.cwd) };
}
// Reading (history, events, reconcile) never takes a session from a terminal.
function runtime(session, url) {
  if (!appServer.isClaimed(session.id) && terminalManager.runtimeForSession(session.id)) throw requestError("This session is running in a Codex terminal. Stop the terminal to continue here.", "terminal_owns_session");
  const model = url.searchParams.get("model");
  const serviceTier = url.searchParams.get("serviceTier");
  const approvalPolicy = url.searchParams.get("approvalPolicy");
  if (model && !/^[A-Za-z0-9._:/-]+$/.test(model)) throw requestError("invalid model");
  if (serviceTier && !/^[A-Za-z0-9._-]+$/.test(serviceTier)) throw requestError("invalid service tier");
  if (approvalPolicy && !["untrusted", "on-request", "never"].includes(approvalPolicy)) throw requestError("invalid approval policy");
  return appServer.start({ threadId: session.id, cwd: session.cwd, model: model || null, serviceTier: serviceTier || null, approvalPolicy: approvalPolicy || "untrusted" });
}
// Writes take the session. A terminal resuming it is stopped. A Codex terminal
// in the same folder whose session is unknown (`new`, `resume-last`, `fork`)
// may be writing it too: the user decides (`terminals: "stop" | "ignore"`).
async function claim(session, terminalsChoice) {
  if (terminalsChoice !== "stop" && terminalsChoice !== "ignore") {
    const unknown = terminalManager.unknownCodexTerminals(session.cwd);
    if (unknown.length) throw Object.assign(requestError("A Codex terminal is running in this folder and may be writing this session.", "terminal_conflict"), { terminals: unknown.map((terminal) => ({ id: terminal.id, title: terminal.title, launchMode: terminal.launchMode })) });
  }
  const stopped = await terminals.claimCodexSession(session.id, terminalsChoice === "stop" ? { cwd: session.cwd } : undefined);
  // A loaded runtime has not seen turns the terminal added; reload it.
  if (stopped && appServer.runtimeForSession(session.id)?.state === "idle") await appServer.stopAndWait(session.id);
}
function afterSeq(req, url, thread) {
  // Event ids are "<runtimeId>:<seq>"; a different runtime replays from the start.
  const [runtimeId, seq] = String(req.headers["last-event-id"] || url.searchParams.get("after") || "").split(":");
  const value = Number(seq);
  return runtimeId === thread.runtimeId && Number.isSafeInteger(value) && value > 0 ? value : 0;
}
const STATUS = { invalid_request: 400, invalid_session: 400, invalid_cwd: 400, forbidden_cwd: 403, not_found: 404, session_archived: 409, session_busy: 409, terminal_owns_session: 409, terminal_conflict: 409, writer_conflict: 409, approval_expired: 409, no_active_turn: 409, catalog_unavailable: 503, cli_missing: 503, runtime_unavailable: 503 };
// Codex's own error text is useful to show; anything else stays in the log.
const SHOWN_SERVER_ERRORS = new Set(["rpc_error", "runtime_timeout", "runtime_unavailable"]);
// Codex errors can name rollout files; session paths stay on the server.
function withoutPaths(message) { return String(message).replace(/(^|[\s"'(=:])(?:~|\/)[^\s"'`(),;:]*\/[^\s"'`(),;:]+/g, "$1<path>"); }
function sendError(res, cause) {
  const code = cause?.code;
  const status = STATUS[code] || 500;
  if (status >= 500) console.error("[pi-web] Codex chat request failed:", cause);
  const message = status < 500 ? cause.message : SHOWN_SERVER_ERRORS.has(code) ? withoutPaths(cause.message) : status === 503 ? "Codex app-server is unavailable. Try again shortly." : "Codex chat request failed";
  return send(res, status, { error: message, code, ...(cause?.terminals ? { terminals: cause.terminals } : {}) });
}
async function handle(req, res, url) {
  try {
    if (url.pathname === "/api/codex/models") {
      if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
      const cwd = terminals.authorizedCwd(url.searchParams.get("cwd"));
      return send(res, 200, { result: await appServer.listModels(cwd) });
    }
    const [, , , , id, action] = url.pathname.split("/");
    if (!id) return send(res, 404, { error: "not found" });
    const session = await sessionFor(id);
    if (req.method === "GET") {
      if (action && action !== "events") return send(res, 405, { error: "method not allowed" });
      const thread = runtime(session, url);
      if (!action) return send(res, 200, { thread: withoutPath(await appServer.readThread(thread)), history: (await catalog.getSessionPreview(id)).recentMessages, events: appServer.snapshot(thread) });
      // A runtime that cannot resume (e.g. writer_conflict) answers with a JSON
      // error; an opened stream would end and the browser would retry forever.
      await thread.ready;
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const off = appServer.subscribe(thread, (event) => {
        res.write(`${event.piSeq ? `id: ${thread.runtimeId}:${event.piSeq}\n` : ""}data: ${JSON.stringify(event)}\n\n`);
        // The runtime is gone; ending the stream makes the browser reconnect to a new one.
        if (event.method === "codex/closed") res.end();
      }, afterSeq(req, url, thread));
      req.on("close", off);
      res.write(`data: ${JSON.stringify({ method: "codex/connected", params: { threadId: id, runtimeId: thread.runtimeId } })}\n\n`);
      return;
    }
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
    const body = await read(req);
    if (action === "claim") { await claim(session, body.terminals === "stop" ? "stop" : "ignore"); return send(res, 204, {}); }
    if (action === "fork") return send(res, 200, { result: await appServer.fork(runtime(session, url)) });
    if (action === "command") {
      if (!["compact", "review", "models"].includes(body.name)) return send(res, 400, { error: "unsupported command", code: "invalid_request" });
      if (body.name !== "models") await claim(session, body.terminals);
      return send(res, 200, { result: await appServer.command(runtime(session, url), body.name) });
    }
    if (action === "interrupt") {
      await claim(session, "ignore");
      return send(res, 200, { result: await appServer.interrupt(runtime(session, url), body.recoverStaleApproval === true ? await catalog.latestTurnId(id) : null) });
    }
    if (action === "approve") {
      // The answer's shape depends on the request type; codex-requests validates it.
      if (typeof body.requestId !== "string") return send(res, 400, { error: "invalid approval", code: "invalid_request" });
      await claim(session, "ignore");
      appServer.respond(runtime(session, url), body.requestId, body);
      return send(res, 204, {});
    }
    if (!action || action === "steer") {
      const images = imageInputs(body.images);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (body.text != null && typeof body.text !== "string") throw requestError("text must be a string");
      if (!text && !images.length) throw requestError("text or an image is required");
      if (body.clientMessageId != null && (typeof body.clientMessageId !== "string" || !/^[A-Za-z0-9._:-]{1,120}$/.test(body.clientMessageId))) throw requestError("invalid client message id");
      if (action === "steer") {
        // Only a turn this chat is running can take more input; never start a runtime for it.
        if (!appServer.isClaimed(id)) throw requestError("No active turn to add this message to", "no_active_turn");
        await claim(session, "ignore");
        // The runtime may have closed while claiming; do not start a new one for it.
        if (!appServer.isClaimed(id)) throw requestError("No active turn to add this message to", "no_active_turn");
        return send(res, 202, { turn: await appServer.steer(runtime(session, url), text, images, body.clientMessageId || null) });
      }
      if (body.model != null && (typeof body.model !== "string" || !/^[A-Za-z0-9._:/-]+$/.test(body.model))) throw requestError("invalid model");
      if (body.effort != null && (typeof body.effort !== "string" || !["low", "medium", "high", "xhigh", "max", "ultra"].includes(body.effort))) throw requestError("invalid reasoning effort");
      if (body.serviceTier != null && (typeof body.serviceTier !== "string" || !/^[A-Za-z0-9._-]+$/.test(body.serviceTier))) throw requestError("invalid service tier");
      if (body.approvalPolicy != null && !["untrusted", "on-request", "never"].includes(body.approvalPolicy)) throw requestError("invalid approval policy");
      await claim(session, body.terminals);
      return send(res, 202, { turn: await appServer.prompt(runtime(session, url), text, body.model || null, body.approvalPolicy || null, images, body.clientMessageId || null, body.effort || null, body.serviceTier || null) });
    }
    return send(res, 405, { error: "method not allowed" });
  } catch (error) {
    return sendError(res, error);
  }
}

module.exports = { isPath, handle };
