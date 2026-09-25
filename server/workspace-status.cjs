"use strict";

/**
 * Process-wide bus for workspace run status (terminals, Codex runtimes) and
 * activity notifications.
 * Next route handlers and the custom server can load separate copies of a
 * module, so all state lives on `global`. Owners register a snapshot provider
 * and call notify() when state changes; the running-status SSE forwards the
 * coalesced snapshots to browsers.
 */
const COALESCE_MS = 100;
const THROTTLE_MS = 5_000;
const EMPTY = {
  terminals: () => ({ terminals: [], limits: null }),
  codex_runtimes: () => ({ runtimes: [] }),
  claude_runtimes: () => ({ runtimes: [] }),
  notifications: () => ({ notifications: [], unread: 0 }),
};

function freshState() {
  return { providers: new Map(), listeners: new Set(), pending: new Map(), lastPublished: new Map() };
}
const state = global.__piWebWorkspaceStatus || freshState();
global.__piWebWorkspaceStatus = state;

function registerProvider(kind, getSnapshot) {
  state.providers.set(kind, getSnapshot);
}

function snapshot(kind) {
  const provider = state.providers.get(kind);
  return { type: kind, ...(provider ? provider() : EMPTY[kind]()) };
}

function publish(kind) {
  state.pending.delete(kind);
  let message;
  try {
    message = snapshot(kind);
  } catch (error) {
    console.error(`[workspace-status] ${kind} snapshot failed:`, error);
    return;
  }
  const serialized = JSON.stringify(message);
  if (state.lastPublished.get(kind) === serialized) return;
  state.lastPublished.set(kind, serialized);
  for (const listener of state.listeners) {
    try { listener(message); } catch { /* a closed stream must not affect others */ }
  }
}

/** Schedule a publish. `throttled` changes (terminal output) wait up to THROTTLE_MS; any urgent change upgrades a pending throttled one. */
function notify(kind, { throttled = false } = {}) {
  const pending = state.pending.get(kind);
  if (pending) {
    if (throttled || !pending.throttled) return;
    clearTimeout(pending.timer);
  }
  const timer = setTimeout(() => publish(kind), throttled ? THROTTLE_MS : COALESCE_MS);
  timer.unref?.();
  state.pending.set(kind, { timer, throttled });
}

function subscribe(listener) {
  state.listeners.add(listener);
  return () => { state.listeners.delete(listener); };
}

function _resetForTests() {
  for (const pending of state.pending.values()) clearTimeout(pending.timer);
  const fresh = freshState();
  state.providers = fresh.providers;
  state.listeners = fresh.listeners;
  state.pending = fresh.pending;
  state.lastPublished = fresh.lastPublished;
}

module.exports = { registerProvider, notify, subscribe, snapshot, COALESCE_MS, THROTTLE_MS, _resetForTests };
