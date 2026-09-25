"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { claudeConversationItems, type ClaudeRecord } from "@/lib/agents/claude-conversation";
import type { ChatDraftImage } from "@/lib/draft-store";
import type { ClaudePermissionMode } from "@/lib/workspace/tabs";
import { CodexAssistantThread, type PermissionOption } from "../codex/CodexAssistantThread";
import { ClaudePermissionCard, type ClaudePermissionAnswer, type ClaudePermissionRequest } from "./ClaudePermissionCard";

type ClaudeEvent = ClaudeRecord & { piRuntime?: string; runtimeId?: string; request_id?: string; request?: ClaudePermissionRequest["request"]; requestId?: string; permissionMode?: string; model?: string; interrupted?: boolean; error?: string };
type Runtime = { runtimeId: string; running: boolean; model: string | null; permissionMode: string | null; process: boolean; requests: ClaudePermissionRequest[] };
type ChatRead = { session?: { id: string; title: string | null }; history?: ClaudeRecord[]; cursor?: number | null; events?: ClaudeEvent[]; runtime?: Runtime | null; terminal?: { terminalId: string } | null };
type ApiError = { error?: string; code?: string };

const MODEL_OPTIONS = [{ id: "sonnet", label: "Sonnet" }, { id: "opus", label: "Opus" }, { id: "haiku", label: "Haiku" }];
const PERMISSION_OPTIONS: PermissionOption[] = [{ value: "default", label: "Ask before edits" }, { value: "acceptEdits", label: "Accept edits" }, { value: "plan", label: "Plan mode" }, { value: "bypassPermissions", label: "Bypass permissions" }];
const isPermissionMode = (value: unknown): value is ClaudePermissionMode => PERMISSION_OPTIONS.some((option) => option.value === value);
const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
async function failure(response: Response, fallback: string) {
  const data = await response.json().catch(() => ({})) as ApiError;
  return Object.assign(new Error(data.error || fallback), { code: data.code });
}

/**
 * A Claude Code session driven by a server-side `claude --print` process
 * (server/agents/claude-chat-runtime.cjs). The transcript is loaded in pages;
 * live events arrive on the chat's SSE stream and replay from `after`.
 */
