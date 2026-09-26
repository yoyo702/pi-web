"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspaceStatusSelector } from "@/hooks/useWorkspaceStatus";
import { computeRailActivity, groupRailActivity, terminalIsBusy, type RailActivityItem, type RailCompletedEntry, type WorkspaceActivity } from "@/lib/rail-activity";
import type { ProjectWorkspace } from "@/lib/project-workspaces";
import type { SessionInfo } from "@/lib/types";

const SESSION_LOOKUP_THROTTLE_MS = 30_000;
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export interface WorkspaceActivityResult {
  /** Activity per workspace id (every workspace has an entry once computed). */
  activityById: Record<string, WorkspaceActivity>;
  /** Running terminals per cwd, for the close-workspace confirmation. */
  runningByCwd: Record<string, number>;
  /**
   * Pi item labels come from the session list fetched when a session first
   * runs, so a later rename would never show. Call when an activity list with
   * Pi items opens to refresh it (same 30 s throttle) — not on a poll.
   */
  refreshSessionLabels: () => void;
}

/**
 * Activity of every open workspace, derived from the pushed status snapshot
 * (see lib/rail-activity.ts). Used once in AppShell and shared by the rail and
 * the activity center, so both show the same items.
 */
export function useWorkspaceActivity(workspaces: ProjectWorkspace[]): WorkspaceActivityResult {
  const terminalsStatus = useWorkspaceStatusSelector((snapshot) => snapshot.terminals);
  const runningSessionIdsStatus = useWorkspaceStatusSelector((snapshot) => snapshot.runningSessionIds);
  const codexRuntimesStatus = useWorkspaceStatusSelector((snapshot) => snapshot.codexRuntimes);
  const claudeRuntimesStatus = useWorkspaceStatusSelector((snapshot) => snapshot.claudeRuntimes);
  const [runningByCwd, setRunningByCwd] = useState<Record<string, number>>({});
  const [activityById, setActivityById] = useState<Record<string, WorkspaceActivity>>({});
  const [tick, setTick] = useState(0);
  const previousRunningRef = useRef<Map<string, RailActivityItem> | null>(null);
  const completedRef = useRef<Map<string, RailCompletedEntry>>(new Map());
  const sessionsByIdRef = useRef<Map<string, SessionInfo>>(new Map());
  const sessionRootsFetchedAtRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let expiryTimer: ReturnType<typeof setTimeout> | null = null;
    const compute = async () => {
      try {
        const terminals = terminalsStatus ?? [];
        const runningSessionIds = runningSessionIdsStatus ?? [];
        const codexRuntimes = codexRuntimesStatus ?? [];
        const claudeRuntimes = claudeRuntimesStatus ?? [];
        // The full session list requires a server-side scan of every session
        // file, so only fetch it when a running session's project is unknown.
        // Throttled because a brand-new session may not be listed yet.
        if (runningSessionIds.some((id) => !sessionsByIdRef.current.has(id)) && Date.now() - sessionRootsFetchedAtRef.current >= SESSION_LOOKUP_THROTTLE_MS) {
          sessionRootsFetchedAtRef.current = Date.now();
          try {
            const response = await fetch("/api/sessions", { cache: "no-store" });
            const sessionData = response.ok ? await response.json() as { sessions?: SessionInfo[] } : null;
            // Kept whole: activity items open the session through this record.
            if (sessionData?.sessions) sessionsByIdRef.current = new Map(sessionData.sessions.map((session) => [session.id, session]));
          } catch { /* status badges are best effort */ }
          // Status frames arrive back to back on connect, so a newer compute has
          // usually replaced this one by now (and was throttled out of its own
          // lookup); recompute so the sessions just fetched are used.
          if (cancelled) { setTick((current) => current + 1); return; }
        }
        const counts: Record<string, number> = {};
        for (const terminal of terminals) if (terminalIsBusy(terminal)) counts[terminal.cwd] = (counts[terminal.cwd] ?? 0) + 1;
        const now = Date.now();
        // Running items, terminals ended within 5 minutes, and items that
        // finished within the last 30 s; see lib/rail-activity.ts.
        const result = computeRailActivity({ terminals, runningSessionIds, codexRuntimes, claudeRuntimes, sessionsById: sessionsByIdRef.current, previousRunning: previousRunningRef.current, completed: completedRef.current, now });
        previousRunningRef.current = result.running;
        completedRef.current = result.completed;
        const activities = groupRailActivity(result.items, workspaces);
        let nextExpiry = result.nextExpiry;
        // A running session whose project is still unknown (brand-new, or its
        // lookup was throttled) gets another lookup once the throttle lapses.
        if (runningSessionIds.some((id) => !sessionsByIdRef.current.has(id))) nextExpiry = Math.min(nextExpiry, sessionRootsFetchedAtRef.current + SESSION_LOOKUP_THROTTLE_MS);
        if (cancelled) return;
        // Unchanged results keep their identity: AppShell renders on each change.
        setRunningByCwd((current) => sameJson(current, counts) ? current : counts);
        setActivityById((current) => sameJson(current, activities) ? current : activities);
        if (Number.isFinite(nextExpiry)) expiryTimer = setTimeout(() => { if (!cancelled) setTick((current) => current + 1); }, Math.max(0, nextExpiry - now));
      } catch { /* status badges are best effort */ }
    };
    void compute();
    return () => { cancelled = true; if (expiryTimer) clearTimeout(expiryTimer); };
  }, [terminalsStatus, runningSessionIdsStatus, codexRuntimesStatus, claudeRuntimesStatus, workspaces, tick]);

  const refreshSessionLabels = useCallback(() => {
    if (Date.now() - sessionRootsFetchedAtRef.current < SESSION_LOOKUP_THROTTLE_MS) return;
    const hasPiItems = [...(previousRunningRef.current?.values() ?? [])].some((item) => item.kind === "pi")
      || [...completedRef.current.values()].some((entry) => entry.item.kind === "pi");
    if (!hasPiItems) return;
    sessionRootsFetchedAtRef.current = Date.now();
    // Not cancelled when the list closes: opening an item closes it, and the
    // result still applies.
    void fetch("/api/sessions", { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ sessions?: SessionInfo[] }> : null)
      .then((sessionData) => {
        if (!sessionData?.sessions) return;
        sessionsByIdRef.current = new Map(sessionData.sessions.map((session) => [session.id, session]));
        setTick((current) => current + 1);
      })
      .catch(() => { /* keep the cached labels */ });
  }, []);

  return { activityById, runningByCwd, refreshSessionLabels };
}
