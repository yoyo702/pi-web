"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const templates = require("../task-templates.cjs");
const api = require("../task-templates-api.cjs");

// Each test gets its own templates file and workspace folders.
function useFile(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-templates-")));
  const previous = process.env.PI_WEB_TASK_TEMPLATES_FILE;
  process.env.PI_WEB_TASK_TEMPLATES_FILE = path.join(dir, "state", "task-templates.json");
  fs.mkdirSync(path.join(dir, "a"));
  fs.mkdirSync(path.join(dir, "b"));
  t.after(() => {
    if (previous === undefined) delete process.env.PI_WEB_TASK_TEMPLATES_FILE;
    else process.env.PI_WEB_TASK_TEMPLATES_FILE = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("templates are saved with their provider's options and listed for their workspace", (t) => {
  const dir = useFile(t);
  const review = templates.create({ name: "  Review changes ", provider: "claude", permissionMode: "plan", model: "opus", initialPrompt: " Review the diff ", webSearch: true, cwd: null });
  assert.deepEqual({ ...review, id: undefined, createdAt: undefined, updatedAt: undefined }, { id: undefined, name: "Review changes", provider: "claude", permissionMode: "plan", model: "opus", initialPrompt: "Review the diff", webSearch: false, cwd: null, createdAt: undefined, updatedAt: undefined });
  const release = templates.create({ name: "Release check", provider: "codex", permissionMode: "on-request", webSearch: true, cwd: path.join(dir, "a") });
  assert.equal(release.model, null);
  assert.equal(release.initialPrompt, null);
  assert.equal(release.webSearch, true);

  assert.deepEqual(templates.list().map((item) => item.name), ["Review changes"]);
  assert.deepEqual(templates.list(path.join(dir, "a")).map((item) => item.name), ["Release check", "Review changes"]);
  // The same folder through a different spelling still matches.
  assert.deepEqual(templates.list(path.join(dir, "b", "..", "a")).map((item) => item.name), ["Release check", "Review changes"]);
  assert.deepEqual(templates.list(path.join(dir, "b")).map((item) => item.name), ["Review changes"]);

  const file = process.env.PI_WEB_TASK_TEMPLATES_FILE;
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).templates.length, 2);

  const renamed = templates.update(release.id, { ...release, name: "Release", permissionMode: "never" });
  assert.equal(renamed.createdAt, release.createdAt);
  assert.equal(renamed.permissionMode, "never");
  templates.remove(review.id);
  assert.deepEqual(templates.list(path.join(dir, "a")).map((item) => item.name), ["Release"]);
  assert.throws(() => templates.remove(review.id), { code: "not_found" });
  assert.throws(() => templates.update(review.id, { name: "x", provider: "codex" }), { code: "not_found" });
});

test("templates are checked against their provider", (t) => {
  useFile(t);
  const valid = { name: "Task", provider: "codex" };
  assert.throws(() => templates.create({ ...valid, name: " " }), { code: "invalid_name" });
  assert.throws(() => templates.create({ ...valid, name: "x".repeat(81) }), { code: "invalid_name" });
  assert.throws(() => templates.create({ ...valid, provider: "shell" }), { code: "invalid_provider" });
  assert.throws(() => templates.create({ ...valid, permissionMode: "plan" }), { code: "invalid_permission_mode" });
  assert.throws(() => templates.create({ ...valid, provider: "claude", permissionMode: "never" }), { code: "invalid_permission_mode" });
  assert.throws(() => templates.create({ ...valid, model: "gpt 5" }), { code: "invalid_model" });
  assert.throws(() => templates.create({ ...valid, model: 5 }), { code: "invalid_model" });
  assert.throws(() => templates.create({ ...valid, initialPrompt: "x".repeat(8001) }), { code: "invalid_prompt" });
  assert.throws(() => templates.create({ ...valid, webSearch: "yes" }), { code: "invalid_web_search" });
  assert.throws(() => templates.create({ ...valid, cwd: "relative/path" }), { code: "invalid_cwd" });
  assert.throws(() => templates.create(null), { code: "invalid_template" });
  assert.equal(templates.create(valid).permissionMode, "confirm");
  assert.equal(templates.list().length, 1);
});

test("broken entries in the templates file are skipped", (t) => {
  useFile(t);
  const kept = templates.create({ name: "Kept", provider: "claude", permissionMode: "plan" });
  const file = process.env.PI_WEB_TASK_TEMPLATES_FILE;
  const broken = [{ ...kept, id: "no-date", createdAt: undefined }, { ...kept, id: "bad-mode", provider: "codex" }, { ...kept, id: "bad-cwd", cwd: 5 }, null];
  fs.writeFileSync(file, JSON.stringify({ version: 1, templates: [kept, ...broken] }));
  assert.deepEqual(templates.list().map((item) => item.id), [kept.id]);
});

test("at most 100 templates are kept", (t) => {
  useFile(t);
  for (let index = 0; index < templates.MAX_TEMPLATES; index += 1) templates.create({ name: `Task ${index}`, provider: "codex" });
  assert.throws(() => templates.create({ name: "One more", provider: "codex" }), { code: "too_many_templates" });
});

test("the templates API lists, creates, edits and deletes", async (t) => {
  const dir = useFile(t);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    void api.handle(req, res, url, { isSameOrigin: (request) => request.headers.origin !== "https://evil.example" }).catch((error) => { res.writeHead(500); res.end(error.message); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/task-templates`;
  const call = async (method, suffix = "", body, headers) => {
    const response = await fetch(base + suffix, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  };

  assert.equal(api.isPath("/api/task-templates"), true);
  assert.equal(api.isPath("/api/task-templates-other"), false);
  assert.deepEqual(await call("GET"), { status: 200, body: { templates: [] } });
  const created = await call("POST", "", { name: "Review", provider: "claude", permissionMode: "accept-edits", cwd: path.join(dir, "a") });
  assert.equal(created.status, 201);
  const { id } = created.body.template;
  assert.deepEqual((await call("GET", `?cwd=${encodeURIComponent(path.join(dir, "a"))}`)).body.templates.map((item) => item.id), [id]);
  assert.deepEqual((await call("GET")).body.templates, []);

  assert.deepEqual(await call("POST", "", { name: "Bad", provider: "claude", permissionMode: "never" }), { status: 400, body: { error: "Claude permissions must be one of confirm, plan, accept-edits, bypass", code: "invalid_permission_mode" } });
  assert.equal((await call("POST", "", "not json")).status, 400);
  const edited = await call("PUT", `/${id}`, { name: "Review all", provider: "claude", cwd: null });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.template.name, "Review all");
  assert.equal(edited.body.template.permissionMode, "confirm");
  assert.equal((await call("PUT", "/missing", { name: "x", provider: "codex" })).status, 404);
  assert.equal((await call("PATCH", `/${id}`, {})).status, 405);
  assert.equal((await call("DELETE")).status, 405);
  assert.equal((await call("GET", `/${id}/extra`)).status, 404);
  assert.equal((await call("DELETE", "/%E0")).status, 404);
  const evil = { Origin: "https://evil.example" };
  assert.equal((await call("POST", "", { name: "Evil", provider: "codex" }, evil)).status, 403);
  assert.equal((await call("DELETE", `/${id}`, undefined, evil)).status, 403);
  assert.equal((await call("GET", "", undefined, evil)).status, 200);
  assert.deepEqual(await call("DELETE", `/${id}`), { status: 204, body: null });
  assert.equal((await call("DELETE", `/${id}`)).status, 404);
});
