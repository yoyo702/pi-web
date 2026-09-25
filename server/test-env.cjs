/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";
// Preloaded by `npm test`: code under test that records notifications must
// never write the user's ~/.pi-web/notifications.json, and the Claude session
// catalog must never read or delete the user's ~/.claude sessions.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

if (!process.env.PI_WEB_NOTIFICATIONS_FILE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-test-notifications-"));
  process.env.PI_WEB_NOTIFICATIONS_FILE = path.join(dir, "notifications.json");
  process.once("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
}

if (!process.env.CLAUDE_CONFIG_DIR) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-test-claude-"));
  process.env.CLAUDE_CONFIG_DIR = dir;
  process.once("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
}
