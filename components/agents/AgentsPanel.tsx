"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { TerminalPermissionMode, TerminalProvider, TerminalSession, TerminalStats } from "@/lib/agents/terminal";

export interface CodexSessionTarget {
  sessionId: string;
  sessionName: string;
  cwd: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  approvalPolicy: "untrusted" | "on-request" | "never";
}

interface CodexSession {
  id: string;
  name: string;
  cwd: string;
  updatedAt: string;
  model?: string;
  lastUserMessage?: string;
  archived?: boolean;
  runtime?: { state: "idle" | "running" | "approval" } | null;
}
interface CatalogModel { id: string; label: string; description: string; isDefault: boolean; defaultReasoningEffort: string; reasoningEfforts: { id: string; description: string }[]; defaultServiceTier: string; serviceTiers: { id: string; name: string; description: string }[] }
type PendingAction =
  | { kind: "session"; action: "rename" | "archive" | "unarchive" | "delete"; session: CodexSession }
  | { kind: "terminal"; action: "stop" | "remove"; terminal: TerminalSession }
  | { kind: "clear"; provider?: TerminalProvider; count: number };

interface Props {
  cwd: string;
  style?: CSSProperties;
  onExpandedChange?: (expanded: boolean) => void;
  onNewAgent?: (provider: TerminalProvider) => void;
  onOpenCodexSession?: (target: CodexSessionTarget) => void;
  onOpenTerminal?: (terminal: TerminalSession, label?: string) => void;
  onTerminalRemoved?: (terminalId: string) => void;
  onCodexSessionChanged?: (change: { id: string; action: "rename" | "archive" | "unarchive" | "delete"; name?: string }) => void;
}

