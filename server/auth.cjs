/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const COOKIE_NAME = "pi_web_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24;
const PAIRING_TTL_MS = 1000 * 60 * 5;
const MAX_PAIRING_TOKENS = 32;
const LOGIN_WINDOW_MS = 1000 * 60 * 15;
const MAX_LOGIN_FAILURES = 8;
const MAX_FAILURE_RECORDS = 1024;

const state = global.__piWebAuthState || {
  sessions: new Map(),
  failures: new Map(),
};
global.__piWebAuthState = state;
state.pairings ||= new Map();

// Session tokens are stateless HMACs, so logout must be remembered until the
// token would have expired anyway — including across restarts, or a stolen
// cookie from a signed-out browser becomes valid again. Only SHA-256 hashes of
// revoked tokens are stored.
const revokedSessionsFile = process.env.PI_WEB_REVOKED_SESSIONS_FILE || path.join(os.homedir(), ".pi-web", "revoked-sessions.json");
function tokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}
function loadRevokedSessions() {
  const revoked = new Map();
  try {
    const stored = JSON.parse(fs.readFileSync(revokedSessionsFile, "utf8"));
    const now = Date.now();
    for (const [hash, expiresAt] of Object.entries(stored)) {
      if (typeof expiresAt === "number" && expiresAt > now) revoked.set(hash, expiresAt);
    }
  } catch { /* nothing revoked yet */ }
  return revoked;
}
function persistRevokedSessions() {
  const now = Date.now();
  for (const [hash, expiresAt] of state.revoked) if (expiresAt <= now) state.revoked.delete(hash);
  try {
    fs.mkdirSync(path.dirname(revokedSessionsFile), { recursive: true });
    fs.writeFileSync(revokedSessionsFile, JSON.stringify(Object.fromEntries(state.revoked)), { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    console.warn("[pi-web auth] could not persist session revocation:", error instanceof Error ? error.message : error);
  }
}
state.revoked ||= loadRevokedSessions();

// Move the password out of process.env as soon as the server loads auth so
// agent bash tools and spawned CLIs (which inherit process.env) never see it.
// Next route handlers run in this same process and share `state` via global.
if (process.env.PI_WEB_PASSWORD) {
  state.password = process.env.PI_WEB_PASSWORD;
  delete process.env.PI_WEB_PASSWORD;
}
// Sign sessions with a key derived from the password rather than the password
// itself, so a leaked cookie signature oracle never equals the login secret.
state.signingKey ||= state.password ? crypto.createHmac("sha256", state.password).update("pi-web-session-signing-v1").digest() : null;

function configured() {
  return Boolean(state.password);
}

function safeEqual(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string" || !expected) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function parseCookies(header) {
  const values = Object.create(null);
  if (!header) return values;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    try {
      values[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      // Malformed percent-encoding in an unrelated cookie must not crash the server.
    }
  }
  return values;
}

function getSession(token) {
  if (!token) return null;
  const session = state.sessions.get(token);
  if (session?.expiresAt <= Date.now()) {
    state.sessions.delete(token);
  } else if (session) {
    return session;
  }
  const hash = state.revoked.size > 0 ? tokenHash(token) : null;
  const revokedUntil = hash ? state.revoked.get(hash) : undefined;
  if (revokedUntil) {
    if (revokedUntil > Date.now()) return null;
    state.revoked.delete(hash);
  }
  return verifySessionToken(token);
}

function getSessionFromRequest(req) {
  return getSession(parseCookies(req.headers?.cookie)[COOKIE_NAME]);
}

/**
 * Rate-limit key for login attempts. X-Forwarded-For is client-controlled when
 * the server is exposed directly, so only the socket peer address is trusted.
 */
function clientKey(req) {
  return req?.socket?.remoteAddress || "local";
}

function isRateLimited(key) {
  const record = state.failures.get(key);
  if (!record) return false;
  if (record.resetAt <= Date.now()) {
    state.failures.delete(key);
    return false;
  }
  return record.count >= MAX_LOGIN_FAILURES;
}

function recordFailure(key) {
  const now = Date.now();
  const record = state.failures.get(key);
  if (!record || record.resetAt <= now) {
    state.failures.delete(key);
    if (state.failures.size >= MAX_FAILURE_RECORDS) {
      // Records are inserted in resetAt order, so expired ones sit at the front.
      for (const [existing, value] of state.failures) {
        if (value.resetAt > now) break;
        state.failures.delete(existing);
      }
      if (state.failures.size >= MAX_FAILURE_RECORDS) state.failures.delete(state.failures.keys().next().value);
    }
    state.failures.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  } else {
    record.count += 1;
  }
}

function clearFailures(key) {
  state.failures.delete(key);
}

function verifyPassword(value) {
  return safeEqual(value, state.password);
}

function sessionSignature(value) {
  return crypto.createHmac("sha256", state.signingKey || "").update(value).digest("base64url");
}

function verifySessionToken(token) {
  if (!configured() || typeof token !== "string") return null;
  const match = /^(v1)\.(\d{10,16})\.([A-Za-z0-9_-]{22,})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return null;
  const [, version, expiresText, nonce, signature] = match;
  const signed = `${version}.${expiresText}.${nonce}`;
  if (!safeEqual(signature, sessionSignature(signed))) return null;
  const expiresAt = Number(expiresText);
  return Number.isSafeInteger(expiresAt) && expiresAt > Date.now() ? { expiresAt } : null;
}

function createSession() {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const unsigned = `v1.${expiresAt}.${crypto.randomBytes(24).toString("base64url")}`;
  const token = `${unsigned}.${sessionSignature(unsigned)}`;
  state.sessions.set(token, { expiresAt });
  return { token, expiresAt };
}

function purgePairingTokens(now = Date.now()) {
  for (const [token, pairing] of state.pairings) {
    if (pairing.expiresAt <= now) state.pairings.delete(token);
  }
  while (state.pairings.size >= MAX_PAIRING_TOKENS) {
    const oldest = state.pairings.keys().next().value;
    if (!oldest) break;
    state.pairings.delete(oldest);
  }
}

/** Issue a short-lived bearer token for transferring login to another device. */
function createPairingToken() {
  const now = Date.now();
  purgePairingTokens(now);
  const token = crypto.randomBytes(24).toString("base64url");
  const expiresAt = now + PAIRING_TTL_MS;
  state.pairings.set(token, { expiresAt });
  return { token, expiresAt };
}

/** Redeem a pairing token exactly once and return a normal authenticated session. */
function redeemPairingToken(token) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(token)) return null;
  const pairing = state.pairings.get(token);
  if (!pairing) return null;
  state.pairings.delete(token);
  if (pairing.expiresAt <= Date.now()) return null;
  return createSession();
}

