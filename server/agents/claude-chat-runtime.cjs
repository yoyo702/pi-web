/* eslint-disable @typescript-eslint/no-require-imports */
"use strict"; // Claude Chat: one `claude --print` stream-json process per session.

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const workspaceStatus = require("../workspace-status.cjs");
const notifications = require("../notifications.cjs");
const catalog = require("./claude-sessions.cjs");

// One entry per session with a Claude Chat open or a Claude process running.
// The process starts on the first message, not when the chat opens: reading
// the transcript needs no process. It stays up while a viewer is connected
// or a turn runs, and stops `idleMs` after both end.
const sessions = new Map();
const PROTOCOL_ARGS = [
  "--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
  // Without it, permission prompts are denied automatically.
  "--permission-prompt-tool", "stdio",
  // Lets the chat switch to bypassPermissions later; it does not enable it.
  "--allow-dangerously-skip-permissions",
];
const DEFAULT_RUNTIME_OPTIONS = { command: "claude", args: [], env: undefined, idleMs: 30_000 };
let runtimeOptions = DEFAULT_RUNTIME_OPTIONS;
/** Tests point runtimes at a fake `claude`; `null` restores the defaults. */
function configure(options) { runtimeOptions = options ? { ...DEFAULT_RUNTIME_OPTIONS, ...options } : DEFAULT_RUNTIME_OPTIONS; commandCache.clear(); }
const probes = new Set();
if (!global.__piWebClaudeChatCleanup) { global.__piWebClaudeChatCleanup = true; process.once("exit", () => { for (const state of sessions.values()) state.child?.kill(); for (const child of probes) child.kill(); }); }

const MODELS = new Set(["", "sonnet", "opus", "haiku"]);
const PERMISSION_MODES = new Set(["default", "acceptEdits", "plan", "bypassPermissions"]);
const EVENTS_MAX = 2_000;
// Sub-agent progress, shown on the Agent tool call that started it.
const TASK_EVENTS = new Set(["task_started", "task_progress", "task_notification"]);

function fail(code, message) { return Object.assign(new Error(message), { code }); }

