"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BellRing } from "lucide-react";
import { currentPushEnvironment, base64UrlToBytes, PUSH_SUPPORT_HINT, pushSupport, sameApplicationServerKey, type PushSupport } from "@/lib/push-support";

type PushEvent = "approval" | "failed" | "completed";
type PushState = { support: PushSupport | null; subscribed: boolean; permission: NotificationPermission | null; events: PushEvent[] };
type PushStatus = { publicKey: string; subscribed: boolean; events: PushEvent[] };

const ALL_EVENTS: PushEvent[] = ["approval", "failed", "completed"];
const EVENT_LABEL: Record<PushEvent, string> = { approval: "Needs input", failed: "Failed", completed: "Finished" };
const knownEvents = (events: unknown): PushEvent[] => Array.isArray(events) ? ALL_EVENTS.filter((event) => events.includes(event)) : [];

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
 * While on, the device picks which events it hears (at least one).
 */
export function PushNotificationsToggle() {
  const [state, setState] = useState<PushState>({ support: null, subscribed: false, permission: null, events: ALL_EVENTS });
  const [busy, setBusy] = useState(false);
  // Controls stay enabled while a change is saved (disabling a focused checkbox drops keyboard focus); this ignores clicks meanwhile.
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const support = pushSupport(currentPushEnvironment());
    if (support !== "supported") { setState({ support, subscribed: false, permission: null, events: ALL_EVENTS }); return; }
    const permission = Notification.permission;
    let subscribed = false;
    let events = ALL_EVENTS;
    try {
      const subscription = await (await registration()).pushManager.getSubscription();
      if (subscription) {
        const status = await postJson<PushStatus>("/api/push", { endpoint: subscription.endpoint });
        subscribed = Boolean(status?.subscribed) && permission === "granted" && sameApplicationServerKey(subscription.options?.applicationServerKey, status?.publicKey ?? "");
        if (knownEvents(status?.events).length) events = knownEvents(status?.events);
      }
    } catch { /* shown as off */ }
    setState({ support, subscribed, permission, events });
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

  const change = async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      await refresh();
      busyRef.current = false;
      setBusy(false);
    }
  };
  const toggle = () => change(state.subscribed ? turnOff : turnOn);
  const toggleEvent = (event: PushEvent) => change(async () => {
    const subscription = await (await registration()).pushManager.getSubscription();
    if (!subscription) return;
    const { endpoint } = subscription;
    // Read the saved choice first: another tab of this browser shares the subscription.
    const current = knownEvents((await postJson<PushStatus>("/api/push", { endpoint }))?.events);
    const events = current.includes(event) ? current.filter((item) => item !== event) : [...current, event];
    if (!events.length) return;
    await postJson("/api/push/events", { endpoint, events: ALL_EVENTS.filter((item) => events.includes(item)) });
  });

  if (state.support === null) return null;
  const hint = state.support !== "supported"
    ? PUSH_SUPPORT_HINT[state.support]
    : state.permission === "denied"
      ? "Notifications are blocked for this site. Allow them in the browser's site settings, then try again."
      : state.subscribed
        ? "This device gets a system notification for the events checked below."
        : "Get a system notification on this device when a run needs your input, fails, or finishes.";
  const disabled = busy || state.support !== "supported" || (state.permission === "denied" && !state.subscribed);
  const lastEvent = state.events.length === 1 ? state.events[0] : null;
  return <section className="activity-center-push" aria-label="System notifications" aria-busy={busy}>
    <div className="activity-center-push-row">
      <BellRing size={14} aria-hidden="true" style={{ flexShrink: 0, color: state.subscribed ? "var(--accent)" : "var(--text-dim)" }} />
      <span style={{ minWidth: 0, flex: 1, display: "grid", gap: 3 }}>
        <strong style={{ color: "var(--text)", fontSize: 11 }}>Notify this device</strong>
        <small style={{ color: error ? "#f87171" : "var(--text-dim)", fontSize: 10, lineHeight: 1.35 }} role={error ? "alert" : undefined}>{error ? `Unable to change notifications: ${error}` : hint}</small>
      </span>
      <button type="button" role="switch" aria-checked={state.subscribed} aria-label="Notify this device" disabled={disabled} onClick={() => void toggle()} className={`activity-center-switch${state.subscribed ? " is-on" : ""}`}><span /></button>
    </div>
    {state.subscribed && <fieldset className="activity-center-push-events">
      <legend>Notify for</legend>
      {ALL_EVENTS.map((event) => {
        // The last event cannot be unchecked (it stays focusable and says why): turn the switch off instead.
        const last = event === lastEvent;
        return <label key={event}>
          <input type="checkbox" checked={state.events.includes(event)} aria-disabled={last || undefined} aria-describedby={last ? "push-events-last" : undefined} onChange={() => { if (!last) void toggleEvent(event); }} />
          {EVENT_LABEL[event]}
        </label>;
      })}
      {lastEvent && <small id="push-events-last">Turn the switch off to stop all notifications.</small>}
    </fieldset>}
  </section>;
}
