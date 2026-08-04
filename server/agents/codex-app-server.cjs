/* eslint-disable @typescript-eslint/no-require-imports */
"use strict"; // Optional Codex app-server process manager.
const { spawn } = require("node:child_process");
const sessions = new Map();
const modelCatalogCache = global.__piWebCodexModelCatalogCache || new Map();
global.__piWebCodexModelCatalogCache = modelCatalogCache;
const MODEL_CATALOG_TTL_MS = 10 * 60_000;
// Leave enough time for thread/resume and EventSource reconnects before releasing ownership.
const IDLE_SHUTDOWN_MS = 30_000;
if (!global.__piWebCodexAppServerCleanup) { global.__piWebCodexAppServerCleanup = true; process.once("exit", () => { for (const state of sessions.values()) state.child.kill(); }); }
function cancelIdleShutdown(state) { if (state.idleTimer) { clearTimeout(state.idleTimer); state.idleTimer = null; } }
function stop(threadId) {
  const state = sessions.get(threadId);
  if (!state) return false;
  cancelIdleShutdown(state);
  sessions.delete(threadId);
  try { state.child.kill(); } catch { /* process already exited */ }
  return true;
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
function scheduleIdleShutdown(state) {
  cancelIdleShutdown(state);
  if (state.listeners.size) return;
  state.idleTimer = setTimeout(() => {
    state.idleTimer = null;
    if (!state.listeners.size) stop(state.threadId);
  }, IDLE_SHUTDOWN_MS);
  state.idleTimer.unref?.();
}
function handleProtocolMessage(state, message) {
  // JSON-RPC ids are scoped to each direction. A Codex server request may use
  // the same numeric id as one of our pending client requests, so `method`
  // must take precedence over an id lookup.
  if (!message.method && message.id != null && state.pending.has(message.id)) {
    const pending = state.pending.get(message.id);
    state.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message || "Codex app-server error"));
    else pending.resolve(message.result);
    return;
  }
  if (message.method === "turn/started") state.activeTurnId = message.params?.turn?.id || message.params?.turnId || state.activeTurnId;
  if (message.method === "turn/completed") state.activeTurnId = null;
  if (message.method === "serverRequest/resolved" && message.params?.requestId != null) state.incoming.delete(String(message.params.requestId));
  if (message.id != null && message.method) state.incoming.set(String(message.id), message);
  const event = { ...message, piSeq: state.nextEventSeq++ };
  state.events.push(event);
  if (state.events.length > 2_000) state.events.splice(0, state.events.length - 2_000);
  for (const listener of state.listeners) listener(event);
}
function failState(state, error) {
  if (state.failure) return;
  state.failure = error instanceof Error ? error : new Error(String(error));
  cancelIdleShutdown(state);
  if (sessions.get(state.threadId) === state) sessions.delete(state.threadId);
  const detail = state.stderrTail?.trim();
  const failure = new Error(detail ? `${state.failure.message}: ${detail}` : state.failure.message);
  for (const pending of state.pending.values()) { clearTimeout(pending.timer); pending.reject(failure); }
  state.pending.clear();
  for (const listener of state.listeners) listener({ method: "codex/closed", params: { error: failure.message } });
}
function start({ threadId, cwd, model, serviceTier, approvalPolicy = "untrusted" }) {
  if (sessions.has(threadId)) { const existing = sessions.get(threadId); cancelIdleShutdown(existing); scheduleIdleShutdown(existing); return existing; }
  const child = spawn("codex", ["app-server", "--stdio"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  const state = { child, threadId, cwd, nextId: 1, nextEventSeq: 1, activeTurnId: null, pending: new Map(), incoming: new Map(), listeners: new Set(), buffer: "", stderrTail: "", failure: null, events: [], idleTimer: null };
  sessions.set(threadId, state); child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { state.buffer += chunk; let index; while ((index = state.buffer.indexOf("\n")) >= 0) { const line = state.buffer.slice(0, index); state.buffer = state.buffer.slice(index + 1); try { handleProtocolMessage(state, JSON.parse(line)); } catch {} } });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { state.stderrTail = `${state.stderrTail}${chunk}`.slice(-16_384); });
  child.on("error", (error) => failState(state, new Error(`Unable to start Codex app-server: ${error.message}`)));
  child.on("exit", () => failState(state, new Error("Codex app-server exited")));
  state.request = (method, params) => new Promise((resolve, reject) => { if (state.failure) { reject(state.failure); return; } const id = state.nextId++; const timer = setTimeout(() => { if (state.pending.delete(id)) reject(new Error(`${method} timed out`)); }, 60_000); state.pending.set(id, { resolve, reject, timer }); state.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => { if (error) failState(state, error); }); });
  state.ready = state.request("initialize", { clientInfo: { name: "pi-web", version: "0.8.1" }, capabilities: {} }).then(() => state.request("thread/resume", { threadId, cwd, model: model || null, serviceTier: serviceTier || null, approvalPolicy }));
  scheduleIdleShutdown(state);
  return state;
}
async function prompt(state, text, model = null, approvalPolicy = null, images = [], clientUserMessageId = null, effort = null, serviceTier = null) { await state.ready; const result = await state.request("turn/start", { threadId: state.threadId, cwd: state.cwd, input: [...(text ? [{ type: "text", text }] : []), ...images.map((url) => ({ type: "image", url }))], clientUserMessageId, approvalPolicy, model, effort, serviceTier, summary: "auto" }); state.activeTurnId = result?.turn?.id || result?.id || state.activeTurnId; return result; }
async function readThread(state) { await state.ready; return state.request("thread/read", { threadId: state.threadId, includeTurns: true }); }
async function command(state, name) { await state.ready; if (name === "compact") return state.request("thread/compact/start", { threadId: state.threadId }); if (name === "review") return state.request("review/start", { threadId: state.threadId, target: { type: "uncommittedChanges" }, delivery: "inline" }); if (name === "models") return state.request("model/list", { cursor: null, includeHidden: false, limit: 100 }); throw new Error(`Unsupported Codex command: /${name}`); }
function respond(state, requestId, result) {
  const request = state.incoming.get(String(requestId));
  if (!request) throw new Error("Approval request is no longer pending");
  state.incoming.delete(String(requestId));
  state.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
}
async function fork(state) { await state.ready; return state.request("thread/fork", { threadId: state.threadId, cwd: state.cwd }); }
async function interrupt(state, fallbackTurnId = null) { await state.ready; const turnId = state.activeTurnId || fallbackTurnId; if (!turnId) throw new Error("No active turn was found"); return state.request("turn/interrupt", { threadId: state.threadId, turnId }); }
function subscribe(state, listener, afterSeq = 0) { cancelIdleShutdown(state); for (const event of state.events) if ((event.piSeq || 0) > afterSeq) listener(event); state.listeners.add(listener); return () => { state.listeners.delete(listener); scheduleIdleShutdown(state); }; }
function isClaimed(threadId) { return sessions.has(threadId); }
function isAttached(threadId) { return Boolean(sessions.get(threadId)?.listeners.size); }
function snapshot(state) { return [...state.events]; }
function runtimeForSession(threadId) {
  const state = sessions.get(threadId);
  if (!state) return null;
  const runState = state.incoming.size ? "approval" : state.activeTurnId ? "running" : "idle";
  return { owner: "chat", state: runState, connected: state.listeners.size > 0 };
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
module.exports = { start, stop, stopAndWait, prompt, readThread, command, respond, fork, interrupt, subscribe, isClaimed, isAttached, snapshot, runtimeForSession, listModels, handleProtocolMessage, failState };