export function AgentsPanel({ cwd, style, onExpandedChange, onNewAgent, onOpenCodexSession, onOpenTerminal, onTerminalRemoved, onCodexSessionChanged }: Props) {
  const [open, setOpen] = useState(true);
  const [shellOpen, setShellOpen] = useState(true);
  const [codexOpen, setCodexOpen] = useState(true);
  const [claudeOpen, setClaudeOpen] = useState(false);
  const [sessions, setSessions] = useState<CodexSession[]>([]);
  const [sessionQuery, setSessionQuery] = useState("");
  const [debouncedSessionQuery, setDebouncedSessionQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [terminals, setTerminals] = useState<TerminalSession[]>([]);
  const [terminalStats, setTerminalStats] = useState<TerminalStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [launchTarget, setLaunchTarget] = useState<{ session: CodexSession; surface: "chat" | "terminal"; mode: "resume" | "fork" } | null>(null);
  const [launchModel, setLaunchModel] = useState("");
  const [launchPermission, setLaunchPermission] = useState<TerminalPermissionMode>("confirm");
  const [launchReasoningEffort, setLaunchReasoningEffort] = useState("");
  const [launchServiceTier, setLaunchServiceTier] = useState("");
  const [launchWebSearch, setLaunchWebSearch] = useState(false);
  const [launchPrompt, setLaunchPrompt] = useState("");
  const [catalogModels, setCatalogModels] = useState<CatalogModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const sessionRequestRef = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSessionQuery(sessionQuery.trim()), 180);
    return () => window.clearTimeout(timer);
  }, [sessionQuery]);

  useEffect(() => {
    if (!launchTarget) return;
    let cancelled = false;
    setModelsLoading(true);
    void fetch(`/api/codex/models?${new URLSearchParams({ cwd: launchTarget.session.cwd || cwd })}`, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as { result?: { data?: { id?: string; displayName?: string; description?: string; isDefault?: boolean; defaultReasoningEffort?: string; supportedReasoningEfforts?: { reasoningEffort?: string; description?: string }[]; defaultServiceTier?: string | null; serviceTiers?: { id?: string; name?: string; description?: string }[] }[]; models?: { id?: string; displayName?: string; description?: string; isDefault?: boolean; defaultReasoningEffort?: string; supportedReasoningEfforts?: { reasoningEffort?: string; description?: string }[]; defaultServiceTier?: string | null; serviceTiers?: { id?: string; name?: string; description?: string }[] }[] } };
        if (!response.ok || cancelled) return;
        const models = data.result?.data ?? data.result?.models ?? [];
        const parsed = models.flatMap((model): CatalogModel[] => typeof model.id === "string" && model.id ? [{ id: model.id, label: model.displayName || model.id, description: model.description || "", isDefault: model.isDefault === true, defaultReasoningEffort: model.defaultReasoningEffort || "", reasoningEfforts: (model.supportedReasoningEfforts || []).flatMap((item) => item.reasoningEffort ? [{ id: item.reasoningEffort, description: item.description || "" }] : []), defaultServiceTier: model.defaultServiceTier || "", serviceTiers: (model.serviceTiers || []).flatMap((item) => item.id ? [{ id: item.id, name: item.name || item.id, description: item.description || "" }] : []) }] : []);
        setCatalogModels(parsed);
        const selected = parsed.find((item) => item.id === (launchTarget.session.model || "")) || parsed.find((item) => item.isDefault);
        if (selected) { setLaunchReasoningEffort(selected.defaultReasoningEffort); setLaunchServiceTier(selected.defaultServiceTier); }
      })
      .catch(() => { /* Manual/current model selection remains available. */ })
      .finally(() => { if (!cancelled) setModelsLoading(false); });
    return () => { cancelled = true; };
  }, [cwd, launchTarget]);

  const loadSessions = useCallback(async (quiet = false) => {
    const requestId = ++sessionRequestRef.current;
    if (!quiet) setLoading(true);
    try {
      const params = new URLSearchParams({ cwd, archived: String(showArchived), limit: "250" });
      if (debouncedSessionQuery) params.set("q", debouncedSessionQuery);
      const response = await fetch(`/api/codex/sessions?${params}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Unable to load sessions");
      const data = await response.json() as { sessions?: CodexSession[] };
      if (requestId !== sessionRequestRef.current) return;
      setSessions(data.sessions ?? []);
      setError(false);
    } catch {
      if (requestId !== sessionRequestRef.current) return;
      setError(true);
    } finally {
      if (!quiet && requestId === sessionRequestRef.current) setLoading(false);
    }
  }, [cwd, debouncedSessionQuery, showArchived]);

  useEffect(() => {
    void loadSessions();
    const timer = window.setInterval(() => {
      if (!document.hidden) void loadSessions(true);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [loadSessions]);

  useEffect(() => {
    let cancelled = false;
    const loadTerminals = async () => {
      try {
        const response = await fetch(`/api/terminals?${new URLSearchParams({ cwd })}`, { cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json() as { terminals?: TerminalSession[]; stats?: TerminalStats };
        if (!cancelled) { setTerminals(data.terminals ?? []); setTerminalStats(data.stats ?? null); }
      } catch { /* Agent history remains usable when the optional terminal service is unavailable. */ }
    };
    void loadTerminals();
    const timer = window.setInterval(() => { if (!document.hidden) void loadTerminals(); }, 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [cwd]);

  const shellTerminals = terminals.filter((terminal) => terminal.provider === "shell");
  const codexTerminals = terminals.filter((terminal) => terminal.provider === "codex");
  const claudeTerminals = terminals.filter((terminal) => terminal.provider === "claude");
  const liveCodexSessionIds = new Set(codexTerminals.filter((terminal) => terminal.state === "running").map((terminal) => terminal.sourceSessionId).filter(Boolean));
  const codexHistory = showArchived ? sessions : sessions.filter((session) => !liveCodexSessionIds.has(session.id));

  const manageSession = useCallback(async (session: CodexSession, action: "rename" | "archive" | "unarchive" | "delete", requestedName?: string) => {
    let body: Record<string, string> = { cwd };
    let nextName: string | undefined;
    if (action === "rename") {
      const name = requestedName?.trim();
      if (!name || name === session.name) return;
      body = { ...body, name };
      nextName = name;
    }
    setBusyId(session.id);
    setActionError(null);
    try {
      const response = await fetch(`/api/codex/sessions/${encodeURIComponent(session.id)}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || `Unable to ${action} session`);
      onCodexSessionChanged?.({ id: session.id, action, name: nextName });
      await loadSessions(true);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : `Unable to ${action} session`);
    } finally {
      setBusyId(null);
    }
  }, [cwd, loadSessions, onCodexSessionChanged]);

  const configureLaunch = useCallback((session: CodexSession, surface: "chat" | "terminal", mode: "resume" | "fork") => {
    setActionError(null);
    setLaunchTarget({ session, surface, mode });
    setLaunchModel(session.model || "");
    setLaunchPermission("confirm");
    setLaunchReasoningEffort("");
    setLaunchServiceTier("");
    setLaunchWebSearch(false);
    setLaunchPrompt("");
  }, []);

  const startSession = useCallback(async () => {
    if (!launchTarget) return;
    const { session, surface, mode } = launchTarget;
    setBusyId(session.id);
    setActionError(null);
    try {
      if (surface === "chat") {
        let sessionId = session.id;
        if (mode === "fork") {
          const response = await fetch(`/api/codex/chat/${encodeURIComponent(session.id)}/fork`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
          const data = await response.json() as { error?: string; result?: { thread?: { id?: string }; id?: string; threadId?: string } };
          sessionId = data.result?.thread?.id ?? data.result?.threadId ?? data.result?.id ?? "";
          if (!response.ok || !sessionId) throw new Error(data.error || "Codex did not return a forked session");
        }
        const approvalPolicy = launchPermission === "confirm" ? "untrusted" : launchPermission === "bypass" ? "never" : launchPermission;
        onOpenCodexSession?.({ sessionId, sessionName: mode === "fork" ? `${session.name} (fork)` : session.name, cwd: session.cwd || cwd, model: launchModel || undefined, reasoningEffort: launchReasoningEffort || undefined, serviceTier: launchServiceTier || undefined, approvalPolicy });
      } else {
        const response = await fetch("/api/terminals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: "codex", cwd: session.cwd || cwd, permissionMode: launchPermission, launchMode: mode, sourceSessionId: session.id, noAltScreen: true, model: launchModel || undefined, webSearch: launchWebSearch, initialPrompt: launchPrompt || undefined }),
        });
        const data = await response.json() as { terminal?: TerminalSession; error?: string };
        if (!response.ok || !data.terminal) throw new Error(data.error || "Unable to start Codex terminal");
        onOpenTerminal?.(data.terminal, session.name);
        setTerminals((current) => current.some((item) => item.id === data.terminal!.id) ? current : [...current, data.terminal!]);
      }
      setLaunchTarget(null);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Unable to start session");
    } finally {
      setBusyId(null);
    }
  }, [cwd, launchModel, launchPermission, launchPrompt, launchReasoningEffort, launchServiceTier, launchTarget, launchWebSearch, onOpenCodexSession, onOpenTerminal]);

  const stopTerminal = useCallback(async (terminal: TerminalSession) => {
    setActionError(null);
    try {
      const response = await fetch(`/api/terminals/${encodeURIComponent(terminal.id)}/stop`, { method: "POST" });
      const data = await response.json() as { terminal?: TerminalSession; error?: string };
      if (!response.ok || !data.terminal) throw new Error(data.error || "Unable to stop terminal");
      setTerminals((current) => current.map((item) => item.id === terminal.id ? data.terminal! : item));
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Unable to stop terminal");
    }
  }, []);

  const removeTerminalRecord = useCallback(async (terminal: TerminalSession) => {
    setActionError(null);
    try {
      const response = await fetch(`/api/terminals/${encodeURIComponent(terminal.id)}`, { method: "DELETE" });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "Unable to remove terminal record");
      setTerminals((current) => current.filter((item) => item.id !== terminal.id));
      onTerminalRemoved?.(terminal.id);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Unable to remove terminal record");
    }
  }, [onTerminalRemoved]);

  const clearEndedTerminalRecords = useCallback(async (provider?: TerminalProvider) => {
    const ended = terminals.filter((terminal) => (!provider || terminal.provider === provider) && terminal.state !== "running");
    if (ended.length === 0) return;
    setActionError(null);
    try {
      const params = new URLSearchParams({ cwd });
      if (provider) params.set("provider", provider);
      const response = await fetch(`/api/terminals?${params}`, { method: "DELETE" });
      const data = await response.json() as { removedIds?: string[]; error?: string };
      if (!response.ok || !data.removedIds) throw new Error(data.error || "Unable to clear terminal records");
      const removed = new Set(data.removedIds);
      setTerminals((current) => current.filter((terminal) => !removed.has(terminal.id)));
      data.removedIds.forEach((id) => onTerminalRemoved?.(id));
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Unable to clear terminal records");
    }
  }, [cwd, onTerminalRemoved, terminals]);

  const runningTerminalCount = terminals.filter((terminal) => terminal.state === "running").length;
  const endedTerminalCount = terminals.length - runningTerminalCount;
  const workspaceStats = terminalStats?.workspace ?? { running: runningTerminalCount, records: terminals.length, bufferBytes: terminals.reduce((total, terminal) => total + terminal.bufferBytes, 0) };
  const globalStats = terminalStats?.global ?? workspaceStats;
  const limits = terminalStats?.limits ?? { running: 20, records: 100 };

  const confirmPendingAction = useCallback(() => {
    const pending = pendingAction;
    if (!pending) return;
    if (pending.kind === "session" && pending.action === "rename" && (!renameValue.trim() || renameValue.trim() === pending.session.name)) return;
    setPendingAction(null);
    if (pending.kind === "session") void manageSession(pending.session, pending.action, renameValue);
    else if (pending.kind === "terminal") void (pending.action === "stop" ? stopTerminal(pending.terminal) : removeTerminalRecord(pending.terminal));
    else void clearEndedTerminalRecords(pending.provider);
  }, [clearEndedTerminalRecords, manageSession, pendingAction, removeTerminalRecord, renameValue, stopTerminal]);

  const requestSessionAction = useCallback((session: CodexSession, action: "rename" | "archive" | "unarchive" | "delete") => {
    setRenameValue(session.name);
    setPendingAction({ kind: "session", action, session });
  }, []);

  return <><section style={{ borderTop: "1px solid var(--border)", display: "flex", flexDirection: "column", flex: "0 0 auto", minHeight: 0, overflow: "hidden", ...style }}>
    <button type="button" onClick={() => { const next = !open; setOpen(next); onExpandedChange?.(next); }} aria-expanded={open} style={headerStyle}>
      <Chevron open={open} />
      Agents
    </button>
    {open && <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflowY: "auto", padding: "0 7px 7px" }}>
      <div style={resourceSummaryStyle}><span>Workspace {workspaceStats.running} running</span><span>Global {globalStats.running}/{limits.running}</span><span>History {globalStats.records}/{limits.records}</span><span>{formatBytes(globalStats.bufferBytes)}</span>{endedTerminalCount > 0 && <button type="button" onClick={() => setPendingAction({ kind: "clear", count: endedTerminalCount })} style={resourceClearStyle}>Clear ended</button>}</div>
      <ProviderRow provider="shell" label="Terminal" badge=">_" badgeColor="#16a34a" open={shellOpen} onToggle={() => setShellOpen((value) => !value)} onNewAgent={onNewAgent} />
      {shellOpen && <div style={sessionListStyle}>
        {shellTerminals.some((terminal) => terminal.state !== "running") && <button type="button" onClick={() => setPendingAction({ kind: "clear", provider: "shell", count: shellTerminals.filter((terminal) => terminal.state !== "running").length })} style={clearEndedStyle}>Clear ended terminals</button>}
        {shellTerminals.length === 0 ? <InlineMessage>No workspace terminals</InlineMessage> : shellTerminals.map((terminal) => <TerminalRow key={terminal.id} terminal={terminal} onOpen={onOpenTerminal} onStop={(item) => setPendingAction({ kind: "terminal", action: "stop", terminal: item })} onRemove={(item) => setPendingAction({ kind: "terminal", action: "remove", terminal: item })} />)}
      </div>}
      <ProviderRow provider="codex" label="Codex" badge="C" badgeColor="var(--accent)" open={codexOpen} onToggle={() => setCodexOpen((value) => !value)} onNewAgent={onNewAgent} />
      {codexOpen && <div style={sessionListStyle}>
        <div style={sessionFilterStyle}>
          <button type="button" onClick={() => setShowArchived(false)} aria-pressed={!showArchived} style={{ ...filterButtonStyle, ...(!showArchived ? filterButtonActiveStyle : {}) }}>Active</button>
          <button type="button" onClick={() => setShowArchived(true)} aria-pressed={showArchived} style={{ ...filterButtonStyle, ...(showArchived ? filterButtonActiveStyle : {}) }}>Archived</button>
        </div>
        <label style={searchStyle}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>
          <input value={sessionQuery} onChange={(event) => setSessionQuery(event.target.value)} placeholder="Search Codex sessions" aria-label="Search Codex sessions" style={searchInputStyle} />
          {sessionQuery && <button type="button" onClick={() => setSessionQuery("")} aria-label="Clear session search" title="Clear" style={searchClearStyle}>×</button>}
        </label>
        {actionError && <div role="alert" style={errorStyle}>{actionError}</div>}
        {!showArchived && codexTerminals.some((terminal) => terminal.state !== "running") && <button type="button" onClick={() => setPendingAction({ kind: "clear", provider: "codex", count: codexTerminals.filter((terminal) => terminal.state !== "running").length })} style={clearEndedStyle}>Clear ended terminals</button>}
        {!showArchived && codexTerminals.map((terminal) => <TerminalRow key={terminal.id} terminal={terminal} preferredLabel={sessions.find((session) => session.id === terminal.sourceSessionId)?.name} onOpen={onOpenTerminal} onStop={(item) => setPendingAction({ kind: "terminal", action: "stop", terminal: item })} onRemove={(item) => setPendingAction({ kind: "terminal", action: "remove", terminal: item })} />)}
        {loading ? <InlineMessage>Loading sessions…</InlineMessage>
          : error ? <button type="button" onClick={() => void loadSessions()} style={retryStyle}>Couldn&apos;t load sessions · Retry</button>
            : codexHistory.length === 0 && (showArchived || codexTerminals.length === 0) ? <InlineMessage>{sessionQuery ? "No matching sessions" : `No ${showArchived ? "archived" : "active"} Codex sessions`}</InlineMessage>
              : codexHistory.map((session) => <div key={session.id} style={sessionContainerStyle}>
                <button
                  type="button"
                  disabled={busyId === session.id}
                  style={{ ...sessionMainStyle, cursor: showArchived ? "default" : "pointer" }}
                  title={`${session.name}\n${session.cwd}`}
                  onClick={() => { if (!showArchived) configureLaunch(session, "chat", "resume"); }}
                >
                  <StatusDot state={session.runtime?.state} />
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span style={sessionNameStyle}>{session.name}</span>
                    <span style={sessionMetaStyle}>{session.lastUserMessage || "No prompt yet"}</span>
                  </span>
                  <span style={timeStyle}>{busyId === session.id ? "…" : formatRelativeTime(session.updatedAt)}</span>
                </button>
                <ActionMenu label={`Manage ${session.name}`}>
                    {!showArchived && <><MenuButton onClick={() => configureLaunch(session, "chat", "resume")}>Open in Chat…</MenuButton>
                    <MenuButton onClick={() => configureLaunch(session, "terminal", "resume")}>Resume in Terminal…</MenuButton>
                    <MenuButton onClick={() => configureLaunch(session, "chat", "fork")}>Fork to Chat…</MenuButton>
                    <MenuButton onClick={() => configureLaunch(session, "terminal", "fork")}>Fork to Terminal…</MenuButton>
                    <span style={menuDividerStyle} /></>}
                    <MenuButton onClick={() => requestSessionAction(session, "rename")}>Rename</MenuButton>
                    {showArchived ? <MenuButton onClick={() => requestSessionAction(session, "unarchive")}>Restore</MenuButton> : <MenuButton onClick={() => requestSessionAction(session, "archive")}>Archive</MenuButton>}
                    <MenuButton danger onClick={() => requestSessionAction(session, "delete")}>Delete…</MenuButton>
                </ActionMenu>
              </div>)}
      </div>}
      <ProviderRow provider="claude" label="Claude" badge="A" badgeColor="#d97706" open={claudeOpen} onToggle={() => setClaudeOpen((value) => !value)} onNewAgent={onNewAgent} />
      {claudeOpen && <div style={sessionListStyle}>
        {claudeTerminals.some((terminal) => terminal.state !== "running") && <button type="button" onClick={() => setPendingAction({ kind: "clear", provider: "claude", count: claudeTerminals.filter((terminal) => terminal.state !== "running").length })} style={clearEndedStyle}>Clear ended terminals</button>}
        {claudeTerminals.length === 0 ? <InlineMessage>No active Claude sessions</InlineMessage> : claudeTerminals.map((terminal) => <TerminalRow key={terminal.id} terminal={terminal} onOpen={onOpenTerminal} onStop={(item) => setPendingAction({ kind: "terminal", action: "stop", terminal: item })} onRemove={(item) => setPendingAction({ kind: "terminal", action: "remove", terminal: item })} />)}
      </div>}
    </div>}
  </section>
    {launchTarget && <SessionLaunchDialog
      target={launchTarget}
      modelOptions={[...catalogModels, ...sessions.map((session) => session.model).filter((model): model is string => Boolean(model)).filter((id) => !catalogModels.some((model) => model.id === id)).map((id): CatalogModel => ({ id, label: id, description: "", isDefault: false, defaultReasoningEffort: "", reasoningEfforts: [], defaultServiceTier: "", serviceTiers: [] }))]}
      modelsLoading={modelsLoading}
      model={launchModel}
      reasoningEffort={launchReasoningEffort}
      serviceTier={launchServiceTier}
      permission={launchPermission}
      webSearch={launchWebSearch}
      prompt={launchPrompt}
      busy={busyId === launchTarget.session.id}
      error={actionError}
      onSurfaceChange={(surface) => { setLaunchTarget((current) => current ? { ...current, surface } : null); if (surface === "chat" && launchPermission === "bypass") setLaunchPermission("confirm"); }}
      onModeChange={(mode) => setLaunchTarget((current) => current ? { ...current, mode } : null)}
      onModelChange={(value) => { setLaunchModel(value); const selected = catalogModels.find((item) => item.id === value); if (selected) { setLaunchReasoningEffort(selected.defaultReasoningEffort); setLaunchServiceTier(selected.defaultServiceTier); } }}
      onReasoningEffortChange={setLaunchReasoningEffort}
      onServiceTierChange={setLaunchServiceTier}
      onPermissionChange={setLaunchPermission}
      onWebSearchChange={setLaunchWebSearch}
      onPromptChange={setLaunchPrompt}
      onCancel={() => { if (!busyId) setLaunchTarget(null); }}
      onStart={() => void startSession()}
    />}
    {pendingAction && <AgentActionDialog action={pendingAction} renameValue={renameValue} busy={Boolean(busyId)} onRenameChange={setRenameValue} onCancel={() => setPendingAction(null)} onConfirm={confirmPendingAction} />}
  </>;
}

