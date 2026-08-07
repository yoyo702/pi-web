"use client";

import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useGlobalKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { SessionSidebar } from "./SessionSidebar";
import { ProjectRail } from "./ProjectRail";
import { ChatWindow } from "./ChatWindow";
import { FileViewer } from "./FileViewer";
import { GitReviewPanel } from "./GitReviewPanel";
import { AgentTerminalPanel } from "./agents/AgentTerminalPanel";
import { CodexChatPanel } from "./agents/codex/CodexChatPanel";
import { NewAgentDialog } from "./agents/NewAgentDialog";
import { TabBar, type Tab } from "./TabBar";
import { getMissingSplitTerminalTabs } from "@/lib/terminal-restore";
import { ModelsConfig } from "./ModelsConfig";
import { SkillsConfig } from "./SkillsConfig";
import { PluginsConfig } from "./PluginsConfig";
import { BranchNavigator } from "./BranchNavigator";
import { useTheme } from "@/hooks/useTheme";
import { useIsMobile } from "@/hooks/useIsMobile";
import { copyText } from "@/lib/clipboard";
import { getFileName, joinFilePath } from "@/lib/file-paths";
import { buildAtMentionText, buildFileAtMentionsText, buildFileLineMentionText } from "@/lib/file-fuzzy";
import { getInitialNavigation } from "@/lib/initial-navigation";
import type { SessionInfo, SessionTreeNode } from "@/lib/types";
import type { ChatInputHandle } from "./ChatInput";
import type { SessionStatsInfo } from "@/lib/pi-types";
import type { TerminalProvider, TerminalSession } from "@/lib/agents/terminal";
import type { TerminalConnectionState } from "@/hooks/useTerminalSocket";
import { useWorkspaceTerminals } from "@/hooks/useWorkspaceTerminals";
import { Activity, ArrowLeft, Bot, Files, GitBranch, Maximize2, Minimize2, PanelsTopLeft, Plus, TerminalSquare } from "lucide-react";
import { PROJECT_WORKSPACES_STORAGE_KEY, RECENT_PROJECTS_STORAGE_KEY, parseProjectWorkspaceSnapshot, parseRecentProjects, projectLabel, updateRecentProjects, upsertProjectWorkspace, type ProjectWorkspace } from "@/lib/project-workspaces";

type SessionCopyField = "file" | "id";
type AutoNameStatus =
  | { kind: "idle" }
  | { kind: "naming" }
  | { kind: "success" }
  | { kind: "error"; message: string };
const rightPanelHeaderButtonStyle: React.CSSProperties = { width: 36, height: 36, display: "grid", placeItems: "center", padding: 0, border: 0, borderLeft: "1px solid var(--border)", background: "transparent", color: "var(--text-muted)", cursor: "pointer" };
const rightPanelToolMenuStyle: React.CSSProperties = { position: "absolute", zIndex: 500, top: 38, right: 2, width: 190, display: "grid", gap: 2, padding: 5, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-panel)", boxShadow: "0 14px 36px rgba(0,0,0,.26)" };
const rightPanelToolItemStyle: React.CSSProperties = { minHeight: 32, display: "flex", alignItems: "center", gap: 8, padding: "0 9px", border: 0, borderRadius: 5, background: "transparent", color: "var(--text)", cursor: "pointer", font: "12px/1.2 inherit", textAlign: "left" };
const WORKSPACE_TABS_STORAGE_KEY = "pi-web:workspace-tabs";
const workspaceTabsStorageKey = (cwd: string) => `${WORKSPACE_TABS_STORAGE_KEY}:${encodeURIComponent(cwd)}`;
const RIGHT_PANEL_TABS_STORAGE_KEY = "pi-web:right-panel-tabs";
const rightPanelTabsStorageKey = (projectRoot: string) => `${RIGHT_PANEL_TABS_STORAGE_KEY}:${encodeURIComponent(projectRoot)}`;