function revokeSessionFromRequest(req) {
  const token = parseCookies(req.headers?.cookie)[COOKIE_NAME];
  if (!token) return;
  const session = getSession(token);
  state.sessions.delete(token);
  if (session?.expiresAt > Date.now()) {
    state.revoked.set(tokenHash(token), session.expiresAt);
    persistRevokedSessions();
  }
}

function isSameOrigin(req) {
  const origin = req.headers?.get ? req.headers.get("origin") : req.headers?.origin;
  const host = req.headers?.get ? req.headers.get("host") : req.headers?.host;
  if (!host) return false;
  const normalizedHost = String(host).toLowerCase();
  if (origin && origin !== "null") {
    try {
      return new URL(origin).host.toLowerCase() === normalizedHost;
    } catch {
      return false;
    }
  }
  const fetchSite = req.headers?.get ? req.headers.get("sec-fetch-site") : req.headers?.["sec-fetch-site"];
  if (fetchSite === "same-origin" || fetchSite === "none") return true;
  const referer = req.headers?.get ? req.headers.get("referer") : req.headers?.referer;
  if (referer) {
    try { return new URL(referer).host.toLowerCase() === normalizedHost; } catch { return false; }
  }
  // Non-browser clients commonly omit all three headers. Preserve API/CLI
  // compatibility; authenticated mutations still require the session cookie.
  return !origin && !fetchSite;
}

function cookieValue(token, expiresAt, secure) {
  const expires = new Date(expiresAt).toUTCString();
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? "; Secure" : ""}`;
}

function clearCookie(secure) {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

module.exports = {
  COOKIE_NAME,
  configured,
  safeEqual,
  clientKey,
  isRateLimited,
  recordFailure,
  clearFailures,
  verifyPassword,
  createSession,
  createPairingToken,
  redeemPairingToken,
  getSessionFromRequest,
  revokeSessionFromRequest,
  isSameOrigin,
  cookieValue,
  clearCookie,
};