function AgentActionDialog({ action, renameValue, busy, onRenameChange, onCancel, onConfirm }: { action: PendingAction; renameValue: string; busy: boolean; onRenameChange: (value: string) => void; onCancel: () => void; onConfirm: () => void }) {
  useDialogEscape(onCancel, busy);
  const rename = action.kind === "session" && action.action === "rename";
  const destructive = action.kind === "session" && action.action === "delete" || action.kind === "terminal" || action.kind === "clear";
  const title = rename ? "Rename Codex session" : action.kind === "session" ? `${action.action === "unarchive" ? "Restore" : action.action[0].toUpperCase() + action.action.slice(1)} Codex session` : action.kind === "terminal" ? `${action.action === "stop" ? "Stop" : "Remove"} ${action.terminal.provider} terminal` : `Clear ended ${action.provider ? `${action.provider} ` : ""}terminals`;
  const description = action.kind === "session"
    ? action.action === "delete" ? `“${action.session.name}” will be permanently deleted. This cannot be undone.` : action.action === "archive" ? `“${action.session.name}” will move out of the active session list.` : action.action === "unarchive" ? `“${action.session.name}” will return to the active session list.` : "Choose a concise name that identifies this session."
    : action.kind === "terminal" ? action.action === "stop" ? "The running process will be interrupted. Its session history will remain available." : "This removes the ended terminal record from the workspace."
    : `${action.count} ended terminal record${action.count === 1 ? "" : "s"} will be removed from this workspace.`;
  const confirmDisabled = busy || rename && (!renameValue.trim() || renameValue.trim() === action.session.name);
  return <div role="dialog" aria-modal="true" aria-label={title} style={dialogOverlayStyle} onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
    <section style={{ ...dialogStyle, width: "min(100%, 400px)" }}>
      <strong style={{ display: "block", fontSize: 14 }}>{title}</strong>
      <p style={{ margin: "8px 0 0", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>{description}</p>
      {rename && <input autoFocus value={renameValue} maxLength={120} onChange={(event) => onRenameChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !confirmDisabled) onConfirm(); }} style={{ ...inputStyle, marginTop: 14 }} />}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <button type="button" disabled={busy} onClick={onCancel} style={dialogButtonStyle}>Cancel</button>
        <button type="button" disabled={confirmDisabled} onClick={onConfirm} style={{ ...dialogButtonStyle, borderColor: destructive ? "rgb(239 68 68 / 45%)" : "var(--accent)", background: destructive ? "rgb(239 68 68 / 10%)" : "var(--accent)", color: destructive ? "#ef4444" : "white", opacity: confirmDisabled ? .5 : 1 }}>{busy ? "Working…" : rename ? "Rename" : action.kind === "session" && action.action === "unarchive" ? "Restore" : action.kind === "session" && action.action === "archive" ? "Archive" : action.kind === "terminal" && action.action === "stop" ? "Stop terminal" : "Remove"}</button>
      </div>
    </section>
  </div>;
}

