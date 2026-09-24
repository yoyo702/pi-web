"use client";

import { useCallback, useEffect, useMemo } from "react";
import type { TerminalSession, TerminalStats } from "@/lib/agents/terminal";
import { terminalsForCwd, terminalStatsForCwd } from "@/lib/workspace-status-store";
import { useWorkspaceStatus, workspaceStatusStore } from "./useWorkspaceStatus";

// Requested cwd -> canonical cwd, as resolved by the last successful
// GET /api/terminals?cwd=. The pushed snapshot is keyed by canonical cwd, so
// every reader needs this mapping to find its slice of it. It is always written
// before the store notifies, so reading it during render is never stale.
const canonicalCwd = new Map<string, string>();
const pendingRequests = new Map<string, Promise<void>>();
const lastAttemptAt = new Map<string, number>();
/** Minimum spacing between retries of a GET that has not succeeded yet. */
const RETRY_MS = 5_000;

export function refreshWorkspaceTerminals(cwd: string): Promise<void> {
  if (!cwd) return Promise.resolve();
  const pending = pendingRequests.get(cwd);
  if (pending) return pending;
  lastAttemptAt.set(cwd, Date.now());
  const request = fetch(`/api/terminals?${new URLSearchParams({ cwd })}`, { cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) return;
      const data = await response.json() as { terminals?: TerminalSession[]; stats?: TerminalStats; cwd?: string };
      const canonical = data.cwd ?? cwd;
      canonicalCwd.set(cwd, canonical);
      workspaceStatusStore.replaceTerminalsForCwd(canonical, data.terminals ?? [], data.stats?.limits ?? null);
    })
    .catch(() => undefined)
    .finally(() => { pendingRequests.delete(cwd); });
  pendingRequests.set(cwd, request);
  return request;
}

export function updateWorkspaceTerminals(cwd: string, update: (current: TerminalSession[]) => TerminalSession[]) {
  if (!cwd) return;
  const canonical = canonicalCwd.get(cwd);
  // Until the canonical cwd is known an optimistic edit would land under the
  // wrong key and duplicate the records the next snapshot brings; fetch the
  // authoritative list instead.
  if (canonical === undefined) {
    void refreshWorkspaceTerminals(cwd);
    return;
  }
  workspaceStatusStore.updateTerminalsForCwd(canonical, update);
}

export function useWorkspaceTerminals(cwd: string, refreshKey?: number) {
  const status = useWorkspaceStatus();
  const canonical = canonicalCwd.get(cwd) ?? cwd;

  useEffect(() => {
    if (cwd) void refreshWorkspaceTerminals(cwd);
  }, [cwd, refreshKey]);

  // A failed first GET (403 while the grant is re-established after a server
  // restart, a network blip) would otherwise leave `loaded` false forever.
  // Retry whenever a pushed snapshot arrives, at most once per RETRY_MS.
  useEffect(() => {
    if (!cwd || canonicalCwd.has(cwd)) return;
    const wait = Math.max(0, (lastAttemptAt.get(cwd) ?? 0) + RETRY_MS - Date.now());
    const timer = setTimeout(() => { if (!canonicalCwd.has(cwd)) void refreshWorkspaceTerminals(cwd); }, wait);
    return () => clearTimeout(timer);
  }, [cwd, status]);

  // terminalsForCwd/terminalStatsForCwd derive a fresh array/object from the
  // shared snapshot on every call; memoize on the snapshot object itself
  // (stable between pushes: useSyncExternalStore only returns a new `status`
  // when the store actually notifies) so consumers that key effects off the
  // returned terminal list don't re-run on every unrelated render.
  const terminals = useMemo(() => (cwd ? terminalsForCwd(status, canonical) : []), [cwd, canonical, status]);
  const stats = useMemo(() => (cwd ? terminalStatsForCwd(status, canonical) : null), [cwd, canonical, status]);
  const loaded = status.terminals !== null && canonicalCwd.has(cwd);

  const update = useCallback((updater: (current: TerminalSession[]) => TerminalSession[]) => updateWorkspaceTerminals(cwd, updater), [cwd]);
  const refresh = useCallback(() => refreshWorkspaceTerminals(cwd), [cwd]);

  return { terminals, stats, loaded, update, refresh };
}
