#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const os = require("node:os");
const next = require("next");
const auth = require("./auth.cjs");
const { readJsonBody, readFormBody } = require("./http-body.cjs");

const root = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const dev = args[0] === "dev";
const portIndex = args.findIndex((arg) => arg === "-p" || arg === "--port");
const hostIndex = args.findIndex((arg) => arg === "-H" || arg === "--hostname");
const port = Number(portIndex >= 0 ? args[portIndex + 1] : process.env.PORT || 30141);
const hostname = hostIndex >= 0 ? args[hostIndex + 1] : process.env.HOSTNAME || "127.0.0.1";
const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const isLoopback = loopbackHosts.has(hostname);
const tls = process.env.PI_WEB_HTTPS_CERT && process.env.PI_WEB_HTTPS_KEY ? { cert: fs.readFileSync(process.env.PI_WEB_HTTPS_CERT), key: fs.readFileSync(process.env.PI_WEB_HTTPS_KEY) } : null;
// Pi custom tools (running in this process via Next route handlers) use this
// capability to call the terminal owner. It lives on `global` rather than
// process.env so agent bash commands and spawned CLIs cannot read it.
global.__piWebInternalTerminalToken ||= crypto.randomBytes(32).toString("base64url");
delete process.env.PI_WEB_INTERNAL_TERMINAL_TOKEN;
process.env.PI_WEB_INTERNAL_PORT = String(port);
// Expose only non-secret runtime binding metadata to Next route workers. The
// access-link dialog uses this to avoid claiming an address is reachable when
// the server is bound to loopback only.
process.env.PI_WEB_RUNTIME_HOST = hostname;
process.env.PI_WEB_RUNTIME_PORT = String(port);
process.env.PI_WEB_RUNTIME_PROTOCOL = tls ? "https" : "http";
if (!isLoopback && !auth.configured()) {
  console.error("PI_WEB_PASSWORD must be set when TianForge pi listens on a non-loopback host.");
  process.exit(1);
}

let handle;

function writeJson(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function writeLoginPage(res, status = 200, errorMessage = "") {
  const error = errorMessage ? `<p role="alert" class="error">${String(errorMessage).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</p>` : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><title>Sign in to TianForge pi</title><style>:root{color-scheme:dark;--bg:#111318;--panel:#191c22;--border:#30343d;--text:#f2f3f5;--muted:#a6acb8;--accent:#2563eb}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,sans-serif}main{min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:20px}form{width:min(100%,360px);padding:24px;border:1px solid var(--border);border-radius:10px;background:var(--panel);box-shadow:0 14px 40px #0003}h1{margin:0;font-size:18px}h1 small{margin-left:.32em;color:var(--muted);font-size:.56em;font-weight:650;letter-spacing:.02em}p{margin:8px 0 20px;color:var(--muted);font-size:13px;line-height:1.5}label{display:grid;gap:7px;color:var(--muted);font-size:12px}input{width:100%;padding:10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font:inherit}button{width:100%;margin-top:18px;padding:10px 12px;border:0;border-radius:6px;background:var(--accent);color:#fff;font-weight:600}.error{margin:12px 0 0;color:#f87171;font-size:12px}</style></head><body><main><form action="/login" method="post"><h1>Sign in to TianForge<small>pi</small></h1><p>This TianForge instance is password protected. Signing in grants access to local projects and terminal sessions.</p><label>Password<input autofocus name="password" type="password" autocomplete="current-password" required></label>${error}<button type="submit">Sign in</button></form></main></body></html>`;
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(html), "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", "X-Content-Type-Options": "nosniff" });
  res.end(html);
}