function SessionLaunchDialog({ target, modelOptions, modelsLoading, model, reasoningEffort, serviceTier, permission, webSearch, prompt, busy, error, onSurfaceChange, onModeChange, onModelChange, onReasoningEffortChange, onServiceTierChange, onPermissionChange, onWebSearchChange, onPromptChange, onCancel, onStart }: {
  target: { session: CodexSession; surface: "chat" | "terminal"; mode: "resume" | "fork" };
  modelOptions: CatalogModel[];
  modelsLoading: boolean;
  model: string;
  reasoningEffort: string;
  serviceTier: string;
  permission: TerminalPermissionMode;
  webSearch: boolean;
  prompt: string;
  busy: boolean;
  error: string | null;
  onSurfaceChange: (surface: "chat" | "terminal") => void;
  onModeChange: (mode: "resume" | "fork") => void;
  onModelChange: (model: string) => void;
  onReasoningEffortChange: (effort: string) => void;
  onServiceTierChange: (tier: string) => void;
  onPermissionChange: (permission: TerminalPermissionMode) => void;
  onWebSearchChange: (enabled: boolean) => void;
  onPromptChange: (prompt: string) => void;
  onCancel: () => void;
  onStart: () => void;
}) {
  useDialogEscape(onCancel, busy);
  const selectedModel = modelOptions.find((option) => option.id === model) ?? modelOptions.find((option) => option.isDefault);
  return <div role="dialog" aria-modal="true" aria-label="Start Codex session" style={dialogOverlayStyle} onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <section style={dialogStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}><strong style={{ flex: 1, fontSize: 14 }}>{target.session.name}</strong><button type="button" onClick={onCancel} disabled={busy} style={dialogButtonStyle}>Cancel</button></div>
      <div style={dialogGridStyle}>
        <label style={fieldStyle}>Open in<select value={target.surface} disabled={busy} onChange={(event) => onSurfaceChange(event.target.value as "chat" | "terminal")} style={inputStyle}><option value="chat">Web Chat</option><option value="terminal">Terminal</option></select></label>
        <label style={fieldStyle}>Action<select value={target.mode} disabled={busy} onChange={(event) => onModeChange(event.target.value as "resume" | "fork")} style={inputStyle}><option value="resume">Resume session</option><option value="fork">Fork session</option></select></label>
      </div>
      <label style={fieldStyle}>Model<input list="codex-session-models" value={model} disabled={busy} onChange={(event) => onModelChange(event.target.value)} placeholder={target.session.model ? `Current: ${target.session.model}` : "Use Codex default"} style={inputStyle} /><datalist id="codex-session-models">{modelOptions.map((option) => <option key={option.id} value={option.id}>{option.label}{option.isDefault ? " · Default" : ""}</option>)}</datalist><small style={hintStyle}>{modelsLoading ? "Loading available models…" : "Choose an available model, enter a model ID, or leave empty for the default."}</small></label>
      {selectedModel?.description && <div style={modelDescriptionStyle}>{selectedModel.description}</div>}
      {target.surface === "chat" && (selectedModel?.reasoningEfforts.length || selectedModel?.serviceTiers.length) ? <div style={dialogGridStyle}>
        {selectedModel.reasoningEfforts.length > 0 && <label style={fieldStyle}>Reasoning<select value={reasoningEffort} disabled={busy} onChange={(event) => onReasoningEffortChange(event.target.value)} style={inputStyle}>{selectedModel.reasoningEfforts.map((option) => <option key={option.id} value={option.id}>{option.id}{option.id === selectedModel.defaultReasoningEffort ? " · Default" : ""}</option>)}</select></label>}
        {selectedModel.serviceTiers.length > 0 && <label style={fieldStyle}>Service tier<select value={serviceTier} disabled={busy} onChange={(event) => onServiceTierChange(event.target.value)} style={inputStyle}><option value="">Standard</option>{selectedModel.serviceTiers.map((option) => <option key={option.id} value={option.id}>{option.name}{option.id === selectedModel.defaultServiceTier ? " · Default" : ""}</option>)}</select></label>}
      </div> : null}
      <label style={fieldStyle}>Permissions<select value={permission} disabled={busy} onChange={(event) => onPermissionChange(event.target.value as TerminalPermissionMode)} style={inputStyle}>
        <option value="confirm">Restricted — confirm risky commands</option>
        <option value="on-request">Ask when needed</option>
        <option value="never">Never ask — workspace sandbox</option>
        {target.surface === "terminal" && <option value="bypass">Dangerous — bypass sandbox</option>}
      </select></label>
      {target.surface === "terminal" && <>
        <label style={checkStyle}><input type="checkbox" checked={webSearch} disabled={busy} onChange={(event) => onWebSearchChange(event.target.checked)} /> Enable live web search</label>
        <label style={fieldStyle}>Initial prompt (optional)<textarea value={prompt} disabled={busy} onChange={(event) => onPromptChange(event.target.value)} maxLength={8000} rows={3} placeholder="Tell Codex what to do after restoring" style={{ ...inputStyle, resize: "vertical" }} /></label>
      </>}
      {permission === "bypass" && <div style={dangerStyle}>This disables command approval and sandbox protection for this Terminal.</div>}
      {error && <div role="alert" style={errorStyle}>{error}</div>}
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}><button type="button" disabled={busy} onClick={onStart} style={{ ...dialogButtonStyle, background: "var(--accent)", borderColor: "var(--accent)", color: "white" }}>{busy ? "Starting…" : `${target.mode === "fork" ? "Fork" : "Resume"} in ${target.surface === "chat" ? "Chat" : "Terminal"}`}</button></div>
    </section>
  </div>;
}

