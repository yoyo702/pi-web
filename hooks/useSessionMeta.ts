"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "@/lib/clipboard";
import type { SessionStatsInfo } from "@/lib/pi-types";

export type SessionCopyField = "file" | "id";
export type AutoNameStatus =
  | { kind: "idle" }
  | { kind: "naming" }
  | { kind: "success" }
  | { kind: "error"; message: string };
export type ContextUsage = { percent: number | null; contextWindow: number; tokens: number | null };

/**
 * Top-bar session metadata: token/cost stats and context usage reported by
 * ChatWindow, copy-to-clipboard feedback, and the auto-name action.
 */
export function useSessionMeta({ sessionId, onAutoNameStart, onAutoNamed }: {
  sessionId: string | null;
  /** Called when auto-naming begins (e.g. to close open top-bar panels). */
  onAutoNameStart: () => void;
  /** Called with the generated title for the session that was named. */
  onAutoNamed: (sessionId: string, title: string) => void;
}) {
  // Session stats (tokens + cost) — populated by ChatWindow, displayed in top bar
  const [sessionStats, setSessionStats] = useState<SessionStatsInfo | null>(null);
  // Context usage — populated by ChatWindow, displayed in top bar
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const [autoNameStatus, setAutoNameStatus] = useState<AutoNameStatus>({ kind: "idle" });
  const [copiedSessionField, setCopiedSessionField] = useState<SessionCopyField | null>(null);
  const autoNameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSessionIdRef = useRef(sessionId);
  activeSessionIdRef.current = sessionId;
  const callbacksRef = useRef({ onAutoNameStart, onAutoNamed });
  callbacksRef.current = { onAutoNameStart, onAutoNamed };

  const handleSessionStatsChange = useCallback((stats: SessionStatsInfo | null) => {
    setSessionStats(stats);
  }, []);
  const handleContextUsageChange = useCallback((usage: ContextUsage | null) => {
    setContextUsage(usage);
  }, []);

  const handleCopySessionField = useCallback((field: SessionCopyField, value: string) => {
    void copyText(value).then(() => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
      setCopiedSessionField(field);
      sessionCopyTimerRef.current = setTimeout(() => setCopiedSessionField(null), 1400);
    });
  }, []);

  useEffect(() => {
    return () => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
      if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    };
  }, []);

  const handleAutoName = useCallback(async () => {
    if (!sessionId || autoNameStatus.kind === "naming") return;
    if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    callbacksRef.current.onAutoNameStart();
    setAutoNameStatus({ kind: "naming" });

    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/auto-name`, {
        method: "POST",
      });
      const body = (await response.json().catch(() => ({}))) as { title?: string; error?: string };
      if (!response.ok || !body.title) {
        throw new Error(body.error || `HTTP ${response.status}`);
      }

      const title = body.title.trim();
      callbacksRef.current.onAutoNamed(sessionId, title);
      if (activeSessionIdRef.current !== sessionId) return;
      setSessionStats((current) => current?.sessionId === sessionId ? { ...current, sessionName: title } : current);
      setAutoNameStatus({ kind: "success" });
      autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: "idle" }), 1800);
    } catch (error) {
      if (activeSessionIdRef.current !== sessionId) return;
      const message = error instanceof Error ? error.message : String(error);
      setAutoNameStatus({ kind: "error", message });
      autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: "idle" }), 5000);
    }
  }, [autoNameStatus.kind, sessionId]);

  useEffect(() => {
    if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    setAutoNameStatus({ kind: "idle" });
  }, [sessionId]);

  return {
    sessionStats,
    handleSessionStatsChange,
    contextUsage,
    handleContextUsageChange,
    copiedSessionField,
    handleCopySessionField,
    autoNameStatus,
    handleAutoName,
  };
}
