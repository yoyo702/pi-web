/* eslint-disable @typescript-eslint/no-require-imports */
"use strict"; // PTY manager for optional external agents.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { ensureNodePtySpawnHelper } = require("./ensure-node-pty-helper.cjs");
const workspaceStatus = require("../workspace-status.cjs");
const notifications = require("../notifications.cjs");

const MAX_BUFFER_BYTES = 1024 * 1024;
const MAX_RUNNING_TERMINALS = 20;
const MAX_TERMINAL_RECORDS = 100;
const MAX_COMMAND_HISTORY = 50;
const MAX_COMMAND_CHARS = 8_000;
const PROVIDERS = new Set(["shell", "codex", "claude"]);
const state = global.__piWebTerminalState || { sessions: new Map() };
global.__piWebTerminalState = state;

class TerminalError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function terminalEnvironment(source = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    // These values authenticate the web server itself and must never become
    // visible to a child shell or an external agent CLI.
    if (key.startsWith("PI_WEB_")) continue;
    if (value !== undefined) env[key] = value;
  }
  if (!env.TERM) env.TERM = "xterm-256color";
  if (!env.COLORTERM) env.COLORTERM = "truecolor";
  return env;
}

function assertTerminalCapacity() {
  const sessions = [...state.sessions.values()];
  if (sessions.filter((session) => session.state === "running").length >= MAX_RUNNING_TERMINALS) {
    throw new TerminalError("terminal_limit", `At most ${MAX_RUNNING_TERMINALS} terminals can run at once; stop one before starting another`);
  }
  if (sessions.length >= MAX_TERMINAL_RECORDS) {
    throw new TerminalError("terminal_record_limit", `Terminal history contains ${MAX_TERMINAL_RECORDS} records; clear ended terminals before starting another`);
  }
}