function useDialogEscape(onCancel: () => void, disabled: boolean) {
  useEffect(() => {
    if (disabled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [disabled, onCancel]);
}

function ActionMenu({ label, children }: { label: string; children: ReactNode }) {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<DOMRect | null>(null);
  const closeMenu = useCallback(() => {
    setPosition(null);
    triggerRef.current?.blur();
  }, []);

  useLayoutEffect(() => {
    if (!position || !menuRef.current || !anchorRef.current) return;
    const menuRect = menuRef.current.getBoundingClientRect();
    const anchor = anchorRef.current;
    const gutter = 8;
    const gap = 5;
    const left = Math.max(gutter, Math.min(window.innerWidth - menuRect.width - gutter, anchor.right - menuRect.width));
    const fitsBelow = anchor.bottom + gap + menuRect.height <= window.innerHeight - gutter;
    const top = fitsBelow
      ? anchor.bottom + gap
      : Math.max(gutter, anchor.top - menuRect.height - gap);
    if (Math.abs(position.top - top) > 0.5 || Math.abs(position.left - left) > 0.5) setPosition({ top, left });
  }, [position]);

  useEffect(() => {
    if (!position) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) closeMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") closeMenu(); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
    };
  }, [closeMenu, position]);

  const toggle = () => {
    if (position) { closeMenu(); return; }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    anchorRef.current = rect;
    const width = 172;
    setPosition({ top: rect.bottom + 5, left: Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width)) });
  };

  return <>
    <button ref={triggerRef} className="agent-action-trigger" type="button" aria-label={label} aria-haspopup="menu" aria-expanded={Boolean(position)} title="Session actions" onClick={toggle} style={{ ...menuTriggerStyle, ...(position ? menuTriggerOpenStyle : {}) }}>
      <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1.25" /><circle cx="8" cy="8" r="1.25" /><circle cx="13" cy="8" r="1.25" /></svg>
    </button>
    {position && createPortal(<div ref={menuRef} className="agent-action-menu" role="menu" aria-label={label} style={{ ...menuStyle, top: position.top, left: position.left }} onClick={closeMenu}>{children}</div>, document.body)}
  </>;
}

