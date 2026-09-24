"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Activity, Bell, Bot, ChevronDown, Clipboard, FolderOpen, FolderPlus, GitBranch, PanelLeftClose, PanelLeftOpen, Pencil, Pin, PinOff, Search, Settings, TerminalSquare, X } from "lucide-react";
import { ProductStatusDot } from "./ProductStatus";
import { DirectoryPicker } from "./DirectoryPicker";
import type { ProjectWorkspace } from "@/lib/project-workspaces";
import type { GitStatusResponse } from "@/lib/git-types";
import type { SessionInfo } from "@/lib/types";
import { getProductStatus, type ProductStatusId } from "@/lib/product-status";
import { computeRailActivity, groupRailActivity, type RailActivityItem, type RailCompletedEntry, type WorkspaceActivity, type WorkspaceActivityState } from "@/lib/rail-activity";
import { useWorkspaceStatus } from "@/hooks/useWorkspaceStatus";

interface ProjectStatus {
  branch: string | null;
  changedFiles: number;
}

type ActivityState = WorkspaceActivityState;

const activityStatus: Record<ActivityState, ProductStatusId> = { approval: "approval", failed: "failed", working: "running", completed: "completed", idle: "idle" };
const activityDefinition = (state: ActivityState) => getProductStatus(activityStatus[state]);
const activityColor = Object.fromEntries((Object.keys(activityStatus) as ActivityState[]).map((state) => [state, activityDefinition(state).color])) as Record<ActivityState, string>;
const activityLabel = Object.fromEntries((Object.keys(activityStatus) as ActivityState[]).map((state) => [state, activityDefinition(state).label])) as Record<ActivityState, string>;

interface Props {
  workspaces: ProjectWorkspace[];
  activeId: string | null;
  onSelect: (workspace: ProjectWorkspace) => void;
  onAdd: (path: string) => void | Promise<void>;
  onClose: (workspace: ProjectWorkspace) => void;
  onRestore: (workspace: ProjectWorkspace) => void;
  onReorder: (sourceId: string, targetId: string) => void;
  onOpenTerminal: (workspace: ProjectWorkspace) => void;
  onRename: (workspace: ProjectWorkspace, label: string) => void;
  onTogglePinned: (workspace: ProjectWorkspace) => void;
  onOpenSettings: () => void;
  /** Opens one activity item (session, terminal, Codex chat), switching workspace first when needed. */
  onOpenActivityItem: (workspace: ProjectWorkspace, item: RailActivityItem) => void;
}

function initials(label: string): string {
  const parts = label.split(/[\s_-]+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : label.slice(0, 2)).toUpperCase();
}

const contextMenuButtonStyle: CSSProperties = { minHeight: 32, display: "flex", alignItems: "center", gap: 9, padding: "0 9px", border: 0, borderRadius: 5, background: "transparent", color: "var(--text)", cursor: "pointer", font: "12px/1.2 inherit", textAlign: "left" };
const activityItemButtonStyle: CSSProperties = { width: "100%", minHeight: 30, display: "flex", alignItems: "center", gap: 8, padding: "0 7px", border: 0, borderRadius: 6, background: "transparent", color: "var(--text)", cursor: "pointer", font: "11px/1.3 inherit", textAlign: "left" };
const activityKindLabel: Record<RailActivityItem["kind"], string> = { pi: "Pi session", terminal: "Terminal", codex: "Codex chat" };

function ActivityItemButton({ item, onOpen }: { item: RailActivityItem; onOpen: () => void }) {
  const Icon = item.kind === "terminal" ? TerminalSquare : Bot;
  return <button type="button" aria-label={`${item.label} · ${activityKindLabel[item.kind]} · ${activityLabel[item.state]}`} title={`${activityKindLabel[item.kind]} · ${item.label}\n${item.cwd}`} onClick={onOpen} style={activityItemButtonStyle}>
    <span aria-hidden="true" style={{ width: 8, height: 8, flexShrink: 0, borderRadius: "50%", background: activityColor[item.state] }} />
    <Icon size={12} aria-hidden="true" style={{ flexShrink: 0, color: "var(--text-dim)" }} />
    <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.label}</span>
    <small style={{ flexShrink: 0, color: activityColor[item.state], fontSize: 10 }}>{activityLabel[item.state]}</small>
  </button>;
}

