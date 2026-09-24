"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TerminalSession } from "@/lib/agents/terminal";
import { CodexAssistantThread } from "./CodexAssistantThread";
import { isCodexCardRequest, type CodexRequestAnswer, type CodexServerRequest } from "./CodexRequestCard";
import { reduceCodexEvent, type CodexConversationItem } from "@/lib/agents/codex-conversation";
import type { ChatDraftImage } from "@/lib/draft-store";
import { useWorkspaceStatusSelector } from "@/hooks/useWorkspaceStatus";

type HistoryMessage = { role: "user" | "assistant"; text: string };
type ModelOption = { id: string; label: string; provider?: string; defaultReasoningEffort?: string; reasoningEfforts?: { id: string; description?: string }[]; defaultServiceTier?: string; serviceTiers?: { id: string; label: string; description?: string }[] };
type AppItem = Record<string, unknown> & { id?: string; type?: string };
type TokenCount = { totalTokens?: number; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; reasoningOutputTokens?: number };
type TokenUsagePayload = { totalTokens?: number; total?: TokenCount; last?: TokenCount; modelContextWindow?: number };
type AppEvent = { id?: string | number; piSeq?: number; piRuntime?: string; method?: string; params?: { turnId?: string; runtimeId?: string; willRetry?: boolean; turn?: { status?: string; error?: { message?: string } | null }; requestId?: string | number; delta?: string; command?: string | string[]; cwd?: string; grantRoot?: string; reason?: string; message?: string; error?: { message?: string } | string; status?: { type?: string; activeFlags?: string[] }; tokenUsage?: TokenUsagePayload; modelContextWindow?: number; item?: AppItem } };
function requestFromEvent(event: AppEvent): CodexServerRequest | null {
  return event.id !== undefined && isCodexCardRequest(event.method) ? { id: String(event.id), method: event.method!, params: (event.params ?? {}) as Record<string, unknown> } : null;
}
function pendingApprovalsFromEvents(events: AppEvent[]): CodexServerRequest[] {
  const pending = new Map<string, CodexServerRequest>();
  for (const event of events) {
    const request = requestFromEvent(event);
    if (request) pending.set(request.id, request);
    if (event.method === "serverRequest/resolved" && event.params?.requestId !== undefined) pending.delete(String(event.params.requestId));
    if (event.method === "turn/completed") pending.clear();
  }
  return [...pending.values()];
}
function tokenUsageFromEvent(event: AppEvent): { used: number; limit?: number } | null {
  if (event.method !== "thread/tokenUsage/updated" || !event.params?.tokenUsage) return null;
  const usage = event.params.tokenUsage;
  const used = usage.last?.totalTokens ?? usage.last?.inputTokens ?? usage.totalTokens ?? usage.total?.totalTokens;
  if (typeof used !== "number") return null;
  return { used, limit: event.params.modelContextWindow ?? usage.modelContextWindow };
}
/** Fallback reconcile while working; pushed runtime status is the fast path. Matches Pi's AGENT_STATE_RECONCILE_MS. */
const CODEX_RECONCILE_FALLBACK_MS = 15_000;
type ApiError = { error?: string; code?: string };
/** A request refused because a Codex terminal may be writing this session. */
type TerminalConflict = { kind: "owns" | "unknown"; message: string };
function errorText(event: AppEvent) {
  return typeof event.params?.error === "string" ? event.params.error : event.params?.error?.message ?? event.params?.message;
}
type ThreadRead = {
  name?: string;
  title?: string;
  model?: string;
  status?: { type?: string; activeFlags?: string[] };
  turns?: { status?: string; items?: AppItem[] }[];
  thread?: { name?: string; title?: string; model?: string; turns?: { status?: string; items?: AppItem[] }[]; status?: { type?: string; activeFlags?: string[] } };
};

