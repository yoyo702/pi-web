/* eslint-disable @typescript-eslint/no-require-imports */
"use strict"; // Optional Codex agent HTTP bridge.

const appServer = require("./codex-app-server.cjs");
const catalog = require("./codex-sessions.cjs");
const terminals = require("./terminal-api.cjs");

const MAX_BODY_BYTES = 20 * 1024 * 1024;
function isPath(pathname) { return pathname === "/api/codex/models" || /^\/api\/codex\/chat\/[0-9a-f-]+(?:\/(?:events|approve|command|interrupt|fork))?$/i.test(pathname); }
function read(req) {
  return new Promise((resolve, reject) => {
    let text = "";
    req.on("data", (chunk) => { text += chunk; if (text.length > MAX_BODY_BYTES) reject(new Error("request body is too large")); });
    req.on("end", () => { try { resolve(JSON.parse(text || "{}")); } catch { reject(new Error("invalid request body")); } });
    req.on("error", reject);
  });
}
function send(res, status, body) { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(status === 204 ? undefined : JSON.stringify(body)); }
function imageInputs(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 5) throw new Error("images must contain at most 5 items");
  return value.map((url) => {
    if (typeof url !== "string" || !/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(url)) throw new Error("invalid image attachment");
    if (url.length > 8 * 1024 * 1024) throw new Error("an image attachment is too large");
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
async function state(id, url) {
  const session = await catalog.requireSession(id);
  // Resuming would write to a rollout that archive has moved away (an open
  // chat tab keeps polling after its session is archived elsewhere).
  if (session.archived) throw new Error("This Codex session is archived. Restore it to continue.");
  await terminals.claimCodexSession(id);
  const model = url.searchParams.get("model");
  const serviceTier = url.searchParams.get("serviceTier");
  const approvalPolicy = url.searchParams.get("approvalPolicy");
  if (model && !/^[A-Za-z0-9._:/-]+$/.test(model)) throw new Error("invalid model");
  if (serviceTier && !/^[A-Za-z0-9._-]+$/.test(serviceTier)) throw new Error("invalid service tier");
  if (approvalPolicy && !["untrusted", "on-request", "never"].includes(approvalPolicy)) throw new Error("invalid approval policy");
  return appServer.start({ threadId: id, cwd: terminals.authorizedCwd(session.cwd), model: model || null, serviceTier: serviceTier || null, approvalPolicy: approvalPolicy || "untrusted" });
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
    const thread = await state(id, url);
    if (!action && req.method === "GET") return send(res, 200, { thread: withoutPath(await appServer.readThread(thread)), history: (await catalog.getSessionPreview(id)).recentMessages, events: appServer.snapshot(thread) });
    if (action === "events" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const requestedSeq = Number(req.headers["last-event-id"] || url.searchParams.get("after") || 0);
      const afterSeq = Number.isSafeInteger(requestedSeq) && requestedSeq > 0 ? requestedSeq : 0;
      const off = appServer.subscribe(thread, (event) => res.write(`id: ${event.piSeq || 0}\ndata: ${JSON.stringify(event)}\n\n`), afterSeq);
      req.on("close", off);
      res.write(`data: ${JSON.stringify({ method: "codex/connected", params: { threadId: id } })}\n\n`);
      return;
    }
    const body = await read(req);
    if (action === "fork" && req.method === "POST") return send(res, 200, { result: await appServer.fork(thread) });
    if (action === "command" && req.method === "POST") {
      if (!["compact", "review", "models"].includes(body.name)) return send(res, 400, { error: "unsupported command" });
      return send(res, 200, { result: await appServer.command(thread, body.name) });
    }
    if (action === "interrupt" && req.method === "POST") return send(res, 200, { result: await appServer.interrupt(thread, body.recoverStaleApproval === true ? await catalog.latestTurnId(id) : null) });
    if (action === "approve" && req.method === "POST") {
      if (typeof body.requestId !== "string" || !["accept", "acceptForSession", "decline"].includes(body.decision)) return send(res, 400, { error: "invalid approval" });
      appServer.respond(thread, body.requestId, { decision: body.decision });
      return send(res, 204, {});
    }
    if (!action && req.method === "POST") {
      const images = imageInputs(body.images);
      if ((typeof body.text !== "string" || !body.text.trim()) && !images.length) return send(res, 400, { error: "text or an image is required" });
      if (body.model != null && (typeof body.model !== "string" || !/^[A-Za-z0-9._:/-]+$/.test(body.model))) return send(res, 400, { error: "invalid model" });
      if (body.effort != null && (typeof body.effort !== "string" || !["low", "medium", "high", "xhigh", "max", "ultra"].includes(body.effort))) return send(res, 400, { error: "invalid reasoning effort" });
      if (body.serviceTier != null && (typeof body.serviceTier !== "string" || !/^[A-Za-z0-9._-]+$/.test(body.serviceTier))) return send(res, 400, { error: "invalid service tier" });
      if (body.clientMessageId != null && (typeof body.clientMessageId !== "string" || !/^[A-Za-z0-9._:-]{1,120}$/.test(body.clientMessageId))) return send(res, 400, { error: "invalid client message id" });
      if (body.approvalPolicy != null && !["untrusted", "on-request", "never"].includes(body.approvalPolicy)) return send(res, 400, { error: "invalid approval policy" });
      return send(res, 202, { turn: await appServer.prompt(thread, body.text.trim(), body.model || null, body.approvalPolicy || null, images, body.clientMessageId || null, body.effort || null, body.serviceTier || null) });
    }
    return send(res, 405, { error: "method not allowed" });
  } catch (error) {
    return send(res, 400, { error: error.message || "Codex chat failed" });
  }
}

module.exports = { isPath, handle };
