"use client";

import { useCallback, useEffect, useState } from "react";
import type { TerminalSession, TerminalStats } from "@/lib/agents/terminal";

interface TerminalSnapshot {
  terminals: TerminalSession[];
  stats: TerminalStats | null;
  loaded: boolean;
}

interface WorkspaceTerminalStore extends TerminalSnapshot {
  listeners: Set<(snapshot: TerminalSnapshot) => void>;
  timer: ReturnType<typeof setInterval> | null;
  request: Promise<void> | null;
}

const stores = new Map<string, WorkspaceTerminalStore>();

function getStore(cwd: string): WorkspaceTerminalStore {
  let store = stores.get(cwd);
  if (!store) {
    store = { terminals: [], stats: null, loaded: false, listeners: new Set(), timer: null, request: null };
    stores.set(cwd, store);
  }
  return store;
}

function snapshot(store: WorkspaceTerminalStore): TerminalSnapshot {
  return { terminals: store.terminals, stats: store.stats, loaded: store.loaded };
}

function emit(store: WorkspaceTerminalStore) {
  const next = snapshot(store);
  store.listeners.forEach((listener) => listener(next));
}

export function refreshWorkspaceTerminals(cwd: string): Promise<void> {
  if (!cwd) return Promise.resolve();
  const store = getStore(cwd);
  if (store.request) return store.request;
  store.request = fetch(`/api/terminals?${new URLSearchParams({ cwd })}`, { cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) return;
      const data = await response.json() as { terminals?: TerminalSession[]; stats?: TerminalStats };
      store.terminals = data.terminals ?? [];
      store.stats = data.stats ?? null;
      store.loaded = true;
      emit(store);
    })
    .catch(() => undefined)
    .finally(() => { store.request = null; });
  return store.request;
}

export function updateWorkspaceTerminals(cwd: string, update: (current: TerminalSession[]) => TerminalSession[]) {
  if (!cwd) return;
  const store = getStore(cwd);
  store.terminals = update(store.terminals);
  // Mutations are immediately visible to every consumer. Discard the old
  // aggregate because its counts no longer describe the optimistic list.
  store.stats = null;
  store.loaded = true;
  emit(store);
}

export function useWorkspaceTerminals(cwd: string, refreshKey?: number) {
  const [state, setState] = useState<TerminalSnapshot>(() => cwd ? snapshot(getStore(cwd)) : { terminals: [], stats: null, loaded: false });

  useEffect(() => {
    if (!cwd) { setState({ terminals: [], stats: null, loaded: false }); return; }
    const store = getStore(cwd);
    store.listeners.add(setState);
    setState(snapshot(store));
    void refreshWorkspaceTerminals(cwd);
    if (!store.timer) store.timer = setInterval(() => { if (!document.hidden) void refreshWorkspaceTerminals(cwd); }, 5000);
    return () => {
      store.listeners.delete(setState);
      if (store.listeners.size === 0 && store.timer) {
        clearInterval(store.timer);
        store.timer = null;
      }
    };
  }, [cwd]);

  useEffect(() => { if (cwd) void refreshWorkspaceTerminals(cwd); }, [cwd, refreshKey]);

  const update = useCallback((updater: (current: TerminalSession[]) => TerminalSession[]) => updateWorkspaceTerminals(cwd, updater), [cwd]);
  const refresh = useCallback(() => refreshWorkspaceTerminals(cwd), [cwd]);
  return { ...state, update, refresh };
}