function writePairingErrorPage(res, message) {
  const safeMessage = String(message).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><title>TianForge pairing</title><style>:root{color-scheme:dark;--bg:#111318;--panel:#191c22;--border:#30343d;--text:#f2f3f5;--muted:#a6acb8;--accent:#2563eb}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,sans-serif}main{min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:20px}section{width:min(100%,360px);padding:24px;border:1px solid var(--border);border-radius:10px;background:var(--panel);box-shadow:0 14px 40px #0003}h1{margin:0;font-size:18px}h1 small{margin-left:.32em;color:var(--muted);font-size:.56em}p{margin:10px 0 18px;color:var(--muted);font-size:13px;line-height:1.5}a{display:block;padding:10px 12px;border-radius:6px;background:var(--accent);color:#fff;text-align:center;text-decoration:none;font-weight:600}</style></head><body><main><section><h1>TianForge<small>pi</small></h1><p>${safeMessage}</p><a href="/login">Use password instead</a></section></main></body></html>`;
  res.writeHead(401, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(html), "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; navigate-to 'self'; base-uri 'none'; frame-ancestors 'none'", "X-Content-Type-Options": "nosniff" });
  res.end(html);
}

function readJson(req) {
  return readJsonBody(req, 16 * 1024);
}

function readForm(req) {
  return readFormBody(req, 16 * 1024);
}

// DNS rebinding defense: a hostile page whose domain resolves to 127.0.0.1
// sends matching Origin/Host headers, so same-origin checks alone are not
// enough. Only accept Host names that actually belong to this machine, plus
// anything listed in PI_WEB_ALLOWED_HOSTS (defaults to Tailscale Serve names;
// entries starting with "*." match any subdomain).
const extraAllowedHosts = String(process.env.PI_WEB_ALLOWED_HOSTS ?? "*.ts.net").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
// isAllowedHost runs for every request, so snapshot this machine's names and
// interface addresses instead of querying the OS each time. Refreshing keeps
// newly acquired LAN/Tailscale addresses working without a restart.
const LOCAL_HOST_REFRESH_MS = 30_000;
let localHostNames = null;
let localHostNamesAt = 0;
function getLocalHostNames() {
  const now = Date.now();
  if (localHostNames && now - localHostNamesAt < LOCAL_HOST_REFRESH_MS) return localHostNames;
  const machine = os.hostname().toLowerCase();
  const names = new Set([...loopbackHosts, hostname.toLowerCase(), machine, `${machine.replace(/\.local$/, "")}.local`]);
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      const value = address.address.toLowerCase();
      names.add(address.family === "IPv6" ? `[${value}]` : value);
    }
  }
  localHostNames = names;
  localHostNamesAt = now;
  return names;
}
function hostnameOf(hostHeader) {
  const value = String(hostHeader || "").toLowerCase();
  if (value.startsWith("[")) return value.slice(0, value.indexOf("]") + 1);
  return value.replace(/:\d+$/, "");
}
function isAllowedHost(hostHeader) {
  const name = hostnameOf(hostHeader);
  if (!name) return false;
  if (getLocalHostNames().has(name)) return true;
  return extraAllowedHosts.some((allowed) => allowed.startsWith("*.") ? name.endsWith(allowed.slice(1)) : name === allowed);
}

function loginRequestMetadata(req) {
  let refererHost = null;
  try { refererHost = req.headers.referer ? new URL(req.headers.referer).host : null; } catch { refererHost = "invalid"; }
  return { host: req.headers.host || null, origin: req.headers.origin || null, fetchSite: req.headers["sec-fetch-site"] || null, refererHost };
}

function isOpaqueLoginForm(req) {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  return req.headers.origin === "null"
    && !req.headers["sec-fetch-site"]
    && !req.headers.referer
    && contentType.startsWith("application/x-www-form-urlencoded");
}

