#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const next = require("next");
const auth = require("./auth.cjs");

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
// This capability is inherited by Next worker processes so Pi custom tools
// can call the terminal owner without exposing an unauthenticated web route.
process.env.PI_WEB_INTERNAL_TERMINAL_TOKEN ||= crypto.randomBytes(32).toString("base64url");
process.env.PI_WEB_INTERNAL_PORT = String(port);
if (!isLoopback && !auth.configured()) {
  console.error("PI_WEB_PASSWORD must be set when TianForge pi listens on a non-loopback host.");
  process.exit(1);
}

let handle;
let nextUpgradeHandler;

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

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 16 * 1024) reject(new Error("request too large"));
    });
    req.on("end", () => {
      try { resolve(JSON.parse(body)); } catch { reject(new Error("invalid request body")); }
    });
    req.on("error", reject);
  });
}

function readForm(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 16 * 1024) reject(new Error("request too large"));
    });
    req.on("end", () => {
      try { resolve(Object.fromEntries(new URLSearchParams(body))); } catch { reject(new Error("invalid form body")); }
    });
    req.on("error", reject);
  });
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
    const key = auth.clientKey(req.headers);
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
    const key = auth.clientKey(req.headers);
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
      const diagnostic = { type: String(body?.type || "error").slice(0, 40), message: String(body?.message || "Unknown client error").slice(0, 500), file: String(body?.file || "").slice(0, 300), line: Number(body?.line) || 0, column: Number(body?.column) || 0 };
      console.warn("[pi-web client error]", diagnostic);
      writeJson(res, 204, {});
    }).catch(() => writeJson(res, 400, { error: "invalid diagnostic" }));
    return;
  }
  const isPiWebAuthRoute = url.pathname === "/api/auth/session" || url.pathname === "/api/auth/login" || url.pathname === "/api/auth/logout" || url.pathname === "/login";
  if (isPiWebAuthRoute) {
    void handleAuthRequest(req, res, url);
    return;
  }
  const terminalApi = require("./agents/terminal-api.cjs");
  if (terminalApi.isTerminalPath(url.pathname)) {
    const internal = req.headers["x-pi-web-internal"] === process.env.PI_WEB_INTERNAL_TERMINAL_TOKEN;
    if (!internal && auth.configured() && !auth.getSessionFromRequest(req)) return writeJson(res, 401, { error: "authentication required" });
    if (!internal && !auth.isSameOrigin(req)) return writeJson(res, 403, { error: "cross-origin mutation rejected" });
    void terminalApi.handleTerminalRequest(req, res, url);
    return;
  }
  const publicPath = url.pathname === "/login"
    || isPiWebAuthRoute
    || url.pathname.startsWith("/_next/")
    || url.pathname === "/favicon.ico";
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
    void codexSessionsApi.handleCodexSessionRequest(req, res, url);
    return;
  }
  const codexAppApi = require("./agents/codex-app-api.cjs");
  if (codexAppApi.isPath(url.pathname)) {
    void codexAppApi.handle(req, res, url);
    return;
  }
  handle(req, res);
});

// Keep WebSocket ownership explicit. Passing `httpServer` here makes Next add
// its own upgrade listener lazily, alongside the terminal listener below. In
// development that race can leave the HMR socket with an invalid response and
// prevent the client bundle from hydrating. Route each upgrade through one
// listener instead: terminal streams stay local and everything else goes to
// Next (including /_next/webpack-hmr).
const app = next({ dev, dir: root, hostname, port });

function isTerminalStream(url) {
  return /^\/api\/terminals\/[^/]+\/stream$/.test(url.pathname);
}

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || hostname}`);
  if (!isTerminalStream(url)) {
    if (nextUpgradeHandler) {
      void nextUpgradeHandler(req, socket, head);
    } else {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
    return;
  }

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
  nextUpgradeHandler = app.getUpgradeHandler();
  server.listen(port, hostname, () => {
    const authStatus = auth.configured() ? "password authentication enabled" : "no password configured (loopback only)";
    console.log(`Ready on ${tls ? "https" : "http"}://${hostname}:${port} (${authStatus})`);
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
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
