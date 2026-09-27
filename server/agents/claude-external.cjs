/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { claudeHome } = require("./claude-sessions.cjs");

// Claude processes outside pi-web (a `claude` in a terminal on this
// computer) that have a session open. Each Claude registers itself in
// <claude home>/sessions/<pid>.json with its session id; a file outlives a
// crashed process, and its pid can be reused, so an entry counts only while
// that pid runs with the same start time. Two processes on one session each
// keep their own context and interleave the session file, so a chat does not
// write a session one of them has open.

const SESSION_ID = /^[0-9a-f-]{36}$/i;

// Claude records `procStart` as ps prints it in UTC.
function processTable() {
  return new Promise((resolve) => {
    execFile("ps", ["-axo", "pid=,ppid=,lstart="], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }, (error, stdout) => {
      const table = new Map();
      if (!error) for (const line of stdout.split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
        if (match) table.set(Number(match[1]), { ppid: Number(match[2]), started: match[3].replace(/\s+/g, " ") });
      }
      resolve(error ? null : table);
    });
  });
}
// pi-web's own Claude chats and terminals are its descendants.
function descendsFrom(table, pid, ancestor) {
  for (let current = pid, hops = 0; current > 1 && hops < 64; hops++) {
    if (current === ancestor) return true;
    current = table.get(current)?.ppid ?? 0;
  }
  return false;
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

/** `{ pid, name, status, entrypoint }[]`: the outside Claude processes with `sessionId` open. */
async function processesForSession(sessionId, { self = process.pid } = {}) {
  if (!SESSION_ID.test(sessionId)) return [];
  const directory = path.join(claudeHome(), "sessions");
  let names;
  try { names = await fs.promises.readdir(directory); } catch { return []; }
  const read = (name) => fs.promises.readFile(path.join(directory, name), "utf8").then(JSON.parse).catch(() => null);
  const entries = (await Promise.all(names.filter((name) => /^\d+\.json$/.test(name)).map(read)))
    .filter((entry) => entry?.sessionId === sessionId && Number.isInteger(entry.pid) && entry.pid > 1 && entry.pid !== self && alive(entry.pid));
  if (!entries.length) return [];
  const table = await processTable();
  return entries
    .filter((entry) => !table || (!descendsFrom(table, entry.pid, self) && (typeof entry.procStart !== "string" || table.get(entry.pid)?.started === entry.procStart.replace(/\s+/g, " "))))
    .map((entry) => ({
      pid: entry.pid,
      name: typeof entry.name === "string" ? entry.name.slice(0, 80) : null,
      status: typeof entry.status === "string" ? entry.status : null,
      entrypoint: typeof entry.entrypoint === "string" ? entry.entrypoint : null,
    }));
}

/** Asks each outside Claude on `sessionId` to exit (SIGTERM, as closing its terminal does) and waits for it. */
async function stopProcessesForSession(sessionId, { self = process.pid, timeoutMs = 5_000 } = {}) {
  const processes = await processesForSession(sessionId, { self });
  for (const { pid } of processes) { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
  const until = Date.now() + timeoutMs;
  while (processes.some(({ pid }) => alive(pid))) {
    if (Date.now() > until) throw Object.assign(new Error("Claude on this computer did not exit. Close it in its terminal to continue here."), { code: "external_still_running" });
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return processes.length;
}

module.exports = { processesForSession, stopProcessesForSession };
