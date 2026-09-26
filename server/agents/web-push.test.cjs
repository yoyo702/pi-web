/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Readable } = require("node:stream");

const push = require("../web-push.cjs");
const pushApi = require("../web-push-api.cjs");
const notifications = require("../notifications.cjs");

// Each test gets its own push and notifications files, and a fake push service.
function usePush(t, { status = 201 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-push-"));
  const file = path.join(dir, "push.json");
  const previous = { push: process.env.PI_WEB_PUSH_FILE, notifications: process.env.PI_WEB_NOTIFICATIONS_FILE };
  process.env.PI_WEB_PUSH_FILE = file;
  process.env.PI_WEB_NOTIFICATIONS_FILE = path.join(dir, "notifications.json");
  const requests = [];
  const service = { status };
  const fakeFetch = async (url, init) => { requests.push({ url, ...init }); return new Response(service.status === 201 ? null : "gone", { status: service.status }); };
  push._resetForTests({ fetch: fakeFetch });
  notifications._resetForTests();
  t.after(() => {
    process.env.PI_WEB_PUSH_FILE = previous.push;
    process.env.PI_WEB_NOTIFICATIONS_FILE = previous.notifications;
    push._resetForTests();
    notifications._resetForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { file, requests, service, saved: () => JSON.parse(fs.readFileSync(file, "utf8")) };
}

// A browser's side of a subscription.
function device(endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`) {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, auth, subscription: { endpoint, expirationTime: null, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } } };
}

function decrypt(body, { ecdh, auth }) {
  const salt = body.subarray(0, 16);
  const idLength = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idLength);
  const secret = ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", secret, auth, Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), asPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const data = body.subarray(21 + idLength);
  const decipher = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(data.subarray(-16));
  const plain = Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]);
  assert.equal(plain.at(-1), 2);
  return JSON.parse(plain.subarray(0, -1).toString());
}

test("encryption matches the RFC 8291 example", () => {
  const serverKey = crypto.createECDH("prime256v1");
  serverKey.setPrivateKey(Buffer.from("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", "base64url"));
  const body = push.encrypt("When I grow up, I want to be a watermelon", { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" }, { salt: Buffer.from("DGv6ra1nlYgDCS1FRnbzlw", "base64url"), serverKey });
  assert.equal(body.toString("base64url"), "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
});

test("the VAPID key is created once, kept private and signs tokens for the push service's origin", (t) => {
  const { file, saved } = usePush(t);
  const key = push.publicKey();
  assert.equal(Buffer.from(key, "base64url").length, 65);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  push._resetForTests();
  assert.equal(push.publicKey(), key);
  assert.equal(saved().vapid.kty, "EC");

  const now = Date.UTC(2026, 8, 26);
  const header = push.vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", now);
  const [, token, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.equal(k, key);
  const [head, claims, signature] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(claims, "base64url")), { aud: "https://fcm.googleapis.com", exp: now / 1000 + 12 * 60 * 60, sub: "https://github.com/agegr/pi-web" });
  const publicKey = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: Buffer.from(key, "base64url").subarray(1, 33).toString("base64url"), y: Buffer.from(key, "base64url").subarray(33).toString("base64url") }, format: "jwk" });
  assert.equal(crypto.verify("sha256", Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")), true);
});

test("each new notification goes to every subscribed device, encrypted for it", async (t) => {
  const { requests } = usePush(t);
  const phone = device();
  const laptop = device();
  push.subscribe(phone.subscription, { userAgent: "Phone" });
  push.subscribe(laptop.subscription);
  const entry = notifications.add({ kind: "codex", event: "approval", targetId: "thread-1", cwd: "/work/pi-web", title: "Fix the build" });
  await waitFor(() => requests.length === 2);
  const [first] = requests;
  assert.equal(first.url, phone.subscription.endpoint);
  assert.equal(first.method, "POST");
  assert.equal(first.headers["Content-Encoding"], "aes128gcm");
  assert.equal(first.headers.Urgency, "high");
  assert.equal(first.headers.TTL, "86400");
  assert.equal(first.redirect, "error");
  assert.match(first.headers.Topic, /^[\w-]{32}$/);
  assert.match(first.headers.Authorization, /^vapid t=.+, k=.+$/);
  assert.deepEqual(decrypt(first.body, phone), { id: entry.id, title: "Codex needs your input", body: "Fix the build · pi-web", tag: "codex:thread-1" });
  assert.equal(decrypt(requests[1].body, laptop).id, entry.id);
});

test("each device only hears the events it chose; a refresh keeps the choice", async (t) => {
  const { requests, saved } = usePush(t);
  const phone = device();
  const laptop = device();
  push.subscribe(phone.subscription, { events: ["failed", "approval", "approval"] });
  push.subscribe(laptop.subscription);
  assert.deepEqual(push.eventsFor(phone.subscription.endpoint), ["approval", "failed"]);
  assert.deepEqual(push.eventsFor(laptop.subscription.endpoint), ["approval", "failed", "completed"]);
  assert.equal(push.eventsFor("https://fcm.googleapis.com/fcm/send/unknown"), null);

  await push.send({ id: "n1", kind: "pi", event: "completed", targetId: "s", cwd: "/a", title: "Done" });
  assert.deepEqual(requests.map((request) => request.url), [laptop.subscription.endpoint]);
  requests.length = 0;
  await push.send({ id: "n2", kind: "terminal", event: "failed", targetId: "t", cwd: "/a", title: "Build" });
  assert.deepEqual(requests.map((request) => request.url), [phone.subscription.endpoint, laptop.subscription.endpoint]);

  assert.equal(push.setEvents(laptop.subscription.endpoint, ["approval"]), true);
  assert.equal(push.setEvents("https://fcm.googleapis.com/fcm/send/unknown", ["approval"]), false);
  for (const events of [[], ["finished"], "failed", null]) assert.throws(() => push.setEvents(phone.subscription.endpoint, events), { code: "invalid_request" });
  assert.throws(() => push.subscribe(device().subscription, { events: [] }), { code: "invalid_request" });
  // The browser re-sends its subscription when the switch is turned on again.
  push.subscribe(phone.subscription);
  push._resetForTests();
  assert.deepEqual(push.eventsFor(phone.subscription.endpoint), ["approval", "failed"]);
  assert.deepEqual(saved().subscriptions.map((entry) => entry.events), [["approval"], ["approval", "failed"]]);
});

test("devices saved before the event choice hear every event", async (t) => {
  const { file, requests } = usePush(t);
  const phone = device();
  const tablet = device();
  push.publicKey();
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  const keys = (entry) => ({ endpoint: entry.subscription.endpoint, keys: entry.subscription.keys });
  fs.writeFileSync(file, JSON.stringify({ ...saved, subscriptions: [keys(phone), { ...keys(tablet), events: ["nope"] }] }));
  push._resetForTests({ fetch: async (url, init) => { requests.push({ url, ...init }); return new Response(null, { status: 201 }); } });
  assert.deepEqual(push.eventsFor(phone.subscription.endpoint), ["approval", "failed", "completed"]);
  assert.deepEqual(push.eventsFor(tablet.subscription.endpoint), ["approval", "failed", "completed"]);
  await push.send({ id: "n1", kind: "pi", event: "completed", targetId: "s", cwd: "/a", title: "Done" });
  assert.equal(requests.length, 2);
});

test("a device the push service reports gone is dropped; other failures are only logged", async (t) => {
  const { requests, service, saved } = usePush(t, { status: 410 });
  const phone = device();
  push.subscribe(phone.subscription);
  await push.send({ id: "n1", kind: "terminal", event: "failed", targetId: "term", cwd: "/a", title: "Build", detail: "Exited with code 1" });
  assert.equal(requests.length, 1);
  assert.equal(push.isSubscribed(phone.subscription.endpoint), false);
  assert.deepEqual(saved().subscriptions, []);

  service.status = 500;
  const warn = t.mock.method(console, "warn", () => undefined);
  push.subscribe(phone.subscription);
  await push.send({ id: "n2", kind: "pi", event: "completed", targetId: "s", cwd: "/a", title: "Done" });
  assert.equal(push.isSubscribed(phone.subscription.endpoint), true);
  assert.match(warn.mock.calls[0].arguments[0], /HTTP 500/);
});

test("subscriptions are validated, replaced by endpoint and capped", (t) => {
  usePush(t);
  const phone = device();
  // Only https endpoints on the browsers' push services: the server POSTs to them.
  for (const endpoint of ["http://fcm.googleapis.com/fcm/send/x", "https://push.example.net/x", "https://127.0.0.1/x", "https://fcm.googleapis.com:8443/x", "https://evil.com/.push.apple.com"]) {
    assert.throws(() => push.subscribe({ endpoint, keys: phone.subscription.keys }), { code: "invalid_request" }, endpoint);
  }
  for (const endpoint of ["https://web.push.apple.com/abc", "https://updates.push.services.mozilla.com/wpush/v2/abc", "https://wns2-par02p.notify.windows.com/w/?token=abc"]) {
    push.subscribe({ endpoint, keys: phone.subscription.keys });
    assert.equal(push.unsubscribe(endpoint), true);
  }
  assert.throws(() => push.subscribe({ ...phone.subscription, keys: { ...phone.subscription.keys, auth: "short" } }), { code: "invalid_request" });
  // 65 bytes starting with 4, but not a point on P-256.
  const offCurve = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString("base64url");
  assert.throws(() => push.subscribe({ ...phone.subscription, keys: { ...phone.subscription.keys, p256dh: offCurve } }), { code: "invalid_request" });
  push.subscribe(phone.subscription);
  push.subscribe(phone.subscription);
  for (let index = 0; index < push.MAX_SUBSCRIPTIONS; index += 1) push.subscribe(device().subscription);
  assert.equal(push.isSubscribed(phone.subscription.endpoint), false);
  assert.equal(push.unsubscribe("https://fcm.googleapis.com/fcm/send/unknown"), false);
});

function call(pathname, body, method = "POST", contentType = "application/json") {
  const req = Readable.from([Buffer.from(typeof body === "string" ? body : JSON.stringify(body ?? {}))]);
  req.method = method;
  req.headers = { "user-agent": "Test", "content-type": contentType };
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      writeHead(status) { this.statusCode = status; return this; },
      end(data) { resolve({ status: this.statusCode, body: data ? JSON.parse(String(data)) : null }); },
    };
    pushApi.handle(req, res, new URL(pathname, "http://localhost"));
  });
}

test("the push API reports the key and this device's state, and subscribes and unsubscribes it", async (t) => {
  usePush(t);
  const phone = device();
  assert.equal(pushApi.isPath("/api/push/subscribe"), true);
  assert.equal(pushApi.isPath("/api/push/other"), false);
  assert.equal((await call("/api/push", {}, "GET")).status, 405);
  // A form post from another site cannot subscribe (cross-origin requests are also rejected by the server).
  assert.equal((await call("/api/push/subscribe", { subscription: phone.subscription }, "POST", "text/plain")).status, 415);
  assert.deepEqual(await call("/api/push", { endpoint: phone.subscription.endpoint }), { status: 200, body: { publicKey: push.publicKey(), subscribed: false, events: ["approval", "failed", "completed"] } });
  assert.equal((await call("/api/push/subscribe", { subscription: { endpoint: "nope" } })).status, 400);
  assert.equal((await call("/api/push/subscribe", "{")).status, 400);
  assert.equal((await call("/api/push/subscribe", { subscription: phone.subscription, events: [] })).status, 400);
  assert.equal((await call("/api/push/subscribe", { subscription: phone.subscription, events: ["failed"] })).status, 204);
  assert.deepEqual(push.eventsFor(phone.subscription.endpoint), ["failed"]);
  assert.equal((await call("/api/push/subscribe", { subscription: phone.subscription })).status, 204);
  assert.equal((await call("/api/push", { endpoint: phone.subscription.endpoint })).body.subscribed, true);
  assert.equal((await call("/api/push/events", { endpoint: phone.subscription.endpoint, events: ["completed", "failed"] })).status, 204);
  assert.deepEqual((await call("/api/push", { endpoint: phone.subscription.endpoint })).body, { publicKey: push.publicKey(), subscribed: true, events: ["failed", "completed"] });
  assert.equal((await call("/api/push/events", { endpoint: phone.subscription.endpoint, events: [] })).status, 400);
  assert.equal((await call("/api/push/events", { endpoint: phone.subscription.endpoint, events: ["finished"] })).status, 400);
  assert.equal((await call("/api/push/events", { endpoint: "https://fcm.googleapis.com/fcm/send/unknown", events: ["failed"] })).status, 404);
  assert.equal((await call("/api/push/unsubscribe", {})).status, 400);
  assert.equal((await call("/api/push/unsubscribe", { endpoint: phone.subscription.endpoint })).status, 204);
  assert.equal(push.isSubscribed(phone.subscription.endpoint), false);
});

async function waitFor(check) {
  const until = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