// Slash commands, per folder (project commands and skills differ). Claude
// lists them in its `initialize` answer; `system/init` names the ones that
// only work in a terminal (seeded with Claude 2.1's). `/clear` starts a new
// session under another id, which the chat would not follow.
const CLEAR_COMMANDS = new Set(["clear", "reset", "new"]);
let terminalCommands = new Set(["doctor", "color", "reload-plugins"]);
const COMMANDS_TTL = 5 * 60_000;
// A failed probe (no CLI, slow startup) is not retried on every panel open.
const COMMANDS_FAILED_TTL = 60_000;
const commandCache = new Map();
const commandProbes = new Map();
function commandList(raw) {
  if (!Array.isArray(raw)) return [];
  const names = (value) => Array.isArray(value) ? value.filter((name) => typeof name === "string" && name) : [];
  const seen = new Set();
  return raw.filter((command) => typeof command?.name === "string" && /^[\w:.-]+$/.test(command.name) && !command.name.startsWith("__") && !terminalCommands.has(command.name) && ![command.name, ...names(command.aliases)].some((name) => CLEAR_COMMANDS.has(name)))
    .filter((command) => !seen.has(command.name) && seen.add(command.name))
    .slice(0, 500)
    .map((command) => ({
      name: command.name,
      description: typeof command.description === "string" ? command.description.slice(0, 300) : "",
      argumentHint: typeof command.argumentHint === "string" ? command.argumentHint.slice(0, 200) : "",
      ...(names(command.aliases).length ? { aliases: names(command.aliases).slice(0, 10) } : {}),
    }));
}
function rememberCommands(cwd, raw, ttl = COMMANDS_TTL) {
  const commands = commandList(raw);
  commandCache.delete(cwd);
  commandCache.set(cwd, { until: Date.now() + ttl, commands });
  while (commandCache.size > 50) commandCache.delete(commandCache.keys().next().value);
  return commands;
}
// A `claude` that answers `initialize` and is stopped: it starts no session
// and makes no model request.
function probeCommands(cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(runtimeOptions.command, [...runtimeOptions.args, ...PROTOCOL_ARGS], { cwd, env: runtimeOptions.env, stdio: ["pipe", "pipe", "ignore"] });
    probes.add(child);
    let buffer = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      probes.delete(child);
      try { child.kill(); } catch { /* already exited */ }
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(fail("runtime_timeout", "Claude did not list its commands in time")), 15_000);
    timer.unref?.();
    child.on("error", (error) => finish(fail("runtime_unavailable", `Unable to start Claude: ${error.message}`)));
    child.on("exit", () => finish(fail("runtime_unavailable", "Claude exited before listing its commands")));
    child.stdin.on("error", () => { /* the exit reports it */ });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        if (record?.type !== "control_response" || record.response?.request_id !== "pi-web-commands") continue;
        if (record.response.subtype === "success") finish(null, record.response.response?.commands);
        else finish(fail("rpc_error", record.response.error || "Claude did not list its commands"));
      }
    });
    child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: "pi-web-commands", request: { subtype: "initialize" } })}\n`);
  });
}
/**
 * Claude's slash commands for `cwd`: `{ name, description, argumentHint, aliases? }[]`;
 * empty (for a minute) when Claude cannot list them.
 */
function commandsFor(cwd) {
  const cached = commandCache.get(cwd);
  if (cached && Date.now() < cached.until) return Promise.resolve(cached.commands);
  let probe = commandProbes.get(cwd);
  if (!probe) {
    probe = probeCommands(cwd).then((raw) => rememberCommands(cwd, raw), (error) => {
      console.warn(`[pi-web] Unable to list Claude's slash commands in ${cwd}: ${error.message}`);
      return rememberCommands(cwd, [], COMMANDS_FAILED_TTL);
    }).finally(() => commandProbes.delete(cwd));
    commandProbes.set(cwd, probe);
  }
  return probe;
}
// `starting` covers a send that is still restarting the process.
function isBusy(state) { return Boolean(state.running || state.starting || state.incoming.size); }
function cancelIdleShutdown(state) { if (state.idleTimer) { clearTimeout(state.idleTimer); state.idleTimer = null; } }
function scheduleIdleShutdown(state) {
  cancelIdleShutdown(state);
  if (state.listeners.size || isBusy(state)) return;
  state.idleTimer = setTimeout(() => {
    state.idleTimer = null;
    if (state.listeners.size || isBusy(state) || sessions.get(state.sessionId) !== state) return;
    sessions.delete(state.sessionId);
    if (state.child) killChild(state);
    workspaceStatus.notify("claude_runtimes");
  }, runtimeOptions.idleMs);
  state.idleTimer.unref?.();
}

function emit(state, record) {
  const event = { ...record, piSeq: state.nextEventSeq++, piRuntime: state.runtimeId };
  state.events.push(event);
  if (state.events.length > EVENTS_MAX) {
    // A client that resumes from before `droppedThrough` is told to reload.
    const dropped = state.events.splice(0, state.events.length - EVENTS_MAX);
    state.droppedThrough = dropped[dropped.length - 1].piSeq;
  }
  for (const listener of state.listeners) listener(event);
}

/**
 * The chat for this session, created if needed. It has no process yet.
 * `fork` (`{ sessionId, resumeAt }`) makes a new session a copy of another:
 * its first process forks that session, keeping the entries through
 * `resumeAt` (all of them when it is unset).
 */
function open(sessionId, cwd, { title = "", fork = null } = {}) {
  const existing = sessions.get(sessionId);
  if (existing) {
    if (existing.cwd !== cwd) throw fail("not_found", "Claude session not found in this workspace");
    return existing;
  }
  const state = {
    sessionId, cwd, title, fork,
    // Event sequence numbers restart with each chat; runtimeId lets a
    // reconnecting client tell a new chat from the one it last saw.
    runtimeId: crypto.randomUUID().slice(0, 8),
    child: null, buffer: "", stderrTail: "", launchModel: "", model: null, permissionMode: null,
    running: false, interrupting: false, compacting: false, blockIndex: 0,
    incoming: new Map(), controls: new Map(), nextControlId: 1,
    nextEventSeq: 1, droppedThrough: 0, events: [], listeners: new Set(), idleTimer: null,
  };
  sessions.set(sessionId, state);
  scheduleIdleShutdown(state);
  return state;
}

function killChild(state) {
  const child = state.child;
  state.child = null;
  try { child.kill(); } catch { /* process already exited */ }
  return child;
}

