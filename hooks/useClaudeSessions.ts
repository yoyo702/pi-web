"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** A Claude Code session of one workspace folder, as listed by `/api/claude/sessions`. */
export interface ClaudeSession {
  id: string;
  /** Claude's custom or generated title, else the first prompt. */
  title: string;
  firstMessage: string | null;
  cwd: string | null;
  gitBranch: string | null;
  createdAt: string | null;
  updatedAt: string;
  size: number;
  /** Set while a terminal resumes (writes) this session or Claude Chat runs it. */
  runtime: { owner: "terminal"; state: "running"; terminalId: string } | { owner: "chat"; state: "idle" | "running" | "approval"; connected: boolean } | null;
}

const PAGE_SIZE = 50;
/** The server returns at most this many per request. */
const MAX_PAGE = 200;

/**
 * The folder's Claude sessions, loaded only while `enabled` (the Claude tree is
 * open). Claude writes its session files itself, so the list is re-read every
 * 30 s while visible and whenever `changeKey` changes (a Claude terminal
 * started or ended).
 */
export function useClaudeSessions(cwd: string, { enabled, query, changeKey, refreshKey }: { enabled: boolean; query: string; changeKey: string; refreshKey?: number }) {
  const [sessions, setSessions] = useState<ClaudeSession[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const requestRef = useRef(0);
  const loadedRef = useRef(0);

  const fetchPage = useCallback(async (cursor: number, limit: number) => {
    const params = new URLSearchParams({ cwd, limit: String(limit), cursor: String(cursor) });
    if (query) params.set("q", query);
    const response = await fetch(`/api/claude/sessions?${params}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Unable to load Claude sessions");
    const data = await response.json() as { sessions?: ClaudeSession[]; nextCursor?: string | null };
    return { page: data.sessions ?? [], cursor: data.nextCursor ?? null };
  }, [cwd, query]);

  // A refresh re-reads the rows already shown (the cursor is an offset), in
  // pages of up to 200. Only the latest request applies its result; a newer
  // request also ends the "loading" state of the one it replaced.
  const reload = useCallback(async (quiet = false) => {
    const requestId = ++requestRef.current;
    if (!quiet) setLoading(true);
    setLoadingMore(false);
    try {
      const wanted = quiet ? Math.max(PAGE_SIZE, loadedRef.current) : PAGE_SIZE;
      const rows: ClaudeSession[] = [];
      let cursor: string | null = null;
      do {
        const result = await fetchPage(rows.length, Math.min(MAX_PAGE, wanted - rows.length));
        if (requestId !== requestRef.current) return;
        rows.push(...result.page);
        cursor = result.cursor;
      } while (cursor && rows.length < wanted);
      loadedRef.current = rows.length;
      setSessions(rows);
      setNextCursor(cursor);
      setError(false);
      setLoadMoreError(false);
    } catch {
      if (requestId === requestRef.current) setError(true);
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [fetchPage]);

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    const requestId = ++requestRef.current;
    setLoading(false);
    setLoadingMore(true);
    setLoadMoreError(false);
    try {
      const { page, cursor } = await fetchPage(Number(nextCursor), PAGE_SIZE);
      if (requestId !== requestRef.current) return;
      setSessions((current) => {
        const ids = new Set(current.map((session) => session.id));
        const next = [...current, ...page.filter((session) => !ids.has(session.id))];
        loadedRef.current = next.length;
        return next;
      });
      setNextCursor(cursor);
    } catch {
      if (requestId === requestRef.current) setLoadMoreError(true);
    } finally {
      if (requestId === requestRef.current) setLoadingMore(false);
    }
  }, [fetchPage, nextCursor]);

  // Another folder's or search's rows must not stay clickable while the new
  // list loads; they would be resumed or deleted against the wrong folder.
  useEffect(() => {
    ++requestRef.current;
    loadedRef.current = 0;
    setSessions([]);
    setNextCursor(null);
    setError(false);
    setLoadMoreError(false);
  }, [cwd, query]);

  useEffect(() => {
    if (!enabled || !cwd) return;
    void reload();
    const timer = window.setInterval(() => { if (!document.hidden) void reload(true); }, 30_000);
    return () => window.clearInterval(timer);
  }, [cwd, enabled, refreshKey, reload]);

  const lastChangeKeyRef = useRef(changeKey);
  useEffect(() => {
    if (lastChangeKeyRef.current === changeKey) return;
    lastChangeKeyRef.current = changeKey;
    if (enabled && cwd) void reload(true);
  }, [changeKey, cwd, enabled, reload]);

  return { sessions, nextCursor, loading, loadingMore, error, loadMoreError, reload, loadMore };
}