function getPty() {
  try {
    ensureNodePtySpawnHelper();
    return require("node-pty");
  } catch (error) {
    throw new TerminalError("runtime_unavailable", `Terminal runtime unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function executableFor(provider) {
  if (!PROVIDERS.has(provider)) throw new TerminalError("invalid_provider", "provider must be shell, codex, or claude");
  if (provider === "shell") return process.platform === "win32" ? process.env.COMSPEC || "cmd.exe" : process.env.SHELL || "/bin/bash";
  return process.platform === "win32" ? `${provider}.cmd` : provider;
}

function resolveExecutable(executable, provider) {
  if (path.isAbsolute(executable) || executable.includes(path.sep)) return executable;
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    const candidate = path.join(directory, executable);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new TerminalError("cli_missing", `${provider} CLI was not found on PATH`);
}

// `--help` probing blocks the server's main thread (up to 5 s), so remember
// the answer per executable until the binary itself changes (e.g. upgrade).
const helpTextCache = global.__piWebCliHelpCache || new Map();
global.__piWebCliHelpCache = helpTextCache;
function cliHelpText(provider, executable) {
  let signature = null;
  try { const stat = fs.statSync(executable); signature = `${stat.mtimeMs}:${stat.size}`; } catch { /* resolved via PATH or missing */ }
  const cached = helpTextCache.get(executable);
  if (signature && cached?.signature === signature) return cached.help;
  const result = spawnSync(executable, ["--help"], { encoding: "utf8", timeout: 5000, windowsHide: true });
  if (result.error && result.error.code === "ENOENT") {
    throw new TerminalError("cli_missing", `${provider} CLI was not found on PATH`);
  }
  const help = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (signature && !result.error) helpTextCache.set(executable, { signature, help });
  return help;
}

function assertSkipPermissionsSupported(provider, executable) {
  const flag = provider === "claude" ? "--dangerously-skip-permissions" : "--dangerously-bypass-approvals-and-sandbox";
  const help = cliHelpText(provider, executable);
  if (!help.includes(flag)) {
    throw new TerminalError("permission_mode_unsupported", `${provider} does not support ${flag}; update the CLI or use interactive permission confirmation`);
  }
  return flag;
}

function appendOutput(session, data) {
  const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
  session.chunks.push(chunk);
  session.bufferBytes += chunk.length;
  while (session.bufferBytes > MAX_BUFFER_BYTES && session.chunks.length > 1) {
    session.bufferBytes -= session.chunks.shift().length;
    session.truncated = true;
  }
  for (const subscriber of session.subscribers) {
    try { subscriber(chunk); } catch { /* disconnected subscriber */ }
  }
  workspaceStatus.notify("terminals", { throttled: true });
}

function recordTerminalInput(session, data) {
  session.history ||= [];
  session.pendingInput ||= "";
  if (data.startsWith("\x1b")) return;
  for (const character of data) {
    if (character === "\r" || character === "\n") {
      const command = session.pendingInput.trim();
      if (command) {
        session.history = [command, ...session.history.filter((item) => item !== command)].slice(0, MAX_COMMAND_HISTORY);
        workspaceStatus.notify("terminals", { throttled: true });
      }
      session.pendingInput = "";
    } else if (character === "\x7f" || character === "\b") {
      session.pendingInput = session.pendingInput.slice(0, -1);
    } else if (character === "\x03" || character === "\x15") {
      session.pendingInput = "";
    } else if (character >= " ") {
      session.pendingInput = (session.pendingInput + character).slice(-MAX_COMMAND_CHARS);
    }
  }
}

function publicSession(session) {
  return {
    id: session.id,
    provider: session.provider,
    title: session.title || (session.provider === "shell" ? "Terminal" : `${session.provider} terminal`),
    cwd: session.cwd,
    pid: session.pid,
    permissionMode: session.permissionMode,
    launchMode: session.launchMode,
    noAltScreen: session.noAltScreen,
    sourceSessionId: session.sourceSessionId || null,
    chatMode: session.chatMode === true,
    model: session.model || null,
    webSearch: session.webSearch === true,
    initialPrompt: session.initialPrompt || null,
    cols: session.cols,
    rows: session.rows,
    state: session.state,
    createdAt: session.createdAt,
    endedAt: session.endedAt || null,
    exitCode: session.exitCode ?? null,
    signal: session.signal ?? null,
    bufferBytes: session.bufferBytes,
    bufferTruncated: session.truncated,
    history: [...(session.history || [])],
  };
}

function buildLaunchArgs(provider, executable, permissionMode, launchMode, noAltScreen, sourceSessionId, model, webSearch, initialPrompt) {
  if (provider === "shell") return process.platform === "win32" ? [] : ["-l"];
  if (!["new", "resume-last", "resume", "fork"].includes(launchMode)) {
    throw new TerminalError("invalid_launch_mode", "launchMode is invalid");
  }
  if (provider === "claude") {
    if (launchMode !== "new") throw new TerminalError("unsupported_launch_mode", "Claude resume is not available from this terminal launcher yet");
    if (permissionMode !== "confirm" && permissionMode !== "bypass") throw new TerminalError("invalid_permission_mode", "Claude supports confirm or bypass permission mode");
    return permissionMode === "bypass" ? [assertSkipPermissionsSupported(provider, executable)] : [];
  }

  if (!["confirm", "on-request", "never", "bypass"].includes(permissionMode)) {
    throw new TerminalError("invalid_permission_mode", "Codex permission mode is invalid");
  }
  if ((launchMode === "resume" || launchMode === "fork") && (typeof sourceSessionId !== "string" || !/^[0-9a-f-]{16,}$/i.test(sourceSessionId))) {
    throw new TerminalError("invalid_session", "A Codex session id is required for this launch mode");
  }
  const args = launchMode === "resume-last" ? ["resume", "--last"]
    : launchMode === "resume" ? ["resume", sourceSessionId]
    : launchMode === "fork" ? ["fork", sourceSessionId]
    : [];
  if (typeof model === "string" && model.trim()) {
    if (model.length > 120 || !/^[A-Za-z0-9._:/-]+$/.test(model)) throw new TerminalError("invalid_model", "Codex model contains unsupported characters");
    args.push("--model", model.trim());
  }
  if (webSearch === true) args.push("--search");
  if (noAltScreen) args.push("--no-alt-screen");
  if (permissionMode === "bypass") {
    args.push(assertSkipPermissionsSupported(provider, executable));
  } else {
    const approval = permissionMode === "confirm" ? "untrusted" : permissionMode;
    args.push("--sandbox", "workspace-write", "--ask-for-approval", approval);
  }
  if (typeof initialPrompt === "string" && initialPrompt.trim()) {
    if (initialPrompt.length > 8_000) throw new TerminalError("invalid_prompt", "Initial prompt must be at most 8000 characters");
    // A prompt starting with "-" would otherwise be parsed as a Codex option
    // (e.g. `-c key=value` config overrides).
    if (initialPrompt.trim().startsWith("-")) args.push("--");
    args.push(initialPrompt.trim());
  }
  return args;
}

function createTerminal({ provider, cwd, title, cols = 100, rows = 30, permissionMode = "confirm", launchMode = "new", noAltScreen = provider === "codex", sourceSessionId, model, webSearch = false, initialPrompt, chatMode = false }) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2 || cols > 500 || rows > 300) {
    throw new TerminalError("invalid_size", "terminal cols and rows must be between 2 and 500/300");
  }
  assertTerminalCapacity();
  const executable = resolveExecutable(executableFor(provider), provider);
  const args = buildLaunchArgs(provider, executable, permissionMode, launchMode, noAltScreen, sourceSessionId, model, webSearch, initialPrompt);
  const pty = getPty();
  const env = terminalEnvironment();

  let terminal;
  try {
    terminal = pty.spawn(executable, args, { name: "xterm-256color", cols, rows, cwd, env });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ENOENT|not found/i.test(message)) throw new TerminalError("cli_missing", `${provider} CLI was not found on PATH`);
    throw new TerminalError("spawn_failed", `Unable to start ${provider}: ${message}`);
  }

  const defaultTitle = provider === "shell" ? `Terminal ${[...state.sessions.values()].filter((item) => item.provider === "shell" && item.cwd === cwd).length + 1}` : `${provider} terminal`;
  const session = {
    id: crypto.randomUUID(), provider, title: typeof title === "string" && title.trim() ? title.trim().slice(0, 80) : defaultTitle, cwd, pid: terminal.pid, permissionMode, launchMode, noAltScreen, sourceSessionId, model, webSearch, initialPrompt, chatMode, cols, rows,
    state: "running", createdAt: new Date().toISOString(), endedAt: null, exitCode: null, signal: null,
    terminal, chunks: [], bufferBytes: 0, truncated: false, subscribers: new Set(), history: [], pendingInput: "",
  };
  state.sessions.set(session.id, session);
  workspaceStatus.notify("terminals");
  terminal.onData((data) => appendOutput(session, data));
  terminal.onExit(({ exitCode, signal }) => {
    session.state = session.state === "stopped" ? "stopped" : "ended";
    session.exitCode = exitCode;
    session.signal = signal;
    session.endedAt = new Date().toISOString();
    session.terminal = null;
    for (const subscriber of session.subscribers) {
      try { subscriber(null); } catch { /* ignore */ }
    }
    workspaceStatus.notify("terminals");
    recordExit(session);
  });
  return publicSession(session);
}

// A terminal the user stopped, or a shell they exited normally, needs no notice.
function recordExit(session) {
  if (session.state === "stopped") return;
  const failed = (session.exitCode ?? 0) !== 0 || Boolean(session.signal);
  if (!failed && session.provider === "shell") return;
  notifications.add({
    kind: "terminal",
    event: failed ? "failed" : "completed",
    targetId: session.id,
    cwd: session.cwd,
    title: session.title,
    ...(failed ? { detail: session.signal && !session.exitCode ? `Killed by signal ${session.signal}` : `Exited with code ${session.exitCode}` } : {}),
  });
}

function lookup(id) {
  const session = state.sessions.get(id);
  if (!session) throw new TerminalError("not_found", "terminal session not found");
  return session;
}

function listTerminals(cwd) {
  return [...state.sessions.values()]
    .filter((session) => !cwd || session.cwd === cwd)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(publicSession);
}

function terminalStats(cwd) {
  const all = [...state.sessions.values()];
  const workspace = cwd ? all.filter((session) => session.cwd === cwd) : all;
  const summarize = (sessions) => ({
    running: sessions.filter((session) => session.state === "running").length,
    records: sessions.length,
    bufferBytes: sessions.reduce((total, session) => total + (session.bufferBytes || 0), 0),
  });
  return { global: summarize(all), workspace: summarize(workspace), limits: { running: MAX_RUNNING_TERMINALS, records: MAX_TERMINAL_RECORDS } };
}

function getTerminal(id) { return publicSession(lookup(id)); }
function renameTerminal(id, title) { const session = lookup(id); if (typeof title !== "string" || !title.trim()) throw new TerminalError("invalid_title", "terminal title is required"); session.title = title.trim().slice(0, 80); workspaceStatus.notify("terminals"); return publicSession(session); }
function getBuffer(id) { const session = lookup(id); return { data: Buffer.concat(session.chunks), truncated: session.truncated, state: session.state }; }
// A `resume` terminal writes to its source session; a `fork` terminal writes
// to a new session and only reads the source.
function writesSession(session, sessionId) {
  return session.provider === "codex" && session.state === "running" && session.launchMode === "resume" && session.sourceSessionId === sessionId;
}
function runtimeForSession(sourceSessionId) {
  const session = [...state.sessions.values()].find((candidate) => writesSession(candidate, sourceSessionId));
  return session ? { owner: "terminal", state: "running", terminalId: session.id } : null;
}

function inputTerminal(id, data) {
  const session = lookup(id);
  if (session.state !== "running" || !session.terminal) throw new TerminalError("not_running", "terminal session has ended");
  const value = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
  if (Buffer.byteLength(value) > 64 * 1024) throw new TerminalError("input_too_large", "terminal input is limited to 64 KiB");
  recordTerminalInput(session, value);
  session.terminal.write(value);
}

function resizeTerminal(id, cols, rows) {
  const session = lookup(id);
  if (session.state !== "running" || !session.terminal) throw new TerminalError("not_running", "terminal session has ended");
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2 || cols > 500 || rows > 300) {
    throw new TerminalError("invalid_size", "terminal cols and rows must be between 2 and 500/300");
  }
  session.cols = cols;
  session.rows = rows;
  session.terminal.resize(cols, rows);
  workspaceStatus.notify("terminals", { throttled: true });
}

function stopTerminal(id) {
  const session = lookup(id);
  if (session.state !== "running" || !session.terminal) return publicSession(session);
  session.state = "stopped";
  workspaceStatus.notify("terminals");
  try {
    if (process.platform !== "win32" && session.pid > 0) process.kill(-session.pid, "SIGTERM");
  } catch { /* pty.kill is the portable fallback */ }
  try { session.terminal.kill(); } catch { /* process already exited */ }
  return publicSession(session);
}

function removeTerminal(id) {
  const session = lookup(id);
  if (session.state === "running") throw new TerminalError("still_running", "stop the terminal before removing its record");
  session.subscribers.clear();
  state.sessions.delete(id);
  workspaceStatus.notify("terminals");
  return publicSession(session);
}

function clearEndedTerminals({ cwd, provider } = {}) {
  const removedIds = [];
  for (const [id, session] of state.sessions) {
    if (session.state === "running" || (cwd && session.cwd !== cwd) || (provider && session.provider !== provider)) continue;
    session.subscribers.clear();
    state.sessions.delete(id);
    removedIds.push(id);
  }
  if (removedIds.length > 0) workspaceStatus.notify("terminals");
  return removedIds;
}

function stopTerminalsForSession(sourceSessionId) {
  for (const session of state.sessions.values()) {
    if (writesSession(session, sourceSessionId)) {
      stopTerminal(session.id);
    }
  }
}

// Codex terminals whose session is unknown (`new`, `resume-last`, `fork`)
// may be writing any session in their directory.
function isUnknownCodexWriter(session, cwd) {
  return session.provider === "codex" && session.state === "running" && session.launchMode !== "resume" && session.cwd === cwd;
}
function unknownCodexTerminals(cwd) {
  return [...state.sessions.values()].filter((session) => isUnknownCodexWriter(session, cwd)).map(publicSession);
}
async function interruptAndStopTerminalsForSession(sourceSessionId, { cwd } = {}) {
  const matching = [...state.sessions.values()].filter((session) => writesSession(session, sourceSessionId) || (cwd && isUnknownCodexWriter(session, cwd)));
  if (!matching.length) return false;
  // Let Codex cancel and persist an approval/current turn before termination.
  for (const session of matching) {
    try { session.terminal?.write("\x03"); } catch { /* terminal may already be exiting */ }
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  for (const session of matching) {
    try { stopTerminal(session.id); } catch { /* best-effort takeover */ }
  }
  return true;
}

function subscribeTerminal(id, callback) {
  const session = lookup(id);
  session.subscribers.add(callback);
  return () => session.subscribers.delete(callback);
}

function snapshotAndSubscribeTerminal(id, callback) {
  const session = lookup(id);
  // Register first. JavaScript cannot interleave a PTY callback between this
  // subscription and the synchronous snapshot below, so every byte is either
  // present in the snapshot or delivered to the subscriber.
  session.subscribers.add(callback);
  return {
    snapshot: { data: Buffer.concat(session.chunks), truncated: session.truncated, state: session.state },
    unsubscribe: () => session.subscribers.delete(callback),
  };
}

function shutdownTerminals() {
  for (const session of state.sessions.values()) {
    try { stopTerminal(session.id); } catch { /* best effort */ }
  }
}

module.exports = { TerminalError, terminalEnvironment, createTerminal, listTerminals, terminalStats, getTerminal, renameTerminal, getBuffer, runtimeForSession, inputTerminal, resizeTerminal, stopTerminal, removeTerminal, clearEndedTerminals, stopTerminalsForSession, interruptAndStopTerminalsForSession, unknownCodexTerminals, subscribeTerminal, snapshotAndSubscribeTerminal, shutdownTerminals };

workspaceStatus.registerProvider("terminals", () => ({ terminals: listTerminals(), limits: terminalStats().limits }));
