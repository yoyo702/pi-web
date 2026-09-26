/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

// /api/task-templates — list, create, edit and delete task templates (task-templates.cjs).
const templates = require("./task-templates.cjs");
const { readJsonBody } = require("./http-body.cjs");

const STATUS = { not_found: 404, too_many_templates: 409 };

function isPath(pathname) { return pathname === "/api/task-templates" || pathname.startsWith("/api/task-templates/"); }
function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(status === 204 ? undefined : JSON.stringify(body));
}

/**
 * `isSameOrigin(req)` comes from auth.cjs. Changes are refused from other sites
 * even without a password: a template's prompt runs when someone clicks Run.
 */
async function handle(req, res, url, { isSameOrigin }) {
  const raw = url.pathname.slice("/api/task-templates".length).replace(/^\//, "");
  let id;
  try { id = decodeURIComponent(raw); } catch { id = null; }
  if (id === null || raw.includes("/")) return send(res, 404, { error: "not found" });
  if (!(id ? ["PUT", "DELETE"] : ["GET", "POST"]).includes(req.method)) return send(res, 405, { error: "method not allowed" });
  if (req.method !== "GET" && !isSameOrigin(req)) return send(res, 403, { error: "cross-origin request rejected" });
  try {
    if (req.method === "GET") return send(res, 200, { templates: templates.list(url.searchParams.get("cwd") || undefined) });
    if (req.method === "DELETE") { templates.remove(id); return send(res, 204); }
    let body;
    try { body = await readJsonBody(req, 64 * 1024); } catch (error) { return send(res, 400, { error: error.message }); }
    if (req.method === "POST") return send(res, 201, { template: templates.create(body) });
    return send(res, 200, { template: templates.update(id, body) });
  } catch (error) {
    if (error instanceof templates.TemplateError) return send(res, STATUS[error.code] ?? 400, { error: error.message, code: error.code });
    throw error;
  }
}

module.exports = { isPath, handle };