export function ClaudeChatPanel({ sessionId: initialSessionId, cwd, sessionName, model: initialModel, permissionMode: initialPermissionMode, workspaceTabId, onCreated, onOpenFile, onStatusChange, onConfigurationChange }: { sessionId: string | null; cwd: string; sessionName?: string; model: string; permissionMode: ClaudePermissionMode; workspaceTabId: string; onCreated?: (tabId: string, cwd: string, sessionId: string, title: string) => void; onOpenFile?: (filePath: string) => void; onStatusChange?: (tabId: string, status: "idle" | "running" | "approval") => void; onConfigurationChange?: (tabId: string, configuration: { model?: string; permissionMode?: ClaudePermissionMode }) => void }) {
  const [sessionId, setSessionId] = useState(initialSessionId);
  const [title, setTitle] = useState(sessionName ?? "");
  const [history, setHistory] = useState<ClaudeRecord[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [events, setEvents] = useState<ClaudeEvent[]>([]);
  const [pending, setPending] = useState<ClaudeRecord[]>([]);
  const [requests, setRequests] = useState<ClaudePermissionRequest[]>([]);
  const [running, setRunning] = useState(false);
  const [sending, setSending] = useState(false);
  const [connection, setConnection] = useState<"loading" | "connected" | "reconnecting" | "failed">(initialSessionId ? "loading" : "connected");
  const [error, setError] = useState<string | null>(null);
  const [terminalConflict, setTerminalConflict] = useState(false);
  const [model, setModel] = useState(initialModel);
  const [reportedModel, setReportedModel] = useState<string | null>(null);
  const [permissionMode, setPermissionMode] = useState<ClaudePermissionMode>(initialPermissionMode);
  const [notice, setNotice] = useState("");
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // Sequence numbers restart with each chat runtime on the server.
  const runtimeIdRef = useRef("");
  const lastSeqRef = useRef(0);

  const runState = requests.length ? "approval" : running || sending ? "running" : "idle";
  useEffect(() => { onStatusChange?.(workspaceTabId, runState); }, [onStatusChange, runState, workspaceTabId]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3_500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const adoptPermissionMode = useCallback((mode: unknown) => {
    // "Allow for session" can switch the live mode; keep it for the next message.
    if (!isPermissionMode(mode)) return;
    setPermissionMode((current) => {
      if (current !== mode) onConfigurationChange?.(workspaceTabId, { permissionMode: mode });
      return mode;
    });
  }, [onConfigurationChange, workspaceTabId]);

  const apply = useCallback((event: ClaudeEvent) => {
    if (event.type === "user") setRunning(true);
    else if (event.type === "result") {
      setRunning(false); setRequests([]);
      if (event.interrupted) setNotice("Turn interrupted");
    } else if (event.type === "pi/closed" || event.type === "pi/stopped") {
      setRunning(false); setRequests([]);
      if (event.type === "pi/closed") setError((current) => current ?? "Claude exited. Send a message to start it again.");
    } else if (event.type === "control_request" && event.request_id && event.request) {
      const request = { request_id: event.request_id, request: event.request };
      setRequests((current) => [...current.filter((item) => item.request_id !== request.request_id), request]);
    } else if (event.type === "pi/resolved") setRequests((current) => current.filter((item) => item.request_id !== event.requestId));
    else if (event.type === "system") {
      if (event.model) setReportedModel(event.model);
      adoptPermissionMode(event.permissionMode);
    }
  }, [adoptPermissionMode]);

  useEffect(() => {
    if (!sessionId) return;
    let closed = false;
    let source: EventSource | null = null;
    runtimeIdRef.current = ""; lastSeqRef.current = 0;
    setConnection("loading"); setTerminalConflict(false);
    const connect = () => {
      const params = new URLSearchParams({ cwd });
      if (runtimeIdRef.current && lastSeqRef.current) params.set("after", `${runtimeIdRef.current}:${lastSeqRef.current}`);
      source = new EventSource(`/api/claude/chat/${encodeURIComponent(sessionId)}/events?${params}`);
      source.onopen = () => { setConnection("connected"); setError((current) => current?.includes("connection") ? null : current); };
      source.onmessage = (raw) => {
        let event: ClaudeEvent;
        try { event = JSON.parse(raw.data) as ClaudeEvent; } catch { return; }
        // Events were missed: the runtime was replaced (it stopped while idle
        // and another chat opened it) or they fell out of its buffer. The
        // snapshot has the finished records and the live state.
        if (event.type === "pi/reset") { source?.close(); setReloadKey((key) => key + 1); return; }
        if (event.type === "pi/connected") {
          if (runtimeIdRef.current && event.runtimeId !== runtimeIdRef.current) { source?.close(); setReloadKey((key) => key + 1); return; }
          runtimeIdRef.current = event.runtimeId ?? "";
          return;
        }
        if (event.piSeq && event.piSeq <= lastSeqRef.current) return;
        if (event.piSeq) lastSeqRef.current = event.piSeq;
        apply(event);
        // Deltas are superseded by the finished records once the turn ends.
        setEvents((current) => event.type === "result" ? [...current.filter((item) => item.type !== "stream_event"), event] : [...current, event]);
      };
      source.onerror = () => {
        if (source?.readyState === EventSource.CLOSED) { setConnection("failed"); setError("Claude chat disconnected."); return; }
        setConnection("reconnecting"); setError("Claude chat connection interrupted; retrying…");
      };
    };
    void fetch(`/api/claude/chat/${encodeURIComponent(sessionId)}?${new URLSearchParams({ cwd })}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw await failure(response, `History request failed (${response.status})`);
        return await response.json() as ChatRead;
      })
      .then((data) => {
        if (closed) return;
        if (data.session?.title) setTitle((current) => current || data.session?.title || "");
        setHistory(data.history ?? []);
        setCursor(data.cursor ?? null);
        const initial = data.events ?? [];
        setEvents(initial);
        runtimeIdRef.current = data.runtime?.runtimeId ?? "";
        lastSeqRef.current = Math.max(0, ...initial.map((event) => event.piSeq ?? 0));
        setRunning(Boolean(data.runtime?.running));
        setRequests(data.runtime?.requests ?? []);
        if (data.runtime?.model) setReportedModel(data.runtime.model);
        if (data.runtime?.process) adoptPermissionMode(data.runtime.permissionMode);
        setTerminalConflict(Boolean(data.terminal));
        connect();
      })
      .catch((cause) => { if (!closed) { setConnection("failed"); setError(cause instanceof Error ? cause.message : "Unable to load the Claude session"); } });
    return () => { closed = true; source?.close(); };
  }, [adoptPermissionMode, apply, cwd, reloadKey, sessionId]);

  const items = useMemo(() => {
    const seen = new Set([...history, ...events].flatMap((record) => record.type === "user" && record.uuid ? [record.uuid] : []));
    return claudeConversationItems([...history, ...events, ...pending.filter((record) => !seen.has(record.uuid ?? ""))]);
  }, [events, history, pending]);

  const loadEarlier = useCallback(async () => {
    if (!sessionId || cursor === null) return;
    setLoadingEarlier(true);
    try {
      const response = await fetch(`/api/claude/chat/${encodeURIComponent(sessionId)}?${new URLSearchParams({ cwd, before: String(cursor) })}`, { cache: "no-store" });
      if (!response.ok) throw await failure(response, "Unable to load earlier messages");
      const data = await response.json() as ChatRead;
      setHistory((current) => [...(data.history ?? []), ...current]);
      setCursor(data.cursor ?? null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to load earlier messages"); }
    finally { setLoadingEarlier(false); }
  }, [cursor, cwd, sessionId]);

  const send = useCallback(async (textOverride?: string, images: ChatDraftImage[] = []): Promise<boolean> => {
    const text = textOverride?.trim() ?? "";
    if (images.length) { setError("Claude Chat does not support images yet. Remove them to send."); return false; }
    if (!text || connection !== "connected") return false;
    const uuid = crypto.randomUUID();
    setSending(true); setError(null);
    setPending((current) => [...current, { type: "user", uuid, pending: true, message: { role: "user", content: text } }]);
    const body = { cwd, text, uuid, model, permissionMode };
    try {
      if (!sessionId) {
        // The first message of a new chat creates the session.
        const response = await post("/api/claude/chat", body);
        if (!response.ok) throw await failure(response, "Unable to start a Claude chat");
        const data = await response.json() as { sessionId: string };
        const name = text.replace(/\s+/g, " ").slice(0, 60);
        setTitle(name); setSessionId(data.sessionId);
        onCreated?.(workspaceTabId, cwd, data.sessionId, name);
        return true;
      }
      const response = await post(`/api/claude/chat/${encodeURIComponent(sessionId)}/send`, body);
      if (!response.ok) throw await failure(response, "Unable to send the message to Claude");
      // `running` follows the runtime's `user` event, which precedes this answer.
      return true;
    } catch (cause) {
      setPending((current) => current.filter((record) => record.uuid !== uuid));
      if ((cause as { code?: string }).code === "terminal_owns_session") setTerminalConflict(true);
      else setError(cause instanceof Error ? cause.message : "Unable to send the message to Claude");
      return false;
    } finally { setSending(false); }
  }, [connection, cwd, model, onCreated, permissionMode, sessionId, workspaceTabId]);

  const stop = useCallback(async () => {
    if (!sessionId) return;
    const response = await post(`/api/claude/chat/${encodeURIComponent(sessionId)}/interrupt`, { cwd }).catch(() => null);
    if (response && !response.ok) {
      const cause = await failure(response, "Unable to stop the current turn");
      if ((cause as { code?: string }).code === "no_active_turn") setRunning(false);
      else setError(cause.message);
    }
  }, [cwd, sessionId]);

  const answer = useCallback(async (requestId: string, value: ClaudePermissionAnswer) => {
    if (!sessionId) return;
    const response = await post(`/api/claude/chat/${encodeURIComponent(sessionId)}/respond`, { cwd, requestId, ...value }).catch(() => null);
    if (response?.ok) { setRequests((current) => current.filter((item) => item.request_id !== requestId)); return; }
    const cause = response ? await failure(response, "Unable to answer Claude") : new Error("Unable to answer Claude");
    if ((cause as { code?: string }).code === "approval_expired") { setRequests((current) => current.filter((item) => item.request_id !== requestId)); setError("That request is no longer pending."); }
    else setError(cause.message);
  }, [cwd, sessionId]);

  const claim = useCallback(async () => {
    if (!sessionId) return;
    setSending(true);
    try {
      const response = await post(`/api/claude/chat/${encodeURIComponent(sessionId)}/claim`, { cwd });
      if (!response.ok) throw await failure(response, "Unable to stop the terminal");
      setTerminalConflict(false); setError(null); setReloadKey((key) => key + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to stop the terminal"); }
    finally { setSending(false); }
  }, [cwd, sessionId]);

  const modelLabel = MODEL_OPTIONS.find((option) => option.id === model)?.label ?? (reportedModel || "Default model");
  return <section style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--bg)" }}>
    <header style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)", color: "var(--text-muted)", fontSize: 12 }}>
      <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><strong style={{ color: "var(--text)" }}>Claude Chat{title ? ` · ${title}` : !sessionId ? " · New chat" : ""}</strong><span title={cwd}> · {cwd}</span></span>
      {cursor !== null && <button type="button" onClick={() => void loadEarlier()} disabled={loadingEarlier} style={buttonStyle}>{loadingEarlier ? "Loading…" : "Load earlier"}</button>}
    </header>
    {terminalConflict ? <div role="alert" style={{ padding: "7px 10px", color: "#fbbf24", fontSize: 12 }}>
      This session is open in a Claude terminal. Stop the terminal to continue here.
      <button type="button" onClick={() => void claim()} disabled={sending} style={{ ...buttonStyle, marginLeft: 8 }}>Stop terminal</button>
    </div> : error && <div role="alert" style={{ padding: "7px 10px", color: "#fca5a5", fontSize: 12 }}>{error}{connection === "failed" ? <button type="button" onClick={() => { setError(null); setReloadKey((key) => key + 1); }} style={{ ...buttonStyle, marginLeft: 8 }}>Reconnect</button> : null}</div>}
    <div style={{ flex: 1, minHeight: 0 }}>
      <CodexAssistantThread
        items={items}
        running={runState !== "idle"}
        requestCards={requests.map((request, index) => <ClaudePermissionCard key={request.request_id} request={request} position={index + 1} total={requests.length} onAnswer={(requestId, value) => void answer(requestId, value)} />)}
        canSteer={false}
        slashCommands={[]}
        permissionOptions={PERMISSION_OPTIONS}
        cwd={cwd}
        draftKey={`claude:${sessionId ?? workspaceTabId}`}
        modelLabel={modelLabel}
        modelValue={model}
        modelOptions={MODEL_OPTIONS}
        modelMenuRequest={0}
        reasoningEffort=""
        serviceTier=""
        approvalPolicy={permissionMode}
        approvalLabel={PERMISSION_OPTIONS.find((option) => option.value === permissionMode)?.label ?? permissionMode}
        statusLabel={connection !== "connected" ? connection === "reconnecting" ? "Reconnecting" : connection === "loading" ? "Loading" : "Offline" : runState === "approval" ? "Approval" : runState === "running" ? "Working" : "Ready"}
        activityLabel={runState === "running" ? "Claude is working…" : undefined}
        noticeLabel={notice || undefined}
        forkDisabled
        onModelToggle={() => undefined}
        onModelChange={(value) => { setModel(value); onConfigurationChange?.(workspaceTabId, { model: value || undefined }); setNotice(value ? `Model changed to ${MODEL_OPTIONS.find((option) => option.id === value)?.label ?? value} · applies to the next message` : "Using the default model on the next message"); }}
        onReasoningEffortChange={() => undefined}
        onServiceTierChange={() => undefined}
        onApprovalPolicyChange={(value) => { if (!isPermissionMode(value)) return; setPermissionMode(value); onConfigurationChange?.(workspaceTabId, { permissionMode: value }); setNotice("Permission mode updated · applies to the next message"); }}
        onSend={send}
        onSteer={async () => "queue"}
        onStop={stop}
        onOpenFile={onOpenFile}
      />
    </div>
  </section>;
}
const buttonStyle: React.CSSProperties = { border: "1px solid var(--border)", background: "var(--bg-hover)", borderRadius: 6, color: "var(--text)", padding: "5px 10px", cursor: "pointer" };
