"use client";

import dynamic from "next/dynamic";
import { joinFilePath } from "@/lib/file-paths";
import type { TerminalSession } from "@/lib/agents/terminal";
import type { TerminalConnectionState } from "@/hooks/useTerminalSocket";
import type { TerminalSplit } from "@/lib/workspace/panel-state";
import type { CenterTab, ClaudeChatTab, ClaudePermissionMode, CodexApprovalPolicy, CodexChatTab, FileTab, TerminalTab } from "@/lib/workspace/tabs";
import { useWorkspaceActions } from "./WorkspaceActions";

// Panels below pull in heavy dependencies (xterm, assistant-ui, provider icon
// sets, diff/preview renderers) and are only shown on demand, so keep them out
// of the initial chat bundle.
const AgentTerminalPanel = dynamic(() => import("../agents/AgentTerminalPanel").then((m) => m.AgentTerminalPanel), { ssr: false });
const CodexChatPanel = dynamic(() => import("../agents/codex/CodexChatPanel").then((m) => m.CodexChatPanel), { ssr: false });
const ClaudeChatPanel = dynamic(() => import("../agents/claude/ClaudeChatPanel").then((m) => m.ClaudeChatPanel), { ssr: false });
const FileViewer = dynamic(() => import("../FileViewer").then((m) => m.FileViewer), { ssr: false });
const GitReviewPanel = dynamic(() => import("../GitReviewPanel").then((m) => m.GitReviewPanel), { ssr: false });

const terminalRecoveryButtonStyle: React.CSSProperties = { padding: "6px 9px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-hover)", color: "var(--text)", cursor: "pointer", font: "11.5px/1.3 inherit" };

/**
 * Terminal tab body: a running AgentTerminalPanel (optionally split with a
 * second pane) or the "process unavailable" recovery view. Also renders for
 * a codex-chat tab that has neither a live terminal nor a source session to
 * resume — the caller falls through to this view in that case.
 */
