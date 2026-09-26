/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

/**
 * Task templates: saved Claude/Codex terminal launches (provider, permissions,
 * model, first prompt) that the Agents panel starts with one click. Shared by
 * every browser through `~/.pi-web/task-templates.json`. The file is read on
 * each call, so the Next route handlers and the custom server never disagree.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_TEMPLATES = 100;
const PERMISSION_MODES = {
  codex: ["confirm", "on-request", "never", "bypass"],
  claude: ["confirm", "plan", "accept-edits", "bypass"],
};

class TemplateError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function file() {
  return process.env.PI_WEB_TASK_TEMPLATES_FILE || path.join(os.homedir(), ".pi-web", "task-templates.json");
}

function canonical(folder) {
  try { return fs.realpathSync(folder); } catch { return path.resolve(folder); }
}

// Hand-edited entries that would break listing or running are skipped.
function isTemplate(value) {
  return value && typeof value === "object" && typeof value.id === "string" && typeof value.name === "string" && typeof value.createdAt === "string"
    && Object.hasOwn(PERMISSION_MODES, value.provider) && PERMISSION_MODES[value.provider].includes(value.permissionMode)
    && (value.cwd === null || typeof value.cwd === "string");
}

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(file(), "utf8"));
    return Array.isArray(parsed?.templates) ? parsed.templates.filter(isTemplate) : [];
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn(`[pi-web] Ignoring unreadable task templates file: ${error.message}`);
    return [];
  }
}

function save(templates) {
  const target = file();
  const temp = `${target}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  // `mode` only applies to a new file, so drop a temp file left by a crash.
  fs.rmSync(temp, { force: true });
  fs.writeFileSync(temp, JSON.stringify({ version: 1, templates }), { mode: 0o600 });
  fs.renameSync(temp, target);
}

/** Checks a template from the browser and returns its stored fields. */
function normalize(input) {
  if (!input || typeof input !== "object") throw new TemplateError("invalid_template", "Template must be an object");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 80) throw new TemplateError("invalid_name", "Name must be 1–80 characters");
  const provider = input.provider;
  if (!Object.hasOwn(PERMISSION_MODES, provider)) throw new TemplateError("invalid_provider", "Provider must be codex or claude");
  const permissionMode = input.permissionMode ?? "confirm";
  if (!PERMISSION_MODES[provider].includes(permissionMode)) throw new TemplateError("invalid_permission_mode", `${provider === "codex" ? "Codex" : "Claude"} permissions must be one of ${PERMISSION_MODES[provider].join(", ")}`);
  const model = typeof input.model === "string" && input.model.trim() ? input.model.trim() : null;
  if (input.model != null && typeof input.model !== "string") throw new TemplateError("invalid_model", "Model must be a string");
  if (model && (model.length > 120 || !/^[A-Za-z0-9._:/-]+$/.test(model))) throw new TemplateError("invalid_model", "Model name contains unsupported characters");
  if (input.initialPrompt != null && typeof input.initialPrompt !== "string") throw new TemplateError("invalid_prompt", "Initial prompt must be a string");
  const initialPrompt = typeof input.initialPrompt === "string" && input.initialPrompt.trim() ? input.initialPrompt.trim() : null;
  if (initialPrompt && initialPrompt.length > 8_000) throw new TemplateError("invalid_prompt", "Initial prompt must be at most 8000 characters");
  if (input.webSearch != null && typeof input.webSearch !== "boolean") throw new TemplateError("invalid_web_search", "webSearch must be a boolean");
  if (input.cwd != null && (typeof input.cwd !== "string" || !path.isAbsolute(input.cwd))) throw new TemplateError("invalid_cwd", "cwd must be an absolute path or null");
  return { name, provider, permissionMode, model, initialPrompt, webSearch: provider === "codex" && input.webSearch === true, cwd: input.cwd ? canonical(input.cwd) : null };
}

/** Templates for every workspace, plus those saved for `cwd` when given; by name. */
function list(cwd) {
  const folder = typeof cwd === "string" && cwd ? canonical(cwd) : null;
  return load()
    .filter((template) => !template.cwd || template.cwd === folder)
    .sort((a, b) => a.name.localeCompare(b.name) || a.createdAt.localeCompare(b.createdAt));
}

function create(input) {
  const templates = load();
  if (templates.length >= MAX_TEMPLATES) throw new TemplateError("too_many_templates", `At most ${MAX_TEMPLATES} templates can be saved`);
  const now = new Date().toISOString();
  const template = { id: crypto.randomUUID(), ...normalize(input), createdAt: now, updatedAt: now };
  save([...templates, template]);
  return template;
}

function update(id, input) {
  const templates = load();
  const index = templates.findIndex((template) => template.id === id);
  if (index < 0) throw new TemplateError("not_found", "Template not found");
  const template = { ...templates[index], ...normalize(input), updatedAt: new Date().toISOString() };
  templates[index] = template;
  save(templates);
  return template;
}

function remove(id) {
  const templates = load();
  const next = templates.filter((template) => template.id !== id);
  if (next.length === templates.length) throw new TemplateError("not_found", "Template not found");
  save(next);
}

module.exports = { TemplateError, PERMISSION_MODES, MAX_TEMPLATES, normalize, list, create, update, remove };
