/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

/**
 * Browser system notifications (Web Push): every activity notification is
 * also sent to the devices that turned "Notify this device" on, so a locked
 * phone hears when a run needs approval, fails or finishes.
 *
 * Messages are encrypted for each device (RFC 8291, aes128gcm) and signed
 * with this server's VAPID key (RFC 8292); the push service (Google, Apple,
 * Mozilla) only relays ciphertext. Requests go through the global fetch, so
 * they follow HTTP(S)_PROXY like model requests do.
 *
 * The VAPID key and the subscribed devices are kept in `~/.pi-web/push.json`
 * (0600; `PI_WEB_PUSH_FILE` overrides it). A device the push service reports
 * gone (404/410) is dropped. State lives on `global` for the same reason as
 * notifications.cjs: Next route handlers and the custom server load separate
 * copies of this module.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_SUBSCRIPTIONS = 20;
const TTL_SECONDS = 24 * 60 * 60;
const SEND_TIMEOUT_MS = 15_000;
// Apple refuses tokens whose `sub` is not a mailto: or https: URL.
const DEFAULT_SUBJECT = "https://github.com/agegr/pi-web";

const state = global.__piWebPush || { data: null, fetch: null };
global.__piWebPush = state;

function file() {
  return process.env.PI_WEB_PUSH_FILE || path.join(os.homedir(), ".pi-web", "push.json");
}

const b64url = (buffer) => Buffer.from(buffer).toString("base64url");
const fromB64url = (value) => Buffer.from(String(value), "base64url");

function isSubscription(value) {
  return value && typeof value === "object" && typeof value.endpoint === "string" && typeof value.keys?.p256dh === "string" && typeof value.keys?.auth === "string";
}

function save() {
  const target = file();
  const temp = `${target}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify({ version: 1, ...state.data }), { mode: 0o600 });
    fs.renameSync(temp, target);
  } catch (error) {
    console.warn(`[pi-web] Unable to save push subscriptions: ${error.message}`);
  }
}

// Without `create`, a missing key is not generated: a server nobody
// subscribed to never writes push.json.
function load({ create = true } = {}) {
  if (state.data) return state.data;
  let parsed = null;
  try { parsed = JSON.parse(fs.readFileSync(file(), "utf8")); } catch (error) {
    if (error?.code !== "ENOENT") console.warn(`[pi-web] Ignoring unreadable push file: ${error.message}`);
  }
  const vapid = parsed?.vapid?.kty === "EC" && typeof parsed.vapid.d === "string" ? parsed.vapid : null;
  if (!vapid && !create) return null;
  state.data = {
    vapid: vapid ?? crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" }),
    // Subscriptions belong to the key they were made with.
    subscriptions: vapid && Array.isArray(parsed.subscriptions) ? parsed.subscriptions.filter(isSubscription) : [],
  };
  if (!vapid) save();
  return state.data;
}

/** The VAPID public key browsers subscribe with (uncompressed P-256 point, base64url). */
function publicKey() {
  const { vapid } = load();
  return b64url(Buffer.concat([Buffer.from([4]), fromB64url(vapid.x), fromB64url(vapid.y)]));
}

function isSubscribed(endpoint) {
  return load().subscriptions.some((subscription) => subscription.endpoint === endpoint);
}

// The push services browsers use (Chrome/Edge/Opera: FCM, Edge on Windows:
// WNS, Firefox: Mozilla, Safari: Apple). The server POSTs to the endpoint on
// every notification, so other hosts (including this network's) are refused.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^([a-z0-9-]+\.)*push\.services\.mozilla\.com$/, /^([a-z0-9-]+\.)*push\.apple\.com$/, /^([a-z0-9-]+\.)*notify\.windows\.com$/];

function validEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" && !url.port && !url.username && !url.password && endpoint.length <= 2048 && PUSH_HOSTS.some((host) => host.test(url.hostname));
  } catch { return false; }
}

// A key that is not a point on P-256 would make every send throw.
function validPublicKey(p256dh) {
  if (p256dh.length !== 65 || p256dh[0] !== 4) return false;
  try { const ecdh = crypto.createECDH("prime256v1"); ecdh.generateKeys(); ecdh.computeSecret(p256dh); return true; } catch { return false; }
}