export function TerminalTabView({
  tab,
  terminals,
  split,
  workspaceTabs,
  isMobile,
  activeTerminalPaneId,
  onActivatePane,
  terminalRestartingId,
  terminalRestartError,
  terminalRestoreErrors,
  isActive,
  onConnectionChange,
  onSetSplit,
  onActivateTab,
  onRestart,
  onTerminalChange,
  onTerminalStarted,
  onOpenCodexChat,
  onBeginSplitResize,
}: {
  tab: TerminalTab | CodexChatTab;
  terminals: Record<string, TerminalSession>;
  split: TerminalSplit | null;
  workspaceTabs: CenterTab[];
  isMobile: boolean;
  activeTerminalPaneId: string | null;
  onActivatePane: (id: string) => void;
  terminalRestartingId: string | null;
  terminalRestartError: string | null;
  terminalRestoreErrors: Record<string, string>;
  isActive: boolean;
  onConnectionChange: (terminalId: string, connection: TerminalConnectionState) => void;
  onSetSplit: (update: TerminalSplit | null | ((current: TerminalSplit | null) => TerminalSplit | null)) => void;
  onActivateTab: (id: string) => void;
  onRestart: (tab: TerminalTab) => void;
  onTerminalChange: (terminal: TerminalSession) => void;
  onTerminalStarted: (terminal: TerminalSession, preferredLabel?: string) => void;
  onOpenCodexChat: (terminal: TerminalSession) => void;
  onBeginSplitResize: (event: React.PointerEvent<HTMLDivElement>) => void;
}) {
  const terminal = tab.terminalId ? terminals[tab.terminalId] ?? null : null;
  const paneSplit = split?.primaryTabId === tab.id ? split : null;
  const secondaryTerminal = paneSplit ? terminals[paneSplit.secondaryTerminalId] ?? null : null;
  const splitDirection = isMobile ? "vertical" : paneSplit?.direction;
  const splitCandidates = terminal ? Object.values(terminals).filter((candidate) => candidate.id !== terminal.id && candidate.state === "running") : [];
  const secondaryTab = paneSplit ? workspaceTabs.find((item): item is TerminalTab => item.kind === "terminal" && item.terminalId === paneSplit.secondaryTerminalId) ?? null : null;
  const primaryPanel = terminal ? <AgentTerminalPanel terminal={terminal} splitCandidates={splitCandidates} splitActive={Boolean(paneSplit)} activePane={!paneSplit || activeTerminalPaneId !== paneSplit.secondaryTerminalId} onActivatePane={() => onActivatePane(terminal.id)} onConnectionChange={(connection) => onConnectionChange(terminal.id, connection)} onSplit={(secondaryTerminalId, direction) => { onActivatePane(terminal.id); onSetSplit({ primaryTabId: tab.id, secondaryTerminalId, direction, ratio: 50, reversed: false }); }} onUnsplit={() => onSetSplit(null)} onSwapSplit={() => onSetSplit((current) => current ? { ...current, reversed: !current.reversed, ratio: 100 - current.ratio } : null)} onMaximizePane={() => onSetSplit(null)} onClosePane={() => { if (secondaryTab) onActivateTab(secondaryTab.id); onSetSplit(null); }} onRestart={() => { if (tab.kind === "terminal") onRestart(tab); }} onTerminalChange={onTerminalChange} onTerminalStarted={onTerminalStarted} onOpenCodexChat={onOpenCodexChat} /> : null;
  const secondaryPanel = secondaryTerminal ? <AgentTerminalPanel terminal={secondaryTerminal} splitActive activePane={activeTerminalPaneId === secondaryTerminal.id} onActivatePane={() => onActivatePane(secondaryTerminal.id)} onConnectionChange={(connection) => onConnectionChange(secondaryTerminal.id, connection)} onUnsplit={() => onSetSplit(null)} onSwapSplit={() => onSetSplit((current) => current ? { ...current, reversed: !current.reversed, ratio: 100 - current.ratio } : null)} onMaximizePane={() => { if (secondaryTab) onActivateTab(secondaryTab.id); onSetSplit(null); }} onClosePane={() => onSetSplit(null)} onRestart={() => { if (secondaryTab) onRestart(secondaryTab); }} onTerminalChange={onTerminalChange} onTerminalStarted={onTerminalStarted} onOpenCodexChat={onOpenCodexChat} /> : secondaryTab ? <div style={{ height: "100%", display: "grid", placeItems: "center", padding: 18, background: "var(--bg)", color: "var(--text-dim)", fontSize: 12 }}><div style={{ display: "grid", justifyItems: "center", gap: 8, textAlign: "center" }}><strong style={{ color: "var(--text)" }}>Split terminal unavailable</strong><span>{terminalRestoreErrors[secondaryTab.id] || "Restoring this pane after the server restart…"}</span><div style={{ display: "flex", gap: 7 }}><button type="button" disabled={terminalRestartingId === secondaryTab.id} onClick={() => onRestart(secondaryTab)} style={terminalRecoveryButtonStyle}>{terminalRestartingId === secondaryTab.id ? "Restoring…" : "Retry"}</button><button type="button" onClick={() => onSetSplit(null)} style={terminalRecoveryButtonStyle}>Remove pane</button></div></div></div> : null;

  return terminal ? (paneSplit && secondaryTab ? <div className={`terminal-split terminal-split--${splitDirection}`} style={splitDirection === "horizontal" ? { gridTemplateColumns: `${paneSplit.ratio}fr 5px ${100 - paneSplit.ratio}fr` } : { gridTemplateRows: `${paneSplit.ratio}fr 5px ${100 - paneSplit.ratio}fr` }}>{paneSplit.reversed ? secondaryPanel : primaryPanel}<div className="terminal-split-divider" role="separator" aria-orientation={splitDirection === "horizontal" ? "vertical" : "horizontal"} onPointerDown={onBeginSplitResize} />{paneSplit.reversed ? primaryPanel : secondaryPanel}</div> : primaryPanel
  ) : (
    <div style={{ height: "100%", display: "grid", placeItems: "center", padding: 24, color: "var(--text-dim)", fontSize: 12 }}><div style={{ display: "grid", justifyItems: "center", gap: 10, textAlign: "center" }}><strong style={{ color: "var(--text)", fontSize: 14 }}>Terminal process is unavailable</strong><span>The server restarted or this terminal process ended outside TianForge.</span>{tab.kind === "terminal" && tab.terminalProvider && <button type="button" disabled={terminalRestartingId === tab.id} onClick={() => onRestart(tab)} style={{ padding: "7px 11px", border: "1px solid var(--accent)", borderRadius: 6, background: "var(--accent)", color: "white" }}>{terminalRestartingId === tab.id ? "Restarting…" : "Restart terminal"}</button>}{terminalRestartError && isActive && <span style={{ color: "#f87171" }}>{terminalRestartError}</span>}</div></div>
  );
}

