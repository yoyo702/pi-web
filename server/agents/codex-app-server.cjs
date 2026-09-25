/* eslint-disable @typescript-eslint/no-require-imports */
"use strict"; // Optional Codex app-server process manager.
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const workspaceStatus = require("../workspace-status.cjs");
const requests = require("./codex-requests.cjs");
const notifications = require("../notifications.cjs");
const sessions = new Map();
const modelCatalogCache = global.__piWebCodexModelCatalogCache || new Map();
global.__piWebCodexModelCatalogCache = modelCatalogCache;
const MODEL_CATALOG_TTL_MS = 10 * 60_000;
// Leave enough time for thread/resume and EventSource reconnects before releasing ownership.
const DEFAULT_RUNTIME_OPTIONS = { command: "codex", args: ["app-server", "--stdio"], env: undefined, idleMs: 30_000 };
let runtimeOptions = DEFAULT_RUNTIME_OPTIONS;
/** Tests point runtimes at a fake app-server; `null` restores the defaults. */
function configure(options) { runtimeOptions = options ? { ...DEFAULT_RUNTIME_OPTIONS, ...options } : DEFAULT_RUNTIME_OPTIONS; }
if (!global.__piWebCodexAppServerCleanup) { global.__piWebCodexAppServerCleanup = true; process.once("exit", () => { for (const state of sessions.values()) state.child.kill(); }); }
function cancelIdleShutdown(state) { if (state.idleTimer) { clearTimeout(state.idleTimer); state.idleTimer = null; } }
function stop(threadId) {
  const state = sessions.get(threadId);
  if (!state) return false;
  cancelIdleShutdown(state);
  sessions.delete(threadId);
  workspaceStatus.notify("codex_runtimes");
  try { state.child.kill(); } catch { /* process already exited */ }
  return true;
}
// Server shutdown. Ctrl+C also reaches the app-server children (same process
// group); stopping them first keeps their exits from being recorded as failed turns.
function shutdownRuntimes() {
  for (const threadId of [...sessions.keys()]) stop(threadId);
}
async function stopAndWait(threadId) {
  const state = sessions.get(threadId);
  if (!state) return false;
  const child = state.child;
  stop(threadId);
  if (child.exitCode !== null || child.signalCode !== null) return true;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    timer.unref?.();
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
  return true;
}
// A turn or approval keeps the runtime alive without a viewer, so closing the
// tab (or a phone locking) does not interrupt it; the idle timer restarts
// when the turn ends.
function isBusy(state) { return Boolean(state.activeTurnId || state.incoming?.size); }
function shouldStayUp(state) { return state.listeners.size > 0 || isBusy(state); }
function scheduleIdleShutdown(state) {
  cancelIdleShutdown(state);
  if (shouldStayUp(state)) return;
  state.idleTimer = setTimeout(() => {
    state.idleTimer = null;
    if (!shouldStayUp(state) && sessions.get(state.threadId) === state) stop(state.threadId);
  }, runtimeOptions.idleMs);
  state.idleTimer.unref?.();
}
// Sessions being archived or deleted; no runtime may start for them meanwhile.
const removing = new Set();
async function withRemovalLock(threadId, task) {
  if (removing.has(threadId)) throw Object.assign(new Error("This Codex session is already being archived or deleted"), { code: "session_busy" });
  removing.add(threadId);
  try { return await task(); } finally { removing.delete(threadId); }
}
function isRemoving(threadId) { return removing.has(threadId); }
function protocolError(error) {
  const message = error?.message || "Codex app-server error";
  if (/already has an active writer/i.test(message)) {
    return Object.assign(new Error("This session is open in another Codex client (for example the ChatGPT desktop app). Quit that app completely and try again, or fork the session from the Agents panel."), { code: "writer_conflict" });
  }
  return Object.assign(new Error(message), { code: "rpc_error", rpcCode: error?.code, rpcData: error?.data });
}
function handleProtocolMessage(state, message) {
  // JSON-RPC ids are scoped to each direction. A Codex server request may use
  // the same numeric id as one of our pending client requests, so `method`
  // must take precedence over an id lookup.
  if (!message.method && message.id != null && state.pending.has(message.id)) {
    const pending = state.pending.get(message.id);
    state.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(protocolError(message.error));
    else pending.resolve(message.result);
    return;
  }
  // A request pi-web cannot answer is refused now instead of stalling the turn;
  // the browser gets a notice saying what was declined.
  if (message.id != null && message.method && !requests.isSupported(message.method)) {
    console.warn(`[pi-web] Declined unsupported Codex request ${message.method}`);
    state.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `pi-web does not support ${message.method}` } })}\n`);
    message = { method: "codex/unsupportedRequest", params: { method: message.method } };
  }
  recordNotification(state, message);
  if (message.method === "turn/started") { state.activeTurnId = message.params?.turn?.id || message.params?.turnId || state.activeTurnId; cancelIdleShutdown(state); }
  // Approvals left open when a turn ends can no longer be answered.
  if (message.method === "turn/completed") { state.activeTurnId = null; state.incoming.clear(); }
  if (message.method === "serverRequest/resolved" && message.params?.requestId != null) state.incoming.delete(String(message.params.requestId));
  if (message.id != null && message.method) state.incoming.set(String(message.id), message);
  const changed = (message.method === "turn/started" || message.method === "turn/completed" || message.method === "serverRequest/resolved" || (message.id != null && message.method));
  if (changed) workspaceStatus.notify("codex_runtimes");
  if ((message.method === "turn/completed" || message.method === "serverRequest/resolved") && !state.idleTimer) scheduleIdleShutdown(state);
  const event = { ...message, piSeq: state.nextEventSeq++, piRuntime: state.runtimeId };
  state.events.push(event);
  if (state.events.length > 2_000) state.events.splice(0, state.events.length - 2_000);
  for (const listener of state.listeners) listener(event);
}
// Turn outcomes and approval requests go to the shared activity notifications.
function recordNotification(state, message) {
  if (message.method === "thread/name/updated" && message.params?.threadName) state.title = message.params.threadName;
  const base = { kind: "codex", targetId: state.threadId, cwd: state.cwd, title: state.title || "Codex chat" };
  if (message.method === "turn/completed") {
    const turn = message.params?.turn;
    if (turn?.error || turn?.status === "failed") notifications.add({ ...base, event: "failed", detail: turn?.error?.message || "Turn failed" });
    else if (turn?.status === "completed") notifications.add({ ...base, event: "completed" });
  } else if (message.id != null && message.method) {
    notifications.add({ ...base, event: "approval" });
  }
}
function failState(state, error) {
  if (state.failure) return;
  state.failure = error instanceof Error ? error : new Error(String(error));
  cancelIdleShutdown(state);
  if (sessions.get(state.threadId) === state) {
    sessions.delete(state.threadId);
    workspaceStatus.notify("codex_runtimes");
    // A crash mid-turn ends the turn without turn/completed. A stopped runtime is no longer in `sessions`.
    if (state.activeTurnId) notifications.add({ kind: "codex", event: "failed", targetId: state.threadId, cwd: state.cwd, title: state.title || "Codex chat", detail: state.failure.message });
  }
  // stderr may name local paths; it goes to the server log, not to clients.
  const detail = state.stderrTail?.trim();
  if (detail) console.warn(`[pi-web] Codex app-server for ${state.threadId}: ${state.failure.message}\n${detail}`);
  const failure = Object.assign(new Error(state.failure.message), { code: "runtime_unavailable" });
  for (const pending of state.pending.values()) { clearTimeout(pending.timer); pending.reject(failure); }
  state.pending.clear();
  for (const listener of state.listeners) listener({ method: "codex/closed", params: { error: failure.message } });
}
// The process for one thread; the caller registers it in `sessions` once it knows the thread id.
function spawnRuntime(threadId, cwd) {
  const child = spawn(runtimeOptions.command, runtimeOptions.args, { cwd, env: runtimeOptions.env, stdio: ["pipe", "pipe", "pipe"] });
  // Event sequence numbers restart with each process; runtimeId lets a
  // reconnecting client tell a new process from the one it last saw.
  const state = { child, threadId, cwd, runtimeId: crypto.randomUUID().slice(0, 8), nextId: 1, nextEventSeq: 1, activeTurnId: null, pending: new Map(), incoming: new Map(), listeners: new Set(), buffer: "", stderrTail: "", failure: null, events: [], idleTimer: null, loaded: false };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { state.buffer += chunk; let index; while ((index = state.buffer.indexOf("\n")) >= 0) { const line = state.buffer.slice(0, index); state.buffer = state.buffer.slice(index + 1); try { handleProtocolMessage(state, JSON.parse(line)); } catch {} } });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { state.stderrTail = `${state.stderrTail}${chunk}`.slice(-16_384); });
  child.on("error", (error) => failState(state, new Error(`Unable to start Codex app-server: ${error.message}`)));
  // EPIPE after Codex exits; unhandled, it would crash the server.
  child.stdin.on("error", (error) => failState(state, error));
  child.on("exit", () => failState(state, new Error("Codex app-server exited")));
  state.request = (method, params) => new Promise((resolve, reject) => { if (state.failure) { reject(state.failure); return; } const id = state.nextId++; const timer = setTimeout(() => { if (state.pending.delete(id)) reject(Object.assign(new Error(`Codex did not answer ${method} in time`), { code: "runtime_timeout" })); }, 60_000); state.pending.set(id, { resolve, reject, timer }); state.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => { if (error) failState(state, error); }); });
  return state;
}
const INITIALIZE = { clientInfo: { name: "pi-web", version: "0.8.1" }, capabilities: {} };
function start({ threadId, cwd, model, serviceTier, approvalPolicy = "untrusted" }) {
  if (sessions.has(threadId)) { const existing = sessions.get(threadId); if (existing.loaded) { cancelIdleShutdown(existing); scheduleIdleShutdown(existing); } return existing; }
  if (removing.has(threadId)) throw Object.assign(new Error("This Codex session is being archived or deleted"), { code: "session_busy" });
  const state = spawnRuntime(threadId, cwd);
  sessions.set(threadId, state); workspaceStatus.notify("codex_runtimes");
  state.ready = state.request("initialize", INITIALIZE).then(() => state.request("thread/resume", { threadId, cwd, model: model || null, serviceTier: serviceTier || null, approvalPolicy })).then((result) => { state.title = state.title || result?.thread?.name || result?.thread?.preview || ""; return result; });
  // A runtime that never resumed is useless; drop it so the next request retries.
  // The idle clock starts once the thread is loaded, not while it is loading.
  state.ready.then(() => { state.loaded = true; if (!state.idleTimer) scheduleIdleShutdown(state); }, () => { if (sessions.get(threadId) === state) stop(threadId); });
  return state;
}
/** Starts a new thread in `cwd`; its runtime is registered under the id Codex gives it. */
async function create({ cwd, model, serviceTier, approvalPolicy = "untrusted" }) {
  const state = spawnRuntime(null, cwd);
  try {
    await state.request("initialize", INITIALIZE);
    const result = await state.request("thread/start", { cwd, model: model || null, serviceTier: serviceTier || null, approvalPolicy });
    if (typeof result?.thread?.id !== "string") throw Object.assign(new Error("Codex did not return a thread id"), { code: "runtime_unavailable" });
    state.threadId = result.thread.id;
  } catch (error) {
    try { state.child.kill(); } catch { /* process already exited */ }
    throw error;
  }
  state.ready = Promise.resolve();
  state.loaded = true;
  sessions.set(state.threadId, state); workspaceStatus.notify("codex_runtimes");
  scheduleIdleShutdown(state);
  return state;
}
async function prompt(state, text, model = null, approvalPolicy = null, images = [], clientUserMessageId = null, effort = null, serviceTier = null) { await state.ready; if (!state.title && text) state.title = text; const result = await state.request("turn/start", { threadId: state.threadId, cwd: state.cwd, input: [...(text ? [{ type: "text", text }] : []), ...images.map((url) => ({ type: "image", url }))], clientUserMessageId, approvalPolicy, model, effort, serviceTier, summary: "auto" }); state.activeTurnId = result?.turn?.id || result?.id || state.activeTurnId; if (state.activeTurnId) cancelIdleShutdown(state); workspaceStatus.notify("codex_runtimes"); return result; }
// Adds input to the running turn. Codex refuses it if that turn has already ended.
async function steer(state, text, images = [], clientUserMessageId = null) {
  await state.ready;
  if (!state.activeTurnId) throw Object.assign(new Error("No active turn to add this message to"), { code: "no_active_turn" });
  try {
    return await state.request("turn/steer", { threadId: state.threadId, expectedTurnId: state.activeTurnId, clientUserMessageId, input: [...(text ? [{ type: "text", text }] : []), ...images.map((url) => ({ type: "image", url }))] });
  } catch (error) {
    // The turn ended (or a review/compact turn cannot take input); the browser queues the message instead.
    const notSteerable = /activeTurnNotSteerable/.test(JSON.stringify(error.rpcData ?? null));
    if (error.code === "rpc_error" && (notSteerable || /no active turn|expected active turn id/i.test(error.message))) throw Object.assign(new Error("This turn can no longer take new input", { cause: error }), { code: "no_active_turn" });
    throw error;
  }
}
// A thread just started here has no turns on disk until Codex writes the first
// message; the event replay has the running turn meanwhile.
async function readThread(state) {
  await state.ready;
  try { return await state.request("thread/read", { threadId: state.threadId, includeTurns: true }); } catch (error) {
    if (!/not materialized/i.test(error?.message ?? "")) throw error;
    return state.request("thread/read", { threadId: state.threadId, includeTurns: false });
  }
}
async function command(state, name) { await state.ready; if (name === "compact") return state.request("thread/compact/start", { threadId: state.threadId }); if (name === "review") return state.request("review/start", { threadId: state.threadId, target: { type: "uncommittedChanges" }, delivery: "inline" }); if (name === "models") return state.request("model/list", { cursor: null, includeHidden: false, limit: 100 }); throw Object.assign(new Error(`Unsupported Codex command: /${name}`), { code: "invalid_request" }); }
// `answer` is the browser's reply; codex-requests turns it into the protocol result.
function respond(state, requestId, answer) {
  const request = state.incoming.get(String(requestId));
  if (!request) throw Object.assign(new Error("Approval request is no longer pending"), { code: "approval_expired" });
  const result = requests.responseFor(request, answer);
  state.incoming.delete(String(requestId));
  workspaceStatus.notify("codex_runtimes");
  state.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
}
// Forks `threadId` into a new thread, keeping the turns up to and including
// `lastTurnId` (all of them without it). A Codex process stays the writer of
// every thread it has loaded, even after `thread/unsubscribe`, so the fork is
// made by a short-lived process: once it exits, the fork's own chat runtime can
// resume it. Forking only reads the source rollout, so the source may be open
// in a chat or another client meanwhile.
async function fork({ threadId, cwd }, lastTurnId = null) {
  if (removing.has(threadId)) throw Object.assign(new Error("This Codex session is being archived or deleted"), { code: "session_busy" });
  const state = spawnRuntime(threadId, cwd);
  // "close", not "exit": a process that failed to spawn never emits "exit".
  const exited = new Promise((resolve) => state.child.once("close", resolve));
  try {
    await state.request("initialize", INITIALIZE);
    return await state.request("thread/fork", { threadId, cwd, excludeTurns: true, ...(lastTurnId ? { lastTurnId } : {}) });
  } finally {
    // Marked failed first so the expected exit is not logged as a crash.
    state.failure = state.failure || new Error("closed");
    state.child.stdin.end();
    const killTimer = setTimeout(() => { try { state.child.kill(); } catch { /* process already exited */ } }, 5_000);
    await exited;
    clearTimeout(killTimer);
  }
}
async function interrupt(state, fallbackTurnId = null) { await state.ready; const turnId = state.activeTurnId || fallbackTurnId; if (!turnId) throw Object.assign(new Error("No active turn was found"), { code: "no_active_turn" }); return state.request("turn/interrupt", { threadId: state.threadId, turnId }); }
function subscribe(state, listener, afterSeq = 0) { cancelIdleShutdown(state); for (const event of state.events) if ((event.piSeq || 0) > afterSeq) listener(event); state.listeners.add(listener); workspaceStatus.notify("codex_runtimes"); return () => { state.listeners.delete(listener); workspaceStatus.notify("codex_runtimes"); scheduleIdleShutdown(state); }; }
function isClaimed(threadId) { return sessions.has(threadId); }
function isAttached(threadId) { return Boolean(sessions.get(threadId)?.listeners.size); }
function snapshot(state) { return [...state.events]; }
function runtimeForSession(threadId) {
  const state = sessions.get(threadId);
  if (!state) return null;
  const runState = state.incoming.size ? "approval" : state.activeTurnId ? "running" : "idle";
  return { owner: "chat", state: runState, connected: state.listeners.size > 0 };
}
function listRuntimes() {
  return [...sessions.entries()].map(([threadId, state]) => ({
    threadId,
    cwd: state.cwd,
    ...runtimeForSession(threadId),
  }));
}
async function readModels(cwd) {
  const child = spawn("codex", ["app-server", "--stdio"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  let nextId = 1;
  let buffer = "";
  let stderrTail = "";
  let failure = null;
  const pending = new Map();
  const fail = (cause) => {
    if (failure) return;
    failure = cause instanceof Error ? cause : new Error(String(cause));
    const detail = stderrTail.trim();
    const error = new Error(detail ? `${failure.message}: ${detail}` : failure.message);
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      try {
        const message = JSON.parse(line);
        if (message.method || message.id == null || !pending.has(message.id)) continue;
        const entry = pending.get(message.id); pending.delete(message.id); clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(message.error.message || "Codex app-server error"));
        else entry.resolve(message.result);
      } catch { /* ignore non-protocol output */ }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderrTail = `${stderrTail}${chunk}`.slice(-16_384); });
  child.on("error", (error) => fail(new Error(`Unable to start Codex app-server: ${error.message}`)));
  child.stdin.on("error", (error) => fail(error));
  child.on("exit", () => fail(new Error("Codex app-server exited")));
  const request = (method, params) => new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    const id = nextId++;
    const timer = setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method} timed out`)); }, 30_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => { if (error) fail(error); });
  });
  try {
    await request("initialize", { clientInfo: { name: "pi-web", version: "0.8.1" }, capabilities: {} });
    return await request("model/list", { cursor: null, includeHidden: false, limit: 100 });
  } finally {
    for (const entry of pending.values()) clearTimeout(entry.timer);
    pending.clear();
    try { child.kill(); } catch { /* process already exited */ }
  }
}
async function listModels(cwd) {
  const now = Date.now();
  const cached = modelCatalogCache.get(cwd);
  if (cached?.value && cached.expiresAt > now) return cached.value;
  if (cached?.promise) return cached.promise;
  const promise = readModels(cwd).then((value) => {
    modelCatalogCache.set(cwd, { value, expiresAt: Date.now() + MODEL_CATALOG_TTL_MS });
    return value;
  }).catch((error) => {
    if (modelCatalogCache.get(cwd)?.promise === promise) modelCatalogCache.delete(cwd);
    throw error;
  });
  modelCatalogCache.set(cwd, { promise, expiresAt: 0 });
  return promise;
}
module.exports = { configure, withRemovalLock, isRemoving, start, create, stop, stopAndWait, shutdownRuntimes, prompt, steer, readThread, command, respond, fork, interrupt, subscribe, isClaimed, isAttached, snapshot, runtimeForSession, listRuntimes, listModels, handleProtocolMessage, failState };

workspaceStatus.registerProvider("codex_runtimes", () => ({ runtimes: listRuntimes() }));