export function CodexChatPanel({ terminal, workspaceTabId, onOpenFile, onStatusChange, onConfigurationChange }: { terminal: Pick<TerminalSession, "cwd" | "model" | "sourceSessionId"> & { reasoningEffort?: string; serviceTier?: string; approvalPolicy?: "untrusted" | "on-request" | "never"; sessionName?: string }; workspaceTabId: string; onOpenFile?: (filePath: string) => void; onStatusChange?: (tabId: string, status: "idle" | "running" | "approval") => void; onConfigurationChange?: (tabId: string, configuration: { model?: string; reasoningEffort?: string; serviceTier?: string; approvalPolicy?: "untrusted" | "on-request" | "never" }) => void }) {
  const [items, setItems] = useState<CodexConversationItem[]>([]);
  const [approvals, setApprovals] = useState<CodexServerRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<"loading" | "connected" | "reconnecting" | "failed">("loading");
  const [runState, setRunState] = useState<"idle" | "working" | "approval" | "recovering">("idle");
  useEffect(() => { onStatusChange?.(workspaceTabId, runState === "approval" ? "approval" : runState === "working" || runState === "recovering" ? "running" : "idle"); }, [onStatusChange, runState, workspaceTabId]);
  const [sending, setSending] = useState(false);
  const [chatModel, setChatModel] = useState(terminal.model ?? "");
  const [reasoningEffort, setReasoningEffort] = useState(terminal.reasoningEffort ?? "");
  const [serviceTier, setServiceTier] = useState(terminal.serviceTier ?? "");
  const [approvalPolicy, setApprovalPolicy] = useState<"untrusted" | "on-request" | "never">(terminal.approvalPolicy ?? "untrusted");
  const [modelMenuRequest, setModelMenuRequest] = useState(0);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [sessionModel, setSessionModel] = useState<string | null>(terminal.model ?? null);
  const [sessionName, setSessionName] = useState(terminal.sessionName ?? "");
  const [threadId, setThreadId] = useState(terminal.sourceSessionId);
  const [currentActivity, setCurrentActivity] = useState("");
  const [contextUsage, setContextUsage] = useState<{ used: number; limit?: number } | null>(null);
  const [modelNotice, setModelNotice] = useState("");
  const lastEventSeqRef = useRef(0);
  // Sequence numbers restart with each app-server process (runtime).
  const runtimeIdRef = useRef("");
  const [reloadKey, setReloadKey] = useState(0);
  const [conflict, setConflict] = useState<TerminalConflict | null>(null);
  // "ignore" once the user chose to write alongside an unknown Codex terminal.
  const terminalsChoiceRef = useRef<"ignore" | undefined>(undefined);

  useEffect(() => { lastEventSeqRef.current = 0; runtimeIdRef.current = ""; terminalsChoiceRef.current = undefined; setConflict(null); }, [threadId]);
  useEffect(() => {
    if (!modelNotice) return;
    const timer = window.setTimeout(() => setModelNotice(""), 3_500);
    return () => window.clearTimeout(timer);
  }, [modelNotice]);

  useEffect(() => {
    if (!threadId) { setError("Structured Chat requires a session started with Resume or Fork."); return; }
    let closed = false;
    let source: EventSource | null = null;
    const connect = () => {
      const params = new URLSearchParams();
      if (terminal.model) params.set("model", terminal.model);
      if (terminal.serviceTier) params.set("serviceTier", terminal.serviceTier);
      if (terminal.approvalPolicy) params.set("approvalPolicy", terminal.approvalPolicy);
      if (lastEventSeqRef.current && runtimeIdRef.current) params.set("after", `${runtimeIdRef.current}:${lastEventSeqRef.current}`);
      source = new EventSource(`/api/codex/chat/${encodeURIComponent(threadId)}/events${params.size ? `?${params}` : ""}`);
      source.onopen = () => { setConnection("connected"); setError((current) => current?.includes("connection") ? null : current); };
      source.onmessage = (raw) => {
        try {
          const event = JSON.parse(raw.data) as AppEvent;
          const eventRuntime = event.method === "codex/connected" ? event.params?.runtimeId : event.piRuntime;
          if (eventRuntime && eventRuntime !== runtimeIdRef.current) { runtimeIdRef.current = eventRuntime; lastEventSeqRef.current = 0; }
          if (event.piSeq && event.piSeq <= lastEventSeqRef.current) return;
          if (event.piSeq) lastEventSeqRef.current = event.piSeq;
          const nextUsage = tokenUsageFromEvent(event);
          if (nextUsage) setContextUsage(nextUsage);
          if (event.method === "error") {
            // willRetry: Codex retries the request itself; the turn goes on.
            if (event.params?.willRetry) setError(`Codex is retrying: ${errorText(event) || "temporary error"}`);
            else { setError(errorText(event) || "Codex reported an error"); setRunState("idle"); }
          }
          if (event.method === "item/started" || event.method === "turn/started") { setRunState("working"); setError((current) => current?.startsWith("Codex is retrying") || current?.startsWith("Codex asked for") ? null : current); }
          if (event.method === "turn/completed" && event.params?.turn?.error?.message) setError(`Turn failed: ${event.params.turn.error.message}`);
          if (event.method === "codex/closed") { setConnection("reconnecting"); setRunState("idle"); setCurrentActivity(""); setApprovals([]); }
          if (event.method === "item/started") {
            const item = event.params?.item;
            setCurrentActivity(item?.type === "commandExecution" ? `Running: ${String(item.command ?? "command")}` : item?.type === "fileChange" ? "Applying file changes…" : item?.type === "webSearch" ? "Searching the web…" : "Codex is working…");
          }
          if (event.method === "turn/completed") { setRunState("idle"); setCurrentActivity(""); setApprovals([]); }
          if (event.method === "thread/status/changed") {
            if (event.params?.status?.activeFlags?.includes("waitingOnApproval")) setRunState("approval");
            else if (event.params?.status?.type === "idle" || event.params?.status?.activeFlags?.length === 0) { setRunState("idle"); setCurrentActivity(""); }
          }
          const request = requestFromEvent(event);
          if (request) { setApprovals((current) => [...current.filter((approval) => approval.id !== request.id), request]); setRunState("approval"); }
          if (event.method === "codex/unsupportedRequest") setError(`Codex asked for ${String((event.params as { method?: unknown } | undefined)?.method ?? "an action")}, which Codex Chat does not support; it was declined.`);
          if (event.method === "serverRequest/resolved" && event.params?.requestId !== undefined) setApprovals((current) => {
            const next = current.filter((approval) => approval.id !== String(event.params?.requestId));
            if (next.length) setRunState("approval");
            return next;
          });
          setItems((current) => reduceCodexEvent(current, event));
        } catch { setError("Received an unreadable event from Codex"); }
      };
      source.onerror = () => {
        // CLOSED: the server refused the stream (e.g. the session is busy); the browser won't retry.
        if (source?.readyState === EventSource.CLOSED) { setConnection("failed"); setError("Codex chat disconnected."); return; }
        setConnection("reconnecting"); setError("Codex chat connection interrupted; retrying…");
      };
    };
    setConnection("loading");
    const params = new URLSearchParams();
    if (terminal.model) params.set("model", terminal.model);
    if (terminal.serviceTier) params.set("serviceTier", terminal.serviceTier);
    if (terminal.approvalPolicy) params.set("approvalPolicy", terminal.approvalPolicy);
    void fetch(`/api/codex/chat/${encodeURIComponent(threadId)}${params.size ? `?${params}` : ""}`, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as ApiError & { history?: HistoryMessage[]; events?: AppEvent[]; thread?: ThreadRead };
        if (data.code === "terminal_owns_session") setConflict({ kind: "owns", message: data.error ?? "This session is running in a Codex terminal." });
        if (!response.ok) throw new Error(data.error ?? `History request failed (${response.status})`);
        return data;
      })
      .then((data) => {
        if (closed) return;
        setSessionModel(data.thread?.thread?.model ?? data.thread?.model ?? terminal.model ?? null);
        setSessionName(data.thread?.thread?.name ?? data.thread?.thread?.title ?? data.thread?.name ?? data.thread?.title ?? terminal.sessionName ?? "");
        const turns = data.thread?.thread?.turns ?? data.thread?.turns ?? [];
        lastEventSeqRef.current = Math.max(0, ...(data.events ?? []).map((event) => event.piSeq ?? 0));
        runtimeIdRef.current = data.events?.at(-1)?.piRuntime ?? "";
        const latestUsage = [...(data.events ?? [])].reverse().map(tokenUsageFromEvent).find(Boolean);
        if (latestUsage) setContextUsage(latestUsage);
        const persistedEvents: AppEvent[] = turns.flatMap((turn) => (turn.items ?? []).map((item) => ({ method: "item/completed", params: { item } })));
        const history: CodexConversationItem[] = persistedEvents.length ? [] : (data.history ?? []).map((message, index) => ({ id: `history-${index}`, kind: "message", role: message.role, text: message.text }));
        setItems([...(persistedEvents), ...(data.events ?? [])].reduce(reduceCodexEvent, history));
        const pendingApprovals = pendingApprovalsFromEvents(data.events ?? []);
        setApprovals(pendingApprovals);
        if (pendingApprovals.length) {
          setRunState("approval");
        }
        if (data.thread?.thread?.status?.activeFlags?.includes("waitingOnApproval")) {
          setRunState("approval");
          setError("Codex is waiting for an approval. Use the approval card shown in this Chat.");
        }
        connect();
      })
      .catch((cause) => { setConnection("failed"); setError(cause instanceof Error ? cause.message : "Unable to load Codex history"); });
    return () => { closed = true; source?.close(); };
  }, [reloadKey, terminal.approvalPolicy, terminal.model, terminal.serviceTier, terminal.sessionName, threadId]);

  // This thread's pushed runtime state as a primitive, so the panel re-renders
  // (and the reconcile trigger below fires) only when it actually changes.
  const pushedRuntimeState = useWorkspaceStatusSelector((status) => {
    if (!threadId || status.codexRuntimes === null) return "unknown";
    return status.codexRuntimes.find((runtime) => runtime.threadId === threadId)?.state ?? "absent";
  });
  const reconcileRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!threadId || runState !== "working") return;
    const reconcile = async () => {
      const params = new URLSearchParams();
      if (terminal.model) params.set("model", terminal.model);
      if (terminal.approvalPolicy) params.set("approvalPolicy", terminal.approvalPolicy);
      try {
        const response = await fetch(`/api/codex/chat/${encodeURIComponent(threadId)}${params.size ? `?${params}` : ""}`, { cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json() as { thread?: ThreadRead };
        const thread = data.thread?.thread ?? data.thread;
        const turns = thread?.turns ?? [];
        const latestTurn = turns.at(-1);
        const persistedEvents: AppEvent[] = turns.flatMap((turn) => (turn.items ?? []).map((item) => ({ method: "item/completed", params: { item } })));
        const isIdle = thread?.status?.type === "idle" || Boolean(latestTurn?.status && latestTurn.status !== "inProgress");
        if (isIdle && persistedEvents.length) setItems(persistedEvents.reduce(reduceCodexEvent, []));
        if (isIdle) {
          setRunState("idle");
          setCurrentActivity("");
        }
      } catch { /* SSE remains primary; try again on the next trigger */ }
    };
    // SSE is primary. Reconcile once now, again whenever the pushed runtime
    // status for this thread changes (below), when the page becomes visible or
    // the network returns, and on a slow fallback interval.
    reconcileRef.current = () => void reconcile();
    void reconcile();
    const timer = window.setInterval(() => void reconcile(), CODEX_RECONCILE_FALLBACK_MS);
    const onVisible = () => { if (document.visibilityState === "visible") void reconcile(); };
    const onOnline = () => void reconcile();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      reconcileRef.current = null;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [runState, terminal.approvalPolicy, terminal.model, threadId]);

  // A pushed turn end / approval / runtime exit while the panel still thinks
  // it's working means the SSE end-of-turn may have been missed. Only react to
  // a turn that was seen running: a first send registers the runtime as idle
  // before turn/start, and reconciling then would replace the optimistic
  // user message with the persisted (still idle) thread.
  const previousPushedStateRef = useRef(pushedRuntimeState);
  useEffect(() => {
    const previous = previousPushedStateRef.current;
    previousPushedStateRef.current = pushedRuntimeState;
    if ((previous === "running" || previous === "approval") && pushedRuntimeState !== previous) reconcileRef.current?.();
  }, [pushedRuntimeState]);

  useEffect(() => {
    if (!threadId || modelOptions.length) return;
    void fetch(`/api/codex/models?${new URLSearchParams({ cwd: terminal.cwd })}`, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as { result?: { data?: { id?: string; displayName?: string; provider?: string; defaultReasoningEffort?: string; supportedReasoningEfforts?: { reasoningEffort?: string; description?: string }[]; defaultServiceTier?: string | null; serviceTiers?: { id?: string; name?: string; description?: string }[] }[]; models?: { id?: string; displayName?: string; provider?: string; defaultReasoningEffort?: string; supportedReasoningEfforts?: { reasoningEffort?: string; description?: string }[]; defaultServiceTier?: string | null; serviceTiers?: { id?: string; name?: string; description?: string }[] }[] } };
        if (!response.ok) return;
        const models = data.result?.data ?? data.result?.models ?? [];
        setModelOptions(models.flatMap((model): ModelOption[] => model.id ? [{ id: model.id, label: model.displayName || model.id, provider: model.provider, defaultReasoningEffort: model.defaultReasoningEffort, reasoningEfforts: (model.supportedReasoningEfforts ?? []).flatMap((option) => option.reasoningEffort ? [{ id: option.reasoningEffort, description: option.description }] : []), defaultServiceTier: model.defaultServiceTier ?? undefined, serviceTiers: (model.serviceTiers ?? []).flatMap((option) => option.id ? [{ id: option.id, label: option.name || option.id, description: option.description }] : []) }] : []).sort((a, b) => (a.provider || "").localeCompare(b.provider || "") || a.label.localeCompare(b.label)));
      }).catch(() => { /* keep default model available */ });
  }, [modelOptions.length, terminal.cwd, threadId]);

  const send = useCallback(async (textOverride?: string, images: ChatDraftImage[] = []): Promise<boolean> => {
    const text = textOverride?.trim() ?? "";
    if ((!text && !images.length) || connection !== "connected") return false;
    if (!threadId) { setError("Structured Chat requires a resumed Codex session"); return false; }
    if (!images.length && text === "/model") { setModelMenuRequest((request) => request + 1); return true; }
    setSending(true); setError(null); setRunState("working");
    const clientMessageId = `pi-web-${crypto.randomUUID()}`;
    try {
      if (!images.length && (text === "/compact" || text === "/review")) {
        const response = await fetch(`/api/codex/chat/${encodeURIComponent(threadId)}/command`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: text.slice(1), terminals: terminalsChoiceRef.current }) });
        const data = await response.json() as ApiError & { result?: { turn?: { id?: string } } };
        if (data.code === "terminal_conflict") { setConflict({ kind: "unknown", message: data.error ?? "A Codex terminal is running in this folder." }); setRunState("idle"); return false; }
        if (!response.ok) throw new Error(data.error ?? "Codex command failed");
      } else {
        const response = await fetch(`/api/codex/chat/${encodeURIComponent(threadId)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, clientMessageId, images: images.map((image) => `data:${image.mimeType};base64,${image.data}`), model: chatModel || undefined, effort: reasoningEffort || undefined, serviceTier: serviceTier || undefined, approvalPolicy, terminals: terminalsChoiceRef.current }) });
        const data = await response.json() as ApiError & { turn?: { turn?: { id?: string } } };
        if (data.code === "terminal_conflict") { setConflict({ kind: "unknown", message: data.error ?? "A Codex terminal is running in this folder." }); setRunState("idle"); return false; }
        if (!response.ok) throw new Error(data.error ?? "Unable to send message to Codex");
      }
      setItems((current) => current.some((item) => item.id === clientMessageId) ? current : [...current, { id: clientMessageId, kind: "message", role: "user", text: text || `[${images.length} image${images.length === 1 ? "" : "s"}]`, pending: true }]);
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to send message to Codex"); setRunState("idle"); return false; }
    finally { setSending(false); }
  }, [approvalPolicy, chatModel, connection, reasoningEffort, serviceTier, threadId]);

  // Adds a message to the running turn. "queue": the turn cannot take it (it ended, or is a
  // review/compact); the caller sends it as the next turn instead.
  const steer = useCallback(async (textOverride: string, images: ChatDraftImage[] = []): Promise<"steered" | "queue" | "failed"> => {
    const text = textOverride.trim();
    if (!threadId || connection !== "connected") return "queue";
    const clientMessageId = `pi-web-${crypto.randomUUID()}`;
    try {
      const response = await fetch(`/api/codex/chat/${encodeURIComponent(threadId)}/steer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, clientMessageId, images: images.map((image) => `data:${image.mimeType};base64,${image.data}`) }) });
      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as ApiError;
        if (data.code === "no_active_turn") return "queue";
        throw new Error(data.error ?? "Unable to add the message to this turn");
      }
      setItems((current) => current.some((item) => item.id === clientMessageId) ? current : [...current, { id: clientMessageId, kind: "message", role: "user", text: text || `[${images.length} image${images.length === 1 ? "" : "s"}]`, pending: true }]);
      return "steered";
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to add the message to this turn"); return "failed"; }
  }, [connection, threadId]);

  const decide = useCallback(async (requestId: string, answer: CodexRequestAnswer) => {
    if (!threadId) return;
    const response = await fetch(`/api/codex/chat/${encodeURIComponent(threadId)}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...answer, requestId }) });
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as ApiError;
      if (data.code === "approval_expired") {
        setApprovals((current) => current.filter((approval) => approval.id !== requestId));
        await fetch(`/api/codex/chat/${encodeURIComponent(threadId)}/interrupt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ recoverStaleApproval: true }) }).catch(() => undefined);
        setRunState("idle");
        setError("The expired approval was cleared. You can continue in this Chat.");
      } else setError(data.error ?? "Unable to submit approval");
    } else setApprovals((current) => {
      const next = current.filter((approval) => approval.id !== requestId);
      setRunState(next.length ? "approval" : "working");
      return next;
    });
  }, [threadId]);

  const interruptBlockedTurn = useCallback(async () => {
    if (!threadId) return;
    setSending(true);
    try {
      const response = await fetch(`/api/codex/chat/${encodeURIComponent(threadId)}/interrupt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Unable to cancel the blocked turn");
      setApprovals([]);
      setError("The blocked turn was cancelled. You can resend your message in Web Chat.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to cancel the blocked turn"); }
    finally { setSending(false); }
  }, [threadId]);
  const stopRun = useCallback(async () => {
    if (!threadId) return;
    setSending(true);
    try {
      const response = await fetch(`/api/codex/chat/${encodeURIComponent(threadId)}/interrupt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Unable to stop the current turn");
      setApprovals([]); setRunState("idle"); setError("Current turn interrupted.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to stop the current turn"); }
    finally { setSending(false); }
  }, [threadId]);
  const resolveConflict = useCallback(async (choice: "stop" | "ignore" | "cancel") => {
    const current = conflict;
    setConflict(null);
    if (!threadId || !current || choice === "cancel") return;
    if (choice === "ignore") { terminalsChoiceRef.current = "ignore"; setError("Send your message again to continue."); return; }
    setSending(true);
    try {
      const response = await fetch(`/api/codex/chat/${encodeURIComponent(threadId)}/claim`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ terminals: current.kind === "owns" ? "ignore" : "stop" }) });
      if (!response.ok) throw new Error((await response.json().catch(() => ({})) as ApiError).error ?? "Unable to stop the terminal");
      if (current.kind === "owns") { setError(null); setReloadKey((key) => key + 1); }
      else setError("Terminal stopped. Send your message again to continue.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to stop the terminal"); }
    finally { setSending(false); }
  }, [conflict, threadId]);
  const forkChat = useCallback(async () => {
    if (!threadId || runState !== "idle") return;
    setSending(true); setError(null);
    try {
      const response = await fetch(`/api/codex/chat/${encodeURIComponent(threadId)}/fork`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await response.json() as { error?: string; result?: { thread?: { id?: string }; id?: string; threadId?: string } };
      const nextThreadId = data.result?.thread?.id ?? data.result?.threadId ?? data.result?.id;
      if (!response.ok || !nextThreadId) throw new Error(data.error ?? "Codex did not return a forked thread");
      setThreadId(nextThreadId); setSessionName((name) => name ? `${name} (fork)` : "Forked Chat"); setItems([]); setApprovals([]); setRunState("idle");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to fork this Chat"); }
    finally { setSending(false); }
  }, [runState, threadId]);

  return <section style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--bg)" }}>
    <header style={{ padding: "9px 12px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)", color: "var(--text-muted)", fontSize: 12 }}>
      <strong style={{ color: "var(--text)" }}>Codex Chat{sessionName ? ` · ${sessionName}` : ""}</strong><span title={terminal.cwd}> · {terminal.cwd}</span>
    </header>
    {conflict ? <div role="alert" style={{ padding: "7px 10px", color: "#fbbf24", fontSize: 12 }}>
      {conflict.message}{conflict.kind === "unknown" ? " Stop it before writing here?" : ""}
      <button type="button" onClick={() => void resolveConflict("stop")} disabled={sending} style={{ ...buttonStyle, marginLeft: 8 }}>Stop terminal</button>
      {conflict.kind === "unknown" && <button type="button" onClick={() => void resolveConflict("ignore")} disabled={sending} style={buttonStyle}>Continue anyway</button>}
      <button type="button" onClick={() => void resolveConflict("cancel")} disabled={sending} style={buttonStyle}>Cancel</button>
    </div> : error && <div role="alert" style={{ padding: "7px 10px", color: "#fca5a5", fontSize: 12 }}>{error}{error.includes("waiting for an approval") ? <button type="button" onClick={() => void interruptBlockedTurn()} disabled={sending} style={{ ...buttonStyle, marginLeft: 8 }}>Cancel blocked turn</button> : null}{connection === "failed" ? <button type="button" onClick={() => { setError(null); setReloadKey((key) => key + 1); }} style={{ ...buttonStyle, marginLeft: 8 }}>Reconnect</button> : null}</div>}
    <div style={{ flex: 1, minHeight: 0 }}>
      <CodexAssistantThread
        items={items}
        running={sending || runState === "working" || runState === "approval"}
        approvals={approvals}
        cwd={terminal.cwd}
        draftKey={`codex:${threadId ?? terminal.sourceSessionId ?? "new"}`}
        modelLabel={chatModel || sessionModel || "Model unknown"}
        modelValue={chatModel}
        modelOptions={modelOptions}
        modelMenuRequest={modelMenuRequest}
        reasoningEffort={reasoningEffort}
        serviceTier={serviceTier}
        approvalPolicy={approvalPolicy}
        approvalLabel={approvalPolicy === "never" ? "Full access" : approvalPolicy === "on-request" ? "Ask when needed" : "Restricted"}
        statusLabel={connection !== "connected" ? connection === "reconnecting" ? "Reconnecting" : "Offline" : runState === "approval" ? "Approval" : runState === "working" ? "Working" : "Ready"}
        activityLabel={runState === "working" ? currentActivity || "Codex is working…" : undefined}
        noticeLabel={modelNotice || undefined}
        contextLabel={contextUsage ? contextUsage.limit && contextUsage.limit > 0 ? `${Math.min(100, Math.max(0, Math.round(contextUsage.used / contextUsage.limit * 100)))}% context` : `${contextUsage.used.toLocaleString()} tokens` : undefined}
        forkDisabled={runState !== "idle" || sending}
        onModelToggle={() => undefined}
        onModelChange={(model) => {
          setChatModel(model);
          const selected = modelOptions.find((option) => option.id === model);
          const nextEffort = selected?.defaultReasoningEffort ?? "";
          const nextTier = selected?.defaultServiceTier ?? "";
          setReasoningEffort(nextEffort);
          setServiceTier(nextTier);
          onConfigurationChange?.(workspaceTabId, { model: model || undefined, reasoningEffort: nextEffort || undefined, serviceTier: nextTier || undefined });
          setModelNotice(model ? `Model changed to ${selected?.label ?? model} · applies to the next turn` : "Using the current/default model on the next turn");
        }}
        onReasoningEffortChange={(value) => { setReasoningEffort(value); onConfigurationChange?.(workspaceTabId, { reasoningEffort: value || undefined }); setModelNotice(`Reasoning changed to ${value} · applies to the next turn`); }}
        onServiceTierChange={(value) => { setServiceTier(value); onConfigurationChange?.(workspaceTabId, { serviceTier: value || undefined }); setModelNotice(`${value ? `Service tier changed to ${value}` : "Using standard service tier"} · applies to the next turn`); }}
        onApprovalPolicyChange={(value) => { setApprovalPolicy(value); onConfigurationChange?.(workspaceTabId, { approvalPolicy: value }); setModelNotice("Permission policy updated · applies to the next turn"); }}
        onFork={() => void forkChat()}
        onSend={send}
        onSteer={steer}
        onStop={stopRun}
        onApproval={(requestId, answer) => void decide(requestId, answer)}
        onOpenFile={onOpenFile}
      />
    </div>
  </section>;
}
const buttonStyle: React.CSSProperties = { border: "1px solid var(--border)", background: "var(--bg-hover)", borderRadius: 6, color: "var(--text)", padding: "7px 11px", cursor: "pointer", marginRight: 6 };