export function AppShell() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [initialNavigation] = useState(() => getInitialNavigation(searchParams));
  const [activeCwd, setActiveCwd] = useState<string | null>(null);
  const [projectWorkspaces, setProjectWorkspaces] = useState<ProjectWorkspace[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [projectWorkspacesHydrated, setProjectWorkspacesHydrated] = useState(false);
  const [projectSelectionDismissed, setProjectSelectionDismissed] = useState(false);
  const [sidebarCwdResetKey, setSidebarCwdResetKey] = useState(0);
  const { isDark, toggleTheme } = useTheme();
  const isMobile = useIsMobile();
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(null);
  // When user clicks +, we only store the cwd — no fake session id
  const [newSessionCwd, setNewSessionCwd] = useState<string | null>(null);
  const [initialCwdStatus, setInitialCwdStatus] = useState<"idle" | "validating" | "ready" | "error">(
    () => initialNavigation.requestedCwd ? "validating" : "idle",
  );
  const [initialCwdError, setInitialCwdError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [sessionKey, setSessionKey] = useState(0);
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);
  const [modelsConfigOpen, setModelsConfigOpen] = useState(false);
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  const [skillsConfigOpen, setSkillsConfigOpen] = useState(false);
  const [pluginsConfigOpen, setPluginsConfigOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileSidebarReady, setMobileSidebarReady] = useState(false);
  const [mobileSidebarModule, setMobileSidebarModule] = useState<"sessions" | "agents" | "explorer">("sessions");
  const [mobileExplorerRevealKey, setMobileExplorerRevealKey] = useState(0);
  // On mobile the sidebar is an overlay drawer; hide it by default so the chat
  // is visible on load. Runs once the breakpoint resolves after hydration.
  useEffect(() => {
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);
  useEffect(() => {
    setMobileSidebarReady(true);
  }, []);
  useEffect(() => {
    const restored = parseProjectWorkspaceSnapshot(localStorage.getItem(PROJECT_WORKSPACES_STORAGE_KEY));
    setProjectWorkspaces(restored.workspaces);
    setActiveProjectId(restored.activeId);
    setProjectWorkspacesHydrated(true);
  }, []);
  useEffect(() => {
    if (!projectWorkspacesHydrated) return;
    try { localStorage.setItem(PROJECT_WORKSPACES_STORAGE_KEY, JSON.stringify({ workspaces: projectWorkspaces, activeId: activeProjectId })); } catch { /* storage may be unavailable */ }
  }, [activeProjectId, projectWorkspaces, projectWorkspacesHydrated]);
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const topBarRef = useRef<HTMLDivElement>(null);

  // Branch navigator state — populated by ChatWindow via onBranchDataChange
  const [branchTree, setBranchTree] = useState<SessionTreeNode[]>([]);
  const [branchActiveLeafId, setBranchActiveLeafId] = useState<string | null>(null);
  const branchLeafChangeFnRef = useRef<((leafId: string | null) => void) | null>(null);

  const handleBranchDataChange = useCallback((tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => {
    setBranchTree(tree);
    setBranchActiveLeafId(activeLeafId);
    branchLeafChangeFnRef.current = onLeafChange;
  }, []);

  const handleBranchLeafChange = useCallback((leafId: string | null) => {
    branchLeafChangeFnRef.current?.(leafId);
  }, []);

  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const systemBtnRef = useRef<HTMLButtonElement>(null);

  const handleSystemPromptChange = useCallback((prompt: string | null) => {
    setSystemPrompt(prompt);
  }, []);

  // Session stats (tokens + cost) — populated by ChatWindow, displayed in top bar
  const [sessionStats, setSessionStats] = useState<SessionStatsInfo | null>(null);
  const [autoNameStatus, setAutoNameStatus] = useState<AutoNameStatus>({ kind: "idle" });
  const autoNameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSessionIdRef = useRef<string | null>(selectedSession?.id ?? null);
  activeSessionIdRef.current = selectedSession?.id ?? null;
  const handleSessionStatsChange = useCallback((stats: SessionStatsInfo | null) => {
    setSessionStats(stats);
  }, []);
  const [copiedSessionField, setCopiedSessionField] = useState<SessionCopyField | null>(null);
  const sessionCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  // Context usage — populated by ChatWindow, displayed in top bar
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const handleContextUsageChange = useCallback((usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => {
    setContextUsage(usage);
  }, []);

  // Single active panel — only one dropdown open at a time
  const [activeTopPanel, setActiveTopPanel] = useState<"branches" | "system" | "session" | null>(null);
  const [activityPanelOpen, setActivityPanelOpen] = useState(false);
  const activityPanelRef = useRef<HTMLDivElement>(null);
  const [topPanelPos, setTopPanelPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const toggleTopPanel = useCallback((panel: "branches" | "system" | "session") => {
    if (isMobile) setSidebarOpen(false);
    setActiveTopPanel((cur) => cur === panel ? null : panel);
  }, [isMobile]);

  const openSessionStatsPanel = useCallback(() => {
    if (isMobile) setSidebarOpen(false);
    setActiveTopPanel("session");
  }, [isMobile]);

  const handleSidebarToggle = useCallback(() => {
    if (isMobile) setActiveTopPanel(null);
    setSidebarOpen((open) => !open);
  }, [isMobile]);

  useEffect(() => {
    if (!activeTopPanel || !topBarRef.current) return;
    const update = () => {
      const rect = topBarRef.current!.getBoundingClientRect();
      setTopPanelPos({ top: rect.bottom, left: rect.left, width: rect.width });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(topBarRef.current);
    return () => ro.disconnect();
  }, [activeTopPanel]);

  useEffect(() => {
    if (!activityPanelOpen) return;
    const close = (event: PointerEvent) => { if (!activityPanelRef.current?.contains(event.target as Node)) setActivityPanelOpen(false); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setActivityPanelOpen(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", closeOnEscape); };
  }, [activityPanelOpen]);

  // The center is the primary workspace: Pi is permanent, external agents open
  // as sibling tabs. The right panel remains auxiliary (files and Git only).
  const [workspaceTabs, setWorkspaceTabs] = useState<Tab[]>([{ id: "pi", label: "Pi", kind: "pi", closable: false }]);
  const [activeWorkspaceTabId, setActiveWorkspaceTabId] = useState("pi");
  const [mountedWorkspaceTabIds, setMountedWorkspaceTabIds] = useState<Set<string>>(() => new Set(["pi"]));
  const [workspaceTabsHydratedCwd, setWorkspaceTabsHydratedCwd] = useState<string | null>(null);
  const [terminalSplit, setTerminalSplit] = useState<{ primaryTabId: string; secondaryTerminalId: string; direction: "horizontal" | "vertical"; ratio: number; reversed: boolean } | null>(null);
  const [activeTerminalPaneId, setActiveTerminalPaneId] = useState<string | null>(null);
  const splitRestoreAttemptRef = useRef<string | null>(null);
  useEffect(() => {
    splitRestoreAttemptRef.current = null;
    setWorkspaceTabs([{ id: "pi", label: "Pi", kind: "pi", closable: false }]);
    setActiveWorkspaceTabId("pi");
    setMountedWorkspaceTabIds(new Set(["pi"]));
    setTerminalSplit(null);
    if (!activeCwd) { setWorkspaceTabsHydratedCwd(null); return; }
    try {
      const raw = localStorage.getItem(workspaceTabsStorageKey(activeCwd)) ?? localStorage.getItem(WORKSPACE_TABS_STORAGE_KEY);
      const parsed = JSON.parse(raw || "null") as { tabs?: unknown; activeId?: unknown; split?: unknown } | null;
      const restored = Array.isArray(parsed?.tabs) ? parsed.tabs.filter((value): value is Tab => {
        if (!value || typeof value !== "object") return false;
        const tab = value as Partial<Tab>;
        return typeof tab.id === "string" && typeof tab.label === "string" && tab.cwd === activeCwd && (tab.kind === "terminal" || tab.kind === "codex-chat");
      }) : [];
      if (restored.length > 0) setWorkspaceTabs([{ id: "pi", label: "Pi", kind: "pi", closable: false }, ...restored.map((tab) => ({ ...tab, status: tab.kind === "codex-chat" ? "idle" as const : tab.status }))]);
      if (typeof parsed?.activeId === "string" && (parsed.activeId === "pi" || restored.some((tab) => tab.id === parsed.activeId))) setActiveWorkspaceTabId(parsed.activeId);
      if (parsed?.split && typeof parsed.split === "object") {
        const split = parsed.split as Partial<{ primaryTabId: string; secondaryTerminalId: string; direction: "horizontal" | "vertical"; ratio: number; reversed: boolean }>;
        if (typeof split.primaryTabId === "string" && typeof split.secondaryTerminalId === "string" && (split.direction === "horizontal" || split.direction === "vertical")) {
          setTerminalSplit({ primaryTabId: split.primaryTabId, secondaryTerminalId: split.secondaryTerminalId, direction: split.direction, ratio: typeof split.ratio === "number" ? Math.max(20, Math.min(80, split.ratio)) : 50, reversed: split.reversed === true });
        }
      }
    } catch { /* Ignore malformed or unavailable browser storage. */ }
    setWorkspaceTabsHydratedCwd(activeCwd);
  }, [activeCwd]);
  useEffect(() => {
    if (!activeCwd || workspaceTabsHydratedCwd !== activeCwd) return;
    try {
      localStorage.setItem(workspaceTabsStorageKey(activeCwd), JSON.stringify({ tabs: workspaceTabs.filter((tab) => tab.id !== "pi"), activeId: activeWorkspaceTabId, split: terminalSplit }));
    } catch { /* Ignore storage quota/privacy errors. */ }
  }, [activeCwd, activeWorkspaceTabId, terminalSplit, workspaceTabs, workspaceTabsHydratedCwd]);
  useEffect(() => {
    setMountedWorkspaceTabIds((current) => {
      if (current.has(activeWorkspaceTabId)) return current;
      const next = new Set(current);
      next.add(activeWorkspaceTabId);
      return next;
    });
  }, [activeWorkspaceTabId]);
  // Right panel tabs: file viewers and Git Review.
  const [fileTabs, setFileTabs] = useState<Tab[]>([]);
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [fileTabsHydratedProject, setFileTabsHydratedProject] = useState<string | null>(null);
  const rightPanelStateCacheRef = useRef(new Map<string, { tabs: Tab[]; activeId: string | null; open: boolean }>());
  useLayoutEffect(() => {
    setFileTabs([]);
    setActiveFileTabId(null);
    setRightPanelOpen(false);
    if (!activeProjectId) { setFileTabsHydratedProject(null); return; }
    try {
      const parsed = rightPanelStateCacheRef.current.get(activeProjectId) ?? JSON.parse(localStorage.getItem(rightPanelTabsStorageKey(activeProjectId)) || "null") as { tabs?: unknown; activeId?: unknown; open?: unknown } | null;
      const restored = Array.isArray(parsed?.tabs) ? parsed.tabs.filter((value): value is Tab => {
        if (!value || typeof value !== "object") return false;
        const tab = value as Partial<Tab>;
        return typeof tab.id === "string" && typeof tab.label === "string" && (tab.kind === "file" || tab.kind === "git");
      }) : [];
      setFileTabs(restored);
      if (typeof parsed?.activeId === "string" && restored.some((tab) => tab.id === parsed.activeId)) setActiveFileTabId(parsed.activeId);
      setRightPanelOpen(parsed?.open === true && restored.length > 0);
    } catch { /* ignore malformed storage */ }
    setFileTabsHydratedProject(activeProjectId);
  }, [activeProjectId]);
  useLayoutEffect(() => {
    if (!activeProjectId || fileTabsHydratedProject !== activeProjectId) return;
    const snapshot = { tabs: fileTabs, activeId: activeFileTabId, open: rightPanelOpen };
    rightPanelStateCacheRef.current.set(activeProjectId, snapshot);
    try { localStorage.setItem(rightPanelTabsStorageKey(activeProjectId), JSON.stringify(snapshot)); } catch { /* storage may be unavailable */ }
  }, [activeFileTabId, activeProjectId, fileTabs, fileTabsHydratedProject, rightPanelOpen]);
  const currentProjectPanelsRef = useRef({ activeCwd, activeFileTabId, activeProjectId, activeWorkspaceTabId, fileTabs, fileTabsHydratedProject, rightPanelOpen, terminalSplit, workspaceTabs, workspaceTabsHydratedCwd });
  currentProjectPanelsRef.current = { activeCwd, activeFileTabId, activeProjectId, activeWorkspaceTabId, fileTabs, fileTabsHydratedProject, rightPanelOpen, terminalSplit, workspaceTabs, workspaceTabsHydratedCwd };
  const persistCurrentProjectPanels = useCallback(() => {
    const current = currentProjectPanelsRef.current;
    try {
      if (current.activeCwd && current.workspaceTabsHydratedCwd === current.activeCwd) localStorage.setItem(workspaceTabsStorageKey(current.activeCwd), JSON.stringify({ tabs: current.workspaceTabs.filter((tab) => tab.id !== "pi"), activeId: current.activeWorkspaceTabId, split: current.terminalSplit }));
      if (current.activeProjectId && current.fileTabsHydratedProject === current.activeProjectId) {
        const snapshot = { tabs: current.fileTabs, activeId: current.activeFileTabId, open: current.rightPanelOpen };
        rightPanelStateCacheRef.current.set(current.activeProjectId, snapshot);
        localStorage.setItem(rightPanelTabsStorageKey(current.activeProjectId), JSON.stringify(snapshot));
      }
    } catch { /* storage may be unavailable */ }
  }, []);
  const { terminals: terminalList, loaded: terminalsLoaded, update: updateTerminals } = useWorkspaceTerminals(activeCwd ?? "");
  const terminals = useMemo(() => Object.fromEntries(terminalList.map((terminal) => [terminal.id, terminal])), [terminalList]);
  const [newTerminalProvider, setNewTerminalProvider] = useState<TerminalProvider | null>(null);
  const [pendingTerminalClose, setPendingTerminalClose] = useState<{ tabId: string; terminal: TerminalSession } | null>(null);
  const [terminalCloseBusy, setTerminalCloseBusy] = useState(false);
  const [terminalCloseError, setTerminalCloseError] = useState<string | null>(null);
  const [terminalRestartingId, setTerminalRestartingId] = useState<string | null>(null);
  const [terminalRestartError, setTerminalRestartError] = useState<string | null>(null);
  const terminalRestoreInFlightRef = useRef(new Set<string>());
  const [terminalRestoreErrors, setTerminalRestoreErrors] = useState<Record<string, string>>({});
  const mobileOverlayHistoryRef = useRef(false);
  const mobileOverlayHistoryReadyRef = useRef(false);
  useEffect(() => {
    if (!isMobile) {
      mobileOverlayHistoryRef.current = false;
      mobileOverlayHistoryReadyRef.current = false;
      return;
    }
    const handlePopState = () => {
      if (!mobileOverlayHistoryRef.current) return;
      mobileOverlayHistoryRef.current = false;
      setSidebarOpen(false);
      setRightPanelOpen(false);
      setActiveTopPanel(null);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [isMobile]);
  useEffect(() => {
    if (!isMobile || !mobileSidebarReady) return;
    const overlayOpen = sidebarOpen || rightPanelOpen;
    // Hydration starts with the desktop sidebar open and then closes it for
    // mobile. Do not create a disposable history entry during that transition.
    if (!mobileOverlayHistoryReadyRef.current) {
      if (!overlayOpen) mobileOverlayHistoryReadyRef.current = true;
      return;
    }
    if (overlayOpen && !mobileOverlayHistoryRef.current) {
      window.history.pushState({ ...window.history.state, piWebMobileOverlay: true }, "");
      mobileOverlayHistoryRef.current = true;
    } else if (!overlayOpen && mobileOverlayHistoryRef.current) {
      mobileOverlayHistoryRef.current = false;
      if (window.history.state?.piWebMobileOverlay) window.history.back();
    }
  }, [isMobile, mobileSidebarReady, rightPanelOpen, sidebarOpen]);
  const prepareMobileOverlayHistory = useCallback(() => {
    if (!isMobile || mobileOverlayHistoryRef.current) return;
    window.history.pushState({ ...window.history.state, piWebMobileOverlay: true }, "");
    mobileOverlayHistoryRef.current = true;
  }, [isMobile]);
  useEffect(() => {
    const misplaced = fileTabs.filter((tab) => tab.kind === "terminal" || tab.kind === "codex-chat");
    if (misplaced.length === 0) return;
    setWorkspaceTabs((current) => {
      const existing = new Set(current.map((tab) => tab.id));
      return [...current, ...misplaced.filter((tab) => !existing.has(tab.id))];
    });
    if (activeFileTabId && misplaced.some((tab) => tab.id === activeFileTabId)) setActiveWorkspaceTabId(activeFileTabId);
    setFileTabs((current) => {
      const next = current.filter((tab) => tab.kind !== "terminal" && tab.kind !== "codex-chat");
      if (next.length === 0) setRightPanelOpen(false);
      return next;
    });
    setActiveFileTabId((current) => current && misplaced.some((tab) => tab.id === current) ? null : current);
  }, [activeFileTabId, fileTabs]);
  // Collapse the center chat column to give the right panel the full width
  // (a "focus the file/git view" mode). Only meaningful while the right panel
  // is open, so reopening later never leaves both main columns hidden.
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [rightPanelFullscreen, setRightPanelFullscreen] = useState(false);
  const [rightPanelMenuOpen, setRightPanelMenuOpen] = useState(false);
  const rightPanelMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!rightPanelMenuOpen && !rightPanelFullscreen) return;
    const onPointerDown = (event: PointerEvent) => { if (rightPanelMenuOpen && !rightPanelMenuRef.current?.contains(event.target as Node)) setRightPanelMenuOpen(false); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") { setRightPanelMenuOpen(false); setRightPanelFullscreen(false); } };
    document.addEventListener("pointerdown", onPointerDown); document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("pointerdown", onPointerDown); document.removeEventListener("keydown", onKeyDown); };
  }, [rightPanelFullscreen, rightPanelMenuOpen]);
  useEffect(() => { if (!rightPanelOpen) { setRightPanelFullscreen(false); setRightPanelMenuOpen(false); } }, [rightPanelOpen]);
  useEffect(() => { if (!rightPanelOpen) setChatCollapsed(false); }, [rightPanelOpen]);

  // Resizable panels. null means "use the CSS default" (260px / 42vw) so the
  // first paint matches the old layout; localStorage rehydrates saved widths.
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(null);
  const [rightPanelWidth, setRightPanelWidth] = useState<number | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  useEffect(() => {
    const s = Number(localStorage.getItem("pi-sidebar-w"));
    if (Number.isFinite(s) && s >= 180 && s <= 640) setSidebarWidth(s);
    const r = Number(localStorage.getItem("pi-right-panel-w"));
    if (Number.isFinite(r) && r >= 320) setRightPanelWidth(Math.min(r, window.innerWidth - 200));
  }, []);

  // Generic edge-drag: `dir` is +1 when dragging the element's right edge
  // (sidebar) and -1 when dragging its left edge (right panel).
  const beginResize = useCallback((
    dir: 1 | -1,
    getStart: () => number,
    setWidth: (w: number) => void,
    storageKey: string,
    clampMax: () => number,
  ) => (event: React.MouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startW = getStart();
    setIsResizing(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    let latest = startW;
    const onMove = (ev: MouseEvent) => {
      latest = Math.min(clampMax(), Math.max(180, startW + dir * (ev.clientX - startX)));
      setWidth(latest);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setIsResizing(false);
      try { localStorage.setItem(storageKey, String(Math.round(latest))); } catch {}
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  const beginSidebarResize = beginResize(
    1,
    () => sidebarWidth ?? 260,
    setSidebarWidth,
    "pi-sidebar-w",
    () => 640,
  );
  const beginRightPanelResize = beginResize(
    -1,
    () => rightPanelWidth ?? Math.round(window.innerWidth * 0.42),
    setRightPanelWidth,
    "pi-right-panel-w",
    () => window.innerWidth - 200,
  );
  // In focus mode the right panel fills the chat's old slot, so it no longer
  // has an edge to resize. Dragging its visible left divider restores chat and
  // continues as a normal right-panel resize in one gesture.
  const restoreChatFromResize = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    const max = () => window.innerWidth - 200;
    const startX = event.clientX;
    const startW = Math.min(max(), Math.max(300, window.innerWidth - startX));
    let latest = startW;
    setChatCollapsed(false);
    setRightPanelWidth(startW);
    setIsResizing(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (moveEvent: MouseEvent) => {
      latest = Math.min(max(), Math.max(300, startW - (moveEvent.clientX - startX)));
      setRightPanelWidth(latest);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setIsResizing(false);
      try { localStorage.setItem("pi-right-panel-w", String(Math.round(latest))); } catch {}
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  const chatHidden = chatCollapsed && rightPanelOpen && !isMobile;
  // Same @mention format as the chat input's @ autocomplete, so the agent's
  // read tool resolves it the same way (it strips the @ prefix).
  const handleAtMention = useCallback((relativePath: string, isDir: boolean) => {
    chatInputRef.current?.insertText(buildAtMentionText(relativePath, isDir));
  }, []);

  const handleAtMentions = useCallback((relativePaths: string[]) => {
    const mentions = buildFileAtMentionsText(relativePaths);
    if (mentions) chatInputRef.current?.insertText(mentions);
  }, []);

  const handleFileLineMention = useCallback((relativePath: string, startLine: number, endLine: number) => {
    chatInputRef.current?.insertText(buildFileLineMentionText(relativePath, startLine, endLine));
  }, []);

  const initialSessionId = initialNavigation.sessionId;
  // True once the initial ?session= URL param has been resolved (or confirmed absent)
  const [initialSessionRestored, setInitialSessionRestored] = useState<boolean>(() => !initialSessionId);
  // Suppresses sessionKey bump in handleCwdChange during the initial URL restore
  const suppressCwdBumpRef = useRef(false);
  const projectSwitchTokenRef = useRef(0);
  const authorizedCwdsRef = useRef(new Set<string>());

  const recordProjectWorkspace = useCallback((cwd: string, projectRoot = cwd, sessionId?: string | null) => {
    setProjectSelectionDismissed(false);
    setActiveProjectId(projectRoot);
    setProjectWorkspaces((current) => upsertProjectWorkspace(current, { projectRoot, cwd, sessionId }));
  }, []);

  const rememberRecentProject = useCallback((workspace: ProjectWorkspace) => {
    try {
      const recent = parseRecentProjects(localStorage.getItem(RECENT_PROJECTS_STORAGE_KEY));
      localStorage.setItem(RECENT_PROJECTS_STORAGE_KEY, JSON.stringify(updateRecentProjects(recent, workspace.projectRoot, workspace.label)));
    } catch { /* local storage may be unavailable */ }
  }, []);

  useEffect(() => {
    const requestedCwd = initialNavigation.requestedCwd;
    if (!requestedCwd) return;

    const controller = new AbortController();
    setInitialCwdStatus("validating");
    setInitialCwdError(null);

    void fetch("/api/cwd/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: requestedCwd }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as { cwd?: string; error?: string };
        if (!response.ok || !data.cwd) {
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }

        // The sidebar will notify us when it adopts this cwd. Avoid remounting
        // the just-created empty chat during that initial synchronization.
        suppressCwdBumpRef.current = true;
        setNewSessionCwd(data.cwd);
        setInitialCwdStatus("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setInitialCwdError(error instanceof Error ? error.message : String(error));
        setInitialCwdStatus("error");
      });

    return () => controller.abort();
  }, [initialNavigation]);

  const handleCwdChange = useCallback((cwd: string | null, projectRoot?: string | null) => {
    setActiveCwd(cwd);
    // Skip if cwd is null (initial mount) or during the initial URL restore.
    if (!cwd) return;
    const newProject = projectRoot ?? cwd;
    const selectedProject = selectedSession ? selectedSession.projectRoot ?? selectedSession.cwd : null;
    recordProjectWorkspace(cwd, newProject, selectedProject === newProject ? selectedSession?.id : undefined);
    if (suppressCwdBumpRef.current) {
      suppressCwdBumpRef.current = false;
      return;
    }
    // Worktrees of one repo share a project root. Moving the effective cwd
    // within the same project (e.g. switching worktree, or clicking a session
    // that lives in another worktree) must not close the open session.
    if (selectedSession && (selectedSession.projectRoot ?? selectedSession.cwd) === newProject) {
      return;
    }
    // Close any session that belongs to a different project — it no longer
    // matches the selected project directory.
    setSelectedSession(null);
    setNewSessionCwd((prev) => {
      if (prev && prev !== cwd) return null;
      return prev;
    });
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setActiveTopPanel(null);
    router.replace("/", { scroll: false });
  }, [recordProjectWorkspace, router, selectedSession]);

  // Some cwd changes originate inside SessionSidebar (session restore,
  // worktree selection, or state retained by Fast Refresh) and therefore do
  // not pass through activateProjectWorkspace. Always establish the server
  // grant for the effective cwd, then retry every view that may have raced the
  // grant with an initial 403.
  useEffect(() => {
    if (!activeCwd || authorizedCwdsRef.current.has(activeCwd)) return;
    const controller = new AbortController();
    void fetch("/api/cwd/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: activeCwd }),
      signal: controller.signal,
    }).then((response) => {
      if (!response.ok || controller.signal.aborted) return;
      authorizedCwdsRef.current.add(activeCwd);
      setExplorerRefreshKey((key) => key + 1);
      setRefreshKey((key) => key + 1);
      setModelsRefreshKey((key) => key + 1);
    }).catch(() => {});
    return () => controller.abort();
  }, [activeCwd]);

  const handleSelectSession = useCallback((session: SessionInfo, isRestore = false) => {
    recordProjectWorkspace(session.cwd, session.projectRoot ?? session.cwd, session.id);
    setActiveWorkspaceTabId("pi");
    setNewSessionCwd(null);
    setSelectedSession(session);
    setSessionKey((k) => k + 1);
    setSystemPrompt(null);
    setInitialSessionRestored(true);
    // On mobile, collapse the overlay drawer so the chat is revealed after pick.
    if (isMobile && !isRestore) setSidebarOpen(false);
    if (isRestore) {
      // Suppress the redundant sessionKey bump that would come from the
      // onCwdChange effect firing after setSelectedCwd in the sidebar
      suppressCwdBumpRef.current = true;
    }
    // Skip router.replace when restoring from URL — the param is already correct
    // and calling replace in production Next.js triggers a Suspense remount loop
    if (!isRestore) {
      router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
    }
  }, [recordProjectWorkspace, router, isMobile]);

  const handleNewSession = useCallback((_sessionId: string, cwd: string) => {
    recordProjectWorkspace(cwd, activeProjectId ?? cwd, null);
    setActiveWorkspaceTabId("pi");
    setSelectedSession(null);
    setNewSessionCwd(cwd);
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setActiveTopPanel(null);
    if (isMobile) setSidebarOpen(false);
    router.replace("/", { scroll: false });
  }, [activeProjectId, recordProjectWorkspace, router, isMobile]);

  const activateProjectWorkspace = useCallback(async (workspace: ProjectWorkspace) => {
    // Explicit roots are held in server memory. Re-authorize a workspace before
    // restoring it from localStorage or switching back to it after a server
    // restart, otherwise Explorer/Git/Worktree requests race ahead with 403s.
    let authorizedCwd = workspace.cwd;
    if (!authorizedCwdsRef.current.has(workspace.cwd)) {
      try {
        const response = await fetch("/api/cwd/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd: workspace.cwd }),
        });
        const data = await response.json().catch(() => ({})) as { cwd?: string };
        if (!response.ok || !data.cwd) return;
        authorizedCwd = data.cwd;
        authorizedCwdsRef.current.add(authorizedCwd);
      } catch {
        return;
      }
    }
    const authorizedWorkspace = authorizedCwd === workspace.cwd
      ? workspace
      : {
          ...workspace,
          cwd: authorizedCwd,
          id: workspace.id === workspace.cwd ? authorizedCwd : workspace.id,
          projectRoot: workspace.projectRoot === workspace.cwd ? authorizedCwd : workspace.projectRoot,
        };
    persistCurrentProjectPanels();
    rememberRecentProject(authorizedWorkspace);
    const token = ++projectSwitchTokenRef.current;
    setActiveProjectId(authorizedWorkspace.id);
    setProjectSelectionDismissed(false);
    setProjectWorkspaces((current) => upsertProjectWorkspace(current, { ...authorizedWorkspace, lastActive: Date.now() }));
    setActiveCwd(authorizedWorkspace.cwd);
    setActiveWorkspaceTabId("pi");
    setSelectedSession(null);
    setNewSessionCwd(authorizedWorkspace.cwd);
    setSessionKey((key) => key + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setActiveTopPanel(null);
    suppressCwdBumpRef.current = true;
    router.replace("/", { scroll: false });
    if (!authorizedWorkspace.sessionId) return;
    try {
      const response = await fetch("/api/sessions", { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json() as { sessions?: SessionInfo[] };
      const session = data.sessions?.find((candidate) => candidate.id === authorizedWorkspace.sessionId);
      if (!session || token !== projectSwitchTokenRef.current) return;
      setNewSessionCwd(null);
      setSelectedSession(session);
      recordProjectWorkspace(session.cwd, session.projectRoot ?? authorizedWorkspace.projectRoot, session.id);
      setSessionKey((key) => key + 1);
      router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
    } catch { /* keep the project open with a fresh Pi tab */ }
  }, [persistCurrentProjectPanels, recordProjectWorkspace, rememberRecentProject, router]);

  const handleAddProjectWorkspace = useCallback(async (path: string) => {
    const response = await fetch("/api/cwd/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: path }),
    });
    const data = await response.json().catch(() => ({})) as { cwd?: string; error?: string };
    if (!response.ok || !data.cwd) throw new Error(data.error ?? `Unable to open directory (HTTP ${response.status})`);
    authorizedCwdsRef.current.add(data.cwd);
    const workspace: ProjectWorkspace = { id: data.cwd, projectRoot: data.cwd, cwd: data.cwd, label: projectLabel(data.cwd), sessionId: null, lastActive: Date.now() };
    await activateProjectWorkspace(workspace);
  }, [activateProjectWorkspace]);

  const handleCloseProjectWorkspace = useCallback((workspace: ProjectWorkspace) => {
    if (workspace.id === activeProjectId) persistCurrentProjectPanels();
    const remaining = projectWorkspaces.filter((candidate) => candidate.id !== workspace.id);
    setProjectWorkspaces(remaining);
    if (workspace.id !== activeProjectId) return;
    const next = remaining[0];
    if (next) void activateProjectWorkspace(next);
    else {
      projectSwitchTokenRef.current += 1;
      setActiveProjectId(null);
      setProjectSelectionDismissed(true);
      setSidebarCwdResetKey((key) => key + 1);
      setActiveCwd(null);
      setSelectedSession(null);
      setNewSessionCwd(null);
      setSessionKey((key) => key + 1);
      router.replace("/", { scroll: false });
    }
  }, [activeProjectId, activateProjectWorkspace, persistCurrentProjectPanels, projectWorkspaces, router]);

  const handleReorderProjectWorkspaces = useCallback((sourceId: string, targetId: string) => {
    setProjectWorkspaces((current) => {
      const sourceIndex = current.findIndex((workspace) => workspace.id === sourceId);
      const targetIndex = current.findIndex((workspace) => workspace.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0) return current;
      const next = [...current];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next.sort((left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)));
    });
  }, []);

  const handleRenameProjectWorkspace = useCallback((workspace: ProjectWorkspace, label: string) => {
    const nextLabel = label.trim();
    if (!nextLabel) return;
    const renamed = { ...workspace, label: nextLabel };
    setProjectWorkspaces((current) => current.map((candidate) => candidate.id === workspace.id ? renamed : candidate));
    rememberRecentProject(renamed);
  }, [rememberRecentProject]);

  const handleTogglePinnedProjectWorkspace = useCallback((workspace: ProjectWorkspace) => {
    setProjectWorkspaces((current) => current
      .map((candidate) => candidate.id === workspace.id ? { ...candidate, pinned: !candidate.pinned } : candidate)
      .sort((left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned))));
  }, []);

  useEffect(() => {
    if (!projectWorkspacesHydrated || activeCwd || !activeProjectId || initialSessionId) return;
    const workspace = projectWorkspaces.find((candidate) => candidate.id === activeProjectId);
    if (workspace) void activateProjectWorkspace(workspace);
  }, [activeCwd, activeProjectId, activateProjectWorkspace, initialSessionId, projectWorkspaces, projectWorkspacesHydrated]);

  // Global keyboard shortcuts (handles Esc, Ctrl+Alt+N etc.)
  useGlobalKeyboardShortcuts({
    onNewSession: (cwd: string) => handleNewSession(`kb-${Date.now()}`, cwd),
    activeCwd,
  });

  // Client-built transient SessionInfo (new session / fork) lacks the
  // server-computed projectRoot, which the same-project check in
  // handleCwdChange relies on. Hydrate it from the session list so switching
  // worktrees right after creating a session doesn't close the chat.
  const hydrateSelectedSession = useCallback((sessionId: string) => {
    void fetch("/api/sessions")
      .then((r) => (r.ok ? (r.json() as Promise<{ sessions: SessionInfo[] }>) : null))
      .then((d) => {
        const full = d?.sessions.find((s) => s.id === sessionId);
        if (!full) return;
        setSelectedSession((prev) => (prev && prev.id === sessionId && !prev.projectRoot ? full : prev));
      })
      .catch(() => {});
  }, []);

  // Called by ChatWindow when a new session gets its real id from pi
  const handleSessionCreated = useCallback((session: SessionInfo) => {
    recordProjectWorkspace(session.cwd, session.projectRoot ?? activeProjectId ?? session.cwd, session.id);
    setNewSessionCwd(null);
    setSelectedSession(session);
    setRefreshKey((k) => k + 1);
    hydrateSelectedSession(session.id);
    router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
  }, [activeProjectId, recordProjectWorkspace, router, hydrateSelectedSession]);

  const handleAgentEnd = useCallback(() => {
    setRefreshKey((k) => k + 1);
    setExplorerRefreshKey((k) => k + 1);
  }, []);

  const handleAutoName = useCallback(async () => {
    const sessionId = selectedSession?.id;
    if (!sessionId || autoNameStatus.kind === "naming") return;
    if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    setActiveTopPanel(null);
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
      setRefreshKey((key) => key + 1);
      if (activeSessionIdRef.current !== sessionId) return;
      setSelectedSession((current) => current?.id === sessionId ? { ...current, name: title } : current);
      setSessionStats((current) => current?.sessionId === sessionId ? { ...current, sessionName: title } : current);
      setAutoNameStatus({ kind: "success" });
      autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: "idle" }), 1800);
    } catch (error) {
      if (activeSessionIdRef.current !== sessionId) return;
      const message = error instanceof Error ? error.message : String(error);
      setAutoNameStatus({ kind: "error", message });
      autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: "idle" }), 5000);
    }
  }, [autoNameStatus.kind, selectedSession?.id]);

  useEffect(() => {
    if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    setAutoNameStatus({ kind: "idle" });
  }, [selectedSession?.id]);

  const handleExplorerRefresh = useCallback(() => {
    setExplorerRefreshKey((k) => k + 1);
  }, []);

  // Git status, the file tree, and open-file diffs are only bumped on our own
  // agent_end and on manual actions. Work done outside Pi Web (terminal `pi`,
  // a git commit/checkout, or editing files in another app) leaves them stale.
  // Refresh those views (and the session list, so sessions created in the
  // terminal appear) both when the tab regains focus and on a low-frequency
  // poll while the tab is visible — a cheap safety net so idle tabs still catch
  // up. Throttled so focus + poll don't double-fire or hammer `git status`.
  const lastFocusRefreshRef = useRef(0);
  useEffect(() => {
    const EXTERNAL_POLL_MS = 20000;
    const refreshExternal = () => {
      const now = Date.now();
      if (now - lastFocusRefreshRef.current < 1500) return;
      lastFocusRefreshRef.current = now;
      setExplorerRefreshKey((k) => k + 1);
      setRefreshKey((k) => k + 1);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshExternal();
    };
    const poll = () => {
      if (document.visibilityState === "visible") refreshExternal();
    };
    const interval = setInterval(poll, EXTERNAL_POLL_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", refreshExternal);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", refreshExternal);
    };
  }, []);

  const handleSessionForked = useCallback((newSessionId: string) => {
    setRefreshKey((k) => k + 1);
    setSessionKey((k) => k + 1);
    setNewSessionCwd(null);
    setSelectedSession((prev) => ({
      ...(prev ?? { path: "", cwd: "", created: "", modified: "", messageCount: 0, firstMessage: "" }),
      id: newSessionId,
    }));
    hydrateSelectedSession(newSessionId);
    router.replace(`?session=${encodeURIComponent(newSessionId)}`, { scroll: false });
  }, [router, hydrateSelectedSession]);

  const handleInitialRestoreDone = useCallback(() => {
    setInitialSessionRestored(true);
  }, []);

  const handleSessionDeleted = useCallback((sessionId: string) => {
    setRefreshKey((k) => k + 1);
    if (selectedSession?.id === sessionId) {
      const cwd = selectedSession.cwd;
      setSelectedSession(null);
      setNewSessionCwd(cwd ?? null);
      setSessionKey((k) => k + 1);
      setBranchTree([]);
      setBranchActiveLeafId(null);
      setSystemPrompt(null);
      setActiveTopPanel(null);
      router.replace("/", { scroll: false });
    }
  }, [selectedSession, router]);

  const handleOpenFile = useCallback((filePath: string, fileName: string, sourceSessionId?: string | null) => {
    const tabId = `file:${filePath}`;
    setFileTabs((prev) => {
      const existing = prev.find((t) => t.id === tabId);
      if (!existing) return [...prev, { id: tabId, label: fileName, kind: "file", filePath, sourceSessionId }];
      if (!sourceSessionId || existing.sourceSessionId === sourceSessionId) return prev;
      return prev.map((t) => t.id === tabId ? { ...t, sourceSessionId } : t);
    });
    setActiveFileTabId(tabId);
    setRightPanelOpen(true);
    // On mobile the file panel is full-screen; close the drawer so it shows.
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);

  const handleExplorerPathRenamed = useCallback((oldPath: string, newPath: string, isDir: boolean) => {
    const matches = (value?: string) => Boolean(value && (value === oldPath || (isDir && value.startsWith(`${oldPath}/`))));
    const renamedPath = (value: string) => `${newPath}${value.slice(oldPath.length)}`;
    setFileTabs((current) => current.map((tab) => {
      if (tab.kind !== "file" || !matches(tab.filePath)) return tab;
      const filePath = renamedPath(tab.filePath!);
      return { ...tab, id: `file:${filePath}`, filePath, label: tab.filePath === oldPath ? getFileName(filePath) : tab.label };
    }));
    setActiveFileTabId((current) => current?.startsWith("file:") && matches(current.slice(5)) ? `file:${renamedPath(current.slice(5))}` : current);
  }, []);

  const handleExplorerPathDeleted = useCallback((deletedPath: string, isDir: boolean) => {
    const matches = (tab: Tab) => tab.kind === "file" && Boolean(tab.filePath && (tab.filePath === deletedPath || (isDir && tab.filePath.startsWith(`${deletedPath}/`))));
    const removedIds = new Set(fileTabs.filter(matches).map((tab) => tab.id));
    if (removedIds.size === 0) return;
    const remaining = fileTabs.filter((tab) => !removedIds.has(tab.id));
    setFileTabs(remaining);
    setActiveFileTabId((current) => current && removedIds.has(current) ? remaining.at(-1)?.id ?? null : current);
    if (remaining.length === 0) setRightPanelOpen(false);
  }, [fileTabs]);

  const handleCloseFileTab = useCallback((tabId: string) => {
    setFileTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      // No tabs left means nothing to show — collapse the right panel.
      if (next.length === 0) setRightPanelOpen(false);
      return next;
    });
    setActiveFileTabId((cur) => {
      if (cur !== tabId) return cur;
      const remaining = fileTabs.filter((t) => t.id !== tabId);
      return remaining.length > 0 ? remaining[remaining.length - 1].id : null;
    });
  }, [fileTabs]);

  const removeWorkspaceTab = useCallback((tabId: string) => {
    if (tabId === "pi") return;
    setWorkspaceTabs((current) => current.filter((tab) => tab.id !== tabId));
    setActiveWorkspaceTabId((current) => {
      if (current !== tabId) return current;
      const index = workspaceTabs.findIndex((tab) => tab.id === tabId);
      return workspaceTabs[index - 1]?.id ?? workspaceTabs[index + 1]?.id ?? "pi";
    });
    setMountedWorkspaceTabIds((current) => { const next = new Set(current); next.delete(tabId); return next; });
    setTerminalSplit((current) => current && (current.primaryTabId === tabId || `terminal:${current.secondaryTerminalId}` === tabId) ? null : current);
  }, [workspaceTabs]);

  const handleCloseWorkspaceTab = useCallback((tabId: string) => {
    const tab = workspaceTabs.find((item) => item.id === tabId);
    const terminal = tab?.terminalId ? terminals[tab.terminalId] : null;
    if (terminal?.state === "running") {
      setTerminalCloseError(null);
      setPendingTerminalClose({ tabId, terminal });
      return;
    }
    removeWorkspaceTab(tabId);
  }, [removeWorkspaceTab, terminals, workspaceTabs]);

  const closeTerminalTab = useCallback(async (stop: boolean) => {
    const target = pendingTerminalClose;
    if (!target) return;
    if (!stop) { setPendingTerminalClose(null); removeWorkspaceTab(target.tabId); return; }
    setTerminalCloseBusy(true);
    setTerminalCloseError(null);
    try {
      const response = await fetch(`/api/terminals/${encodeURIComponent(target.terminal.id)}/stop`, { method: "POST" });
      const data = await response.json() as { terminal?: TerminalSession; error?: string };
      if (!response.ok) throw new Error(data.error || "Unable to stop terminal");
      if (data.terminal) updateTerminals((current) => [...current.filter((item) => item.id !== data.terminal!.id), data.terminal!]);
      setPendingTerminalClose(null);
      removeWorkspaceTab(target.tabId);
    } catch (cause) { setTerminalCloseError(cause instanceof Error ? cause.message : "Unable to stop terminal"); }
    finally { setTerminalCloseBusy(false); }
  }, [pendingTerminalClose, removeWorkspaceTab, updateTerminals]);

  const handleSelectWorkspaceTab = useCallback((tabId: string) => {
    if (terminalSplit && tabId === `terminal:${terminalSplit.secondaryTerminalId}`) setTerminalSplit(null);
    setActiveWorkspaceTabId(tabId);
    setActiveTopPanel(null);
  }, [terminalSplit]);

  const beginTerminalSplitResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const container = event.currentTarget.parentElement;
    const split = terminalSplit;
    if (!container || !split) return;
    event.preventDefault();
    const onMove = (moveEvent: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      const direction = isMobile ? "vertical" : split.direction;
      const raw = direction === "horizontal" ? (moveEvent.clientX - rect.left) / rect.width * 100 : (moveEvent.clientY - rect.top) / rect.height * 100;
      setTerminalSplit((current) => current ? { ...current, ratio: Math.max(20, Math.min(80, raw)) } : null);
    };
    const onUp = () => { document.removeEventListener("pointermove", onMove); document.removeEventListener("pointerup", onUp); };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, { once: true });
  }, [isMobile, terminalSplit]);

  const handleCodexSessionChanged = useCallback((change: { id: string; action: "rename" | "archive" | "unarchive" | "delete"; name?: string }) => {
    if (change.action === "rename" && change.name) {
      setWorkspaceTabs((current) => current.map((tab) => tab.sourceSessionId === change.id ? { ...tab, label: change.name!, ...(tab.kind === "codex-chat" ? { sessionName: change.name! } : {}) } : tab));
      return;
    }
    if (change.action !== "archive" && change.action !== "delete") return;
    setWorkspaceTabs((current) => current.filter((tab) => !(tab.kind === "codex-chat" && tab.sourceSessionId === change.id)));
    setActiveWorkspaceTabId((current) => {
      const active = workspaceTabs.find((tab) => tab.id === current);
      return active?.kind === "codex-chat" && active.sourceSessionId === change.id ? "pi" : current;
    });
  }, [workspaceTabs]);

  const handleAgentTerminalRemoved = useCallback((terminalId: string) => {
    updateTerminals((current) => current.filter((terminal) => terminal.id !== terminalId));
    setWorkspaceTabs((current) => current.filter((tab) => tab.terminalId !== terminalId));
    setActiveWorkspaceTabId((current) => current === `terminal:${terminalId}` || current === `codex-chat:${terminalId}` ? "pi" : current);
  }, [updateTerminals]);

  const openGitReview = useCallback(() => {
    if (!activeCwd) return;
    const tabId = "git-review";
    setFileTabs((prev) => prev.some((tab) => tab.id === tabId)
      ? prev
      : [...prev, { id: tabId, label: "Git Review", kind: "git" }]);
    setActiveFileTabId(tabId);
    setRightPanelOpen(true);
    if (isMobile) setSidebarOpen(false);
  }, [activeCwd, isMobile]);

  const handleOpenGitReview = useCallback(() => {
    if (rightPanelOpen && activeFileTabId === "git-review") {
      handleCloseFileTab("git-review");
      return;
    }
    openGitReview();
  }, [rightPanelOpen, activeFileTabId, handleCloseFileTab, openGitReview]);

  const handleTerminalCreated = useCallback((terminal: TerminalSession, preferredLabel?: string) => {
    const tabId = `terminal:${terminal.id}`;
    updateTerminals((current) => [...current.filter((item) => item.id !== terminal.id), terminal]);
    setWorkspaceTabs((current) => current.some((tab) => tab.id === tabId)
      ? current
      : [...current, { id: tabId, label: preferredLabel || terminal.title || (terminal.provider === "shell" ? "Terminal" : `${terminal.provider} terminal`), kind: "terminal", terminalId: terminal.id, terminalProvider: terminal.provider, terminalPermissionMode: terminal.permissionMode, terminalLaunchMode: terminal.launchMode, terminalNoAltScreen: terminal.noAltScreen, terminalModel: terminal.model, terminalWebSearch: terminal.webSearch, terminalChatMode: terminal.chatMode, cwd: terminal.cwd, sourceSessionId: terminal.sourceSessionId, status: terminal.state === "running" ? "running" : "ended" }]);
    setActiveWorkspaceTabId(tabId);
    setNewTerminalProvider(null);
    if (isMobile) setSidebarOpen(false);
  }, [isMobile, updateTerminals]);

  const restartUnavailableTerminal = useCallback(async (tab: Tab): Promise<TerminalSession | null> => {
    if (!tab.terminalProvider || !tab.cwd) return null;
    if (terminalRestoreInFlightRef.current.has(tab.id)) return null;
    terminalRestoreInFlightRef.current.add(tab.id);
    setTerminalRestartingId(tab.id);
    setTerminalRestartError(null);
    setTerminalRestoreErrors((current) => { const next = { ...current }; delete next[tab.id]; return next; });
    try {
      if (tab.terminalId) await fetch(`/api/terminals/${encodeURIComponent(tab.terminalId)}`, { method: "DELETE" }).catch(() => undefined);
      const resumeCodex = tab.terminalProvider === "codex" && Boolean(tab.sourceSessionId);
      const response = await fetch("/api/terminals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: tab.terminalProvider, cwd: tab.cwd, permissionMode: tab.terminalPermissionMode, launchMode: resumeCodex ? "resume" : "new", sourceSessionId: resumeCodex ? tab.sourceSessionId : undefined, noAltScreen: tab.terminalNoAltScreen, model: tab.terminalModel, webSearch: tab.terminalWebSearch, chatMode: tab.terminalChatMode }) });
      const data = await response.json() as { terminal?: TerminalSession; error?: string };
      if (!response.ok || !data.terminal) throw new Error(data.error || "Unable to restart terminal");
      const renamedResponse = await fetch(`/api/terminals/${encodeURIComponent(data.terminal.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: tab.label }) });
      const renamedData = await renamedResponse.json() as { terminal?: TerminalSession };
      const restarted = renamedResponse.ok && renamedData.terminal ? renamedData.terminal : { ...data.terminal, title: tab.label };
      updateTerminals((current) => [...current.filter((item) => item.id !== restarted.id && item.id !== tab.terminalId), restarted]);
      setWorkspaceTabs((current) => current.map((item) => item.id === tab.id ? { ...item, terminalId: restarted.id, terminalProvider: restarted.provider, terminalPermissionMode: restarted.permissionMode, terminalLaunchMode: restarted.launchMode, terminalNoAltScreen: restarted.noAltScreen, terminalModel: restarted.model, terminalWebSearch: restarted.webSearch, terminalChatMode: restarted.chatMode, sourceSessionId: restarted.sourceSessionId, status: "running" } : item));
      setTerminalSplit((current) => current && tab.terminalId && current.secondaryTerminalId === tab.terminalId ? { ...current, secondaryTerminalId: restarted.id } : current);
      return restarted;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Unable to restart terminal";
      setTerminalRestartError(message);
      setTerminalRestoreErrors((current) => ({ ...current, [tab.id]: message }));
      return null;
    } finally { terminalRestoreInFlightRef.current.delete(tab.id); setTerminalRestartingId((current) => current === tab.id ? null : current); }
  }, [updateTerminals]);

  const handleOpenCodexChat = useCallback((terminal: TerminalSession) => {
    const tabId = `codex-chat:${terminal.id}`;
    setWorkspaceTabs((current) => current.some((tab) => tab.id === tabId) ? current : [...current, { id: tabId, label: "Codex Chat", kind: "codex-chat", terminalId: terminal.id, sourceSessionId: terminal.sourceSessionId, cwd: terminal.cwd, model: terminal.model }]);
    setActiveWorkspaceTabId(tabId);
  }, []);

  const handleOpenCodexSessionChat = useCallback((target: { sessionId: string; sessionName: string; cwd: string; model?: string; reasoningEffort?: string; serviceTier?: string; approvalPolicy: "untrusted" | "on-request" | "never" }) => {
    const tabId = `codex-chat:${target.sessionId}`;
    setWorkspaceTabs((current) => current.some((tab) => tab.id === tabId)
      ? current.map((tab) => tab.id === tabId ? { ...tab, label: target.sessionName, sessionName: target.sessionName, cwd: target.cwd, model: target.model, reasoningEffort: target.reasoningEffort, serviceTier: target.serviceTier, approvalPolicy: target.approvalPolicy } : tab)
      : [...current, { id: tabId, label: target.sessionName, kind: "codex-chat", sourceSessionId: target.sessionId, cwd: target.cwd, model: target.model, reasoningEffort: target.reasoningEffort, serviceTier: target.serviceTier, approvalPolicy: target.approvalPolicy, sessionName: target.sessionName }]);
    setActiveWorkspaceTabId(tabId);
  }, []);

  const handleTerminalChanged = useCallback((terminal: TerminalSession) => {
    updateTerminals((current) => [...current.filter((item) => item.id !== terminal.id), terminal]);
    setWorkspaceTabs((current) => current.map((tab) => tab.terminalId === terminal.id && tab.kind === "terminal" ? { ...tab, label: terminal.title || tab.label, terminalPermissionMode: terminal.permissionMode, terminalLaunchMode: terminal.launchMode, terminalNoAltScreen: terminal.noAltScreen, terminalModel: terminal.model, terminalWebSearch: terminal.webSearch, terminalChatMode: terminal.chatMode, sourceSessionId: terminal.sourceSessionId, status: terminal.state === "running" ? "running" : "ended" } : tab));
  }, [updateTerminals]);
  const handleTerminalConnection = useCallback((terminalId: string, connection: TerminalConnectionState) => {
    const status: Tab["status"] = connection === "connected" ? "running" : connection === "offline" ? "offline" : connection === "disconnected" ? "failed" : "connecting";
    setWorkspaceTabs((current) => current.map((tab) => tab.kind === "terminal" && tab.terminalId === terminalId && tab.status !== status ? { ...tab, status } : tab));
  }, []);

  const handleCodexTabStatus = useCallback((tabId: string, status: "idle" | "running" | "approval") => {
    setWorkspaceTabs((current) => current.map((tab) => tab.id === tabId && tab.status !== status ? { ...tab, status } : tab));
  }, []);

  const handleCodexTabConfiguration = useCallback((tabId: string, configuration: { model?: string; reasoningEffort?: string; serviceTier?: string; approvalPolicy?: "untrusted" | "on-request" | "never" }) => {
    setWorkspaceTabs((current) => current.map((tab) => tab.id === tabId ? { ...tab, ...configuration } : tab));
  }, []);

  useEffect(() => {
    if (!activeCwd || workspaceTabsHydratedCwd !== activeCwd || !terminalsLoaded) return;
    const available = new Set(terminalList.map((terminal) => terminal.id));
    setWorkspaceTabs((current) => {
      let changed = false;
      const next = current.map((tab) => {
        if (tab.kind !== "terminal" || !tab.terminalId || available.has(tab.terminalId) || tab.status === "ended") return tab;
        changed = true;
        return { ...tab, status: "ended" as const };
      });
      return changed ? next : current;
    });
    if (terminalSplit) {
      const restoreTabs = getMissingSplitTerminalTabs(workspaceTabs, terminalSplit, available);
      const restoreKey = `${activeCwd}:${terminalSplit.primaryTabId}:${terminalSplit.secondaryTerminalId}`;
      if (restoreTabs.length > 0 && splitRestoreAttemptRef.current !== restoreKey) {
        splitRestoreAttemptRef.current = restoreKey;
        void Promise.all(restoreTabs.map((tab) => restartUnavailableTerminal(tab)));
      }
    }
  }, [activeCwd, restartUnavailableTerminal, terminalList, terminalSplit, terminalsLoaded, workspaceTabs, workspaceTabsHydratedCwd]);

  const handleOpenLinkedFile = useCallback((filePath: string) => {
    handleOpenFile(filePath, getFileName(filePath), selectedSession?.id ?? null);
  }, [handleOpenFile, selectedSession?.id]);

  const handleViewFullHistory = useCallback(() => {
    if (!selectedSession) return;
    window.open(
      `/api/sessions/${encodeURIComponent(selectedSession.id)}/export?inline=1`,
      "_blank",
      "noopener,noreferrer",
    );
  }, [selectedSession]);

  // Show chat area if a session is selected, or if we have a cwd to start a new session in
  const effectiveNewSessionCwd = newSessionCwd ?? (selectedSession === null && activeCwd ? activeCwd : null);
  const showChat = selectedSession !== null || effectiveNewSessionCwd !== null;
  // While restoring initial session from URL, don't show the placeholder
  const showPlaceholder = initialSessionRestored && !showChat;

  const activeFileTab = fileTabs.find((t) => t.id === activeFileTabId) ?? null;
  const runningTerminals = Object.values(terminals).filter((terminal) => terminal.state === "running");
  const runningTasks = runningTerminals.filter((terminal) => terminal.provider === "shell" && terminal.title?.startsWith("Task: "));
  const runningAgents = runningTerminals.filter((terminal) => terminal.provider !== "shell");
  const runningShells = runningTerminals.filter((terminal) => terminal.provider === "shell" && !terminal.title?.startsWith("Task: "));
  const activeCodexChats = workspaceTabs.filter((tab) => tab.kind === "codex-chat" && (tab.status === "running" || tab.status === "approval"));
  const approvalCount = activeCodexChats.filter((tab) => tab.status === "approval").length;
  const activityCount = runningTerminals.length + activeCodexChats.length;
  const showWorkspaceTabBar = workspaceTabs.length > 1;
  const activityControl = <div ref={activityPanelRef} style={{ position: "relative", alignSelf: "stretch", flexShrink: 0, marginLeft: "auto" }}>
    <button type="button" aria-label="Workspace activity" title="Workspace activity" aria-expanded={activityPanelOpen} onClick={() => setActivityPanelOpen((open) => !open)} style={{ display: "flex", alignItems: "center", gap: 5, height: "100%", padding: "0 10px", border: 0, borderLeft: "1px solid var(--border)", background: activityPanelOpen ? "var(--bg-selected)" : "transparent", color: approvalCount > 0 ? "#f59e0b" : activityCount > 0 ? "var(--accent)" : "var(--text-dim)", cursor: "pointer", font: "10.5px/1 inherit" }}>
      <Activity size={15} /><span>{activityCount}</span>{approvalCount > 0 && <span title={`${approvalCount} approval pending`} style={{ width: 6, height: 6, borderRadius: "50%", background: "#f59e0b" }} />}
    </button>
    {activityPanelOpen && <div role="dialog" aria-label="Workspace activity" style={{ position: "absolute", zIndex: 500, top: 40, right: 4, width: "min(330px, calc(100vw - 16px))", maxHeight: "min(480px, calc(100dvh - 100px))", overflowY: "auto", padding: 7, border: "1px solid var(--border)", borderRadius: 9, background: "var(--bg-panel)", boxShadow: "0 16px 44px rgb(0 0 0 / 38%)" }}>
      <div style={{ padding: "5px 7px 7px", color: "var(--text-dim)", fontSize: 10 }}>Workspace activity · {activityCount} active</div>
      {activityCount === 0 && <div style={{ padding: "14px 10px", color: "var(--text-dim)", fontSize: 11, textAlign: "center" }}>No tasks or agents are running</div>}
      {[...runningTasks, ...runningAgents, ...runningShells].map((terminal) => <button key={terminal.id} type="button" onClick={() => { handleTerminalCreated(terminal, terminal.title); setActivityPanelOpen(false); }} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", minHeight: 38, padding: "6px 8px", border: 0, borderRadius: 6, background: "transparent", color: "var(--text)", cursor: "pointer", textAlign: "left", font: "11px/1.3 inherit" }}><span style={{ width: 7, height: 7, borderRadius: "50%", background: "#22c55e", flexShrink: 0 }} /><span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{terminal.title || `${terminal.provider} terminal`}</span><small style={{ color: "var(--text-dim)" }}>{terminal.provider}</small></button>)}
      {activeCodexChats.map((tab) => <button key={tab.id} type="button" onClick={() => { setActiveWorkspaceTabId(tab.id); setActivityPanelOpen(false); }} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", minHeight: 38, padding: "6px 8px", border: 0, borderRadius: 6, background: "transparent", color: "var(--text)", cursor: "pointer", textAlign: "left", font: "11px/1.3 inherit" }}><span style={{ width: 7, height: 7, borderRadius: "50%", background: tab.status === "approval" ? "#f59e0b" : "var(--accent)", flexShrink: 0 }} /><span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tab.label}</span><small style={{ color: tab.status === "approval" ? "#f59e0b" : "var(--text-dim)" }}>{tab.status}</small></button>)}
    </div>}
  </div>;
  const activeCwdName = activeCwd ? getFileName(activeCwd) || activeCwd : null;
  const windowTitle = activeCwdName ? `${activeCwdName} - Pi Web` : "Pi Web";

  useEffect(() => {
    const syncWindowTitle = () => {
      if (document.title !== windowTitle) document.title = windowTitle;
    };

    syncWindowTitle();
    const observer = new MutationObserver(syncWindowTitle);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [windowTitle]);

  const sidebarContent = (
    <>
      <SessionSidebar
        selectedSessionId={selectedSession?.id ?? null}
        onSelectSession={handleSelectSession}
        onNewSession={handleNewSession}
        initialSessionId={initialSessionId}
        skipInitialProjectSelection={!projectWorkspacesHydrated || projectSelectionDismissed || initialNavigation.requestedCwd !== null || (!initialSessionId && activeProjectId !== null)}
        onInitialRestoreDone={handleInitialRestoreDone}
        refreshKey={refreshKey}
        onSessionDeleted={handleSessionDeleted}
        selectedCwd={selectedSession?.cwd ?? newSessionCwd ?? null}
        onCwdChange={handleCwdChange}
        onOpenFile={handleOpenFile}
        onExplorerPathRenamed={handleExplorerPathRenamed}
        onExplorerPathDeleted={handleExplorerPathDeleted}
        explorerRefreshKey={explorerRefreshKey}
        onExplorerRefresh={handleExplorerRefresh}
        onAtMention={handleAtMention}
        onAtMentions={handleAtMentions}
        onOpenGitReview={handleOpenGitReview}
        gitReviewOpen={rightPanelOpen && activeFileTabId === "git-review"}
        onNewAgent={setNewTerminalProvider}
        onOpenCodexSession={handleOpenCodexSessionChat}
        onOpenAgentTerminal={handleTerminalCreated}
        onAgentTerminalRemoved={handleAgentTerminalRemoved}
        onCodexSessionChanged={handleCodexSessionChanged}
        requestedModule={isMobile ? mobileSidebarModule : undefined}
        explorerRevealKey={isMobile ? mobileExplorerRevealKey : undefined}
        cwdResetKey={sidebarCwdResetKey}
      />
      <div style={{ padding: "8px", flexShrink: 0, display: "flex", justifyContent: "space-between", gap: 4 }}>
        {([
          {
            label: "Models",
            onClick: () => setModelsConfigOpen(true),
            disabled: false,
            icon: (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" />
                <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
                <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
                <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
                <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
              </svg>
            ),
          },
          {
            label: "Skills",
            onClick: () => setSkillsConfigOpen(true),
            disabled: !activeCwd && !selectedSession?.cwd && !newSessionCwd,
            icon: (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2L2 7l10 5 10-5-10-5z" />
                <path d="M2 17l10 5 10-5" />
                <path d="M2 12l10 5 10-5" />
              </svg>
            ),
          },
          {
            label: "Plugins",
            onClick: () => setPluginsConfigOpen(true),
            disabled: !activeCwd && !selectedSession?.cwd && !newSessionCwd,
            icon: (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 7V2" />
                <path d="M15 7V2" />
                <path d="M6 13V8a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v5a6 6 0 0 1-12 0Z" />
                <path d="M12 19v3" />
              </svg>
            ),
          },
        ] as { label: string; onClick: () => void; disabled: boolean; icon: React.ReactNode }[]).map(({ label, onClick, disabled, icon }) => (
          <button
            key={label}
            onClick={onClick}
            disabled={disabled}
            title={label}
            style={{
              flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              height: 32, padding: 0, background: "none", border: "none",
              borderRadius: 9, color: "var(--text-muted)", cursor: disabled ? "default" : "pointer",
              fontSize: 12, opacity: disabled ? 0.35 : 1,
              transition: "background 0.12s, color 0.12s",
            }}
            onMouseEnter={(e) => { if (!disabled) { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; } }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            {icon}
            {label}
          </button>
        ))}
      </div>
    </>
  );

  return (
    <>
    <style>{`
      @keyframes session-info-pop {
        0% {
          opacity: 0;
          transform: translateY(-24px);
          filter: blur(6px);
          box-shadow: 0 2px 8px rgba(0,0,0,0);
        }
        55% {
          opacity: 1;
          transform: translateY(0);
          filter: blur(0);
          background: color-mix(in srgb, var(--accent) 8%, var(--bg-panel));
          box-shadow: 0 18px 44px rgba(37,99,235,0.16);
        }
        100% {
          opacity: 1;
          transform: translateY(0);
          filter: blur(0);
          background: var(--bg-panel);
          box-shadow: 0 10px 28px rgba(0,0,0,0.10);
        }
      }
      @keyframes session-info-light-wash {
        0% {
          opacity: 0;
          transform: translateX(-110%) skewX(-16deg);
        }
        24% {
          opacity: 0.42;
        }
        100% {
          opacity: 0;
          transform: translateX(115%) skewX(-16deg);
        }
      }
      .session-info-popover {
        position: relative;
        overflow: hidden;
        transform-origin: top right;
        animation: session-info-pop 360ms ease-out both;
        will-change: transform, opacity, filter, background, box-shadow;
      }
      .session-info-popover::after {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        width: 44%;
        pointer-events: none;
        background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 24%, transparent), transparent);
        animation: session-info-light-wash 620ms ease-out both;
      }
      @media (prefers-reduced-motion: reduce) {
        .session-info-popover,
        .session-info-popover::after {
          animation: none;
        }
      }
      @media (max-width: 640px) {
        .sidebar-overlay-backdrop.sidebar-mobile-pending {
          opacity: 0 !important;
          pointer-events: none !important;
        }
        .sidebar-container.sidebar-mobile-pending.sidebar-open {
          transform: translateX(-100%);
          box-shadow: none;
        }
      }
    `}</style>
    <div
      className={isResizing ? "layout-resizing" : undefined}
      style={{
        display: "flex",
        height: "100dvh",
        overflow: "hidden",
        background: "var(--bg)",
        ...(sidebarWidth != null ? { ["--sidebar-w"]: `${sidebarWidth}px` } : {}),
        ...(rightPanelWidth != null ? { ["--right-panel-w"]: `${rightPanelWidth}px` } : {}),
      } as React.CSSProperties}
    >
      {/* Mobile overlay backdrop */}
      <div
        className={`sidebar-overlay-backdrop${mobileSidebarReady ? "" : " sidebar-mobile-pending"}`}
        onClick={() => setSidebarOpen(false)}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 199,
          background: "rgba(0,0,0,0.4)",
          opacity: sidebarOpen ? 1 : 0,
          pointerEvents: sidebarOpen ? "auto" : "none",
          transition: "opacity 0.25s ease",
        }}
      />

      <ProjectRail
        workspaces={projectWorkspaces}
        activeId={activeProjectId}
        onSelect={(workspace) => void activateProjectWorkspace(workspace)}
        onAdd={(path) => void handleAddProjectWorkspace(path)}
        onClose={handleCloseProjectWorkspace}
        onRestore={(workspace) => void activateProjectWorkspace(workspace)}
        onReorder={handleReorderProjectWorkspaces}
        onRename={handleRenameProjectWorkspace}
        onTogglePinned={handleTogglePinnedProjectWorkspace}
        onOpenTerminal={(workspace) => {
          void activateProjectWorkspace(workspace);
          setNewTerminalProvider("shell");
        }}
      />

      {/* Left sidebar */}
      <div
        className={`sidebar-container${sidebarOpen ? " sidebar-open" : " sidebar-closed"}${mobileSidebarReady ? "" : " sidebar-mobile-pending"}`}
        style={{
          background: "var(--bg-panel)",
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          zIndex: 200,
        }}
      >
        {sidebarContent}
      </div>

      {/* Sidebar resize handle */}
      {!isMobile && sidebarOpen && (
        <div
          className="resize-handle resize-handle--panel"
          onMouseDown={beginSidebarResize}
          role="separator"
          aria-orientation="vertical"
          title="Drag to resize"
        />
      )}

      {/* Center workspace: Pi plus external-agent tabs. */}
      <div className="center-workspace" style={{ flex: chatHidden ? "0 0 0" : 1, display: chatHidden ? "none" : "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        <div style={{ position: "relative", display: showWorkspaceTabBar ? "flex" : "none", alignItems: "center", height: 36, flexShrink: 0, borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" }}>
          <button
            onClick={handleSidebarToggle}
            title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
            aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 36, height: 36, padding: 0,
              background: "none", border: "none", borderRight: "1px solid var(--border)",
              color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            {sidebarOpen ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            )}
          </button>
          <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
            <TabBar tabs={workspaceTabs} activeTabId={activeWorkspaceTabId} onSelectTab={handleSelectWorkspaceTab} onCloseTab={handleCloseWorkspaceTab} />
          </div>
          {showWorkspaceTabBar && activityControl}
        </div>
        {/* Pi-specific controls are only relevant while the Pi workspace is active. */}
        <div ref={topBarRef} style={{ display: activeWorkspaceTabId === "pi" ? "flex" : "none", alignItems: "center", flexShrink: 0, borderBottom: "1px solid var(--border)", height: 36, background: "var(--bg-panel)" }}>
          {!showWorkspaceTabBar && <button
            onClick={handleSidebarToggle}
            title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
            aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
            style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, padding: 0, background: "none", border: "none", borderRight: "1px solid var(--border)", color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, transition: "color 0.12s" }}
            onMouseEnter={(event) => { event.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(event) => { event.currentTarget.style.color = "var(--text-muted)"; }}
          >
            {sidebarOpen ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" /></svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></svg>
            )}
          </button>}
          <button
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              toggleTheme({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
            }}
            title={isDark ? "Switch to light mode" : "Switch to dark mode"}
            aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
            aria-pressed={isDark}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 36, height: 36, padding: 0,
              background: "none", border: "none", borderRight: "1px solid var(--border)",
              color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            {isDark ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="5" />
                <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>
          {showChat && (
            <div style={{ display: "flex", alignItems: "stretch", height: "100%" }}>
              <button
                onClick={handleViewFullHistory}
                disabled={!selectedSession}
                title={selectedSession ? "View full history" : "Full history is available after the session is saved"}
                aria-label="View full history"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  height: "100%",
                  padding: "0 12px",
                  background: "none",
                  border: "none",
                  borderTop: "2px solid transparent",
                  borderRight: "1px solid var(--border)",
                  color: selectedSession ? "var(--text-muted)" : "var(--text-dim)",
                  cursor: selectedSession ? "pointer" : "not-allowed",
                  opacity: selectedSession ? 1 : 0.45,
                  flexShrink: 0,
                  fontSize: 11,
                  whiteSpace: "nowrap",
                  transition: "color 0.1s, background 0.1s, opacity 0.1s",
                }}
                onMouseEnter={(e) => {
                  if (!selectedSession) return;
                  e.currentTarget.style.color = "var(--text)";
                  e.currentTarget.style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = selectedSession ? "var(--text-muted)" : "var(--text-dim)";
                  e.currentTarget.style.background = "none";
                }}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{
                    color: selectedSession ? "var(--text-muted)" : "var(--text-dim)",
                    flexShrink: 0,
                  }}
                >
                  <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                  <path d="M3 3v5h5" />
                  <path d="M12 7v5l3 2" />
                </svg>
                {!isMobile && <span>Full history</span>}
              </button>
              {(() => {
                const hasMessages = Boolean(
                  selectedSession
                  && (sessionStats?.userMessages ?? selectedSession.messageCount) > 0,
                );
                const disabled = !selectedSession || !hasMessages || autoNameStatus.kind === "naming";
                const isSuccess = autoNameStatus.kind === "success";
                const isError = autoNameStatus.kind === "error";
                const label = autoNameStatus.kind === "naming"
                  ? "Generating..."
                  : isSuccess
                    ? "Title updated"
                    : isError
                      ? "Generation failed"
                      : "Generate title";
                const title = !selectedSession
                  ? "Title generation is available after the session is saved"
                  : !hasMessages
                    ? "Send a message before naming this session"
                    : isError
                      ? autoNameStatus.message
                      : "Generate a session title";

                return (
                  <button
                    type="button"
                    onClick={() => void handleAutoName()}
                    disabled={disabled}
                    title={title}
                    aria-label={label}
                    style={{
                      display: "flex", alignItems: "center", gap: 6,
                      height: "100%", padding: "0 12px",
                      background: "none", border: "none",
                      borderTop: "2px solid transparent",
                      borderRight: "1px solid var(--border)",
                      color: isError ? "#dc2626" : isSuccess ? "var(--accent)" : disabled ? "var(--text-dim)" : "var(--text-muted)",
                      cursor: disabled ? "not-allowed" : "pointer",
                      opacity: disabled && autoNameStatus.kind !== "naming" ? 0.45 : 1,
                      flexShrink: 0, fontSize: 11, whiteSpace: "nowrap",
                      transition: "color 0.1s, background 0.1s, opacity 0.1s",
                    }}
                    onMouseEnter={(e) => {
                      if (disabled) return;
                      e.currentTarget.style.color = isError ? "#dc2626" : "var(--text)";
                      e.currentTarget.style.background = "var(--bg-hover)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = isError ? "#dc2626" : isSuccess ? "var(--accent)" : disabled ? "var(--text-dim)" : "var(--text-muted)";
                      e.currentTarget.style.background = "none";
                    }}
                  >
                    {autoNameStatus.kind === "naming" ? (
                      <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
                        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                    ) : isSuccess ? (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    ) : (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="m15 4 5 5L7 22l-5-5Z" />
                        <path d="m14 5 5 5" />
                        <path d="M6 4V2M5 3H3M19 19v3M17.5 20.5h3" />
                      </svg>
                    )}
                    {!isMobile && <span>{label}</span>}
                  </button>
                );
              })()}
              <BranchNavigator
                tree={branchTree}
                activeLeafId={branchActiveLeafId}
                onLeafChange={handleBranchLeafChange}
                inline
                compact={isMobile}
                containerRef={topBarRef}
                open={activeTopPanel === "branches"}
                onToggle={() => toggleTopPanel("branches")}
                hasSession
              />
              <button
                ref={systemBtnRef}
                onClick={() => toggleTopPanel("system")}
                title="System prompt"
                aria-label="System prompt"
                aria-pressed={activeTopPanel === "system"}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  height: "100%", padding: "0 12px",
                  background: activeTopPanel === "system" ? "var(--bg-selected)" : "none",
                  border: "none",
                  borderTop: activeTopPanel === "system" ? "2px solid var(--accent)" : "2px solid transparent",
                  borderRight: "1px solid var(--border)",
                  cursor: "pointer",
                  color: activeTopPanel === "system" ? "var(--text)" : "var(--text-muted)",
                  fontSize: 11, whiteSpace: "nowrap", transition: "color 0.1s, background 0.1s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = activeTopPanel === "system" ? "var(--text)" : "var(--text-muted)"; }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: systemPrompt ? "var(--accent)" : "var(--text-dim)", flexShrink: 0 }}>
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="8" y1="13" x2="16" y2="13" />
                  <line x1="8" y1="17" x2="13" y2="17" />
                </svg>
                {!isMobile && <span>System</span>}
              </button>
            </div>
          )}
          {/* Session stats — right-aligned in top bar */}
          {showChat && (sessionStats || contextUsage) && (() => {
            const t = sessionStats?.tokens;
            const c = sessionStats?.cost ?? 0;
            const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
            const costStr = c > 0 ? (c >= 0.01 ? `$${c.toFixed(2)}` : `<$0.01`) : null;

            let ctxColor = "var(--text-muted)";
            let ctxStr: string | null = null;
            if (contextUsage?.contextWindow) {
              const pct = contextUsage.percent;
              if (pct !== null && pct > 90) ctxColor = "#ef4444";
              else if (pct !== null && pct > 70) ctxColor = "rgba(234,179,8,0.95)";
              ctxStr = pct !== null ? `${pct.toFixed(0)}% / ${fmt(contextUsage.contextWindow)}` : `? / ${fmt(contextUsage.contextWindow)}`;
            }

            const tooltipParts: string[] = [];
            if (t) {
              tooltipParts.push(`in: ${t.input.toLocaleString()}`);
              tooltipParts.push(`out: ${t.output.toLocaleString()}`);
              tooltipParts.push(`cache read: ${t.cacheRead.toLocaleString()}`);
              tooltipParts.push(`cache write: ${t.cacheWrite.toLocaleString()}`);
              if (c > 0) tooltipParts.push(`cost: $${c.toFixed(4)}`);
            }
            if (contextUsage?.contextWindow) {
              const pct = contextUsage.percent;
              tooltipParts.push(`context: ${pct !== null ? pct.toFixed(1) + "%" : "unknown"} of ${contextUsage.contextWindow.toLocaleString()} tokens`);
            }
            const tooltip = tooltipParts.join("  |  ");

            return (
              <button
                type="button"
                onClick={() => toggleTopPanel("session")}
                title={tooltip || "Session info"}
                aria-label="Session info"
                aria-pressed={activeTopPanel === "session"}
                style={{
                  marginLeft: "auto",
                  display: "flex", alignItems: "center", gap: 10,
                  paddingLeft: 12,
                  paddingRight: rightPanelOpen ? 12 : 48,
                  height: "100%",
                  background: activeTopPanel === "session" ? "var(--bg-selected)" : "none",
                  border: "none",
                  borderTop: activeTopPanel === "session" ? "2px solid var(--accent)" : "2px solid transparent",
                  fontSize: 11, color: "var(--text-muted)",
                  whiteSpace: "nowrap", cursor: "pointer",
                  fontVariantNumeric: "tabular-nums",
                  transition: "color 0.1s, background 0.1s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = activeTopPanel === "session" ? "var(--text)" : "var(--text-muted)"; }}
              >
                {isMobile && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
                  </svg>
                )}
                {!isMobile && t && t.input > 0 && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="8.5" x2="5" y2="1.5" /><polyline points="2 4 5 1.5 8 4" />
                    </svg>
                    {fmt(t.input)}
                  </span>
                )}
                {!isMobile && t && t.output > 0 && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
                    </svg>
                    {fmt(t.output)}
                  </span>
                )}
                {!isMobile && t && t.cacheRead > 0 && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M8.5 5a3.5 3.5 0 1 1-1-2.45" /><polyline points="6.5 1.5 8.5 2.5 7.5 4.5" />
                    </svg>
                    {fmt(t.cacheRead)}
                  </span>
                )}
                {!isMobile && costStr && (
                  <span style={{ display: "flex", alignItems: "center", color: "var(--text)", fontWeight: 500 }}>
                    {costStr}
                  </span>
                )}
                {ctxStr && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4, color: ctxColor }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 9 L1 5 Q1 1 5 1 Q9 1 9 5 L9 9" /><line x1="1" y1="9" x2="9" y2="9" />
                    </svg>
                    {ctxStr}
                  </span>
                )}
              </button>
            );
          })()}
          {/* Top panel dropdown — shared, only one active at a time */}
          {activeTopPanel && topPanelPos && (
            <div style={{
              position: "fixed",
              top: topPanelPos.top,
              left: topPanelPos.left,
              width: topPanelPos.width,
              maxHeight: `calc(100dvh - ${topPanelPos.top}px)`,
              overflowY: "auto",
              zIndex: 500,
            }}>
              {activeTopPanel === "system" && (
                <div style={{
                  background: "var(--bg-panel)",
                  borderBottom: "1px solid var(--border)",
                }}>
                  {systemPrompt ? (
                    <div style={{
                      maxHeight: "min(600px, 75vh)",
                      overflowY: "auto",
                      padding: "12px 16px",
                      color: "var(--text-muted)",
                      fontSize: 12,
                      lineHeight: 1.6,
                      whiteSpace: "pre-wrap",
                      fontFamily: "var(--font-mono)",
                    }}>
                      {systemPrompt}
                    </div>
                  ) : systemPrompt === "" ? (
                    <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                      System prompt is empty (tools are disabled)
                    </div>
                  ) : (
                    <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                      Send a message to load the system prompt
                    </div>
                  )}
                </div>
              )}
              {activeTopPanel === "session" && (
                <div className="session-info-popover" style={{
                  background: "var(--bg-panel)",
                  borderBottom: "1px solid var(--border)",
                  boxShadow: "0 10px 28px rgba(0,0,0,0.10)",
                  padding: "12px 16px",
                }}>
                  {sessionStats ? (() => {
                    const sessionRows = [
                      ...(sessionStats.sessionName ? [{ label: "Name", value: sessionStats.sessionName, copyField: null }] : []),
                      { label: "File", value: sessionStats.sessionFile ?? "In-memory", copyField: "file" as const },
                      { label: "ID", value: sessionStats.sessionId, copyField: "id" as const },
                    ];
                    const messageRows = [
                      ["User", sessionStats.userMessages.toLocaleString()],
                      ["Assistant", sessionStats.assistantMessages.toLocaleString()],
                      ["Tool Calls", sessionStats.toolCalls.toLocaleString()],
                      ["Tool Results", sessionStats.toolResults.toLocaleString()],
                      ["Total", sessionStats.totalMessages.toLocaleString()],
                    ];
                    const tokenRows = [
                      ["Input", sessionStats.tokens.input.toLocaleString()],
                      ["Output", sessionStats.tokens.output.toLocaleString()],
                      ...(sessionStats.tokens.cacheRead > 0 ? [["Cache Read", sessionStats.tokens.cacheRead.toLocaleString()]] : []),
                      ...(sessionStats.tokens.cacheWrite > 0 ? [["Cache Write", sessionStats.tokens.cacheWrite.toLocaleString()]] : []),
                      ["Total", sessionStats.tokens.total.toLocaleString()],
                    ];
                    const ctx = contextUsage ?? sessionStats.contextUsage;
                    const formatCompact = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
                    const extraTokenRows = [
                      ...(sessionStats.cost > 0 ? [["Cost", `$${sessionStats.cost.toFixed(4)}`]] : []),
                      ...(ctx?.contextWindow ? [["Context", `${ctx.percent !== null ? `${ctx.percent.toFixed(1)}%` : "?"} / ${formatCompact(ctx.contextWindow)}`]] : []),
                    ];
                    const section = (
                      title: string,
                      sectionRows: string[][],
                      valueAlign: "left" | "right" = "left",
                      compact = false,
                    ) => (
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{title}</div>
                          <div style={{
                            display: "grid",
                            gridTemplateColumns: compact ? "max-content max-content" : "auto minmax(0, 1fr)",
                            columnGap: compact ? 14 : 12,
                            rowGap: 4,
                            justifyContent: compact ? "start" : undefined,
                          }}>
                            {sectionRows.map(([label, value]) => (
                              <div key={`${title}:${label}`} style={{ display: "contents" }}>
                                <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{label}</div>
                                <div style={{
                                  color: "var(--text-muted)",
                                  minWidth: 0,
                                  overflowWrap: compact ? "normal" : "anywhere",
                                  textAlign: valueAlign,
                                  whiteSpace: valueAlign === "right" ? "nowrap" : "normal",
                                }}>{value}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    const copyButton = (field: SessionCopyField, value: string) => {
                      const copied = copiedSessionField === field;
                      return (
                        <button
                          type="button"
                          title={copied ? "Copied" : `Copy ${field === "file" ? "file path" : "session ID"}`}
                          onClick={() => handleCopySessionField(field, value)}
                          style={{
                            alignSelf: "start",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: 22,
                            height: 22,
                            marginTop: -2,
                            color: copied ? "var(--accent)" : "var(--text-dim)",
                            background: "transparent",
                            border: "1px solid var(--border)",
                            borderRadius: 4,
                            cursor: "pointer",
                            flex: "0 0 auto",
                            transition: "color 0.12s, border-color 0.12s, background 0.12s",
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.color = "var(--accent)";
                            e.currentTarget.style.borderColor = "var(--accent)";
                            e.currentTarget.style.background = "var(--bg-hover)";
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.color = copied ? "var(--accent)" : "var(--text-dim)";
                            e.currentTarget.style.borderColor = "var(--border)";
                            e.currentTarget.style.background = "transparent";
                          }}
                        >
                          {copied ? (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          ) : (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                            </svg>
                          )}
                        </button>
                      );
                    };
                    const sessionInfoSection = (
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>Session Info</div>
                        <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto", columnGap: 12, rowGap: 8, alignItems: "start" }}>
                          {sessionRows.map((row) => (
                            <div key={`session-info:${row.label}`} style={{ display: "contents" }}>
                              <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{row.label}</div>
                              <div style={{
                                color: "var(--text-muted)",
                                minWidth: 0,
                                overflowWrap: "anywhere",
                                wordBreak: "break-word",
                                whiteSpace: "normal",
                              }}>{row.value}</div>
                              <div>{row.copyField ? copyButton(row.copyField, row.value) : null}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );

                    return (
                      <div style={{
                        display: "grid",
                        gridTemplateColumns: isMobile
                          ? "1fr"
                          : "minmax(360px, 1.7fr) minmax(140px, 0.55fr) minmax(190px, 0.75fr)",
                        gap: isMobile ? 16 : 24,
                        fontSize: 12,
                        lineHeight: 1.5,
                        fontFamily: "var(--font-mono)",
                      }}>
                        {sessionInfoSection}
                        {section("Messages", messageRows)}
                        {section("Tokens", [...tokenRows, ...extraTokenRows], "right", true)}
                      </div>
                    );
                  })() : (
                    <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                      Send a message or run /session to load session info
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {!showWorkspaceTabBar && activityControl}

        </div>

        {/* Chat content */}
        <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          <div style={{ position: "absolute", inset: 0, display: activeWorkspaceTabId === "pi" ? "block" : "none" }}>
          {showChat ? (
            <ChatWindow
              key={sessionKey}
              session={selectedSession}
              newSessionCwd={effectiveNewSessionCwd}
              onAgentEnd={handleAgentEnd}
              onSessionCreated={handleSessionCreated}
              onSessionForked={handleSessionForked}
              modelsRefreshKey={modelsRefreshKey}
              chatInputRef={chatInputRef}
              onBranchDataChange={handleBranchDataChange}
              onSystemPromptChange={handleSystemPromptChange}
              onSessionStatsChange={handleSessionStatsChange}
              onSessionStatsPanelOpen={openSessionStatsPanel}
              onContextUsageChange={handleContextUsageChange}
              onOpenFile={handleOpenLinkedFile}
            />
          ) : initialCwdStatus === "validating" ? (
            <div
              role="status"
              style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
            >
              <div style={{ fontSize: 14, color: "var(--text)" }}>Opening workspace...</div>
              <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                {initialNavigation.requestedCwd}
              </div>
            </div>
          ) : initialCwdStatus === "error" ? (
            <div
              role="alert"
              style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
            >
              <div style={{ fontSize: 14, color: "#dc2626" }}>Unable to open workspace</div>
              <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                {initialNavigation.requestedCwd}
              </div>
              <div style={{ maxWidth: 720, fontSize: 12 }}>{initialCwdError}</div>
            </div>
          ) : showPlaceholder ? (
            activeCwd ? (
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 15 }}>
                Select a session from the sidebar
              </div>
            ) : (
              <div style={{ position: "absolute", top: 12, left: 12, display: "flex", alignItems: "flex-start", gap: 8, userSelect: "none", pointerEvents: "none" }}>
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7, flexShrink: 0 }}>
                  <line x1="20" y1="12" x2="4" y2="12" /><polyline points="10 6 4 12 10 18" />
                </svg>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>Get Started</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.8 }}>
                    <span style={{ color: "var(--text-dim)", marginRight: 6 }}>1.</span>Select a project directory from the sidebar<br />
                    <span style={{ color: "var(--text-dim)", marginRight: 6 }}>2.</span>Add models via the <strong style={{ color: "var(--text)" }}>Models</strong> button at the bottom
                  </div>
                </div>
              </div>
            )
          ) : null}
          </div>
          {workspaceTabs.filter((tab) => (tab.kind === "terminal" || tab.kind === "codex-chat") && mountedWorkspaceTabIds.has(tab.id) && (!terminalSplit || tab.id !== `terminal:${terminalSplit.secondaryTerminalId}`)).map((tab) => {
            const terminal = tab.terminalId ? terminals[tab.terminalId] ?? null : null;
            const split = terminalSplit?.primaryTabId === tab.id ? terminalSplit : null;
            const secondaryTerminal = split ? terminals[split.secondaryTerminalId] ?? null : null;
            const splitDirection = isMobile ? "vertical" : split?.direction;
            const splitCandidates = terminal ? Object.values(terminals).filter((candidate) => candidate.id !== terminal.id && candidate.state === "running") : [];
            const primaryPanel = terminal ? <AgentTerminalPanel terminal={terminal} splitCandidates={splitCandidates} splitActive={Boolean(split)} activePane={!split || activeTerminalPaneId !== split.secondaryTerminalId} onActivatePane={() => setActiveTerminalPaneId(terminal.id)} onConnectionChange={(connection) => handleTerminalConnection(terminal.id, connection)} onSplit={(secondaryTerminalId, direction) => { setActiveTerminalPaneId(terminal.id); setTerminalSplit({ primaryTabId: tab.id, secondaryTerminalId, direction, ratio: 50, reversed: false }); }} onUnsplit={() => setTerminalSplit(null)} onSwapSplit={() => setTerminalSplit((current) => current ? { ...current, reversed: !current.reversed, ratio: 100 - current.ratio } : null)} onMaximizePane={() => setTerminalSplit(null)} onClosePane={() => { if (secondaryTab) setActiveWorkspaceTabId(secondaryTab.id); setTerminalSplit(null); }} onRestart={() => void restartUnavailableTerminal(tab)} onTerminalChange={handleTerminalChanged} onTerminalStarted={handleTerminalCreated} onOpenCodexChat={handleOpenCodexChat} /> : null;
            const secondaryTab = split ? workspaceTabs.find((item) => item.kind === "terminal" && item.terminalId === split.secondaryTerminalId) ?? null : null;
            const secondaryPanel = secondaryTerminal ? <AgentTerminalPanel terminal={secondaryTerminal} splitActive activePane={activeTerminalPaneId === secondaryTerminal.id} onActivatePane={() => setActiveTerminalPaneId(secondaryTerminal.id)} onConnectionChange={(connection) => handleTerminalConnection(secondaryTerminal.id, connection)} onUnsplit={() => setTerminalSplit(null)} onSwapSplit={() => setTerminalSplit((current) => current ? { ...current, reversed: !current.reversed, ratio: 100 - current.ratio } : null)} onMaximizePane={() => { if (secondaryTab) setActiveWorkspaceTabId(secondaryTab.id); setTerminalSplit(null); }} onClosePane={() => setTerminalSplit(null)} onRestart={() => secondaryTab && void restartUnavailableTerminal(secondaryTab)} onTerminalChange={handleTerminalChanged} onTerminalStarted={handleTerminalCreated} onOpenCodexChat={handleOpenCodexChat} /> : secondaryTab ? <div style={{ height: "100%", display: "grid", placeItems: "center", padding: 18, background: "var(--bg)", color: "var(--text-dim)", fontSize: 12 }}><div style={{ display: "grid", justifyItems: "center", gap: 8, textAlign: "center" }}><strong style={{ color: "var(--text)" }}>Split terminal unavailable</strong><span>{terminalRestoreErrors[secondaryTab.id] || "Restoring this pane after the server restart…"}</span><div style={{ display: "flex", gap: 7 }}><button type="button" disabled={terminalRestartingId === secondaryTab.id} onClick={() => void restartUnavailableTerminal(secondaryTab)} style={terminalRecoveryButtonStyle}>{terminalRestartingId === secondaryTab.id ? "Restoring…" : "Retry"}</button><button type="button" onClick={() => setTerminalSplit(null)} style={terminalRecoveryButtonStyle}>Remove pane</button></div></div></div> : null;
            return <div key={tab.id} style={{ position: "absolute", inset: 0, display: activeWorkspaceTabId === tab.id ? "block" : "none" }}>
              {tab.kind === "codex-chat" && (terminal || tab.sourceSessionId) ? (
                <CodexChatPanel terminal={terminal ? { ...terminal, model: tab.model ?? terminal.model, reasoningEffort: tab.reasoningEffort, serviceTier: tab.serviceTier, approvalPolicy: tab.approvalPolicy, sessionName: tab.sessionName } : { cwd: tab.cwd ?? activeCwd ?? "", model: tab.model, sourceSessionId: tab.sourceSessionId, reasoningEffort: tab.reasoningEffort, serviceTier: tab.serviceTier, approvalPolicy: tab.approvalPolicy, sessionName: tab.sessionName }} workspaceTabId={tab.id} onStatusChange={handleCodexTabStatus} onConfigurationChange={handleCodexTabConfiguration} onOpenFile={(filePath) => { const absolutePath = filePath.startsWith("/") ? filePath : joinFilePath(tab.cwd ?? activeCwd ?? "", filePath); handleOpenFile(absolutePath, getFileName(absolutePath), tab.sourceSessionId); }} />
              ) : terminal ? (split && secondaryTab ? <div className={`terminal-split terminal-split--${splitDirection}`} style={splitDirection === "horizontal" ? { gridTemplateColumns: `${split.ratio}fr 5px ${100 - split.ratio}fr` } : { gridTemplateRows: `${split.ratio}fr 5px ${100 - split.ratio}fr` }}>{split.reversed ? secondaryPanel : primaryPanel}<div className="terminal-split-divider" role="separator" aria-orientation={splitDirection === "horizontal" ? "vertical" : "horizontal"} onPointerDown={beginTerminalSplitResize} />{split.reversed ? primaryPanel : secondaryPanel}</div> : primaryPanel
              ) : (
                <div style={{ height: "100%", display: "grid", placeItems: "center", padding: 24, color: "var(--text-dim)", fontSize: 12 }}><div style={{ display: "grid", justifyItems: "center", gap: 10, textAlign: "center" }}><strong style={{ color: "var(--text)", fontSize: 14 }}>Terminal process is unavailable</strong><span>The server restarted or this terminal process ended outside Pi Web.</span>{tab.terminalProvider && <button type="button" disabled={terminalRestartingId === tab.id} onClick={() => void restartUnavailableTerminal(tab)} style={{ padding: "7px 11px", border: "1px solid var(--accent)", borderRadius: 6, background: "var(--accent)", color: "white" }}>{terminalRestartingId === tab.id ? "Restarting…" : "Restart terminal"}</button>}{terminalRestartError && activeWorkspaceTabId === tab.id && <span style={{ color: "#f87171" }}>{terminalRestartError}</span>}</div></div>
              )}
            </div>;
          })}
        </div>
      </div>

      {/* Right panel resize handle */}
      {!isMobile && rightPanelOpen && !rightPanelFullscreen && (
        <div
          className="resize-handle resize-handle--panel"
          onMouseDown={chatHidden ? restoreChatFromResize : beginRightPanelResize}
          role="separator"
          aria-orientation="vertical"
          title={chatHidden ? "Drag to restore workspace and resize the right panel" : "Drag to resize the right panel"}
        />
      )}

      {/* Right panel: file viewer — always mounted, width animated via CSS */}
      <div
        className={`right-panel-container${rightPanelOpen ? " right-panel-open" : " right-panel-closed"}${chatHidden ? " right-panel-full" : ""}${rightPanelFullscreen ? " right-panel-fullscreen" : ""}`}
        style={{
          display: "flex",
          flexDirection: "column",
          borderLeft: "1px solid var(--border)",
          background: "var(--bg)",
          // The chat's former flex slot becomes the right panel, including its
          // header, so there is no blank area between this panel and the fixed
          // right-edge toggle.
          ...(chatHidden ? { flex: "1 1 0%", width: "auto", minWidth: 0, alignSelf: "stretch", height: "100%" } : {}),
        }}
      >
        {/* Right panel tab bar */}
        <div style={{ display: "flex", alignItems: "center", flexShrink: 0, background: "var(--bg-panel)", borderBottom: "1px solid var(--border)", height: 36, ...(chatHidden ? { width: "auto", minWidth: 0 } : {}) }}>
          {isMobile && (
            <button
              type="button"
              onClick={() => setRightPanelOpen(false)}
              title="Back to workspace"
              aria-label="Back to workspace"
              style={{ width: 40, height: 36, padding: 0, border: "none", borderRight: "1px solid var(--border)", background: "transparent", color: "var(--text-muted)", cursor: "pointer", display: "grid", placeItems: "center", flexShrink: 0 }}
            >
              <ArrowLeft size={17} />
            </button>
          )}
          {chatHidden && (
            <button
              type="button"
              onClick={handleSidebarToggle}
              title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
              aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
              style={{ width: 36, height: 36, padding: 0, border: "none", borderRight: "1px solid var(--border)", background: "transparent", color: "var(--text-muted)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" />
              </svg>
            </button>
          )}
          <div style={{ flex: 1, overflow: "hidden" }}>
            <TabBar
              tabs={fileTabs}
              activeTabId={activeFileTabId ?? ""}
              onSelectTab={setActiveFileTabId}
              onCloseTab={handleCloseFileTab}
            />
          </div>
          <div ref={rightPanelMenuRef} style={{ position: "relative", display: "flex", flexShrink: 0 }}>
            <button type="button" onClick={() => setRightPanelFullscreen((value) => !value)} title={rightPanelFullscreen ? "Exit fullscreen" : "Fullscreen"} aria-label={rightPanelFullscreen ? "Exit fullscreen" : "Fullscreen"} aria-pressed={rightPanelFullscreen} style={rightPanelHeaderButtonStyle}>{rightPanelFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
            <button type="button" onClick={() => setRightPanelMenuOpen((value) => !value)} title="Open workspace tool" aria-label="Open workspace tool" aria-expanded={rightPanelMenuOpen} style={rightPanelHeaderButtonStyle}><Plus size={17} /></button>
            {rightPanelMenuOpen && <div role="menu" aria-label="Workspace tools" style={rightPanelToolMenuStyle}>
              <button type="button" role="menuitem" disabled={!activeCwd} onClick={() => { setRightPanelMenuOpen(false); openGitReview(); }} style={rightPanelToolItemStyle}><GitBranch size={15} />Git Review</button>
              <button type="button" role="menuitem" disabled={!activeCwd} onClick={() => { setRightPanelMenuOpen(false); setRightPanelOpen(false); setSidebarOpen(true); if (isMobile) setMobileSidebarModule("explorer"); }} style={rightPanelToolItemStyle}><Files size={15} />Workspace Files</button>
              {(["shell", "codex", "claude"] as TerminalProvider[]).map((provider) => <button key={provider} type="button" role="menuitem" disabled={!activeCwd} onClick={() => { setRightPanelMenuOpen(false); setNewTerminalProvider(provider); }} style={rightPanelToolItemStyle}><TerminalSquare size={15} />{provider === "shell" ? "Terminal" : provider === "codex" ? "Codex" : "Claude"}</button>)}
            </div>}
          </div>
          {!isMobile && rightPanelOpen && (
            <button
              type="button"
              onClick={() => setChatCollapsed((v) => !v)}
              title={chatHidden ? "Show workspace" : "Hide workspace (expand panel)"}
              aria-label={chatHidden ? "Show workspace" : "Hide workspace"}
              aria-pressed={chatHidden}
              style={{ width: 36, height: 36, padding: 0, border: "none", borderLeft: "1px solid var(--border)", background: "transparent", color: "var(--text-muted)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
            >
              {chatHidden ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="13 17 18 12 13 7" /><polyline points="6 17 11 12 6 7" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="11 17 6 12 11 7" /><polyline points="18 17 13 12 18 7" />
                </svg>
              )}
            </button>
          )}
          <button
            type="button"
            onClick={handleOpenGitReview}
            disabled={!activeCwd}
            title={!activeCwd ? "Select a workspace to review Git changes" : (rightPanelOpen && activeFileTabId === "git-review" ? "Close Git Review" : "Open Git Review")}
            aria-label={rightPanelOpen && activeFileTabId === "git-review" ? "Close Git Review" : "Open Git Review"}
            aria-pressed={rightPanelOpen && activeFileTabId === "git-review"}
            style={{ width: 36, height: 36, padding: 0, border: "none", borderLeft: "1px solid var(--border)", background: "transparent", color: activeCwd ? "var(--text-muted)" : "var(--text-dim)", cursor: activeCwd ? "pointer" : "not-allowed", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="6" cy="6" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="12" cy="18" r="2" />
              <path d="M8 6h8M6 8v4a6 6 0 0 0 6 6M18 8v4a6 6 0 0 1-6 6" />
            </svg>
          </button>
        </div>

        {/* File content */}
        <div style={{ flex: 1, overflow: "hidden", ...(chatHidden ? { width: "auto", minWidth: 0 } : {}) }}>
          {activeFileTab?.kind === "file" && activeFileTab.filePath ? (
            <FileViewer
              filePath={activeFileTab.filePath}
              cwd={activeCwd ?? undefined}
              sourceSessionId={activeFileTab.sourceSessionId}
              gitRefreshKey={explorerRefreshKey}
              onMentionLines={rightPanelOpen ? handleFileLineMention : undefined}
              onOpenFile={(filePath) => handleOpenFile(
                filePath,
                getFileName(filePath),
                activeFileTab.sourceSessionId,
              )}
            />
          ) : activeFileTab?.kind === "git" ? (
            <GitReviewPanel cwd={activeCwd} refreshKey={explorerRefreshKey} onRepoChanged={handleExplorerRefresh} />
          ) : (
            <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>
              No file open
            </div>
          )}
        </div>
      </div>
    </div>
    {isMobile && !rightPanelFullscreen && <nav className="mobile-main-nav" aria-label="Mobile navigation">
      <button type="button" aria-pressed={!sidebarOpen && !rightPanelOpen} onClick={() => { setSidebarOpen(false); setRightPanelOpen(false); }}><PanelsTopLeft size={18} /><small>Workspace</small></button>
      <button type="button" aria-pressed={sidebarOpen && mobileSidebarModule === "agents"} onClick={() => { prepareMobileOverlayHistory(); setMobileSidebarModule("agents"); setRightPanelOpen(false); setSidebarOpen(true); }}><Bot size={18} /><small>Agents</small></button>
      <button type="button" aria-pressed={sidebarOpen && mobileSidebarModule === "explorer"} onClick={() => { prepareMobileOverlayHistory(); setMobileSidebarModule("explorer"); setMobileExplorerRevealKey((key) => key + 1); setRightPanelOpen(false); setSidebarOpen(true); }}><Files size={18} /><small>Files</small></button>
      <button type="button" disabled={!activeCwd} aria-pressed={rightPanelOpen && activeFileTabId === "git-review"} onClick={() => { setSidebarOpen(false); if (!(rightPanelOpen && activeFileTabId === "git-review")) { prepareMobileOverlayHistory(); handleOpenGitReview(); } else setRightPanelOpen(false); }}><GitBranch size={18} /><small>Git</small></button>
    </nav>}
    {!rightPanelOpen && <button
      onClick={() => setRightPanelOpen(true)}
      title="Show file panel"
      aria-label="Show file panel"
      style={{
        position: "fixed", top: 0, right: 0, zIndex: 300,
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 36, height: 36, padding: 0,
        background: "var(--bg-panel)", border: "none", borderLeft: "1px solid var(--border)", borderBottom: "1px solid var(--border)",
        color: "var(--text-muted)",
        cursor: "pointer", transition: "color 0.12s",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="15" y1="3" x2="15" y2="21" />
      </svg>
    </button>}
    {newTerminalProvider && activeCwd && (
      <NewAgentDialog
        cwd={activeCwd}
        provider={newTerminalProvider}
        onClose={() => setNewTerminalProvider(null)}
        onCreated={handleTerminalCreated}
      />
    )}
    {pendingTerminalClose && <TerminalCloseDialog terminal={pendingTerminalClose.terminal} busy={terminalCloseBusy} error={terminalCloseError} onCancel={() => { if (!terminalCloseBusy) setPendingTerminalClose(null); }} onKeepRunning={() => void closeTerminalTab(false)} onStop={() => void closeTerminalTab(true)} />}
    {modelsConfigOpen && <ModelsConfig onClose={() => { setModelsConfigOpen(false); setModelsRefreshKey((k) => k + 1); }} />}
    {skillsConfigOpen && (activeCwd ?? selectedSession?.cwd ?? newSessionCwd) && (
      <SkillsConfig cwd={(activeCwd ?? selectedSession?.cwd ?? newSessionCwd)!} onClose={() => setSkillsConfigOpen(false)} />
    )}
    {pluginsConfigOpen && (activeCwd ?? selectedSession?.cwd ?? newSessionCwd) && (
      <PluginsConfig
        cwd={(activeCwd ?? selectedSession?.cwd ?? newSessionCwd)!}
        sessionId={selectedSession?.id ?? null}
        onClose={() => setPluginsConfigOpen(false)}
        onReloaded={() => setSessionKey((k) => k + 1)}
      />
    )}
    </>
  );
}

function TerminalCloseDialog({ terminal, busy, error, onCancel, onKeepRunning, onStop }: { terminal: TerminalSession; busy: boolean; error: string | null; onCancel: () => void; onKeepRunning: () => void; onStop: () => void }) {
  useEffect(() => {
    if (busy) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, onCancel]);
  return <div role="dialog" aria-modal="true" aria-label="Close terminal" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }} style={{ position: "fixed", inset: 0, zIndex: 1000, display: "grid", placeItems: "center", padding: 20, background: "rgb(0 0 0 / 55%)" }}><section style={{ width: "min(100%, 420px)", padding: 18, border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-panel)", color: "var(--text)", boxShadow: "0 20px 60px rgb(0 0 0 / 45%)" }}><strong>Close {terminal.provider} terminal?</strong><p style={{ margin: "8px 0 0", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>The process is still running in {terminal.cwd}. You can keep it running and reopen it from Agents, or stop it now.</p>{error && <p role="alert" style={{ color: "#f87171", fontSize: 12 }}>{error}</p>}<div style={{ display: "flex", justifyContent: "flex-end", flexWrap: "wrap", gap: 8, marginTop: 18 }}><button type="button" disabled={busy} onClick={onCancel} style={terminalCloseButtonStyle}>Cancel</button><button type="button" disabled={busy} onClick={onKeepRunning} style={terminalCloseButtonStyle}>Keep running</button><button type="button" disabled={busy} onClick={onStop} style={{ ...terminalCloseButtonStyle, color: "#ef4444", borderColor: "rgb(239 68 68 / 45%)", background: "rgb(239 68 68 / 10%)" }}>{busy ? "Stopping…" : "Stop and close"}</button></div></section></div>;
}

const terminalCloseButtonStyle: React.CSSProperties = { padding: "7px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-hover)", color: "var(--text)", cursor: "pointer", font: "12px/1.3 inherit" };
const terminalRecoveryButtonStyle: React.CSSProperties = { padding: "6px 9px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-hover)", color: "var(--text)", cursor: "pointer", font: "11.5px/1.3 inherit" };