function handleRecord(state, record) {
  const type = record?.type;
  if (type === "control_response") {
    const id = record.response?.request_id;
    const pending = state.controls.get(id);
    if (pending) {
      state.controls.delete(id);
      clearTimeout(pending.timer);
      if (record.response.subtype === "success") pending.resolve(record.response.response ?? {});
      else pending.reject(fail("rpc_error", record.response.error || "Claude refused the request"));
    }
    return;
  }
  if (type === "control_request") {
    if (record.request?.subtype !== "can_use_tool") {
      // Hook callbacks and MCP messages are not used by Claude Chat.
      write(state, { type: "control_response", response: { subtype: "error", request_id: record.request_id, error: `pi-web does not support ${record.request?.subtype}` } });
      return;
    }
    state.incoming.set(String(record.request_id), record);
    notifications.add({ kind: "claude", event: "approval", targetId: state.sessionId, cwd: state.cwd, title: state.title || "Claude chat" });
    workspaceStatus.notify("claude_runtimes");
    emit(state, { type: "control_request", request_id: record.request_id, request: record.request });
    return;
  }
  if (type === "control_cancel_request") {
    if (state.incoming.delete(String(record.request_id))) { workspaceStatus.notify("claude_runtimes"); emit(state, { type: "pi/resolved", requestId: String(record.request_id) }); }
    return;
  }
  if (type === "system") {
    if (record.subtype === "init") {
      // A command that moved Claude to another session (as /clear does): this
      // chat's session no longer receives the turns.
      if (typeof record.session_id === "string" && record.session_id !== state.sessionId) {
        const child = state.child;
        onExit(state, child, Object.assign(new Error("Claude moved to another session. Start a new chat to continue."), { code: "session_changed" }));
        try { child?.kill(); } catch { /* already exited */ }
        return;
      }
      state.model = record.model ?? state.model;
      if (record.permissionMode) state.permissionMode = record.permissionMode;
      if (Array.isArray(record.terminal_slash_commands)) terminalCommands = new Set(record.terminal_slash_commands.filter((name) => typeof name === "string"));
      emit(state, { type: "system", subtype: "init", model: record.model, permissionMode: record.permissionMode });
    } else if (record.subtype === "status") {
      // Other statuses ("requesting") come with every request; only compaction is shown.
      const compacting = record.status === "compacting";
      const mode = record.permissionMode && record.permissionMode !== state.permissionMode ? record.permissionMode : undefined;
      if (!mode && compacting === state.compacting) return;
      state.compacting = compacting;
      if (mode) state.permissionMode = mode;
      emit(state, { type: "system", subtype: "status", compacting, ...(mode ? { permissionMode: mode } : {}) });
    } else if (record.subtype === "compact_boundary") {
      const compact = catalog.compactRecord(record);
      if (compact) emit(state, compact);
    } else if (TASK_EVENTS.has(record.subtype) && typeof record.tool_use_id === "string") {
      const usage = record.usage ?? {};
      emit(state, {
        type: "system", subtype: record.subtype, tool_use_id: record.tool_use_id,
        description: typeof record.description === "string" ? record.description.slice(0, 300) : undefined,
        last_tool_name: typeof record.last_tool_name === "string" ? record.last_tool_name : undefined,
        status: typeof record.status === "string" ? record.status : undefined,
        usage: { tool_uses: usage.tool_uses, duration_ms: usage.duration_ms },
      });
    }
    return;
  }
  if (type === "stream_event") {
    // A sub-agent's messages are shown once finished.
    if (record.parent_tool_use_id) return;
    const event = record.event ?? {};
    if (event.type === "content_block_start") state.blockIndex = event.index ?? 0;
    if (event.type === "message_start") emit(state, { type: "stream_event", event: { type: "message_start", message: { id: event.message?.id } } });
    else if (event.type === "content_block_start" || event.type === "content_block_delta" || event.type === "content_block_stop") emit(state, { type: "stream_event", event });
    return;
  }
  if (type === "assistant" || type === "user") {
    const compact = catalog.compactRecord(record);
    if (!compact) return;
    // A streamed assistant record arrives right after its content_block_start;
    // the transcript file keeps the same index as `apiBlockIndex`. Synthetic
    // messages (command output) and sub-agent messages are not streamed.
    if (type === "assistant" && compact.piBlockIndex === undefined && !compact.parentToolUseId) compact.piBlockIndex = state.blockIndex;
    emit(state, compact);
    return;
  }
  if (type === "result") {
    finishTurn(state, record);
  }
}