function MenuButton({ children, danger, onClick }: { children: ReactNode; danger?: boolean; onClick: () => void }) {
  return <button className="agent-action-menu-item" role="menuitem" type="button" onClick={onClick} style={{ ...menuButtonStyle, color: danger ? "#f87171" : "var(--text)" }}>{children}</button>;
}

function TerminalRow({ terminal, preferredLabel, onOpen, onStop, onRemove }: { terminal: TerminalSession; preferredLabel?: string; onOpen?: (terminal: TerminalSession, label?: string) => void; onStop: (terminal: TerminalSession) => void; onRemove: (terminal: TerminalSession) => void }) {
  const state = terminal.state === "running" ? "running" : "idle";
  const label = preferredLabel || terminal.title || (terminal.sourceSessionId ? `${terminal.provider} · ${terminal.sourceSessionId.slice(0, 8)}` : `${terminal.provider} terminal`);
  return <div style={sessionContainerStyle}>
    <button type="button" style={sessionMainStyle} title={`${label}\n${terminal.cwd}`} onClick={() => onOpen?.(terminal, label)}>
      <StatusDot state={state} />
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={sessionNameStyle}>{label}</span>
        <span style={sessionMetaStyle}>Terminal · {terminal.state}</span>
      </span>
      <span style={{ ...timeStyle, textTransform: "uppercase" }}>{terminal.state === "running" ? "live" : "ended"}</span>
    </button>
    <ActionMenu label={`Manage ${label}`}>
        <MenuButton onClick={() => onOpen?.(terminal, label)}>Open Terminal</MenuButton>
        {terminal.state === "running" && <MenuButton danger onClick={() => void onStop(terminal)}>Stop Terminal…</MenuButton>}
        {terminal.state !== "running" && <MenuButton danger onClick={() => void onRemove(terminal)}>Remove Record…</MenuButton>}
    </ActionMenu>
  </div>;
}

