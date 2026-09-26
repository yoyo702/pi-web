"use client";

import { useCallback, useEffect, useState } from "react";
import { BellRing } from "lucide-react";
import { currentPushEnvironment, base64UrlToBytes, PUSH_SUPPORT_HINT, pushSupport, sameApplicationServerKey, type PushSupport } from "@/lib/push-support";

type PushState = { support: PushSupport | null; subscribed: boolean; permission: NotificationPermission | null };

async function postJson<T>(url: string, body: unknown): Promise<T | null> {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return response.status === 204 ? null : await response.json() as T;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  // Registered by MobileFullscreenPrompt on load; register here too in case that failed or has not run yet.
  if (!await navigator.serviceWorker.getRegistration("/")) await navigator.serviceWorker.register("/sw.js");
  // Subscribing needs an active worker, not one still installing.
  return await navigator.serviceWorker.ready;
}

/**
 * "Notify this device": subscribes this browser to the server's Web Push
 * notifications (server/web-push.cjs). Turning it off unsubscribes only this
 * device; the server also drops devices the push service reports gone.
 */
export function PushNotificationsToggle() {
  const [state, setState] = useState<PushState>({ support: null, subscribed: false, permission: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const support = pushSupport(currentPushEnvironment());
    if (support !== "supported") { setState({ support, subscribed: false, permission: null }); return; }
    const permission = Notification.permission;
    let subscribed = false;
    try {
      const subscription = await (await registration()).pushManager.getSubscription();
      if (subscription) {
        const status = await postJson<{ publicKey: string; subscribed: boolean }>("/api/push", { endpoint: subscription.endpoint });
        subscribed = Boolean(status?.subscribed) && permission === "granted" && sameApplicationServerKey(subscription.options?.applicationServerKey, status?.publicKey ?? "");
      }
    } catch { /* shown as off */ }
    setState({ support, subscribed, permission });
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const turnOn = async () => {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") { setState((current) => ({ ...current, permission })); return; }
    const worker = await registration();
    const status = await postJson<{ publicKey: string }>("/api/push", {});
    if (!status?.publicKey) throw new Error("The server has no push key");
    let subscription = await worker.pushManager.getSubscription();
    // Made with another key (the server's push.json was reset): browsers refuse to change it in place.
    if (subscription && !sameApplicationServerKey(subscription.options?.applicationServerKey, status.publicKey)) {
      await subscription.unsubscribe().catch(() => false);
      subscription = null;
    }
    subscription ??= await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(status.publicKey) });
    await postJson("/api/push/subscribe", { subscription: subscription.toJSON() });
  };

  const turnOff = async () => {
    const subscription = await (await registration()).pushManager.getSubscription();
    if (!subscription) return;
    const { endpoint } = subscription;
    await subscription.unsubscribe().catch(() => false);
    await postJson("/api/push/unsubscribe", { endpoint });
  };

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      if (state.subscribed) await turnOff();
      else await turnOn();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      await refresh();
      setBusy(false);
    }
  };

  if (state.support === null) return null;
  const hint = state.support !== "supported"
    ? PUSH_SUPPORT_HINT[state.support]
    : state.permission === "denied"
      ? "Notifications are blocked for this site. Allow them in the browser's site settings, then try again."
      : state.subscribed
        ? "This device gets a system notification when a run needs your input, fails, or finishes."
        : "Get a system notification on this device when a run needs your input, fails, or finishes.";
  const disabled = busy || state.support !== "supported" || (state.permission === "denied" && !state.subscribed);
  return <section className="activity-center-push" aria-label="System notifications">
    <BellRing size={14} aria-hidden="true" style={{ flexShrink: 0, color: state.subscribed ? "var(--accent)" : "var(--text-dim)" }} />
    <span style={{ minWidth: 0, flex: 1, display: "grid", gap: 3 }}>
      <strong style={{ color: "var(--text)", fontSize: 11 }}>Notify this device</strong>
      <small style={{ color: error ? "#f87171" : "var(--text-dim)", fontSize: 10, lineHeight: 1.35 }} role={error ? "alert" : undefined}>{error ? `Unable to change notifications: ${error}` : hint}</small>
    </span>
    <button type="button" role="switch" aria-checked={state.subscribed} aria-label="Notify this device" disabled={disabled} onClick={() => void toggle()} className={`activity-center-switch${state.subscribed ? " is-on" : ""}`}><span /></button>
  </section>;
}
