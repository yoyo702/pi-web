/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const crypto = require("node:crypto");

const COOKIE_NAME = "pi_web_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24;
const LOGIN_WINDOW_MS = 1000 * 60 * 15;
const MAX_LOGIN_FAILURES = 8;

const state = global.__piWebAuthState || {
  sessions: new Map(),
  failures: new Map(),
};
global.__piWebAuthState = state;
state.revoked ||= new Map();

function configured() {
  return Boolean(process.env.PI_WEB_PASSWORD);
}

function parseCookies(header) {
  const values = Object.create(null);
  if (!header) return values;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    values[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
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
  const revokedUntil = state.revoked.get(token);
  if (revokedUntil) {
    if (revokedUntil > Date.now()) return null;
    state.revoked.delete(token);
  }
  return verifySessionToken(token);
}

function getSessionFromRequest(req) {
  return getSession(parseCookies(req.headers?.cookie)[COOKIE_NAME]);
}

function clientKey(headers) {
  const forwarded = headers?.get ? headers.get("x-forwarded-for") : headers?.["x-forwarded-for"];
  return (forwarded || headers?.get?.("x-real-ip") || headers?.["x-real-ip"] || "local").split(",")[0].trim();
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
    state.failures.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  } else {
    record.count += 1;
  }
}

function clearFailures(key) {
  state.failures.delete(key);
}

function verifyPassword(value) {
  const expected = process.env.PI_WEB_PASSWORD;
  if (!expected || typeof value !== "string") return false;
  const actualBuffer = Buffer.from(value);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function sessionSignature(value) {
  return crypto.createHmac("sha256", process.env.PI_WEB_PASSWORD || "").update(value).digest("base64url");
}

function verifySessionToken(token) {
  if (!configured() || typeof token !== "string") return null;
  const match = /^(v1)\.(\d{10,16})\.([A-Za-z0-9_-]{22,})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return null;
  const [, version, expiresText, nonce, signature] = match;
  const signed = `${version}.${expiresText}.${nonce}`;
  const expected = sessionSignature(signed);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return null;
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

function revokeSessionFromRequest(req) {
  const token = parseCookies(req.headers?.cookie)[COOKIE_NAME];
  if (!token) return;
  const session = getSession(token);
  state.sessions.delete(token);
  if (session?.expiresAt > Date.now()) state.revoked.set(token, session.expiresAt);
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
  clientKey,
  isRateLimited,
  recordFailure,
  clearFailures,
  verifyPassword,
  createSession,
  getSessionFromRequest,
  revokeSessionFromRequest,
  isSameOrigin,
  cookieValue,
  clearCookie,
};
