/* eslint-disable @typescript-eslint/no-require-imports */
"use strict"; // External agent terminal API.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const manager = require("./terminal-manager.cjs");
const codexAppServer = require("./codex-app-server.cjs");

const state = global.__piWebTerminalAuthorization || { roots: new Set() };
global.__piWebTerminalAuthorization = state;

function json(res, status, value, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(value));
}
function errorResponse(res, error) {
  const code = error?.code;
  const status = code === "not_found" ? 404 : code === "terminal_limit" || code === "terminal_record_limit" ? 429 : code === "not_running" || code === "still_running" || code === "chat_input_owned" ? 409 : code === "forbidden_cwd" ? 403 : code === "cli_missing" || code === "runtime_unavailable" ? 503 : 400;
  json(res, status, { error: error?.message || "terminal request failed", code });
}
function readJson(req) {
  return new Promise((resolve, reject) => { let body = ""; req.on("data", (chunk) => { body += chunk; if (body.length > 65536) reject(new Error("request too large")); }); req.on("end", () => { try { resolve(JSON.parse(body)); } catch { reject(new Error("invalid request body")); } }); req.on("error", reject); });
}
function addRoot(root) { state.roots.add(path.resolve(root)); }
function registerCwd(cwd) {
  if (typeof cwd !== "string" || !cwd) throw Object.assign(new Error("Path is required"), { code: "invalid_cwd" });
  let canonical;
  try { canonical = fs.realpathSync(path.resolve(cwd)); } catch { throw Object.assign(new Error(`Directory does not exist: ${cwd}`), { code: "invalid_cwd" }); }
  if (!fs.statSync(canonical).isDirectory()) throw Object.assign(new Error(`Path is not a directory: ${cwd}`), { code: "invalid_cwd" });
  addRoot(canonical);
  return canonical;
}
function sessionRoots() {
  const roots = new Set(state.roots);
  const sessionBase = path.join(os.homedir(), ".pi", "agent", "sessions");
  try {
    for (const dir of fs.readdirSync(sessionBase)) {
      const directory = path.join(sessionBase, dir);
      for (const file of fs.readdirSync(directory)) {
        if (!file.endsWith(".jsonl")) continue;
        try {
          const first = fs.readFileSync(path.join(directory, file), "utf8").split("\n", 1)[0];
          const header = JSON.parse(first);
          if (typeof header.cwd === "string") roots.add(path.resolve(header.cwd));
        } catch { /* malformed historical session */ }
      }
    }
  } catch { /* no sessions yet */ }
  try {
    for (const name of fs.readdirSync(os.homedir())) if (/^pi-cwd-\d{8}$/.test(name)) roots.add(path.join(os.homedir(), name));
  } catch { /* ignore */ }
  return roots;
}
function authorizedCwd(cwd) {
  if (typeof cwd !== "string" || !cwd) throw Object.assign(new Error("cwd is required"), { code: "invalid_cwd" });
  let target;
  try { target = fs.realpathSync(path.resolve(cwd)); } catch { throw Object.assign(new Error("terminal working directory does not exist"), { code: "invalid_cwd" }); }
  const allowed = [...sessionRoots()].some((root) => {
    try { const canonicalRoot = fs.realpathSync(root); const relative = path.relative(canonicalRoot, target); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".."); } catch { return false; }
  });
  if (!allowed) throw Object.assign(new Error("terminal working directory is not an authorized workspace"), { code: "forbidden_cwd" });
  return target;
}
async function claimCodexSession(sourceSessionId) { return manager.interruptAndStopTerminalsForSession(sourceSessionId); }
function isTerminalPath(pathname) { return pathname === "/api/terminals" || /^\/api\/terminals\/[^/]+(?:\/(?:input|resize|stop|buffer))?$/.test(pathname); }

async function handleTerminalRequest(req, res, url) {
  try {
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.pathname === "/api/terminals" && req.method === "GET") {
      const requestedCwd = url.searchParams.get("cwd");
      const cwd = requestedCwd ? authorizedCwd(requestedCwd) : undefined;
      return json(res, 200, { terminals: manager.listTerminals(cwd), stats: manager.terminalStats(cwd) });
    }
    if (url.pathname === "/api/terminals" && req.method === "DELETE") {
      const requestedCwd = url.searchParams.get("cwd");
      const provider = url.searchParams.get("provider");
      if (provider && provider !== "shell" && provider !== "codex" && provider !== "claude") throw Object.assign(new Error("invalid terminal provider"), { code: "invalid_provider" });
      return json(res, 200, { removedIds: manager.clearEndedTerminals({ cwd: requestedCwd ? authorizedCwd(requestedCwd) : undefined, provider: provider || undefined }) });
    }
    if (url.pathname === "/api/terminals" && req.method === "POST") {
      const body = await readJson(req);
      const cwd = authorizedCwd(body.cwd);
      if (body.provider === "codex" && typeof body.sourceSessionId === "string") {
        if (codexAppServer.isAttached(body.sourceSessionId)) throw Object.assign(new Error("Close Codex Chat before starting a Terminal for this session"), { code: "chat_input_owned" });
        await codexAppServer.stopAndWait(body.sourceSessionId);
      }
      const terminal = manager.createTerminal({ provider: body.provider, cwd, cols: body.cols ?? 100, rows: body.rows ?? 30, permissionMode: body.permissionMode ?? "confirm", launchMode: body.launchMode ?? "new", noAltScreen: body.noAltScreen ?? body.provider === "codex", sourceSessionId: body.sourceSessionId, model: body.model, webSearch: body.webSearch, initialPrompt: body.initialPrompt, chatMode: body.chatMode === true });
      return json(res, 201, { terminal });
    }
    const id = parts[2];
    const action = parts[3];
    if (!id) return json(res, 404, { error: "not found" });
    if (!action && req.method === "GET") { const terminal = manager.getTerminal(id); return json(res, 200, { terminal: { ...terminal, chatInputOwned: Boolean(terminal.sourceSessionId && codexAppServer.isClaimed(terminal.sourceSessionId)) } }); }
    if (!action && req.method === "DELETE") return json(res, 200, { terminal: manager.removeTerminal(id) });
    if (!action && req.method === "PATCH") { const body = await readJson(req); return json(res, 200, { terminal: manager.renameTerminal(id, body.title) }); }
    if (action === "buffer" && req.method === "GET") {
      const result = manager.getBuffer(id);
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Cache-Control": "no-store", "X-Pi-Terminal-Truncated": result.truncated ? "1" : "0", "X-Pi-Terminal-State": result.state });
      return res.end(result.data);
    }
    if (action === "input" && req.method === "POST") { const body = await readJson(req); if (typeof body.data !== "string") throw Object.assign(new Error("data must be a string"), { code: "invalid_input" }); const terminal = manager.getTerminal(id); if (terminal.sourceSessionId && codexAppServer.isClaimed(terminal.sourceSessionId)) throw Object.assign(new Error("Codex Chat currently owns input for this session"), { code: "chat_input_owned" }); manager.inputTerminal(id, body.data); res.writeHead(204); return res.end(); }
    if (action === "resize" && req.method === "POST") { const body = await readJson(req); manager.resizeTerminal(id, body.cols, body.rows); res.writeHead(204); return res.end(); }
    if (action === "stop" && req.method === "POST") return json(res, 200, { terminal: manager.stopTerminal(id) });
    return json(res, 405, { error: "method not allowed" });
  } catch (error) { return errorResponse(res, error); }
}

module.exports = { isTerminalPath, handleTerminalRequest, addRoot, registerCwd, authorizedCwd, claimCodexSession };