function finishTurn(state, result) {
  const interrupted = state.interrupting;
  state.running = false;
  state.interrupting = false;
  state.compacting = false;
  const expired = [...state.incoming.keys()];
  state.incoming.clear();
  // Deltas are superseded by the finished records; replaying them is waste.
  state.events = state.events.filter((event) => event.type !== "stream_event");
  for (const requestId of expired) emit(state, { type: "pi/resolved", requestId });
  const failed = Boolean(result.is_error) || (typeof result.subtype === "string" && result.subtype.startsWith("error"));
  const detail = failed ? (typeof result.result === "string" && result.result) || (Array.isArray(result.errors) && result.errors.join("; ")) || "Turn failed" : undefined;
  emit(state, { type: "result", subtype: result.subtype, is_error: failed, interrupted, result: failed ? detail : undefined, total_cost_usd: result.total_cost_usd, usage: result.usage, modelUsage: result.modelUsage });
  const base = { kind: "claude", targetId: state.sessionId, cwd: state.cwd, title: state.title || "Claude chat" };
  if (failed) notifications.add({ ...base, event: "failed", detail });
  else if (!interrupted) notifications.add({ ...base, event: "completed" });
  workspaceStatus.notify("claude_runtimes");
  scheduleIdleShutdown(state);
}

// The process ended. A stop (`stop`, idle shutdown) clears `state.child` first.
function onExit(state, child, error) {
  if (state.child !== child) return;
  state.child = null;
  for (const pending of state.controls.values()) { clearTimeout(pending.timer); pending.reject(fail("runtime_unavailable", "Claude exited")); }
  state.controls.clear();
  state.compacting = false;
  const detail = state.stderrTail.trim();
  if (detail) console.warn(`[pi-web] Claude for ${state.sessionId}: ${error.message}\n${detail}`);
  if (state.running) {
    notifications.add({ kind: "claude", event: "failed", targetId: state.sessionId, cwd: state.cwd, title: state.title || "Claude chat", detail: error.message });
    state.running = false;
    state.interrupting = false;
    state.incoming.clear();
  }
  // stderr may name local paths; it goes to the server log, not to clients.
  // A fork that exited before writing its session forks again on the next message.
  const forkFailed = Boolean(state.fork) && !catalog.sessionFile(state.sessionId, state.cwd);
  emit(state, forkFailed
    ? { type: "pi/closed", code: "fork_failed", error: "Claude could not fork the session (details are in the server log). Send the message again to retry." }
    : { type: "pi/closed", error: error.message, ...(error.code === "session_changed" ? { code: error.code } : {}) });
  workspaceStatus.notify("claude_runtimes");
  scheduleIdleShutdown(state);
}

function write(state, message) {
  const child = state.child;
  if (!child) throw fail("runtime_unavailable", "Claude is not running");
  child.stdin.write(`${JSON.stringify(message)}\n`, (error) => { if (error) onExit(state, child, error); });
}

function spawnChild(state, { model, permissionMode }) {
  const resume = Boolean(catalog.sessionFile(state.sessionId, state.cwd));
  // A fork keeps its source until the new session is written, so a process
  // that failed before writing it forks again.
  const fork = !resume && state.fork
    ? ["--resume", state.fork.sessionId, "--fork-session", ...(state.fork.resumeAt ? ["--resume-session-at", state.fork.resumeAt] : [])]
    : [];
  const args = [
    ...runtimeOptions.args, ...PROTOCOL_ARGS,
    ...(resume ? ["--resume", state.sessionId] : [...fork, "--session-id", state.sessionId]),
    ...(model ? ["--model", model] : []),
    ...(permissionMode ? ["--permission-mode", permissionMode] : []),
  ];
  const child = spawn(runtimeOptions.command, args, { cwd: state.cwd, env: runtimeOptions.env, stdio: ["pipe", "pipe", "pipe"] });
  state.child = child;
  state.buffer = "";
  state.compacting = false;
  state.stderrTail = "";
  // `model` is what Claude reports; `launchModel` is the alias we asked for.
  state.launchModel = model || "";
  state.model = model || null;
  state.permissionMode = permissionMode || "default";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    if (state.child !== child) return;
    state.buffer += chunk;
    let index;
    while ((index = state.buffer.indexOf("\n")) >= 0) {
      const line = state.buffer.slice(0, index);
      state.buffer = state.buffer.slice(index + 1);
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      handleRecord(state, record);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { state.stderrTail = `${state.stderrTail}${chunk}`.slice(-16_384); });
  child.on("error", (error) => onExit(state, child, new Error(`Unable to start Claude: ${error.message}`)));
  // EPIPE after Claude exits; unhandled, it would crash the server.
  child.stdin.on("error", (error) => onExit(state, child, error));
  child.on("exit", () => onExit(state, child, new Error("Claude exited")));
  // Sent before the first message, as the Agent SDK does. Older Claude
  // versions without it keep the probe's list.
  control(state, { subtype: "initialize" }).then((response) => {
    if (state.child === child && Array.isArray(response.commands)) emit(state, { type: "pi/commands", commands: rememberCommands(state.cwd, response.commands) });
  }, () => undefined);
  workspaceStatus.notify("claude_runtimes");
}