async function handleAuthRequest(req, res, url) {
  if (url.pathname === "/pair" && req.method === "GET") {
    if (!auth.configured()) {
      res.writeHead(303, { Location: "/", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
      res.end();
      return;
    }
    const session = auth.redeemPairingToken(url.searchParams.get("token"));
    if (!session) return writePairingErrorPage(res, "This sign-in QR code has expired or was already used. Generate a new one from your computer.");
    res.writeHead(303, { Location: "/", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Set-Cookie": auth.cookieValue(session.token, session.expiresAt, url.protocol === "https:") });
    res.end();
    return;
  }
  if (url.pathname === "/api/auth/pair" && req.method === "POST") {
    if (!auth.configured()) return writeJson(res, 200, { passwordRequired: false });
    if (!auth.getSessionFromRequest(req)) return writeJson(res, 401, { error: "authentication required" });
    if (!auth.isSameOrigin(req)) return writeJson(res, 403, { error: "cross-origin request rejected" });
    const pairing = auth.createPairingToken();
    return writeJson(res, 200, { passwordRequired: true, ...pairing });
  }
  if (url.pathname === "/login" && req.method === "GET") {
    if (url.searchParams.has("password")) {
      res.writeHead(303, { Location: "/login", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
      res.end();
      return;
    }
    if (auth.configured() && auth.getSessionFromRequest(req)) { res.writeHead(303, { Location: "/" }); res.end(); return; }
    writeLoginPage(res);
    return;
  }
  if (url.pathname === "/login" && req.method === "POST") {
    if (!auth.isSameOrigin(req) && !isOpaqueLoginForm(req)) {
      console.warn("[pi-web auth] rejected login origin", loginRequestMetadata(req));
      return writeLoginPage(res, 403, "This browser sent an unexpected origin. Reload this login page and try again.");
    }
    if (!auth.configured()) { res.writeHead(303, { Location: "/" }); res.end(); return; }
    const key = auth.clientKey(req);
    if (auth.isRateLimited(key)) return writeLoginPage(res, 429, "Too many failed login attempts; try again later.");
    let body;
    try { body = await readForm(req); } catch (error) { return writeLoginPage(res, 400, error.message); }
    if (!auth.verifyPassword(body?.password)) {
      auth.recordFailure(key);
      return writeLoginPage(res, 401, "Invalid password.");
    }
    auth.clearFailures(key);
    const { token, expiresAt } = auth.createSession();
    res.writeHead(303, { Location: "/", "Cache-Control": "no-store", "Set-Cookie": auth.cookieValue(token, expiresAt, url.protocol === "https:") });
    res.end();
    return;
  }
  if (url.pathname === "/api/auth/session" && req.method === "GET") {
    writeJson(res, 200, { authenticated: auth.configured() ? Boolean(auth.getSessionFromRequest(req)) : true, passwordRequired: auth.configured() });
    return;
  }
  if (url.pathname === "/api/auth/logout" && req.method === "POST") {
    if (!auth.isSameOrigin(req)) return writeJson(res, 403, { error: "cross-origin mutation rejected" });
    auth.revokeSessionFromRequest(req);
    return writeJson(res, 200, { authenticated: false }, { "Set-Cookie": auth.clearCookie(url.protocol === "https:") });
  }
  if (url.pathname === "/api/auth/login" && req.method === "POST") {
    if (!auth.isSameOrigin(req)) return writeJson(res, 403, { error: "cross-origin mutation rejected" });
    if (!auth.configured()) return writeJson(res, 200, { authenticated: true, passwordRequired: false });
    const key = auth.clientKey(req);
    if (auth.isRateLimited(key)) return writeJson(res, 429, { error: "too many failed login attempts; try again later" });
    let body;
    try { body = await readJson(req); } catch (error) { return writeJson(res, 400, { error: error.message }); }
    if (!auth.verifyPassword(body?.password)) {
      auth.recordFailure(key);
      return writeJson(res, 401, { error: "invalid password" });
    }
    auth.clearFailures(key);
    const { token, expiresAt } = auth.createSession();
    return writeJson(res, 200, { authenticated: true, passwordRequired: true }, { "Set-Cookie": auth.cookieValue(token, expiresAt, url.protocol === "https:") });
  }
  writeJson(res, 405, { error: "method not allowed" });
}
const server = (tls ? https : http).createServer(tls || undefined, (req, res) => {
  // Route handlers return their promises so both synchronous throws and
  // rejected async work (e.g. auth handlers after an await) land here.
  Promise.resolve().then(() => handleRequest(req, res)).catch((error) => {
    console.error("[pi-web] request failed", error);
    if (!res.headersSent) writeJson(res, 500, { error: "internal server error" });
    else res.destroy();
  });
});

function handleRequest(req, res) {
  if (!isAllowedHost(req.headers.host)) {
    return writeJson(res, 421, { error: "unrecognized Host header; set PI_WEB_ALLOWED_HOSTS to allow it" });
  }
  if (!handle) {
    res.statusCode = 503;
    res.end("TianForge pi is starting");
    return;
  }

  const url = new URL(req.url || "/", `${tls ? "https" : "http"}://${req.headers.host || hostname}`);
  if (/Mobile|Android|iPhone|iPad/i.test(String(req.headers["user-agent"] || ""))) {
    res.once("finish", () => console.log("[pi-web mobile]", req.method, url.pathname, res.statusCode));
  }
  if (url.pathname === "/api/client-error" && req.method === "POST") {
    if (auth.configured() && !auth.getSessionFromRequest(req)) return writeJson(res, 401, { error: "authentication required" });
    void readJson(req).then((body) => {
      const diagnostic = { type: String(body?.type || "error").slice(0, 40), message: String(body?.message || "Unknown client error").slice(0, 500), file: String(body?.file || "").slice(0, 300), line: Number(body?.line) || 0, column: Number(body?.column) || 0, userAgent: String(body?.userAgent || req.headers["user-agent"] || "").slice(0, 300) };
      console.warn("[pi-web client error]", diagnostic);
      writeJson(res, 204, {});
    }).catch(() => writeJson(res, 400, { error: "invalid diagnostic" }));
    return;
  }
  const isPiWebAuthRoute = url.pathname === "/api/auth/session" || url.pathname === "/api/auth/login" || url.pathname === "/api/auth/logout" || url.pathname === "/api/auth/pair" || url.pathname === "/login" || url.pathname === "/pair";
  if (isPiWebAuthRoute) {
    return handleAuthRequest(req, res, url);
  }
  const terminalApi = require("./agents/terminal-api.cjs");
  if (terminalApi.isTerminalPath(url.pathname)) {
    const internal = auth.safeEqual(req.headers["x-pi-web-internal"], global.__piWebInternalTerminalToken);
    if (!internal && auth.configured() && !auth.getSessionFromRequest(req)) return writeJson(res, 401, { error: "authentication required" });
    if (!internal && !auth.isSameOrigin(req)) return writeJson(res, 403, { error: "cross-origin mutation rejected" });
    return terminalApi.handleTerminalRequest(req, res, url);
  }
  const publicPath = url.pathname === "/login"
    || isPiWebAuthRoute
    // Only immutable build assets are public. Other /_next/ endpoints (e.g.
    // the image optimizer, which can fetch local API routes) need a session.
    || url.pathname.startsWith("/_next/static/")
    || url.pathname === "/favicon.ico"
    || url.pathname === "/manifest.webmanifest"
    || url.pathname === "/sw.js"
    || url.pathname === "/icon-192.png"
    || url.pathname === "/icon-512.png"
    || url.pathname === "/apple-touch-icon.png";
  const session = auth.getSessionFromRequest(req);

  if (auth.configured() && !publicPath && !session) {
    if (url.pathname.startsWith("/api/")) {
      res.writeHead(401, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: "authentication required" }));
      return;
    }
    res.writeHead(302, { Location: "/login", "Cache-Control": "no-store" });
    res.end();
    return;
  }

  if (auth.configured() && ["POST", "PUT", "PATCH", "DELETE"].includes(req.method || "") && !auth.isSameOrigin(req)) {
    res.writeHead(403, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: "cross-origin mutation rejected" }));
    return;
  }
  const codexSessionsApi = require("./agents/codex-sessions-api.cjs");
  if (codexSessionsApi.isCodexSessionPath(url.pathname)) {
    return codexSessionsApi.handleCodexSessionRequest(req, res, url);
  }
  const claudeSessionsApi = require("./agents/claude-sessions-api.cjs");
  if (claudeSessionsApi.isPath(url.pathname)) {
    return claudeSessionsApi.handle(req, res, url);
  }
  const claudeChatApi = require("./agents/claude-chat-api.cjs");
  if (claudeChatApi.isPath(url.pathname)) {
    return claudeChatApi.handle(req, res, url);
  }
  const notificationsApi = require("./notifications-api.cjs");
  if (notificationsApi.isPath(url.pathname)) {
    return notificationsApi.handle(req, res);
  }
  const codexAppApi = require("./agents/codex-app-api.cjs");
  if (codexAppApi.isPath(url.pathname)) {
    return codexAppApi.handle(req, res, url);
  }
  return handle(req, res);
}

// Next lazily installs its own upgrade listener when the first page request is
// handled. This listener only claims Next HMR sockets and deliberately leaves
// unknown WebSocket paths alone, so TianForge can independently own terminal
// streams without dispatching HMR a second time.
const app = next({ dev, dir: root, hostname, port });

function isTerminalStream(url) {
  return /^\/api\/terminals\/[^/]+\/stream$/.test(url.pathname);
}

server.on("upgrade", (req, socket, head) => {
  if (!isAllowedHost(req.headers.host)) {
    socket.write("HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  let url;
  try { url = new URL(req.url || "/", `http://${req.headers.host || hostname}`); } catch { socket.destroy(); return; }
  if (!isTerminalStream(url)) return;

  if (auth.configured() && !auth.getSessionFromRequest(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  if (!auth.isSameOrigin(req)) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  try {
    const { acceptTerminalWebSocket } = require("./agents/terminal-websocket.cjs");
    acceptTerminalWebSocket(req, socket, head, url.pathname.split("/")[3]);
  } catch (error) {
    console.error("Terminal WebSocket unavailable:", error);
    socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    socket.destroy();
  }
});

app.prepare().then(() => {
  handle = app.getRequestHandler();
  server.listen(port, hostname, () => {
    const authStatus = auth.configured() ? "password authentication enabled" : "no password configured (loopback only)";
    console.log(`Ready on ${tls ? "https" : "http"}://${hostname}:${port} (${authStatus})`);
    if (!isLoopback && !tls) {
      console.warn("WARNING: TianForge pi is reachable from the network over plain HTTP. The password and session cookie can be read by anyone on the same network. Use `npm run dev:https`, set PI_WEB_HTTPS_CERT/PI_WEB_HTTPS_KEY, or bind to 127.0.0.1 behind Tailscale Serve.");
    }
  });
}).catch((error) => {
  console.error(error);
  process.exit(1);
});

function shutdown() {
  try {
    const { shutdownTerminals } = require("./agents/terminal-manager.cjs");
    shutdownTerminals();
  } catch { /* terminal runtime may not have loaded */ }
  try {
    require("./agents/codex-app-server.cjs").shutdownRuntimes();
  } catch { /* Codex runtime may not have loaded */ }
  try {
    require("./agents/claude-chat-runtime.cjs").shutdownRuntimes();
  } catch { /* Claude Chat runtime may not have loaded */ }
  server.close(() => process.exit(0));
  // SSE streams and terminal WebSockets never end on their own, so close()
  // would otherwise always wait for the forced-exit timeout below.
  server.closeAllConnections();
  setTimeout(() => process.exit(1), 5000).unref();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