/** Adds (or refreshes) a device; the oldest is dropped past 20. */
function subscribe(subscription, { userAgent = "" } = {}) {
  if (!isSubscription(subscription) || !validEndpoint(subscription.endpoint)) throw Object.assign(new Error("invalid push subscription"), { code: "invalid_request" });
  const p256dh = fromB64url(subscription.keys.p256dh);
  const auth = fromB64url(subscription.keys.auth);
  if (!validPublicKey(p256dh) || auth.length !== 16) throw Object.assign(new Error("invalid push subscription keys"), { code: "invalid_request" });
  const data = load();
  data.subscriptions = data.subscriptions.filter((entry) => entry.endpoint !== subscription.endpoint);
  data.subscriptions.push({ endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth }, userAgent: String(userAgent).slice(0, 200), createdAt: Date.now() });
  data.subscriptions = data.subscriptions.slice(-MAX_SUBSCRIPTIONS);
  save();
}

function unsubscribe(endpoint) {
  const data = load();
  const kept = data.subscriptions.filter((entry) => entry.endpoint !== endpoint);
  if (kept.length === data.subscriptions.length) return false;
  data.subscriptions = kept;
  save();
  return true;
}

/**
 * RFC 8291 message encryption: one aes128gcm record for the device's
 * `p256dh`/`auth` keys. `salt` and `serverKey` (an ECDH object) are only
 * passed by tests.
 */
function encrypt(payload, keys, { salt = crypto.randomBytes(16), serverKey } = {}) {
  const uaPublic = fromB64url(keys.p256dh);
  const authSecret = fromB64url(keys.auth);
  const ecdh = serverKey ?? crypto.createECDH("prime256v1");
  if (!serverKey) ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  // A single record: the content, then the last-record delimiter.
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

/** RFC 8292: `vapid t=<ES256 JWT for the push service's origin>, k=<public key>`. */
function vapidAuthorization(endpoint, now = Date.now()) {
  const { vapid } = load();
  const header = b64url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64url(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 60 * 60, sub: process.env.PI_WEB_PUSH_SUBJECT || DEFAULT_SUBJECT }));
  const key = crypto.createPrivateKey({ key: vapid, format: "jwk" });
  const signature = crypto.sign("sha256", Buffer.from(`${header}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${publicKey()}`;
}

const KIND_LABEL = { pi: "Pi session", terminal: "Terminal", codex: "Codex", claude: "Claude" };
const EVENT_LABEL = { completed: "finished", failed: "failed", approval: "needs your input" };

/** What the service worker shows for a notification entry. */
function message(entry) {
  const project = path.basename(entry.projectRoot || entry.cwd || "") || entry.cwd;
  return {
    id: entry.id,
    title: `${KIND_LABEL[entry.kind] ?? entry.kind} ${EVENT_LABEL[entry.event] ?? entry.event}`,
    // Cut by code point so an emoji is never split.
    body: Array.from([entry.title, project, entry.event === "failed" ? entry.detail : ""].filter(Boolean).join(" · ")).slice(0, 400).join(""),
    // A newer message about the same chat, session or terminal replaces this one.
    tag: `${entry.kind}:${entry.targetId}`,
  };
}

async function deliver(subscription, entry) {
  const fetchImpl = state.fetch ?? fetch;
  const payload = message(entry);
  const response = await fetchImpl(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: vapidAuthorization(subscription.endpoint),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(TTL_SECONDS),
      Urgency: entry.event === "completed" ? "normal" : "high",
      // An undelivered message about the same target is replaced (≤ 32 base64url characters).
      Topic: crypto.createHash("sha256").update(payload.tag).digest("base64url").slice(0, 32),
    },
    body: encrypt(JSON.stringify(payload), subscription.keys),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    // Push services never redirect; following one would reach any host.
    redirect: "error",
  });
  if (response.status === 404 || response.status === 410) {
    unsubscribe(subscription.endpoint);
    return;
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.warn(`[pi-web] Push to ${new URL(subscription.endpoint).host} failed: HTTP ${response.status} ${text.slice(0, 200)}`);
  }
}

/** Sends a notification entry to every subscribed device; never throws. */
function send(entry) {
  let subscriptions;
  try { subscriptions = [...load({ create: false })?.subscriptions ?? []]; } catch (error) {
    console.warn(`[pi-web] Push unavailable: ${error.message}`);
    return Promise.resolve();
  }
  return Promise.all(subscriptions.map((subscription) => deliver(subscription, entry).catch((error) => {
    console.warn(`[pi-web] Push to ${new URL(subscription.endpoint).host} failed: ${error.message}`);
  }))).then(() => undefined);
}

function _resetForTests({ fetch: fetchImpl = null } = {}) {
  state.data = null;
  state.fetch = fetchImpl;
}

module.exports = { publicKey, isSubscribed, subscribe, unsubscribe, send, encrypt, vapidAuthorization, message, MAX_SUBSCRIPTIONS, _resetForTests };
