/* eslint-disable @typescript-eslint/no-require-imports */
"use strict"; // Shared Codex app-server connection for the session catalog.

const os = require("node:os");
const { spawn } = require("node:child_process");

// One long-lived app-server answers list/read/rename/archive/delete for every
// workspace. It is separate from the per-session chat runtimes in
// codex-app-server.cjs, starts on first use, restarts on the next request
// after a crash, and exits after a quiet period. Codex keeps the thread
// catalog in its state database, so changes made by terminals and chat
// runtimes are visible here without a restart.
const IDLE_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
// After a start that never became ready (missing CLI, bad config), fail fast
// instead of spawning a new process on every request.
const START_RETRY_MS = 30_000;
const LIST_LIMIT_MAX = 100;

function catalogError(code, message, extra = {}) { return Object.assign(new Error(message), { code, ...extra }); }

function createClient({ command = "codex", args = ["app-server", "--stdio"], env, cwd = os.homedir(), idleMs = IDLE_MS, timeoutMs = REQUEST_TIMEOUT_MS, retryMs = START_RETRY_MS } = {}) {
  let current = null;
  let idleTimer = null;
  let retryAt = 0;
  let startFailure = null;

  function shutdown(proc, cause) {
    if (proc.failure) return;
    proc.failure = cause;
    if (current === proc) current = null;
    // stderr stays in the server log; errors reach the browser.
    const detail = proc.stderrTail.trim().split("\n").slice(-3).join("\n");
    if (detail) console.warn(`[pi-web] Codex catalog app-server: ${cause.message}\n${detail}`);
    if (!proc.started) { retryAt = Date.now() + retryMs; startFailure = cause.message; }
    const failure = catalogError("catalog_unavailable", cause.message);
    for (const entry of proc.pending.values()) { clearTimeout(entry.timer); entry.reject(failure); }
    proc.pending.clear();
    try { proc.child.kill(); } catch { /* already exited */ }
  }

  function send(proc, method, params) {
    return new Promise((resolve, reject) => {
      if (proc.failure) { reject(catalogError("catalog_unavailable", proc.failure.message)); return; }
      const id = proc.nextId++;
      const timer = setTimeout(() => {
        if (!proc.pending.delete(id)) return;
        reject(catalogError("catalog_unavailable", `${method} timed out`));
        // A wedged server would time out every later request too.
        shutdown(proc, new Error("Codex app-server stopped responding"));
      }, timeoutMs);
      timer.unref?.();
      proc.pending.set(id, { resolve, reject, timer, method });
      proc.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => { if (error) shutdown(proc, error); });
    });
  }

  function handleLine(proc, line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method) {
      // Notifications are not needed here. Answer server requests so the
      // server does not wait on us; the catalog never starts turns.
      if (message.id != null) proc.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not supported by the pi-web catalog client" } })}\n`);
      return;
    }
    const entry = proc.pending.get(message.id);
    if (!entry) return;
    proc.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(catalogError("rpc_error", message.error.message || `${entry.method} failed`, { rpcCode: message.error.code }));
    else entry.resolve(message.result);
  }

  function start() {
    const child = spawn(command, args, { cwd, env: env || process.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const proc = { child, nextId: 1, pending: new Map(), buffer: "", stderrTail: "", failure: null, ready: null, started: false };
    current = proc;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      proc.buffer += chunk;
      let index;
      while ((index = proc.buffer.indexOf("\n")) >= 0) {
        const line = proc.buffer.slice(0, index);
        proc.buffer = proc.buffer.slice(index + 1);
        handleLine(proc, line);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { proc.stderrTail = `${proc.stderrTail}${chunk}`.slice(-4096); });
    child.stdin.on("error", (error) => shutdown(proc, error));
    child.on("error", (error) => shutdown(proc, new Error(`Unable to start Codex app-server: ${error.message}`)));
    child.on("exit", () => shutdown(proc, new Error("Codex app-server exited")));
    proc.ready = send(proc, "initialize", { clientInfo: { name: "pi-web-catalog", version: "1" }, capabilities: {} })
      .then(() => { proc.started = true; }, (cause) => {
        // A process that cannot initialize is useless; drop it so a later
        // request starts a fresh one.
        shutdown(proc, new Error(`Codex app-server failed to initialize: ${cause.message}`));
        throw catalogError("catalog_unavailable", `Codex app-server failed to initialize: ${cause.message}`);
      });
    proc.ready.catch(() => { /* surfaced by request() */ });
    return proc;
  }

  function scheduleIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!current) return;
      if (current.pending.size) { scheduleIdle(); return; }
      shutdown(current, new Error("Codex catalog connection closed while idle"));
    }, idleMs);
    idleTimer.unref?.();
  }

  async function request(method, params) {
    if (!current && Date.now() < retryAt) throw catalogError("catalog_unavailable", `Codex app-server is unavailable (${startFailure}); retrying shortly`);
    const proc = current || start();
    scheduleIdle();
    await proc.ready;
    return send(proc, method, params);
  }

  function close() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (current) shutdown(current, new Error("Codex catalog connection closed"));
  }

  return { request, close };
}

const shared = global.__piWebCodexCatalog || { client: null };
global.__piWebCodexCatalog = shared;
if (!shared.exitHook) { shared.exitHook = true; process.once("exit", () => shared.client?.close()); }

function client() {
  if (!shared.client) shared.client = createClient();
  return shared.client;
}
/** Replace the shared client (tests point it at a fake app-server). */
function configure(options) {
  shared.client?.close();
  shared.client = options ? createClient(options) : null;
}

// The server answers requests for unknown or already-moved threads with
// invalid-request errors such as "no rollout found for thread id …".
function isMissingThread(error) {
  return error?.code === "rpc_error" && /no (?:archived )?rollout found|not found|not loaded/i.test(error.message || "");
}

async function listThreads({ cwd, archived = false, searchTerm, cursor, limit = 50 } = {}) {
  const result = await client().request("thread/list", {
    cursor: cursor || null,
    limit: Math.min(LIST_LIMIT_MAX, Math.max(1, Number(limit) || 50)),
    sortKey: "updated_at",
    sortDirection: "desc",
    // Without this the server lists only the default provider's threads.
    modelProviders: [],
    archived: archived === true,
    cwd: cwd || null,
    searchTerm: searchTerm || null,
  });
  return { data: Array.isArray(result?.data) ? result.data : [], nextCursor: result?.nextCursor || null };
}
async function readThread(threadId) {
  try {
    const result = await client().request("thread/read", { threadId, includeTurns: false });
    return result?.thread || null;
  } catch (error) {
    if (isMissingThread(error)) return null;
    throw error;
  }
}
async function mutate(method, params) {
  try {
    await client().request(method, params);
  } catch (error) {
    if (isMissingThread(error)) throw catalogError("not_found", "Codex session not found");
    throw error;
  }
}
const setName = (threadId, name) => mutate("thread/name/set", { threadId, name });
const archive = (threadId) => mutate("thread/archive", { threadId });
const unarchive = (threadId) => mutate("thread/unarchive", { threadId });
const remove = (threadId) => mutate("thread/delete", { threadId });

module.exports = { createClient, configure, listThreads, readThread, setName, archive, unarchive, remove };