/**
 * Sends one user message: `text` and `images` (`{ mediaType, data }`, base64).
 * A model or permission mode other than the running process's restarts it
 * (the chat is idle, so nothing is lost).
 */
async function send(state, { text = "", images = [], uuid, model = "", permissionMode = "default" }) {
  if (typeof text !== "string" || !Array.isArray(images) || (!text.trim() && !images.length)) throw fail("invalid_request", "A message is required");
  if (!MODELS.has(model)) throw fail("invalid_request", "Unsupported model");
  if (!PERMISSION_MODES.has(permissionMode)) throw fail("invalid_request", "Unsupported permission mode");
  if (CLEAR_COMMANDS.has(/^\/(\S+)/.exec(text.trim())?.[1])) throw fail("invalid_request", "/clear would move this chat to a new Claude session. Start a new chat instead.");
  if (isBusy(state)) throw fail("session_busy", "Claude is still working on the previous message");
  const id = typeof uuid === "string" && /^[0-9a-f-]{36}$/i.test(uuid) ? uuid : crypto.randomUUID();
  state.starting = true;
  try {
    // Compare the mode with the live one: "Allow for session" can switch it.
    if (state.child && (state.launchModel !== model || state.permissionMode !== permissionMode)) await stopProcess(state);
    // The server may have shut the runtimes down while the old process exited.
    if (sessions.get(state.sessionId) !== state) throw fail("runtime_unavailable", "Claude chat was closed");
    if (!state.child) spawnChild(state, { model, permissionMode });
  } finally { state.starting = false; scheduleIdleShutdown(state); }
  if (!state.title) state.title = text.replace(/\s+/g, " ").trim().slice(0, 120) || "Image";
  cancelIdleShutdown(state);
  state.running = true;
  state.blockIndex = 0;
  // Images go before the text, as Claude Code sends pasted images.
  const blocks = (image) => [...images.map(image), ...(text.trim() ? [{ type: "text", text }] : [])];
  const content = images.length ? blocks(({ mediaType, data }) => ({ type: "image", source: { type: "base64", media_type: mediaType, data } })) : text;
  // Clients get `{ type: "image" }`, as in the transcript history.
  emit(state, { type: "user", uuid: id, timestamp: new Date().toISOString(), message: { role: "user", content: images.length ? blocks(() => ({ type: "image" })) : text } });
  write(state, { type: "user", uuid: id, session_id: "", parent_tool_use_id: null, message: { role: "user", content } });
  workspaceStatus.notify("claude_runtimes");
  return { uuid: id };
}

function control(state, request, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const requestId = `pi-web-${state.nextControlId++}`;
    const timer = setTimeout(() => { if (state.controls.delete(requestId)) reject(fail("runtime_timeout", "Claude did not answer in time")); }, timeoutMs);
    timer.unref?.();
    state.controls.set(requestId, { resolve, reject, timer });
    try { write(state, { type: "control_request", request_id: requestId, request }); } catch (error) { clearTimeout(timer); state.controls.delete(requestId); reject(error); }
  });
}

/** Stops the running turn; Claude ends it with a `result` and keeps the process. */
async function interrupt(state) {
  if (!state.running || !state.child) throw fail("no_active_turn", "No active turn was found");
  state.interrupting = true;
  return control(state, { subtype: "interrupt" }).catch((error) => { state.interrupting = false; throw error; });
}