function ProviderRow({ provider, label, badge, badgeColor, open, onToggle, onNewAgent }: { provider: TerminalProvider; label: string; badge: string; badgeColor: string; open: boolean; onToggle: () => void; onNewAgent?: (provider: TerminalProvider) => void }) {
  return <div style={providerStyle}>
    <button type="button" onClick={onToggle} aria-expanded={open} style={providerToggleStyle}>
      <Chevron open={open} />
      <span style={{ display: "grid", width: 20, placeItems: "center", color: badgeColor, fontSize: 11, fontWeight: 700 }}>{badge}</span>
      <span style={{ flex: 1, color: "var(--text)", fontSize: 12 }}>{label}</span>
    </button>
    {onNewAgent && <button type="button" onClick={() => onNewAgent(provider)} title={`New ${label} terminal`} aria-label={`New ${label} terminal`} style={addStyle}>＋</button>}
  </div>;
}

function Chevron({ open }: { open: boolean }) {
  return <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}><polyline points="3 2 7 5 3 8" /></svg>;
}

function StatusDot({ state }: { state?: "idle" | "running" | "approval" }) {
  const color = state === "approval" ? "#d97706" : state === "running" ? "#22c55e" : "var(--text-dim)";
  return <span title={state ?? "idle"} style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: color, boxShadow: state === "running" ? `0 0 0 2px color-mix(in srgb, ${color} 18%, transparent)` : undefined }} />;
}

function InlineMessage({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: "7px 8px 8px 31px", color: "var(--text-dim)", fontSize: 11 }}>{children}</div>;
}

