import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { pushSupport, isAppleMobile, base64UrlToBytes, sameApplicationServerKey } = await jiti.import("./push-support.ts");

const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const full = { secureContext: true, serviceWorker: true, pushManager: true, notification: true, userAgent: CHROME, standalone: false };

test("push needs a secure context and the push APIs; iOS Safari only from the Home Screen", () => {
  assert.equal(pushSupport(full), "supported");
  assert.equal(pushSupport({ ...full, secureContext: false }), "insecure");
  // iOS Safari in a tab has no PushManager.
  assert.equal(pushSupport({ ...full, userAgent: IPHONE, pushManager: false, notification: false }), "ios-home-screen");
  assert.equal(pushSupport({ ...full, userAgent: IPHONE, standalone: true }), "supported");
  // Installed but too old (before 16.4).
  assert.equal(pushSupport({ ...full, userAgent: IPHONE, standalone: true, pushManager: false }), "unsupported");
  assert.equal(pushSupport({ ...full, pushManager: false }), "unsupported");
});

test("iPadOS is recognized by its touch points", () => {
  assert.equal(isAppleMobile(CHROME, 0), false);
  assert.equal(isAppleMobile(CHROME.replace("Chrome/140.0 ", ""), 5), true);
  assert.equal(isAppleMobile(IPHONE), true);
});

test("VAPID keys decode from base64url and compare with a subscription's key", () => {
  const key = Buffer.from([4, ...Array.from({ length: 64 }, (_, index) => index * 3)]).toString("base64url");
  const bytes = base64UrlToBytes(key);
  assert.equal(bytes.length, 65);
  assert.deepEqual(Buffer.from(bytes), Buffer.from(key, "base64url"));
  assert.equal(sameApplicationServerKey(bytes.buffer, key), true);
  assert.equal(sameApplicationServerKey(new Uint8Array(65).buffer, key), false);
  assert.equal(sameApplicationServerKey(null, key), false);
});
