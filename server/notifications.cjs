/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

/**
 * Activity notifications (a Codex/Pi turn finished or failed, Codex waits for
 * approval, a terminal ended), shared by every browser. Entries and their read
 * state are kept in `~/.pi-web/notifications.json` so a phone and a PC see the
 * same list, and the list survives restarts. Next route handlers and the
 * custom server can load separate copies of this module, so state lives on
 * `global`. Changes are pushed as `notifications` snapshots on the status SSE.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const workspaceStatus = require("./workspace-status.cjs");

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 200;
const KINDS = new Set(["codex", "pi", "terminal"]);
const EVENTS = new Set(["completed", "failed", "approval"]);

function file() {
  return process.env.PI_WEB_NOTIFICATIONS_FILE || path.join(os.homedir(), ".pi-web", "notifications.json");
}

const state = global.__piWebNotifications || { entries: null };
global.__piWebNotifications = state;

function isEntry(value) {
  return value && typeof value === "object" && typeof value.id === "string" && KINDS.has(value.kind) && EVENTS.has(value.event)
    && typeof value.targetId === "string" && typeof value.createdAt === "number";
}

function load() {
  if (state.entries) return state.entries;
  try {
    const parsed = JSON.parse(fs.readFileSync(file(), "utf8"));
    state.entries = Array.isArray(parsed?.notifications) ? parsed.notifications.filter(isEntry) : [];
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn(`[pi-web] Ignoring unreadable notifications file: ${error.message}`);
    state.entries = [];
  }
  return state.entries;
}

function save() {
  const target = file();
  const temp = `${target}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify({ version: 1, notifications: state.entries }), { mode: 0o600 });
    fs.renameSync(temp, target);
  } catch (error) {
    // The list still works in memory; it just will not survive a restart.
    console.warn(`[pi-web] Unable to save notifications: ${error.message}`);
  }
}

/** Drops entries older than 7 days and keeps the newest 200. Entries are stored oldest first. */
function prune(now = Date.now()) {
  const entries = load();
  const kept = entries.filter((entry) => now - entry.createdAt < MAX_AGE_MS).slice(-MAX_ENTRIES);
  if (kept.length === entries.length) return false;
  state.entries = kept;
  return true;
}

function text(value, max) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/**
 * Records one event. Older unread entries for the same target are marked read:
 * only the latest state of a chat, session or terminal needs attention.
 */
function add({ kind, event, targetId, cwd, projectRoot, title, detail, path: targetPath }) {
  if (!KINDS.has(kind) || !EVENTS.has(event) || typeof targetId !== "string" || !targetId) return null;
  const entries = load();
  for (const entry of entries) if (!entry.read && entry.kind === kind && entry.targetId === targetId) entry.read = true;
  const entry = {
    id: crypto.randomUUID(),
    kind,
    event,
    targetId,
    cwd: typeof cwd === "string" ? cwd : "",
    // Set when it differs from cwd (a Pi session in a worktree).
    ...(typeof projectRoot === "string" && projectRoot && projectRoot !== cwd ? { projectRoot } : {}),
    title: text(title, 120) || targetId,
    // A Pi session file, so the browser can open the session.
    ...(typeof targetPath === "string" && targetPath ? { path: targetPath } : {}),
    ...(text(detail, 300) ? { detail: text(detail, 300) } : {}),
    createdAt: Date.now(),
    read: false,
  };
  entries.push(entry);
  prune();
  save();
  workspaceStatus.notify("notifications");
  return entry;
}

/** Marks `ids` (or every entry with `all`) read; returns how many changed. */
function markRead({ ids, all = false } = {}) {
  const wanted = new Set(Array.isArray(ids) ? ids : []);
  let changed = 0;
  for (const entry of load()) {
    if (entry.read || (!all && !wanted.has(entry.id))) continue;
    entry.read = true;
    changed += 1;
  }
  if (changed) {
    save();
    workspaceStatus.notify("notifications");
  }
  return changed;
}

/** Newest first. */
function list() {
  if (prune()) save();
  return [...load()].reverse();
}

function snapshot() {
  const notifications = list();
  return { notifications, unread: notifications.filter((entry) => !entry.read).length };
}
workspaceStatus.registerProvider("notifications", snapshot);

function _resetForTests() {
  state.entries = null;
  workspaceStatus.registerProvider("notifications", snapshot);
}

module.exports = { add, markRead, list, MAX_AGE_MS, MAX_ENTRIES, _resetForTests };
