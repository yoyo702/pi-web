/**
 * Whether this browser can turn on "Notify this device" (Web Push), and why
 * not when it cannot. Browsers only allow push on a trusted HTTPS origin
 * (localhost counts); iOS Safari only for an app added to the Home Screen.
 */
export type PushSupport = "supported" | "insecure" | "ios-home-screen" | "unsupported";

export interface PushEnvironment {
  secureContext: boolean;
  serviceWorker: boolean;
  pushManager: boolean;
  notification: boolean;
  userAgent: string;
  /** Running as an installed app (display-mode standalone or navigator.standalone). */
  standalone: boolean;
  maxTouchPoints?: number;
}

export function isAppleMobile(userAgent: string, maxTouchPoints = 0): boolean {
  // iPadOS reports a Mac user agent; touch points tell them apart.
  return /iPhone|iPad|iPod/i.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

export function pushSupport(env: PushEnvironment): PushSupport {
  if (!env.secureContext) return "insecure";
  if (env.serviceWorker && env.pushManager && env.notification) return "supported";
  if (isAppleMobile(env.userAgent, env.maxTouchPoints) && !env.standalone) return "ios-home-screen";
  return "unsupported";
}

export const PUSH_SUPPORT_HINT: Record<Exclude<PushSupport, "supported">, string> = {
  insecure: "System notifications need trusted HTTPS: open TianForge through its *.ts.net address (or localhost).",
  "ios-home-screen": "On iPhone and iPad (iOS 16.4+), add TianForge to the Home Screen and open it from there to get notifications.",
  unsupported: "This browser does not support system notifications.",
};

export function currentPushEnvironment(): PushEnvironment {
  const nav = navigator as Navigator & { standalone?: boolean };
  return {
    secureContext: window.isSecureContext,
    serviceWorker: "serviceWorker" in navigator,
    pushManager: "PushManager" in window,
    notification: "Notification" in window,
    userAgent: navigator.userAgent,
    standalone: window.matchMedia?.("(display-mode: standalone)").matches || nav.standalone === true,
    maxTouchPoints: navigator.maxTouchPoints,
  };
}

/** A base64url VAPID key as bytes, for `pushManager.subscribe`. */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Whether a subscription was made with `key` (a server that lost push.json has a new key). */
export function sameApplicationServerKey(subscriptionKey: ArrayBuffer | null | undefined, key: string): boolean {
  if (!subscriptionKey) return false;
  const expected = base64UrlToBytes(key);
  const actual = new Uint8Array(subscriptionKey);
  return actual.length === expected.length && actual.every((byte, index) => byte === expected[index]);
}
