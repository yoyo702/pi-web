/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

// POST /api/notifications/read — marks activity notifications read for every browser.
const notifications = require("./notifications.cjs");
const { readBody } = require("./http-body.cjs");

function isPath(pathname) { return pathname === "/api/notifications/read"; }
function send(res, status, body) { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); }

async function handle(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
  let body;
  try { body = JSON.parse((await readBody(req, 64 * 1024)) || "{}"); } catch { return send(res, 400, { error: "invalid request body" }); }
  const all = body?.all === true;
  const ids = body?.ids;
  if (!all && (!Array.isArray(ids) || ids.length > 500 || !ids.every((id) => typeof id === "string"))) return send(res, 400, { error: "ids must be a list of notification ids, or all must be true" });
  return send(res, 200, { changed: notifications.markRead(all ? { all } : { ids }) });
}

module.exports = { isPath, handle };
