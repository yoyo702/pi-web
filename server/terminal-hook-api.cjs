/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

// POST /api/terminal-hook — Claude Code hooks inside a TianForge terminal
// report its state here (server/terminal-hook.cjs). They have no login: the
// terminal's own token authorizes them. Accepting only this machine's
// addresses is defence in depth (a local reverse proxy looks local too).
const { readJsonBody } = require("./http-body.cjs");

function isPath(pathname) { return pathname === "/api/terminal-hook"; }
function send(res, status, body) { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); }

/** `isLocalAddress(name)` gets the peer address as a host name ("127.0.0.1", "[::1]"). */
async function handle(req, res, { isLocalAddress, manager = require("./agents/terminal-manager.cjs") }) {
  if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
  const remote = String(req.socket?.remoteAddress || "").toLowerCase().replace(/^::ffff:/, "");
  if (!isLocalAddress(remote.includes(":") ? `[${remote}]` : remote)) return send(res, 403, { error: "terminal hooks are accepted from this machine only" });
  let body;
  try { body = await readJsonBody(req, 16 * 1024); } catch (error) { return send(res, 400, { error: error.message }); }
  if (!manager.reportHookActivity(body && typeof body === "object" ? body : {})) return send(res, 404, { error: "unknown terminal" });
  res.writeHead(204, { "Cache-Control": "no-store" });
  res.end();
}

module.exports = { isPath, handle };