function formatRelativeTime(value: string): string {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "";
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d` : new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

const headerStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 6, width: "100%", padding: "7px 10px", border: 0, background: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 11, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", textAlign: "left" };
const resourceSummaryStyle: CSSProperties = { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "3px 8px", margin: "1px 4px 5px", padding: "6px 8px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text-dim)", fontSize: 9.5, lineHeight: 1.3 };
const resourceClearStyle: CSSProperties = { marginLeft: "auto", padding: 0, border: 0, background: "transparent", color: "var(--text-muted)", cursor: "pointer", font: "inherit" };
const providerStyle: CSSProperties = { display: "flex", alignItems: "center", minHeight: 34, borderRadius: 7, background: "var(--bg-panel)" };
const providerToggleStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 4, alignSelf: "stretch", minWidth: 0, flex: 1, padding: "0 4px 0 7px", border: 0, background: "transparent", color: "var(--text-muted)", cursor: "pointer", textAlign: "left", font: "inherit" };
const sessionListStyle: CSSProperties = { display: "flex", flexDirection: "column", margin: "1px 0 4px 12px" };
const sessionFilterStyle: CSSProperties = { display: "flex", gap: 2, margin: "3px 4px 1px 20px", padding: 2, borderRadius: 6, background: "var(--bg)" };
const filterButtonStyle: CSSProperties = { flex: 1, minHeight: 24, padding: "3px 6px", border: 0, borderRadius: 4, background: "transparent", color: "var(--text-dim)", cursor: "pointer", font: "10.5px/1.2 inherit" };
const filterButtonActiveStyle: CSSProperties = { background: "var(--bg-selected)", color: "var(--text)" };
const searchStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 6, minHeight: 28, margin: "3px 4px 4px 20px", padding: "0 7px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text-dim)" };
const searchInputStyle: CSSProperties = { minWidth: 0, flex: 1, padding: 0, border: 0, outline: 0, background: "transparent", color: "var(--text)", font: "11px/1.3 inherit" };
const searchClearStyle: CSSProperties = { width: 18, height: 18, padding: 0, border: 0, borderRadius: 4, background: "transparent", color: "var(--text-dim)", cursor: "pointer", font: "15px/1 inherit" };
const sessionRowStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 8, width: "100%", minHeight: 42, padding: "5px 7px 5px 10px", border: 0, borderRadius: 6, background: "transparent", color: "var(--text)", cursor: "pointer", textAlign: "left", font: "inherit" };
const sessionContainerStyle: CSSProperties = { position: "relative", display: "flex", alignItems: "stretch", minWidth: 0, borderRadius: 6 };
const sessionMainStyle: CSSProperties = { ...sessionRowStyle, minWidth: 0, paddingRight: 2, flex: 1 };
const sessionNameStyle: CSSProperties = { display: "block", overflow: "hidden", color: "var(--text)", fontSize: 11.5, lineHeight: "16px", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const sessionMetaStyle: CSSProperties = { display: "block", overflow: "hidden", color: "var(--text-dim)", fontSize: 10.5, lineHeight: "15px", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const timeStyle: CSSProperties = { alignSelf: "flex-start", paddingTop: 2, color: "var(--text-dim)", fontSize: 9.5, flexShrink: 0 };
const retryStyle: CSSProperties = { margin: "3px 4px 5px 23px", padding: "5px 8px", border: 0, background: "transparent", color: "var(--text-muted)", cursor: "pointer", font: "11px/1.3 inherit", textAlign: "left" };
const clearEndedStyle: CSSProperties = { alignSelf: "flex-end", margin: "2px 5px 3px", padding: "3px 6px", border: 0, borderRadius: 4, background: "transparent", color: "var(--text-dim)", cursor: "pointer", font: "10px/1.2 inherit" };
const addStyle: CSSProperties = { display: "grid", width: 28, height: 28, marginRight: 3, padding: 0, placeItems: "center", border: 0, borderRadius: 6, background: "transparent", color: "var(--text-muted)", cursor: "pointer", font: "16px/1 inherit" };
const errorStyle: CSSProperties = { margin: "3px 5px", padding: "6px 8px", borderRadius: 5, background: "rgb(239 68 68 / 10%)", color: "#f87171", fontSize: 10.5, lineHeight: 1.35 };
const menuTriggerStyle: CSSProperties = { display: "grid", width: 28, height: 30, marginRight: 1, padding: 0, placeItems: "center", alignSelf: "center", flex: "0 0 auto", border: "1px solid transparent", borderRadius: 6, background: "transparent", color: "var(--text-dim)", cursor: "pointer" };
const menuTriggerOpenStyle: CSSProperties = { color: "var(--text)" };
const menuStyle: CSSProperties = { position: "fixed", zIndex: 1100, width: 184, maxHeight: "calc(100vh - 16px)", overflowY: "auto", boxSizing: "border-box", padding: 6, border: "1px solid var(--border)", borderRadius: 9, background: "var(--bg-panel)", boxShadow: "0 16px 42px rgb(0 0 0 / 38%), 0 2px 8px rgb(0 0 0 / 18%)" };
const menuButtonStyle: CSSProperties = { display: "flex", alignItems: "center", width: "100%", minHeight: 31, padding: "7px 10px", border: 0, borderRadius: 6, background: "transparent", cursor: "pointer", textAlign: "left", font: "12px/1.35 inherit", whiteSpace: "nowrap" };
const menuDividerStyle: CSSProperties = { display: "block", height: 1, margin: "4px 5px", background: "var(--border)" };
const dialogOverlayStyle: CSSProperties = { position: "fixed", inset: 0, zIndex: 1000, display: "grid", placeItems: "center", padding: 20, background: "rgb(0 0 0 / 55%)" };
const dialogStyle: CSSProperties = { width: "min(100%, 460px)", maxHeight: "min(720px, 90vh)", overflowY: "auto", padding: 18, border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-panel)", color: "var(--text)", boxShadow: "0 20px 60px rgb(0 0 0 / 45%)" };
const dialogGridStyle: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 9, marginTop: 14 };
const fieldStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 5, marginTop: 11, color: "var(--text-muted)", fontSize: 11.5 };
const inputStyle: CSSProperties = { width: "100%", boxSizing: "border-box", padding: "7px 8px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", font: "12px/1.35 inherit" };
const hintStyle: CSSProperties = { color: "var(--text-dim)", fontSize: 10.5, lineHeight: 1.35 };
const modelDescriptionStyle: CSSProperties = { marginTop: 6, padding: "6px 8px", borderRadius: 6, background: "var(--bg)", color: "var(--text-dim)", fontSize: 10.5, lineHeight: 1.4 };
const checkStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 7, marginTop: 12, color: "var(--text-muted)", fontSize: 11.5 };
const dangerStyle: CSSProperties = { marginTop: 11, padding: "7px 8px", borderRadius: 6, background: "rgb(239 68 68 / 10%)", color: "#f87171", fontSize: 11, lineHeight: 1.4 };
const dialogButtonStyle: CSSProperties = { padding: "6px 9px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-hover)", color: "var(--text)", cursor: "pointer", font: "11.5px/1.3 inherit" };