/** Codex chat tab body. Renders nothing when neither a live terminal, a resumable source session, nor a new chat exists — the caller falls through to TerminalTabView's unavailable view in that case. */
export function CodexChatTabView({
  tab,
  terminal,
  activeCwd,
  onStatusChange,
  onConfigurationChange,
  onCreated,
}: {
  tab: CodexChatTab;
  terminal: TerminalSession | null;
  activeCwd: string | null;
  onStatusChange: (tabId: string, status: "idle" | "running" | "approval") => void;
  onConfigurationChange: (tabId: string, configuration: { model?: string; reasoningEffort?: string; serviceTier?: string; approvalPolicy?: CodexApprovalPolicy }) => void;
  onCreated?: (tabId: string, cwd: string, threadId: string, title: string) => void;
}) {
  const actions = useWorkspaceActions();
  if (!terminal && !tab.sourceSessionId && !tab.newChat) return null;
  return (
    <CodexChatPanel
      terminal={terminal ? { ...terminal, model: tab.model ?? terminal.model, reasoningEffort: tab.reasoningEffort, serviceTier: tab.serviceTier, approvalPolicy: tab.approvalPolicy, sessionName: tab.sessionName } : { cwd: tab.cwd ?? activeCwd ?? "", model: tab.model, sourceSessionId: tab.sourceSessionId, reasoningEffort: tab.reasoningEffort, serviceTier: tab.serviceTier, approvalPolicy: tab.approvalPolicy, sessionName: tab.sessionName }}
      workspaceTabId={tab.id}
      newChat={!terminal && tab.newChat}
      onCreated={onCreated}
      onOpenFork={actions.openCodexChat}
      onStatusChange={onStatusChange}
      onConfigurationChange={onConfigurationChange}
      onOpenFile={(filePath) => {
        const absolutePath = filePath.startsWith("/") ? filePath : joinFilePath(tab.cwd ?? activeCwd ?? "", filePath);
        actions.openFile(absolutePath, { sourceSessionId: tab.sourceSessionId });
      }}
    />
  );
}

/** Claude chat tab body: a saved Claude session, or a new chat created by its first message. */
export function ClaudeChatTabView({
  tab,
  activeCwd,
  onStatusChange,
  onConfigurationChange,
  onCreated,
}: {
  tab: ClaudeChatTab;
  activeCwd: string | null;
  onStatusChange: (tabId: string, status: "idle" | "running" | "approval") => void;
  onConfigurationChange: (tabId: string, configuration: { model?: string; permissionMode?: ClaudePermissionMode }) => void;
  onCreated: (tabId: string, cwd: string, sessionId: string, title: string) => void;
}) {
  const actions = useWorkspaceActions();
  const cwd = tab.cwd ?? activeCwd ?? "";
  return (
    <ClaudeChatPanel
      sessionId={tab.sourceSessionId ?? null}
      cwd={cwd}
      sessionName={tab.sessionName}
      model={tab.model ?? ""}
      permissionMode={tab.permissionMode ?? "default"}
      workspaceTabId={tab.id}
      onCreated={onCreated}
      onStatusChange={onStatusChange}
      onConfigurationChange={onConfigurationChange}
      onOpenFile={(filePath) => actions.openFile(filePath.startsWith("/") ? filePath : joinFilePath(cwd, filePath))}
    />
  );
}

/** File tab body: the file viewer for the tab's path. */
export function FileTabView({
  tab,
  activeCwd,
  gitRefreshKey,
  onMentionLines,
}: {
  tab: FileTab;
  activeCwd: string | null;
  gitRefreshKey: number;
  onMentionLines?: (relativePath: string, startLine: number, endLine: number) => void;
}) {
  const actions = useWorkspaceActions();
  return (
    <FileViewer
      filePath={tab.filePath}
      cwd={activeCwd ?? undefined}
      sourceSessionId={tab.sourceSessionId}
      gitRefreshKey={gitRefreshKey}
      onMentionLines={onMentionLines}
      onOpenFile={(filePath) => actions.openFile(filePath, { sourceSessionId: tab.sourceSessionId })}
    />
  );
}

/** Git tab body: the Git review panel for the active workspace. */
export function GitTabView({
  activeCwd,
  gitRefreshKey,
  onRepoChanged,
}: {
  activeCwd: string | null;
  gitRefreshKey: number;
  onRepoChanged: () => void;
}) {
  return <GitReviewPanel cwd={activeCwd} refreshKey={gitRefreshKey} onRepoChanged={onRepoChanged} />;
}
