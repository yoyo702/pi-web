/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

// Web Push for this device:
//   POST /api/push              { endpoint? } → { publicKey, subscribed, events }
//   POST /api/push/subscribe    { subscription, events? } (PushSubscription.toJSON())
//   POST /api/push/events       { endpoint, events }  (404 for an unknown device)
//   POST /api/push/unsubscribe  { endpoint }
// `events` lists what the device hears: approval, failed, completed.
// The status is a POST so the endpoint (a capability URL) stays out of logs.
// pi-web-server.js rejects cross-origin requests even without a password;
// requiring JSON also rules out form posts from other sites.
const push = require("./web-push.cjs");
const { readBody } = require("./http-body.cjs");

const PATHS = new Set(["/api/push", "/api/push/subscribe", "/api/push/events", "/api/push/unsubscribe"]);
function isPath(pathname) { return PATHS.has(pathname); }
function send(res, status, body) { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(status === 204 ? undefined : JSON.stringify(body)); }

async function handle(req, res, url) {
  if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
  if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) return send(res, 415, { error: "expected application/json" });
  let body;
  try { body = JSON.parse((await readBody(req, 16 * 1024)) || "{}"); } catch { return send(res, 400, { error: "invalid request body" }); }
  try {
    if (url.pathname === "/api/push") {
      const events = typeof body?.endpoint === "string" ? push.eventsFor(body.endpoint) : null;
      return send(res, 200, { publicKey: push.publicKey(), subscribed: events !== null, events: events ?? push.EVENTS });
    }
    if (url.pathname === "/api/push/subscribe") {
      push.subscribe(body?.subscription, { userAgent: req.headers["user-agent"], events: body?.events });
      return send(res, 204, {});
    }
    if (typeof body?.endpoint !== "string") return send(res, 400, { error: "endpoint is required" });
    if (url.pathname === "/api/push/events") return push.setEvents(body.endpoint, body.events) ? send(res, 204, {}) : send(res, 404, { error: "this device is not subscribed" });
    push.unsubscribe(body.endpoint);
    return send(res, 204, {});
  } catch (error) {
    if (error?.code === "invalid_request") return send(res, 400, { error: error.message });
    console.error("[pi-web] Push request failed:", error);
    return send(res, 500, { error: "Push request failed" });
  }
}

module.exports = { isPath, handle };
