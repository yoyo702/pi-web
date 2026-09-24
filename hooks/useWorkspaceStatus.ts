"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { createWorkspaceStatusStore, type WorkspaceStatusSnapshot } from "@/lib/workspace-status-store";

type StatusMessage = { type?: string; [key: string]: unknown };
type Listener = (message: StatusMessage) => void;

export const workspaceStatusStore = createWorkspaceStatusStore();

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

let source: EventSource | null = null;
let users = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = RECONNECT_MIN_MS;
const messageListeners = new Set<Listener>();

function open(): void {
  const current = new EventSource("/api/agent/running/events");
  source = current;
  current.onopen = () => { reconnectDelay = RECONNECT_MIN_MS; };
  // EventSource retries network errors by itself, but an HTTP error response
  // (a proxy 502 while the server restarts, a 401) closes it for good. Terminal
  // and rail state depend on this stream, so reopen with backoff; the new
  // connection's snapshots replace the store.
  current.onerror = () => {
    if (current.readyState !== EventSource.CLOSED || source !== current) return;
    source = null;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (users > 0 && !source) open();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  };
  current.onmessage = (e) => {
    let data: unknown;
    try {
      data = JSON.parse(e.data);
    } catch {
      // ignore malformed frames
      return;
    }
    workspaceStatusStore.apply(data);
    for (const listener of messageListeners) listener(data as StatusMessage);
  };
}

function retain(): void {
  users += 1;
  if (!source && !reconnectTimer) open();
}

function release(): void {
  users -= 1;
  if (users > 0) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  reconnectDelay = RECONNECT_MIN_MS;
  source?.close();
  source = null;
}

/** Subscribes to the store and keeps the shared connection open while mounted. */
export function useWorkspaceStatus(): WorkspaceStatusSnapshot {
  useEffect(() => {
    retain();
    return release;
  }, []);

  return useSyncExternalStore(
    workspaceStatusStore.subscribe,
    workspaceStatusStore.getSnapshot,
    workspaceStatusStore.getSnapshot,
  );
}

/**
 * Like useWorkspaceStatus, but re-renders only when `select` returns a
 * different value (compare with Object.is — return primitives or stable refs).
 */
export function useWorkspaceStatusSelector<T>(select: (snapshot: WorkspaceStatusSnapshot) => T): T {
  useEffect(() => {
    retain();
    return release;
  }, []);

  const getSelected = () => select(workspaceStatusStore.getSnapshot());
  return useSyncExternalStore(workspaceStatusStore.subscribe, getSelected, getSelected);
}

/** Receive every raw SSE message (e.g. session_event) while mounted; also keeps the connection open. */
export function useWorkspaceStatusMessages(listener: (message: StatusMessage) => void): void {
  const listenerRef = useRef(listener);
  listenerRef.current = listener;

  useEffect(() => {
    const wrapper: Listener = (message) => listenerRef.current(message);
    messageListeners.add(wrapper);
    retain();
    // The connection may already be open (another consumer mounted first), in
    // which case its initial `running` frame has come and gone. Replay the
    // current snapshot so late listeners start from the same state.
    const { runningSessionIds } = workspaceStatusStore.getSnapshot();
    if (runningSessionIds !== null) wrapper({ type: "running", runningSessionIds });
    return () => {
      messageListeners.delete(wrapper);
      release();
    };
  }, []);
}
