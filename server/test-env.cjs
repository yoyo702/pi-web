/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";
// Preloaded by `npm test`: code under test that records notifications must
// never write the user's ~/.pi-web/notifications.json, push.json or task-templates.json, and the Claude session
// catalog must never read or delete the user's ~/.claude sessions.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// `node --test` runs each file in a child that inherits this environment and
// preloads this file again; each process gets its own files so parallel test
// files do not see each other's notifications.
const inherited = process.env.PI_WEB_TEST_ENV_PID && process.env.PI_WEB_TEST_ENV_PID !== String(process.pid);
if (inherited) { delete process.env.PI_WEB_NOTIFICATIONS_FILE; delete process.env.PI_WEB_PUSH_FILE; delete process.env.PI_WEB_TASK_TEMPLATES_FILE; delete process.env.CLAUDE_CONFIG_DIR; }
process.env.PI_WEB_TEST_ENV_PID = String(process.pid);

if (!process.env.PI_WEB_NOTIFICATIONS_FILE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-test-notifications-"));
  process.env.PI_WEB_NOTIFICATIONS_FILE = path.join(dir, "notifications.json");
  process.once("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
}

// Push subscriptions and the VAPID key: tests never send to the user's devices.
if (!process.env.PI_WEB_PUSH_FILE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-test-push-"));
  process.env.PI_WEB_PUSH_FILE = path.join(dir, "push.json");
  process.once("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
}

if (!process.env.PI_WEB_TASK_TEMPLATES_FILE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-test-templates-"));
  process.env.PI_WEB_TASK_TEMPLATES_FILE = path.join(dir, "task-templates.json");
  process.once("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
}

if (!process.env.CLAUDE_CONFIG_DIR) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-test-claude-"));
  process.env.CLAUDE_CONFIG_DIR = dir;
  process.once("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
}