/**
 * Answers a permission prompt. `decision`: "allow", "allowSession" (also
 * applies Claude's suggested rules, such as accepting edits for the session)
 * or "deny". `updatedInput` replaces the tool input (AskUserQuestion answers).
 */
function respond(state, requestId, { decision, message, updatedInput } = {}) {
  const request = state.incoming.get(String(requestId));
  if (!request) throw fail("approval_expired", "Permission request is no longer pending");
  if (!["allow", "allowSession", "deny"].includes(decision)) throw fail("invalid_request", "Unknown decision");
  const input = updatedInput && typeof updatedInput === "object" && !Array.isArray(updatedInput) ? updatedInput : request.request.input ?? {};
  const response = decision === "deny"
    ? { behavior: "deny", message: typeof message === "string" && message.trim() ? message.trim() : "The user denied this action." }
    : { behavior: "allow", updatedInput: input, ...(decision === "allowSession" && Array.isArray(request.request.permission_suggestions) ? { updatedPermissions: request.request.permission_suggestions } : {}) };
  write(state, { type: "control_response", response: { subtype: "success", request_id: request.request_id, response } });
  state.incoming.delete(String(requestId));
  workspaceStatus.notify("claude_runtimes");
  emit(state, { type: "pi/resolved", requestId: String(requestId), decision });
}

async function stopProcess(state) {
  const child = state.child;
  if (!child) return;
  killChild(state);
  for (const pending of state.controls.values()) { clearTimeout(pending.timer); pending.reject(fail("runtime_unavailable", "Claude was stopped")); }
  state.controls.clear();
  state.running = false;
  state.interrupting = false;
  state.compacting = false;
  state.incoming.clear();
  workspaceStatus.notify("claude_runtimes");
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      timer.unref?.();
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}

/** Stops the session's process (a terminal takes the session over). Open chats stay. */
async function stopAndWait(sessionId) {
  const state = sessions.get(sessionId);
  if (!state?.child) return false;
  await stopProcess(state);
  emit(state, { type: "pi/stopped" });
  scheduleIdleShutdown(state);
  return true;
}
// Server shutdown; stopping first keeps the exits from counting as failed turns.
function shutdownRuntimes() {
  for (const state of sessions.values()) { cancelIdleShutdown(state); if (state.child) killChild(state); }
  sessions.clear();
}

function subscribe(state, listener, afterSeq = 0) {
  cancelIdleShutdown(state);
  if (afterSeq && afterSeq < state.droppedThrough) listener({ type: "pi/reset" });
  else for (const event of state.events) if (event.piSeq > afterSeq) listener(event);
  state.listeners.add(listener);
  workspaceStatus.notify("claude_runtimes");
  return () => { state.listeners.delete(listener); workspaceStatus.notify("claude_runtimes"); scheduleIdleShutdown(state); };
}

function get(sessionId) { return sessions.get(sessionId) ?? null; }
function pendingRequests(state) { return [...state.incoming.values()].map((record) => ({ request_id: record.request_id, request: record.request })); }
/** Set while a Claude process runs for this session (it writes the session file). */
function runtimeForSession(sessionId) {
  const state = sessions.get(sessionId);
  if (!state?.child) return null;
  return { owner: "chat", state: state.incoming.size ? "approval" : state.running ? "running" : "idle", connected: state.listeners.size > 0 };
}
function isBusySession(sessionId) { const state = sessions.get(sessionId); return Boolean(state && isBusy(state)); }
function listRuntimes() {
  return [...sessions.values()].filter((state) => state.child).map((state) => ({ sessionId: state.sessionId, cwd: state.cwd, title: state.title || null, ...runtimeForSession(state.sessionId) }));
}
function describe(state) {
  return { runtimeId: state.runtimeId, running: state.running, compacting: state.compacting, model: state.model, launchModel: state.launchModel, permissionMode: state.permissionMode, process: Boolean(state.child), requests: pendingRequests(state) };
}

module.exports = { configure, commandsFor, open, get, send, interrupt, respond, stopAndWait, shutdownRuntimes, subscribe, runtimeForSession, isBusySession, listRuntimes, describe, handleRecord };

workspaceStatus.registerProvider("claude_runtimes", () => ({ runtimes: listRuntimes() }));