export function ProjectRail({ workspaces, activeId, onSelect, onAdd, onClose, onRestore, onReorder, onOpenTerminal, onRename, onTogglePinned, onOpenSettings, onOpenActivityItem }: Props) {
  const workspaceStatus = useWorkspaceStatus();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [runningByCwd, setRunningByCwd] = useState<Record<string, number>>({});
  const [activityById, setActivityById] = useState<Record<string, WorkspaceActivity>>({});
  const [statusById, setStatusById] = useState<Record<string, ProjectStatus>>({});
  const [contextMenu, setContextMenu] = useState<{ workspace: ProjectWorkspace; x: number; y: number } | null>(null);
  const [renameTarget, setRenameTarget] = useState<ProjectWorkspace | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [projectSearchOpen, setProjectSearchOpen] = useState(false);
  const [projectQuery, setProjectQuery] = useState("");
  const [projectSearchIndex, setProjectSearchIndex] = useState(0);
  const [recentlyClosed, setRecentlyClosed] = useState<ProjectWorkspace | null>(null);
  const [activityMenu, setActivityMenu] = useState<{ workspace: ProjectWorkspace; x: number; y: number } | null>(null);
  const [activityCenterOpen, setActivityCenterOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [tick, setTick] = useState(0);
  const mobileRef = useRef<HTMLDivElement>(null);
  const previousRunningRef = useRef<Map<string, RailActivityItem> | null>(null);
  const completedRef = useRef<Map<string, RailCompletedEntry>>(new Map());
  const sessionsByIdRef = useRef<Map<string, SessionInfo>>(new Map());
  const sessionRootsFetchedAtRef = useRef(0);
  useEffect(() => {
    setCollapsed(localStorage.getItem("pi-web:project-rail-collapsed") === "true");
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        setPickerOpen(true);
      } else if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setProjectQuery("");
        setProjectSearchIndex(0);
        setProjectSearchOpen(true);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
  useEffect(() => {
    const editable = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || editable(event.target)) return;
      let target: ProjectWorkspace | undefined;
      if (!event.shiftKey && /^[1-9]$/.test(event.key)) {
        const index = Number(event.key) === 9 ? workspaces.length - 1 : Number(event.key) - 1;
        target = workspaces[index];
      } else if (event.shiftKey && (event.key === "[" || event.key === "]")) {
        const current = Math.max(0, workspaces.findIndex((workspace) => workspace.id === activeId));
        const direction = event.key === "]" ? 1 : -1;
        target = workspaces[(current + direction + workspaces.length) % workspaces.length];
      }
      if (!target) return;
      event.preventDefault();
      onSelect(target);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [activeId, onSelect, workspaces]);
  const toggleCollapsed = () => {
    setCollapsed((current) => {
      const next = !current;
      try { localStorage.setItem("pi-web:project-rail-collapsed", String(next)); } catch { /* storage may be unavailable */ }
      return next;
    });
  };
  useEffect(() => {
    if (!mobileOpen) return;
    const close = (event: PointerEvent) => { if (!mobileRef.current?.contains(event.target as Node)) setMobileOpen(false); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setMobileOpen(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", closeOnEscape); };
  }, [mobileOpen]);
  useEffect(() => {
    let cancelled = false;
    let expiryTimer: ReturnType<typeof setTimeout> | null = null;
    const compute = async () => {
      try {
        const terminals = workspaceStatus.terminals ?? [];
        const runningSessionIds = workspaceStatus.runningSessionIds ?? [];
        const codexRuntimes = workspaceStatus.codexRuntimes ?? [];
        // The full session list requires a server-side scan of every session
        // file, so only fetch it when a running session's project is unknown.
        // Throttled because a brand-new session may not be listed yet.
        if (runningSessionIds.some((id) => !sessionsByIdRef.current.has(id)) && Date.now() - sessionRootsFetchedAtRef.current >= 30_000) {
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
        for (const terminal of terminals) if (terminal.state === "running") counts[terminal.cwd] = (counts[terminal.cwd] ?? 0) + 1;
        const now = Date.now();
        // Running items, terminals ended within 5 minutes, and items that
        // finished within the last 30 s; see lib/rail-activity.ts.
        const result = computeRailActivity({ terminals, runningSessionIds, codexRuntimes, sessionsById: sessionsByIdRef.current, previousRunning: previousRunningRef.current, completed: completedRef.current, now });
        previousRunningRef.current = result.running;
        completedRef.current = result.completed;
        const activities = groupRailActivity(result.items, workspaces);
        let nextExpiry = result.nextExpiry;
        // A running session whose project is still unknown (brand-new, or its
        // lookup was throttled) gets another lookup once the throttle lapses.
        if (runningSessionIds.some((id) => !sessionsByIdRef.current.has(id))) nextExpiry = Math.min(nextExpiry, sessionRootsFetchedAtRef.current + 30_000);
        if (cancelled) return;
        setRunningByCwd(counts);
        setActivityById(activities);
        if (Number.isFinite(nextExpiry)) expiryTimer = setTimeout(() => { if (!cancelled) setTick((current) => current + 1); }, Math.max(0, nextExpiry - now));
      } catch { /* status badges are best effort */ }
    };
    void compute();
    return () => { cancelled = true; if (expiryTimer) clearTimeout(expiryTimer); };
  }, [workspaceStatus.terminals, workspaceStatus.runningSessionIds, workspaceStatus.codexRuntimes, workspaces, tick]);
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const entries = await Promise.all(workspaces.map(async (workspace) => {
        try {
          // The rail is restored from browser storage before the active project
          // finishes mounting. Re-establish each saved workspace grant before
          // asking protected Git routes for badges, and repeat on the low-rate
          // poll so a backend restart heals without user interaction.
          const authorization = await fetch("/api/cwd/validate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cwd: workspace.cwd }),
          });
          if (!authorization.ok) return null;
          const response = await fetch(`/api/git/status?${new URLSearchParams({ cwd: workspace.cwd })}`, { cache: "no-store" });
          if (!response.ok) return null;
          const status = await response.json() as GitStatusResponse;
          return [workspace.id, { branch: status.branch, changedFiles: status.files?.length ?? 0 }] as const;
        } catch { return null; }
      }));
      if (!cancelled) setStatusById(Object.fromEntries(entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null)));
    };
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 20_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [workspaces]);
  useEffect(() => {
    if (!contextMenu) return;
    const close = (event?: PointerEvent) => {
      if (event?.target instanceof Element && event.target.closest(".project-rail-context")) return;
      setContextMenu(null);
    };
    const closeOnBlur = () => setContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setContextMenu(null); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("blur", closeOnBlur);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", closeOnEscape); window.removeEventListener("blur", closeOnBlur); };
  }, [contextMenu]);
  useEffect(() => {
    if (!activityMenu) return;
    const close = (event: PointerEvent) => { if (!(event.target instanceof Element && event.target.closest(".project-activity-menu"))) setActivityMenu(null); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setActivityMenu(null); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", closeOnEscape); };
  }, [activityMenu]);
  useEffect(() => {
    if (!recentlyClosed) return;
    const timer = window.setTimeout(() => setRecentlyClosed(null), 6000);
    return () => window.clearTimeout(timer);
  }, [recentlyClosed]);
  useEffect(() => {
    if (!recentlyClosed) return;
    const reopen = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.key.toLowerCase() !== "t") return;
      event.preventDefault();
      const workspace = recentlyClosed;
      setRecentlyClosed(null);
      onRestore(workspace);
    };
    document.addEventListener("keydown", reopen);
    return () => document.removeEventListener("keydown", reopen);
  }, [onRestore, recentlyClosed]);

  const closeWorkspace = (workspace: ProjectWorkspace) => {
    const running = runningByCwd[workspace.cwd] ?? 0;
    if (running > 0 && !window.confirm(`${running} process${running === 1 ? " is" : "es are"} still running in ${workspace.label}. Close the workspace tab and keep them running?`)) return;
    onClose(workspace);
    setRecentlyClosed(workspace);
  };

  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeId) ?? null;
  const normalizedProjectQuery = projectQuery.trim().toLocaleLowerCase();
  const filteredWorkspaces = normalizedProjectQuery
    ? workspaces.filter((workspace) => `${workspace.label}\n${workspace.cwd}\n${statusById[workspace.id]?.branch ?? ""}`.toLocaleLowerCase().includes(normalizedProjectQuery))
    : workspaces;
  const chooseSearchedProject = (workspace: ProjectWorkspace | undefined) => {
    if (!workspace) return;
    setProjectSearchOpen(false);
    onSelect(workspace);
  };
  const activeActivities = workspaces.flatMap((workspace) => {
    const activity = activityById[workspace.id];
    return activity && activity.state !== "idle" ? [{ workspace, activity }] : [];
  });
  const openActivityItem = (workspace: ProjectWorkspace, item: RailActivityItem) => {
    setActivityMenu(null);
    setActivityCenterOpen(false);
    onOpenActivityItem(workspace, item);
  };
  const attentionCount = activeActivities.reduce((total, item) => total + item.activity.approval + item.activity.failed, 0);

  return <>
    <nav className={`project-rail${collapsed ? " is-collapsed" : ""}`} aria-label="Project workspaces">
      <div style={{ display: "flex", alignItems: "center", justifyContent: collapsed ? "center" : "space-between", flexShrink: 0 }}>
        {!collapsed && <span style={{ display: "flex", alignItems: "center", gap: 2 }}><button type="button" className="project-rail-collapse" aria-label="Search projects" title="Search projects (⌘⇧P)" onClick={() => { setProjectQuery(""); setProjectSearchIndex(0); setProjectSearchOpen(true); }}><Search size={14} /></button><button type="button" className="project-rail-collapse" aria-label="Workspace activity" title="Workspace activity" onClick={() => setActivityCenterOpen(true)} style={{ position: "relative" }}><Bell size={14} />{attentionCount > 0 && <span style={{ position: "absolute", top: 1, right: 1, minWidth: 12, height: 12, display: "grid", placeItems: "center", padding: "0 2px", borderRadius: 999, background: getProductStatus("approval").color, color: "white", fontSize: 7, fontWeight: 800 }}>{Math.min(99, attentionCount)}</span>}</button><button type="button" className="project-rail-collapse" aria-label="Settings" title="Settings" onClick={onOpenSettings}><Settings size={14} /></button></span>}
        <button type="button" className="project-rail-collapse" aria-label={collapsed ? "Expand project bar" : "Collapse project bar"} title={collapsed ? "Expand project bar" : "Collapse project bar"} onClick={toggleCollapsed}>{collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}</button>
      </div>
      <div className="project-rail-list">
        {workspaces.map((workspace) => {
          const active = workspace.id === activeId;
          const projectStatus = statusById[workspace.id];
          const activity = activityById[workspace.id];
          const activityTotal = activity ? activity.working + activity.approval + activity.failed + activity.completed : 0;
          const activitySummary = activity ? [activity.approval && `${activity.approval} waiting`, activity.failed && `${activity.failed} failed`, activity.working && `${activity.working} working`, activity.completed && `${activity.completed} completed`].filter(Boolean).join(" · ") : "";
          return <div key={workspace.id} className={`project-rail-tab${active ? " is-active" : ""}`} draggable onContextMenu={(event) => { event.preventDefault(); setContextMenu({ workspace, x: event.clientX, y: event.clientY }); }} onDragStart={() => setDraggedId(workspace.id)} onDragEnd={() => setDraggedId(null)} onDragOver={(event) => event.preventDefault()} onDrop={() => { if (draggedId && draggedId !== workspace.id) onReorder(draggedId, workspace.id); setDraggedId(null); }}>
            <button type="button" className="project-rail-select" aria-current={active ? "page" : undefined} title={`${workspace.projectRoot}${projectStatus?.changedFiles ? `\n${projectStatus.changedFiles} files with uncommitted Git changes` : ""}`} onClick={() => onSelect(workspace)}>
              <span className="project-rail-icon" aria-hidden="true">{initials(workspace.label)}</span>
              <span className="project-rail-copy"><strong style={{ display: "flex", alignItems: "center", gap: 4 }}>{workspace.pinned && <Pin size={9} aria-label="Pinned" />}{workspace.label}</strong><small><span className="project-rail-branch">{projectStatus?.branch || workspace.cwd}</span>{projectStatus?.changedFiles ? <span className="project-rail-git-status">{projectStatus.changedFiles} Git changes</span> : null}</small></span>
              {collapsed && projectStatus?.changedFiles ? <ProductStatusDot status="git-changes" size={6} title={`${projectStatus.changedFiles} files with uncommitted Git changes`} style={{ position: "absolute", right: 3, bottom: 4, boxShadow: "0 0 0 2px var(--bg-selected)" }} /> : null}
              {activity && activity.state !== "idle" && <span role="button" tabIndex={0} title={`${activityDefinition(activity.state).label}${activitySummary ? ` · ${activitySummary}` : ""}`} aria-label={`${activityDefinition(activity.state).label}${activitySummary ? `: ${activitySummary}` : ""}`} onClick={(event) => { event.stopPropagation(); setActivityMenu({ workspace, x: event.clientX, y: event.clientY }); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); setActivityMenu({ workspace, x: rect.right, y: rect.bottom }); } }} style={{ position: "absolute", right: collapsed ? 3 : 29, top: collapsed ? 3 : "50%", minWidth: activityTotal > 1 ? 16 : 9, height: activityTotal > 1 ? 16 : 9, display: "grid", placeItems: "center", padding: activityTotal > 1 ? "0 4px" : 0, transform: collapsed ? "none" : "translateY(-50%)", border: "2px solid var(--bg-selected)", borderRadius: 999, boxSizing: "border-box", background: activityDefinition(activity.state).color, color: "white", fontSize: 8, fontWeight: 750, cursor: "pointer" }}>{activityTotal > 1 ? activityTotal : ""}</span>}
            </button>
            <button type="button" className="project-rail-close" aria-label={`Close ${workspace.label}`} title="Close project workspace" onClick={() => closeWorkspace(workspace)}><X size={13} /></button>
          </div>;
        })}
      </div>
      <button type="button" className="project-rail-add" aria-label="Open project" title="Open project (⌘⇧O)" onClick={() => { setPickerError(null); setPickerOpen(true); }}><FolderPlus size={16} /><span>Open project</span></button>
    </nav>
    {contextMenu && <div className="project-rail-context" role="menu" aria-label={`${contextMenu.workspace.label} actions`} style={{ position: "fixed", zIndex: 1200, width: 196, display: "grid", gap: 2, padding: 5, left: Math.max(8, Math.min(contextMenu.x, window.innerWidth - 204)), top: Math.max(8, Math.min(contextMenu.y, window.innerHeight - 238)), border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-panel)", boxShadow: "0 14px 38px rgba(0,0,0,.32)" }}>
      <button type="button" role="menuitem" style={contextMenuButtonStyle} onClick={() => { onSelect(contextMenu.workspace); setContextMenu(null); }}><FolderOpen size={14} />Open project</button>
      <button type="button" role="menuitem" style={contextMenuButtonStyle} onClick={() => { onOpenTerminal(contextMenu.workspace); setContextMenu(null); }}><TerminalSquare size={14} />New terminal</button>
      <button type="button" role="menuitem" style={contextMenuButtonStyle} onClick={() => { setRenameTarget(contextMenu.workspace); setRenameValue(contextMenu.workspace.label); setContextMenu(null); }}><Pencil size={14} />Rename</button>
      <button type="button" role="menuitem" style={contextMenuButtonStyle} onClick={() => { onTogglePinned(contextMenu.workspace); setContextMenu(null); }}>{contextMenu.workspace.pinned ? <PinOff size={14} /> : <Pin size={14} />}{contextMenu.workspace.pinned ? "Unpin project" : "Pin project"}</button>
      <button type="button" role="menuitem" style={contextMenuButtonStyle} onClick={() => { void navigator.clipboard.writeText(contextMenu.workspace.cwd).catch(() => undefined); setContextMenu(null); }}><Clipboard size={14} />Copy path</button>
      <div className="project-rail-context-separator" style={{ height: 1, margin: "3px 4px", background: "var(--border)" }} />
      <button type="button" role="menuitem" className="is-danger" style={{ ...contextMenuButtonStyle, color: "#f87171" }} onClick={() => { closeWorkspace(contextMenu.workspace); setContextMenu(null); }}><X size={14} />Close project</button>
    </div>}
    {renameTarget && <div role="dialog" aria-modal="true" aria-label="Rename project" onMouseDown={(event) => { if (event.target === event.currentTarget) setRenameTarget(null); }} style={{ position: "fixed", inset: 0, zIndex: 1300, display: "grid", placeItems: "center", padding: 16, background: "rgba(0,0,0,.32)" }}>
      <form onSubmit={(event) => { event.preventDefault(); if (!renameValue.trim()) return; onRename(renameTarget, renameValue); setRenameTarget(null); }} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setRenameTarget(null); } }} style={{ width: "min(360px,100%)", display: "grid", gap: 12, padding: 16, border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-panel)", boxShadow: "0 18px 52px rgba(0,0,0,.36)" }}>
        <strong style={{ fontSize: 14, color: "var(--text)" }}>Rename project</strong>
        <input autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)} aria-label="Project name" maxLength={80} style={{ height: 36, padding: "0 10px", border: "1px solid var(--border)", borderRadius: 6, outline: "none", background: "var(--bg)", color: "var(--text)", font: "13px/1 inherit" }} />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}><button type="button" onClick={() => setRenameTarget(null)} style={{ ...contextMenuButtonStyle, border: "1px solid var(--border)" }}>Cancel</button><button type="submit" disabled={!renameValue.trim()} style={{ ...contextMenuButtonStyle, background: "var(--accent)", color: "white", opacity: renameValue.trim() ? 1 : .55 }}>Rename</button></div>
      </form>
    </div>}
    {projectSearchOpen && <div role="dialog" aria-modal="true" aria-label="Search projects" onMouseDown={(event) => { if (event.target === event.currentTarget) setProjectSearchOpen(false); }} style={{ position: "fixed", inset: 0, zIndex: 1300, display: "grid", alignItems: "start", justifyItems: "center", padding: "min(14vh,140px) 16px 16px", background: "rgba(0,0,0,.32)" }}>
      <section style={{ width: "min(560px,100%)", maxHeight: "min(620px,72vh)", display: "flex", flexDirection: "column", overflow: "hidden", border: "1px solid var(--border)", borderRadius: 11, background: "var(--bg-panel)", boxShadow: "0 22px 64px rgba(0,0,0,.42)" }} onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); setProjectSearchOpen(false); }
        else if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); if (filteredWorkspaces.length) setProjectSearchIndex((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + filteredWorkspaces.length) % filteredWorkspaces.length); }
        else if (event.key === "Enter") { event.preventDefault(); chooseSearchedProject(filteredWorkspaces[projectSearchIndex]); }
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "0 13px", borderBottom: "1px solid var(--border)" }}><Search size={15} color="var(--text-dim)" /><input autoFocus value={projectQuery} onChange={(event) => { setProjectQuery(event.target.value); setProjectSearchIndex(0); }} placeholder="Search projects, paths, or branches" aria-label="Search projects" style={{ minWidth: 0, flex: 1, height: 46, padding: 0, border: 0, outline: 0, background: "transparent", color: "var(--text)", font: "13px/1 inherit" }} /><kbd style={{ color: "var(--text-dim)", font: "10px/1 var(--font-mono)" }}>esc</kbd></div>
        <div role="listbox" aria-label="Project results" style={{ minHeight: 0, overflowY: "auto", padding: 6 }}>
          {filteredWorkspaces.map((workspace, index) => { const status = statusById[workspace.id]; const activity = activityById[workspace.id]; return <button key={workspace.id} type="button" role="option" aria-selected={index === projectSearchIndex} onMouseEnter={() => setProjectSearchIndex(index)} onClick={() => chooseSearchedProject(workspace)} style={{ width: "100%", minHeight: 48, display: "flex", alignItems: "center", gap: 10, padding: "6px 9px", border: 0, borderRadius: 7, background: index === projectSearchIndex ? "var(--bg-selected)" : "transparent", color: "var(--text)", cursor: "pointer", textAlign: "left" }}><span className="project-rail-icon">{initials(workspace.label)}</span><span style={{ minWidth: 0, flex: 1, display: "grid", gap: 3 }}><strong style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12 }}>{workspace.pinned && <Pin size={10} />}{workspace.label}</strong><small style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)", font: "10px/1.2 var(--font-mono)" }}>{workspace.cwd}</small></span><span style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-dim)", fontSize: 10 }}>{status?.branch && <span style={{ display: "flex", alignItems: "center", gap: 3 }}><GitBranch size={11} />{status.branch}</span>}{status?.changedFiles ? <span style={{ color: getProductStatus("git-changes").color }}>{status.changedFiles} Git changes</span> : null}{activity && activity.state !== "idle" && <span style={{ display: "flex", alignItems: "center", gap: 4, color: activityDefinition(activity.state).color }}><Activity size={11} />{activityDefinition(activity.state).label}</span>}</span></button>; })}
          {filteredWorkspaces.length === 0 && <div style={{ padding: 24, color: "var(--text-dim)", fontSize: 12, textAlign: "center" }}>No matching projects</div>}
        </div>
        <footer style={{ display: "flex", gap: 12, padding: "7px 12px", borderTop: "1px solid var(--border)", color: "var(--text-dim)", fontSize: 10 }}><span>↑↓ Navigate</span><span>Enter Open</span><span style={{ marginLeft: "auto" }}>{workspaces.length} projects</span></footer>
      </section>
    </div>}
    {activityMenu && (() => {
      const activity = activityById[activityMenu.workspace.id];
      if (!activity) return null;
      const menuHeight = Math.min(activity.items.length * 32, 240) + 104;
      return <section className="project-activity-menu" role="dialog" aria-label={`${activityMenu.workspace.label} activity`} style={{ position: "fixed", zIndex: 1250, left: Math.max(8, Math.min(activityMenu.x, window.innerWidth - 288)), top: Math.max(8, Math.min(activityMenu.y, window.innerHeight - menuHeight)), width: 280, padding: 7, border: "1px solid var(--border)", borderRadius: 9, background: "var(--bg-panel)", boxShadow: "0 16px 44px rgba(0,0,0,.36)" }}>
        <header style={{ padding: "5px 7px 8px", borderBottom: "1px solid var(--border)" }}><strong style={{ display: "block", color: "var(--text)", fontSize: 12 }}>{activityMenu.workspace.label}</strong><small style={{ display: "block", marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)", fontSize: 9 }}>{activityMenu.workspace.cwd}</small></header>
        <div style={{ display: "grid", gap: 2, maxHeight: 240, overflowY: "auto", padding: "6px 0" }}>
          {activity.items.map((item) => <ActivityItemButton key={item.key} item={item} onOpen={() => openActivityItem(activityMenu.workspace, item)} />)}
          {activity.items.length === 0 && <div style={{ padding: "8px 7px", color: "var(--text-dim)", fontSize: 11 }}>No active, failed, or recently completed tasks</div>}
        </div>
        <button type="button" onClick={() => { const workspace = activityMenu.workspace; setActivityMenu(null); onSelect(workspace); }} style={{ width: "100%", minHeight: 32, border: 0, borderRadius: 6, background: "var(--bg-selected)", color: "var(--accent)", cursor: "pointer", font: "600 11px/1 inherit" }}>Open workspace</button>
      </section>;
    })()}
    {activityCenterOpen && <div role="dialog" aria-modal="true" aria-label="Workspace activity" onMouseDown={(event) => { if (event.target === event.currentTarget) setActivityCenterOpen(false); }} onKeyDown={(event) => { if (event.key === "Escape") setActivityCenterOpen(false); }} style={{ position: "fixed", inset: 0, zIndex: 1300, display: "grid", alignItems: "start", justifyItems: "center", padding: "min(14vh,140px) 16px 16px", background: "rgba(0,0,0,.32)" }}><section style={{ width: "min(520px,100%)", maxHeight: "min(620px,72vh)", display: "flex", flexDirection: "column", overflow: "hidden", border: "1px solid var(--border)", borderRadius: 11, background: "var(--bg-panel)", boxShadow: "0 22px 64px rgba(0,0,0,.42)" }}><header style={{ display: "flex", alignItems: "center", gap: 9, padding: "12px 14px", borderBottom: "1px solid var(--border)" }}><Bell size={15} color="var(--text-muted)" /><strong style={{ flex: 1, color: "var(--text)", fontSize: 13 }}>Workspace activity</strong><span style={{ color: "var(--text-dim)", fontSize: 10 }}>{activeActivities.length} active</span><button type="button" aria-label="Close workspace activity" onClick={() => setActivityCenterOpen(false)} style={{ width: 26, height: 26, display: "grid", placeItems: "center", border: 0, borderRadius: 5, background: "transparent", color: "var(--text-dim)", cursor: "pointer" }}><X size={13} /></button></header><div style={{ minHeight: 0, overflowY: "auto", padding: 6 }}>{activeActivities.map(({ workspace, activity }) => { const summary = [activity.approval && `${activity.approval} waiting`, activity.failed && `${activity.failed} failed`, activity.working && `${activity.working} working`, activity.completed && `${activity.completed} completed`].filter(Boolean).join(" · "); return <div key={workspace.id} style={{ display: "grid", gap: 1, paddingBottom: 4 }}><button type="button" onClick={() => { setActivityCenterOpen(false); onSelect(workspace); }} style={{ width: "100%", minHeight: 50, display: "flex", alignItems: "center", gap: 10, padding: "7px 9px", border: 0, borderRadius: 7, background: "transparent", color: "var(--text)", cursor: "pointer", textAlign: "left" }}><span style={{ width: 10, height: 10, borderRadius: "50%", background: activityColor[activity.state], boxShadow: `0 0 0 3px color-mix(in srgb,${activityColor[activity.state]} 18%,transparent)` }} /><span style={{ minWidth: 0, flex: 1, display: "grid", gap: 4 }}><strong style={{ fontSize: 12 }}>{workspace.label}</strong><small style={{ color: "var(--text-dim)", fontSize: 10 }}>{summary}</small></span><span style={{ color: activityColor[activity.state], fontSize: 10 }}>{activityLabel[activity.state]}</span></button>{activity.items.length > 0 && <div role="group" aria-label={`${workspace.label} activity items`} style={{ display: "grid", gap: 1, paddingLeft: 22 }}>{activity.items.map((item) => <ActivityItemButton key={item.key} item={item} onOpen={() => openActivityItem(workspace, item)} />)}</div>}</div>; })}{activeActivities.length === 0 && <div style={{ padding: 30, textAlign: "center", color: "var(--text-dim)", fontSize: 12 }}>No active, failed, or recently completed tasks</div>}</div></section></div>}
    {recentlyClosed && <div role="status" aria-live="polite" style={{ position: "fixed", left: 14, bottom: 14, zIndex: 1400, maxWidth: "min(390px,calc(100vw - 28px))", minHeight: 44, display: "flex", alignItems: "center", gap: 10, padding: "8px 9px 8px 13px", border: "1px solid var(--border)", borderRadius: 9, background: "var(--bg-panel)", color: "var(--text)", boxShadow: "0 16px 44px rgba(0,0,0,.36)", fontSize: 12 }}><span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Closed <strong>{recentlyClosed.label}</strong></span><kbd style={{ color: "var(--text-dim)", font: "9px/1 var(--font-mono)" }}>⌘⇧T</kbd><button type="button" onClick={() => { const workspace = recentlyClosed; setRecentlyClosed(null); onRestore(workspace); }} style={{ minHeight: 28, padding: "0 9px", border: 0, borderRadius: 5, background: "var(--bg-selected)", color: "var(--accent)", cursor: "pointer", font: "600 11px/1 inherit" }}>Undo</button><button type="button" aria-label="Dismiss closed project notice" onClick={() => setRecentlyClosed(null)} style={{ width: 28, height: 28, display: "grid", placeItems: "center", padding: 0, border: 0, borderRadius: 5, background: "transparent", color: "var(--text-dim)", cursor: "pointer" }}><X size={13} /></button></div>}
    <div className="project-mobile-switcher" ref={mobileRef}>
      <button type="button" className="project-mobile-trigger" aria-label="Switch project" aria-expanded={mobileOpen} onClick={() => setMobileOpen((open) => !open)}><span>{activeWorkspace?.label ?? "Projects"}</span><ChevronDown size={13} /></button>
      {mobileOpen && <div className="project-mobile-menu" role="menu" aria-label="Project workspaces">
        {workspaces.map((workspace) => <div key={workspace.id} className={`project-mobile-row${workspace.id === activeId ? " is-active" : ""}`}>
          <button type="button" role="menuitem" onClick={() => { setMobileOpen(false); onSelect(workspace); }}><span className="project-rail-icon">{initials(workspace.label)}</span><span className="project-mobile-label">{workspace.label}</span>{statusById[workspace.id]?.changedFiles ? <span className="project-mobile-git-status"><ProductStatusDot status="git-changes" size={6} />{statusById[workspace.id].changedFiles} Git changes</span> : null}{(runningByCwd[workspace.cwd] ?? 0) > 0 && <span className="project-rail-badge">{runningByCwd[workspace.cwd]}</span>}</button>
          <button type="button" aria-label={`Close ${workspace.label}`} onClick={() => closeWorkspace(workspace)}><X size={13} /></button>
        </div>)}
        <button type="button" className="project-mobile-add" onClick={() => { setMobileOpen(false); setPickerOpen(true); }}><FolderPlus size={14} />Open project</button>
      </div>}
    </div>
    {pickerOpen && <DirectoryPicker
      busy={pickerBusy}
      error={pickerError}
      onCancel={() => { if (!pickerBusy) setPickerOpen(false); }}
      onSelect={async (path) => {
        setPickerBusy(true);
        setPickerError(null);
        try {
          await onAdd(path);
          setPickerOpen(false);
        } catch (error) {
          setPickerError(error instanceof Error ? error.message : String(error));
        } finally {
          setPickerBusy(false);
        }
      }}
    />}
  </>;
}
