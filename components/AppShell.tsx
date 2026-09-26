"use client";

import { useState, useCallback, useReducer, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { useGlobalKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { SessionSidebar } from "./SessionSidebar";
import { ProjectRail } from "./ProjectRail";
import { ChatWindow } from "./ChatWindow";
import { NewAgentDialog } from "./agents/NewAgentDialog";
import { TabBar } from "./TabBar";
import { claudeChatTabId, codexChatTabId, terminalTabId, GIT_REVIEW_TAB_ID, type CenterTab, type ClaudePermissionMode, type TabStatus, type TerminalTab } from "@/lib/workspace/tabs";
import { centerReducer, sideReducer, initialCenterState, initialSideState, type TerminalSplit } from "@/lib/workspace/panel-state";
import { loadCenterState, saveCenterState, loadSideState, saveSideState, type SideSnapshotCache } from "@/lib/workspace/panel-storage";
import { getMissingSplitTerminalTabs } from "@/lib/terminal-restore";
import { CenterWorkspace } from "./workspace/CenterWorkspace";
import { SidePanel } from "./workspace/SidePanel";
import { TopBar } from "./workspace/TopBar";
import { TerminalTabView, CodexChatTabView, ClaudeChatTabView, FileTabView, GitTabView } from "./workspace/tab-views";
import { WorkspaceActionsProvider, type ClaudeChatTarget, type CodexChatTarget, type WorkspaceActions } from "./workspace/WorkspaceActions";

// Heavy on-demand panels are declared in ./workspace/tab-views (dynamic,
// ssr: false) so they stay out of the initial chat bundle.
const SettingsPanel = dynamic(() => import("./SettingsPanel").then((m) => m.SettingsPanel), { ssr: false });
import { ProductStatusDot } from "./ProductStatus";
import { RecentNotifications, UnreadNotificationBadge } from "./RecentNotifications";
import { useTheme } from "@/hooks/useTheme";
import { useIsMobile } from "@/hooks/useIsMobile";
import { getFileName } from "@/lib/file-paths";
import { randomId } from "@/lib/random-id";
import { buildAtMentionText, buildFileAtMentionsText, buildFileLineMentionText } from "@/lib/file-fuzzy";
import { getInitialNavigation } from "@/lib/initial-navigation";
import type { SessionInfo, SessionTreeNode } from "@/lib/types";
import type { ChatInputHandle } from "./ChatInput";
import type { TerminalProvider, TerminalSession } from "@/lib/agents/terminal";
import type { TerminalConnectionState } from "@/hooks/useTerminalSocket";
import { useWorkspaceTerminals } from "@/hooks/useWorkspaceTerminals";
import { usePanelResize } from "@/hooks/usePanelResize";
import { useSessionMeta } from "@/hooks/useSessionMeta";
import { useMobileOverlayHistory } from "@/hooks/useMobileOverlayHistory";
import { useProjectWorkspaces } from "@/hooks/useProjectWorkspaces";
import { Activity, ArrowLeft, Bot, Files, GitBranch, Maximize2, Minimize2, PanelRightClose, PanelRightOpen, PanelsTopLeft, Plus, TerminalSquare } from "lucide-react";
import { projectLabel, upsertProjectWorkspace, type ProjectWorkspace } from "@/lib/project-workspaces";
import { getProductStatus } from "@/lib/product-status";
import type { ActivityTarget } from "@/lib/rail-activity";

const rightPanelHeaderButtonStyle: React.CSSProperties = { width: 36, height: 36, display: "grid", placeItems: "center", padding: 0, border: 0, borderLeft: "1px solid var(--border)", background: "transparent", color: "var(--text-muted)", cursor: "pointer" };
const rightPanelToolMenuStyle: React.CSSProperties = { position: "absolute", zIndex: 500, top: 38, right: 2, width: 190, display: "grid", gap: 2, padding: 5, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-panel)", boxShadow: "0 14px 36px rgba(0,0,0,.26)" };
const rightPanelToolItemStyle: React.CSSProperties = { minHeight: 32, display: "flex", alignItems: "center", gap: 8, padding: "0 9px", border: 0, borderRadius: 5, background: "transparent", color: "var(--text)", cursor: "pointer", font: "12px/1.2 inherit", textAlign: "left" };

/** Settings the caller knows; merging an unknown one would wipe what an open tab saved. */
function definedOnly<T extends Record<string, unknown>>(values: T): Partial<T> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as Partial<T>;
}

/** Current SessionInfo for a session (the list is cached server-side); `cached` on any failure. */
async function fetchFreshSessionInfo(cached: SessionInfo): Promise<SessionInfo> {
  try {
    // Bounded: a slow cold scan must not leave the click doing nothing.
    const response = await fetch("/api/sessions", { cache: "no-store", signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return cached;
    const data = await response.json() as { sessions?: SessionInfo[] };
    return data.sessions?.find((session) => session.id === cached.id) ?? cached;
  } catch {
    return cached;
  }
}

export function AppShell() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [initialNavigation] = useState(() => getInitialNavigation(searchParams));
  const [activeCwd, setActiveCwd] = useState<string | null>(null);
  const {
    projectWorkspaces, setProjectWorkspaces, activeProjectId, setActiveProjectId, projectWorkspacesHydrated,
    rememberRecentProject,
    reorderProjectWorkspaces: handleReorderProjectWorkspaces,
    renameProjectWorkspace: handleRenameProjectWorkspace,
    togglePinnedProjectWorkspace: handleTogglePinnedProjectWorkspace,
  } = useProjectWorkspaces();
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
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileSidebarReady, setMobileSidebarReady] = useState(false);
  const [mobileSidebarModule, setMobileSidebarModule] = useState<"sessions" | "agents" | "explorer">("sessions");
  const [mobileExplorerRevealKey, setMobileExplorerRevealKey] = useState(0);
  const [explorerRevealRequest, setExplorerRevealRequest] = useState<{ path: string; key: number } | null>(null);
  // On mobile the sidebar is an overlay drawer; hide it by default so the chat
  // is visible on load. Runs once the breakpoint resolves after hydration.
  useEffect(() => {
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);
  useEffect(() => {
    setMobileSidebarReady(true);
  }, []);
  const chatInputRef = useRef<ChatInputHandle | null>(null);

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

  const handleSystemPromptChange = useCallback((prompt: string | null) => {
    setSystemPrompt(prompt);
  }, []);

  // The system prompt is only known once the session's agent is running.
  // Opening a saved session does not start it (that parses the whole session
  // file), so the System panel starts it on demand instead of asking the user
  // to send a message first.
  const [systemPromptLoading, setSystemPromptLoading] = useState(false);
  const selectedSessionIdRef = useRef<string | null>(null);
  selectedSessionIdRef.current = selectedSession?.id ?? null;
  const loadSystemPrompt = useCallback(async (sessionId: string) => {
    setSystemPromptLoading(true);
    try {
      const response = await fetch(`/api/agent/${encodeURIComponent(sessionId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "get_state" }),
      });
      const body = await response.json().catch(() => ({})) as { data?: { systemPrompt?: unknown } };
      if (response.ok && typeof body.data?.systemPrompt === "string" && selectedSessionIdRef.current === sessionId) {
        setSystemPrompt(body.data.systemPrompt);
      }
    } catch {
      // Leave the prompt unknown; the panel keeps its "send a message" hint.
    } finally {
      setSystemPromptLoading(false);
    }
  }, []);

  // Single active panel — only one dropdown open at a time
  const [activeTopPanel, setActiveTopPanel] = useState<"branches" | "system" | "session" | null>(null);
  const [activityPanelOpen, setActivityPanelOpen] = useState(false);
  const activityPanelRef = useRef<HTMLDivElement>(null);

  const toggleTopPanel = useCallback((panel: "branches" | "system" | "session") => {
    if (isMobile) setSidebarOpen(false);
    const opening = activeTopPanel !== panel;
    setActiveTopPanel(opening ? panel : null);
    if (opening && panel === "system" && systemPrompt === null && selectedSession && !systemPromptLoading) {
      void loadSystemPrompt(selectedSession.id);
    }
  }, [activeTopPanel, isMobile, loadSystemPrompt, selectedSession, systemPrompt, systemPromptLoading]);

  const openSessionStatsPanel = useCallback(() => {
    if (isMobile) setSidebarOpen(false);
    setActiveTopPanel("session");
  }, [isMobile]);

  const handleSidebarToggle = useCallback(() => {
    if (isMobile) setActiveTopPanel(null);
    setSidebarOpen((open) => !open);
  }, [isMobile]);

  useEffect(() => {
    if (!activityPanelOpen) return;
    const close = (event: PointerEvent) => { if (!activityPanelRef.current?.contains(event.target as Node)) setActivityPanelOpen(false); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setActivityPanelOpen(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", closeOnEscape); };
  }, [activityPanelOpen]);

  // Center workspace (per cwd) and right panel (per project) state. See
  // lib/workspace/panel-state.ts for the transitions.
  const [center, dispatchCenter] = useReducer(centerReducer, undefined, initialCenterState);
  const [side, dispatchSide] = useReducer(sideReducer, undefined, initialSideState);
  const [centerHydratedCwd, setCenterHydratedCwd] = useState<string | null>(null);
  const [sideHydratedProject, setSideHydratedProject] = useState<string | null>(null);
  const sideCacheRef = useRef<SideSnapshotCache>(new Map());
  const { tabs: workspaceTabs, activeId: activeWorkspaceTabId, split: terminalSplit } = center;
  const { tabs: fileTabs, activeId: activeFileTabId, open: rightPanelOpen } = side;
  const setRightPanelOpen = useCallback((open: boolean) => dispatchSide({ type: "setOpen", open }), []);
  const setTerminalSplit = useCallback((split: TerminalSplit | null | ((current: TerminalSplit | null) => TerminalSplit | null)) => dispatchCenter({ type: "setSplit", split }), []);
  const activateWorkspaceTab = useCallback((id: string) => dispatchCenter({ type: "activate", id }), []);
  const splitRestoreAttemptRef = useRef<string | null>(null);

  useEffect(() => {
    splitRestoreAttemptRef.current = null;
    dispatchCenter({ type: "hydrate", state: activeCwd ? loadCenterState(localStorage, activeCwd) : initialCenterState() });
    setCenterHydratedCwd(activeCwd);
  }, [activeCwd]);
  const centerHydratedCwdRef = useRef(centerHydratedCwd);
  useEffect(() => { centerHydratedCwdRef.current = centerHydratedCwd; }, [centerHydratedCwd]);
  useEffect(() => {
    if (activeCwd && centerHydratedCwd === activeCwd) saveCenterState(localStorage, activeCwd, center);
  }, [activeCwd, center, centerHydratedCwd]);
  // Layout effects so a project switch never paints the previous project's tabs.
  useLayoutEffect(() => {
    dispatchSide({ type: "hydrate", state: activeProjectId ? loadSideState(localStorage, activeProjectId, sideCacheRef.current) : initialSideState() });
    setSideHydratedProject(activeProjectId);
  }, [activeProjectId]);
  useLayoutEffect(() => {
    if (activeProjectId && sideHydratedProject === activeProjectId) saveSideState(localStorage, activeProjectId, side, sideCacheRef.current);
  }, [activeProjectId, side, sideHydratedProject]);
  // Project switches save synchronously before the scope changes.
  const panelSnapshotRef = useRef({ activeCwd, activeProjectId, center, side, centerHydratedCwd, sideHydratedProject });
  panelSnapshotRef.current = { activeCwd, activeProjectId, center, side, centerHydratedCwd, sideHydratedProject };
  const persistCurrentProjectPanels = useCallback(() => {
    const current = panelSnapshotRef.current;
    if (current.activeCwd && current.centerHydratedCwd === current.activeCwd) saveCenterState(localStorage, current.activeCwd, current.center);
    if (current.activeProjectId && current.sideHydratedProject === current.activeProjectId) saveSideState(localStorage, current.activeProjectId, current.side, sideCacheRef.current);
  }, []);
  const [activeTerminalPaneId, setActiveTerminalPaneId] = useState<string | null>(null);
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
  const closeMobileOverlays = useCallback(() => {
    setSidebarOpen(false);
    setRightPanelOpen(false);
    setActiveTopPanel(null);
  }, [setRightPanelOpen]);
  const prepareMobileOverlayHistory = useMobileOverlayHistory({
    isMobile,
    ready: mobileSidebarReady,
    overlayOpen: sidebarOpen || rightPanelOpen,
    onBack: closeMobileOverlays,
  });
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

  const restoreChat = useCallback(() => setChatCollapsed(false), []);
  const { layoutRootRef, layoutStyle, isResizing, beginSidebarResize, beginRightPanelResize, restoreChatFromResize } = usePanelResize({ onRestoreChat: restoreChat });

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

  const recordProjectWorkspace = useCallback((cwd: string, projectRoot = cwd, sessionId?: string | null) => {
    setProjectSelectionDismissed(false);
    setActiveProjectId(projectRoot);
    setProjectWorkspaces((current) => upsertProjectWorkspace(current, { projectRoot, cwd, sessionId }));
  }, [setActiveProjectId, setProjectWorkspaces]);


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
  // grant for the effective cwd. Do not cache this as a client-side boolean:
  // the server can restart while React state survives, and a remembered grant
  // is not evidence that the current server process has loaded it.
  useEffect(() => {
    if (!activeCwd) return;
    const controller = new AbortController();
    void fetch("/api/cwd/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: activeCwd }),
      signal: controller.signal,
    }).then((response) => {
      if (!response.ok || controller.signal.aborted) return;
      setExplorerRefreshKey((key) => key + 1);
      setRefreshKey((key) => key + 1);
      setModelsRefreshKey((key) => key + 1);
    }).catch(() => {});
    return () => controller.abort();
  }, [activeCwd]);

  const handleSelectSession = useCallback((session: SessionInfo, isRestore = false) => {
    recordProjectWorkspace(session.cwd, session.projectRoot ?? session.cwd, session.id);
    activateWorkspaceTab("pi");
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
  }, [recordProjectWorkspace, router, isMobile, activateWorkspaceTab]);

  const handleNewSession = useCallback((_sessionId: string, cwd: string) => {
    recordProjectWorkspace(cwd, activeProjectId ?? cwd, null);
    activateWorkspaceTab("pi");
    setSelectedSession(null);
    setNewSessionCwd(cwd);
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setActiveTopPanel(null);
    if (isMobile) setSidebarOpen(false);
    router.replace("/", { scroll: false });
  }, [activeProjectId, recordProjectWorkspace, router, isMobile, activateWorkspaceTab]);

  const activateProjectWorkspace = useCallback(async (workspace: ProjectWorkspace, onActivated?: (activation: { token: number; cwd: string }) => void) => {
    // Activation is the trust boundary. Always ask the current server to
    // validate the path, even if the picker or a previous render already did.
    // This keeps restored workspaces and Fast Refresh/server-restart state in
    // sync instead of trusting stale client memory.
    let authorizedCwd: string;
    try {
      const response = await fetch("/api/cwd/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: workspace.cwd }),
      });
      const data = await response.json().catch(() => ({})) as { cwd?: string };
      if (!response.ok || !data.cwd) return;
      authorizedCwd = data.cwd;
    } catch {
      return;
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
    activateWorkspaceTab("pi");
    setSelectedSession(null);
    setNewSessionCwd(authorizedWorkspace.cwd);
    setSessionKey((key) => key + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setActiveTopPanel(null);
    suppressCwdBumpRef.current = true;
    router.replace("/", { scroll: false });
    onActivated?.({ token, cwd: authorizedWorkspace.cwd });
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
  }, [persistCurrentProjectPanels, recordProjectWorkspace, rememberRecentProject, router, setActiveProjectId, setProjectWorkspaces, activateWorkspaceTab]);

  const handleAddProjectWorkspace = useCallback(async (path: string) => {
    const workspace: ProjectWorkspace = { id: path, projectRoot: path, cwd: path, label: projectLabel(path), sessionId: null, lastActive: Date.now() };
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
  }, [activeProjectId, activateProjectWorkspace, persistCurrentProjectPanels, projectWorkspaces, router, setActiveProjectId, setProjectWorkspaces]);


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

  const closeTopPanels = useCallback(() => setActiveTopPanel(null), []);
  const handleAutoNamed = useCallback((sessionId: string, title: string) => {
    setRefreshKey((key) => key + 1);
    setSelectedSession((current) => current?.id === sessionId ? { ...current, name: title } : current);
  }, []);
  const {
    sessionStats, handleSessionStatsChange, contextUsage, handleContextUsageChange,
    copiedSessionField, handleCopySessionField, autoNameStatus, handleAutoName,
  } = useSessionMeta({ sessionId: selectedSession?.id ?? null, onAutoNameStart: closeTopPanels, onAutoNamed: handleAutoNamed });

  const handleExplorerRefresh = useCallback(() => {
    setExplorerRefreshKey((k) => k + 1);
  }, []);

  // Git status, the file tree, and open-file diffs are only bumped on our own
  // agent_end and on manual actions. Work done outside TianForge pi (terminal `pi`,
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
    dispatchSide({ type: "openFile", filePath, label: fileName, sourceSessionId });
    // On mobile the file panel is full-screen; close the drawer so it shows.
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);

  const handleRevealFileInExplorer = useCallback((filePath: string) => {
    setExplorerRevealRequest((current) => ({ path: filePath, key: (current?.key ?? 0) + 1 }));
    setSidebarOpen(true);
    if (isMobile) {
      prepareMobileOverlayHistory();
      setMobileSidebarModule("explorer");
      setRightPanelOpen(false);
    }
  }, [isMobile, prepareMobileOverlayHistory, setRightPanelOpen]);

  const handleExplorerPathRenamed = useCallback((oldPath: string, newPath: string, isDir: boolean) => {
    dispatchSide({ type: "pathRenamed", oldPath, newPath, isDir });
  }, []);

  const handleExplorerPathDeleted = useCallback((deletedPath: string, isDir: boolean) => {
    dispatchSide({ type: "pathDeleted", path: deletedPath, isDir });
  }, []);

  const handleCloseFileTabs = useCallback((tabIds: string[]) => dispatchSide({ type: "close", ids: tabIds }), []);
  const handleCloseFileTab = useCallback((tabId: string) => dispatchSide({ type: "close", ids: [tabId] }), []);
  const handleToggleFileTabLocked = useCallback((tabId: string) => dispatchSide({ type: "toggleLock", id: tabId }), []);

  const removeWorkspaceTab = useCallback((tabId: string) => dispatchCenter({ type: "remove", id: tabId }), []);

  const handleCloseWorkspaceTab = useCallback((tabId: string) => {
    const tab = workspaceTabs.find((item) => item.id === tabId);
    const terminal = tab && "terminalId" in tab && tab.terminalId ? terminals[tab.terminalId] : null;
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
    dispatchCenter({ type: "select", id: tabId });
    setActiveTopPanel(null);
  }, []);

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
  }, [isMobile, terminalSplit, setTerminalSplit]);

  const handleCodexSessionChanged = useCallback((change: { id: string; action: "rename" | "archive" | "unarchive" | "delete"; name?: string }) => {
    if (change.action === "rename" && change.name) {
      const name = change.name;
      dispatchCenter({ type: "update", update: (tab) => tab.kind !== "pi" && tab.sourceSessionId === change.id ? { ...tab, label: name, ...(tab.kind === "codex-chat" || tab.kind === "claude-chat" ? { sessionName: name } : {}) } : tab });
      return;
    }
    if (change.action !== "archive" && change.action !== "delete") return;
    dispatchCenter({ type: "removeWhere", predicate: (tab) => (tab.kind === "codex-chat" || tab.kind === "claude-chat") && tab.sourceSessionId === change.id });
  }, []);

  const handleAgentTerminalRemoved = useCallback((terminalId: string) => {
    updateTerminals((current) => current.filter((terminal) => terminal.id !== terminalId));
    dispatchCenter({ type: "removeWhere", predicate: (tab) => "terminalId" in tab && tab.terminalId === terminalId });
  }, [updateTerminals]);

  const openGitReview = useCallback(() => {
    if (!activeCwd) return;
    dispatchSide({ type: "openGitReview" });
    if (isMobile) setSidebarOpen(false);
  }, [activeCwd, isMobile]);

  const handleOpenGitReview = useCallback(() => {
    if (rightPanelOpen && activeFileTabId === GIT_REVIEW_TAB_ID) {
      handleCloseFileTab(GIT_REVIEW_TAB_ID);
      return;
    }
    openGitReview();
  }, [rightPanelOpen, activeFileTabId, handleCloseFileTab, openGitReview]);

  const openTerminalTab = useCallback((terminal: TerminalSession, preferredLabel?: string) => {
    dispatchCenter({ type: "open", tab: { id: terminalTabId(terminal.id), label: preferredLabel || terminal.title || (terminal.provider === "shell" ? "Terminal" : `${terminal.provider} terminal`), kind: "terminal", terminalId: terminal.id, terminalProvider: terminal.provider, terminalPermissionMode: terminal.permissionMode, terminalLaunchMode: terminal.launchMode, terminalNoAltScreen: terminal.noAltScreen, terminalModel: terminal.model, terminalWebSearch: terminal.webSearch, terminalChatMode: terminal.chatMode, cwd: terminal.cwd, sourceSessionId: terminal.sourceSessionId, status: terminal.state === "running" ? "running" : "ended" } });
  }, []);

  const handleTerminalCreated = useCallback((terminal: TerminalSession, preferredLabel?: string) => {
    updateTerminals((current) => [...current.filter((item) => item.id !== terminal.id), terminal]);
    openTerminalTab(terminal, preferredLabel);
    setNewTerminalProvider(null);
    if (isMobile) setSidebarOpen(false);
  }, [isMobile, openTerminalTab, updateTerminals]);

  const restartUnavailableTerminal = useCallback(async (tab: TerminalTab): Promise<TerminalSession | null> => {
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
      dispatchCenter({ type: "update", update: (item) => item.id === tab.id && item.kind === "terminal" ? { ...item, terminalId: restarted.id, terminalProvider: restarted.provider, terminalPermissionMode: restarted.permissionMode, terminalLaunchMode: restarted.launchMode, terminalNoAltScreen: restarted.noAltScreen, terminalModel: restarted.model, terminalWebSearch: restarted.webSearch, terminalChatMode: restarted.chatMode, sourceSessionId: restarted.sourceSessionId, status: "running" } : item });
      setTerminalSplit((current) => current && tab.terminalId && current.secondaryTerminalId === tab.terminalId ? { ...current, secondaryTerminalId: restarted.id } : current);
      return restarted;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Unable to restart terminal";
      setTerminalRestartError(message);
      setTerminalRestoreErrors((current) => ({ ...current, [tab.id]: message }));
      return null;
    } finally { terminalRestoreInFlightRef.current.delete(tab.id); setTerminalRestartingId((current) => current === tab.id ? null : current); }
  }, [updateTerminals, setTerminalSplit]);

  const handleOpenCodexChat = useCallback((terminal: TerminalSession) => {
    dispatchCenter({ type: "open", tab: { id: codexChatTabId(terminal.id), label: "Codex Chat", kind: "codex-chat", terminalId: terminal.id, sourceSessionId: terminal.sourceSessionId, cwd: terminal.cwd, model: terminal.model } });
  }, []);

  const handleOpenCodexSessionChat = useCallback((target: CodexChatTarget) => {
    const settings = { sessionName: target.sessionName || undefined, cwd: target.cwd, ...definedOnly({ model: target.model, reasoningEffort: target.reasoningEffort, serviceTier: target.serviceTier, approvalPolicy: target.approvalPolicy }) };
    // An empty name falls back to the panel's own title and the thread's name;
    // an open tab keeps its label then (e.g. the first message of a new chat).
    const fields = { label: target.sessionName || "Codex Chat", ...settings };
    dispatchCenter({ type: "open", tab: { id: codexChatTabId(target.sessionId), kind: "codex-chat", sourceSessionId: target.sessionId, ...fields }, mergeExisting: target.sessionName ? fields : settings });
  }, []);

  const handleNewCodexChat = useCallback((cwd: string) => {
    dispatchCenter({ type: "open", tab: { id: codexChatTabId(`new-${randomId()}`), label: "New Codex chat", kind: "codex-chat", cwd, newChat: true, approvalPolicy: "untrusted" } });
  }, []);

  const handleCodexChatCreated = useCallback((tabId: string, cwd: string, threadId: string, title: string) => {
    const update = (tab: CenterTab): CenterTab => tab.id === tabId && tab.kind === "codex-chat" ? { ...tab, sourceSessionId: threadId, newChat: false, label: title || tab.label } : tab;
    dispatchCenter({ type: "update", update });
    // The project was switched while Codex started the chat: fix its saved tab, or going back would start a second chat.
    if (cwd !== centerHydratedCwdRef.current) {
      const saved = loadCenterState(localStorage, cwd);
      saveCenterState(localStorage, cwd, { ...saved, tabs: saved.tabs.map(update) });
    }
  }, []);

  const handleOpenClaudeSessionChat = useCallback((target: ClaudeChatTarget) => {
    const settings = { sessionName: target.sessionName || undefined, cwd: target.cwd, ...definedOnly({ model: target.model, permissionMode: target.permissionMode }) };
    const fields = { label: target.sessionName || "Claude Chat", ...settings };
    dispatchCenter({ type: "open", tab: { id: claudeChatTabId(target.sessionId), kind: "claude-chat", sourceSessionId: target.sessionId, ...fields }, mergeExisting: target.sessionName ? fields : settings });
  }, []);

  const handleNewClaudeChat = useCallback((cwd: string) => {
    dispatchCenter({ type: "open", tab: { id: claudeChatTabId(`new-${randomId()}`), label: "New Claude chat", kind: "claude-chat", cwd, newChat: true, permissionMode: "default" } });
  }, []);

  const handleClaudeChatCreated = useCallback((tabId: string, cwd: string, sessionId: string, title: string) => {
    const update = (tab: CenterTab): CenterTab => tab.id === tabId && tab.kind === "claude-chat" ? { ...tab, sourceSessionId: sessionId, newChat: false, label: title || tab.label } : tab;
    dispatchCenter({ type: "update", update });
    if (cwd !== centerHydratedCwdRef.current) {
      const saved = loadCenterState(localStorage, cwd);
      saveCenterState(localStorage, cwd, { ...saved, tabs: saved.tabs.map(update) });
    }
  }, []);

  const handleClaudeTabConfiguration = useCallback((tabId: string, configuration: { model?: string; permissionMode?: ClaudePermissionMode }) => {
    dispatchCenter({ type: "update", update: (tab) => tab.id === tabId && tab.kind === "claude-chat" ? { ...tab, ...configuration } : tab });
  }, []);

  const handleTerminalChanged = useCallback((terminal: TerminalSession) => {
    updateTerminals((current) => [...current.filter((item) => item.id !== terminal.id), terminal]);
    dispatchCenter({ type: "update", update: (tab) => tab.kind === "terminal" && tab.terminalId === terminal.id ? { ...tab, label: terminal.title || tab.label, terminalPermissionMode: terminal.permissionMode, terminalLaunchMode: terminal.launchMode, terminalNoAltScreen: terminal.noAltScreen, terminalModel: terminal.model, terminalWebSearch: terminal.webSearch, terminalChatMode: terminal.chatMode, sourceSessionId: terminal.sourceSessionId, status: terminal.state === "running" ? "running" : "ended" } : tab });
  }, [updateTerminals]);

  const handleTerminalConnection = useCallback((terminalId: string, connection: TerminalConnectionState) => {
    const status: TabStatus = connection === "connected" ? "running" : connection === "offline" ? "offline" : connection === "disconnected" ? "failed" : "connecting";
    dispatchCenter({ type: "update", update: (tab) => tab.kind === "terminal" && tab.terminalId === terminalId && tab.status !== status ? { ...tab, status } : tab });
  }, []);

  const handleCodexTabStatus = useCallback((tabId: string, status: "idle" | "running" | "approval") => {
    dispatchCenter({ type: "update", update: (tab) => tab.id === tabId && tab.status !== status ? { ...tab, status } : tab });
  }, []);

  const handleCodexTabConfiguration = useCallback((tabId: string, configuration: { model?: string; reasoningEffort?: string; serviceTier?: string; approvalPolicy?: "untrusted" | "on-request" | "never" }) => {
    dispatchCenter({ type: "update", update: (tab) => tab.id === tabId && tab.kind === "codex-chat" ? { ...tab, ...configuration } : tab });
  }, []);

  useEffect(() => {
    if (!activeCwd || centerHydratedCwd !== activeCwd || !terminalsLoaded) return;
    const available = new Set(terminalList.map((terminal) => terminal.id));
    const gone = (tab: CenterTab) => tab.kind === "terminal" && Boolean(tab.terminalId) && !available.has(tab.terminalId!) && tab.status !== "ended";
    // Dispatch only for a change: this effect runs whenever the tabs change, and
    // a no-op dispatch still re-renders, which (while other tab updates are
    // pending) yields a new tabs array and runs it again, without end.
    if (workspaceTabs.some(gone)) dispatchCenter({ type: "update", update: (tab) => gone(tab) ? { ...tab, status: "ended" } as CenterTab : tab });
    if (terminalSplit) {
      const restoreTabs = getMissingSplitTerminalTabs(workspaceTabs.filter((tab): tab is TerminalTab => tab.kind === "terminal"), terminalSplit, available);
      const restoreKey = `${activeCwd}:${terminalSplit.primaryTabId}:${terminalSplit.secondaryTerminalId}`;
      if (restoreTabs.length > 0 && splitRestoreAttemptRef.current !== restoreKey) {
        splitRestoreAttemptRef.current = restoreKey;
        void Promise.all(restoreTabs.map((tab) => restartUnavailableTerminal(tab)));
      }
    }
  }, [activeCwd, centerHydratedCwd, restartUnavailableTerminal, terminalList, terminalSplit, terminalsLoaded, workspaceTabs]);

  // Rail activity items open a specific session/terminal/Codex chat, possibly
  // in another project. The open waits until that project's center panel state
  // is hydrated (and, for terminals, its terminal list is loaded): the project
  // switch restores saved tabs, which would otherwise replace the opened tab.
  // `token` is the project switch that must still be current when it runs
  // (null while activation is in flight); activation may canonicalize the cwd,
  // so the cwd to wait for comes from the activation itself.
  const [activityOpenIntent, setActivityOpenIntent] = useState<{ seq: number; item: ActivityTarget; token: number | null; cwd: string | null } | null>(null);
  const activityOpenSeqRef = useRef(0);
  // A Pi item carries the SessionInfo the rail cached when the session started
  // running, so its name can be stale. Look up the current record as soon as
  // the item is clicked (in parallel with any project activation) and open with
  // that, falling back to the cached record.
  const activityFreshSessionRef = useRef<{ seq: number; session: Promise<SessionInfo> } | null>(null);
  const handleOpenActivityItem = useCallback((workspace: ProjectWorkspace, item: ActivityTarget) => {
    const seq = ++activityOpenSeqRef.current;
    activityFreshSessionRef.current = item.kind === "pi" ? { seq, session: fetchFreshSessionInfo(item.session) } : null;
    // Terminals are grouped under a workspace by cwd or project root, but the
    // center only loads the active cwd's terminals. A terminal in another
    // directory of the project (e.g. the main checkout while a worktree is
    // active) needs the workspace activated in that directory.
    const targetCwd = item.kind === "terminal" ? item.cwd : null;
    if (workspace.id === activeProjectId && activeCwd && (!targetCwd || targetCwd === activeCwd)) {
      setActivityOpenIntent({ seq, item, token: projectSwitchTokenRef.current, cwd: activeCwd });
      return;
    }
    setActivityOpenIntent({ seq, item, token: null, cwd: null });
    void activateProjectWorkspace(targetCwd ? { ...workspace, cwd: targetCwd } : workspace, ({ token, cwd }) => {
      setActivityOpenIntent((current) => current?.seq === seq ? { ...current, token, cwd } : current);
    }).finally(() => {
      // Activation failed (e.g. the path is no longer authorized).
      setActivityOpenIntent((current) => current?.seq === seq && current.token === null ? null : current);
    });
  }, [activateProjectWorkspace, activeCwd, activeProjectId]);

  // An intent that cannot run soon (e.g. the terminal list never loads) is
  // dropped rather than popping a tab open much later.
  const activityOpenIntentSeq = activityOpenIntent?.seq ?? null;
  useEffect(() => {
    if (activityOpenIntentSeq === null) return;
    const timer = setTimeout(() => setActivityOpenIntent((current) => current?.seq === activityOpenIntentSeq ? null : current), 10_000);
    return () => clearTimeout(timer);
  }, [activityOpenIntentSeq]);

  useEffect(() => {
    const intent = activityOpenIntent;
    if (!intent || intent.token === null) return;
    // The user moved to another project (or cwd) before it could open.
    if (intent.token !== projectSwitchTokenRef.current || activeCwd !== intent.cwd) {
      setActivityOpenIntent(null);
      return;
    }
    if (!activeCwd || centerHydratedCwd !== activeCwd) return;
    if (intent.item.kind === "terminal" && !terminalsLoaded) return;
    setActivityOpenIntent(null);
    const { item } = intent;
    if (item.kind === "terminal") {
      // Only open a terminal this cwd actually has: a tab without a live record
      // shows "unavailable", and its Restart would delete the real process
      // (or the record was removed after the item was listed).
      const current = terminals[item.id];
      if (!current) return;
      if (isMobile) closeMobileOverlays();
      openTerminalTab(current);
      return;
    }
    if (isMobile) closeMobileOverlays();
    if (item.kind === "pi") {
      // Supersede the activation's pending restore of the project's last session.
      const token = ++projectSwitchTokenRef.current;
      const selectedAtOpen = selectedSessionIdRef.current;
      const pending = activityFreshSessionRef.current?.seq === intent.seq ? activityFreshSessionRef.current.session : Promise.resolve(item.session);
      activityFreshSessionRef.current = null;
      void pending.then((session) => {
        // Superseded while the lookup was in flight: another project switch,
        // another activity item, or the user picked a session themselves.
        if (token !== projectSwitchTokenRef.current || intent.seq !== activityOpenSeqRef.current || selectedSessionIdRef.current !== selectedAtOpen) return;
        handleSelectSession(session);
      });
    } else if (item.kind === "claude") {
      const existing = workspaceTabs.find((tab) => tab.kind === "claude-chat" && (tab.id === claudeChatTabId(item.id) || tab.sourceSessionId === item.id));
      if (existing) activateWorkspaceTab(existing.id);
      else handleOpenClaudeSessionChat({ sessionId: item.id, sessionName: "", cwd: item.cwd });
    } else {
      const threadId = item.id;
      const existing = workspaceTabs.find((tab) => tab.kind === "codex-chat" && (tab.id === codexChatTabId(threadId) || tab.sourceSessionId === threadId));
      if (existing) activateWorkspaceTab(existing.id);
      // A running runtime was started from a chat tab; reopen it with the chat
      // defaults. No session name, so the panel shows the thread's own name.
      else handleOpenCodexSessionChat({ sessionId: threadId, sessionName: "", cwd: item.cwd, approvalPolicy: "untrusted" });
    }
  }, [activateWorkspaceTab, activeCwd, activityOpenIntent, centerHydratedCwd, closeMobileOverlays, handleOpenClaudeSessionChat, handleOpenCodexSessionChat, handleSelectSession, isMobile, openTerminalTab, terminals, terminalsLoaded, workspaceTabs]);

  // The context value is ref-backed so its identity never changes. Consumers
  // derive callbacks from it (e.g. ChatWindow's onOpenFile) and MessageView's
  // memo comparator relies on stable callback identity; recreating the value on
  // every tab/terminal change would re-render the whole message list.
  const latestWorkspaceActions: WorkspaceActions = {
    openFile: (filePath, options) => handleOpenFile(filePath, getFileName(filePath), options?.sourceSessionId),
    toggleGitReview: handleOpenGitReview,
    openTerminal: handleTerminalCreated,
    openCodexChat: handleOpenCodexSessionChat,
    newCodexChat: handleNewCodexChat,
    openClaudeChat: handleOpenClaudeSessionChat,
    newClaudeChat: handleNewClaudeChat,
    closeTab: (tabId) => (fileTabs.some((tab) => tab.id === tabId) ? handleCloseFileTab(tabId) : handleCloseWorkspaceTab(tabId)),
    revealInExplorer: handleRevealFileInExplorer,
  };
  const workspaceActionsRef = useRef(latestWorkspaceActions);
  workspaceActionsRef.current = latestWorkspaceActions;
  const workspaceActions = useMemo<WorkspaceActions>(() => ({
    openFile: (filePath, options) => workspaceActionsRef.current.openFile(filePath, options),
    toggleGitReview: () => workspaceActionsRef.current.toggleGitReview(),
    openTerminal: (terminal, label) => workspaceActionsRef.current.openTerminal(terminal, label),
    openCodexChat: (target) => workspaceActionsRef.current.openCodexChat(target),
    newCodexChat: (cwd) => workspaceActionsRef.current.newCodexChat(cwd),
    openClaudeChat: (target) => workspaceActionsRef.current.openClaudeChat(target),
    newClaudeChat: (cwd) => workspaceActionsRef.current.newClaudeChat(cwd),
    closeTab: (tabId) => workspaceActionsRef.current.closeTab(tabId),
    revealInExplorer: (filePath) => workspaceActionsRef.current.revealInExplorer(filePath),
  }), []);

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
  const activeCodexChats = workspaceTabs.filter((tab) => (tab.kind === "codex-chat" || tab.kind === "claude-chat") && (tab.status === "running" || tab.status === "approval"));
  const approvalCount = activeCodexChats.filter((tab) => tab.status === "approval").length;
  const activityCount = runningTerminals.length + activeCodexChats.length;
  const showWorkspaceTabBar = workspaceTabs.length > 1;
  const activityControl = <div ref={activityPanelRef} style={{ position: "relative", alignSelf: "stretch", flexShrink: 0 }}>
    <button type="button" aria-label="Workspace activity" title="Workspace activity" aria-expanded={activityPanelOpen} onClick={() => setActivityPanelOpen((open) => !open)} style={{ display: "flex", alignItems: "center", gap: 5, height: "100%", padding: "0 10px", border: 0, borderLeft: "1px solid var(--border)", background: activityPanelOpen ? "var(--bg-selected)" : "transparent", color: approvalCount > 0 ? getProductStatus("approval").color : activityCount > 0 ? "var(--accent)" : "var(--text-dim)", cursor: "pointer", font: "10.5px/1 inherit" }}>
      <Activity size={15} /><span>{activityCount}</span>{approvalCount > 0 && <ProductStatusDot status="approval" size={6} title={`${approvalCount} approval pending`} />}<UnreadNotificationBadge />
    </button>
    {activityPanelOpen && <div role="dialog" aria-label="Workspace activity" style={{ position: "absolute", zIndex: 500, top: 40, right: 4, width: "min(330px, calc(100vw - 16px))", maxHeight: "min(480px, calc(100dvh - 100px))", overflowY: "auto", padding: 7, border: "1px solid var(--border)", borderRadius: 9, background: "var(--bg-panel)", boxShadow: "0 16px 44px rgb(0 0 0 / 38%)" }}>
      <div style={{ padding: "5px 7px 7px", color: "var(--text-dim)", fontSize: 10 }}>Workspace activity · {activityCount} active</div>
      {activityCount === 0 && <div style={{ padding: "14px 10px", color: "var(--text-dim)", fontSize: 11, textAlign: "center" }}>No tasks or agents are running</div>}
      {[...runningTasks, ...runningAgents, ...runningShells].map((terminal) => <button key={terminal.id} type="button" onClick={() => { handleTerminalCreated(terminal, terminal.title); setActivityPanelOpen(false); }} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", minHeight: 38, padding: "6px 8px", border: 0, borderRadius: 6, background: "transparent", color: "var(--text)", cursor: "pointer", textAlign: "left", font: "11px/1.3 inherit" }}><ProductStatusDot status="running" size={7} /><span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{terminal.title || `${terminal.provider} terminal`}</span><small style={{ color: "var(--text-dim)" }}>{terminal.provider}</small></button>)}
      {activeCodexChats.map((tab) => <button key={tab.id} type="button" onClick={() => { activateWorkspaceTab(tab.id); setActivityPanelOpen(false); }} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", minHeight: 38, padding: "6px 8px", border: 0, borderRadius: 6, background: "transparent", color: "var(--text)", cursor: "pointer", textAlign: "left", font: "11px/1.3 inherit" }}><ProductStatusDot status={tab.status === "approval" ? "approval" : "running"} size={7} /><span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tab.label}</span><small style={{ color: tab.status === "approval" ? getProductStatus("approval").color : "var(--text-dim)" }}>{tab.status}</small></button>)}
      <div style={{ marginTop: 4, borderTop: "1px solid var(--border)" }}><RecentNotifications workspaces={projectWorkspaces} onOpen={(workspace, target) => { setActivityPanelOpen(false); handleOpenActivityItem(workspace, target); }} /></div>
    </div>}
  </div>;
  const topRightControls = <div style={{ display: "flex", alignSelf: "stretch", flexShrink: 0, marginLeft: "auto", marginRight: rightPanelOpen ? 0 : 36 }}>
    {activityControl}
  </div>;
  const activeCwdName = activeCwd ? getFileName(activeCwd) || activeCwd : null;
  const windowTitle = activeCwdName ? `${activeCwdName} - TianForge pi` : "TianForge pi";

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
        onExplorerPathRenamed={handleExplorerPathRenamed}
        onExplorerPathDeleted={handleExplorerPathDeleted}
        explorerRefreshKey={explorerRefreshKey}
        onExplorerRefresh={handleExplorerRefresh}
        onAtMention={handleAtMention}
        onAtMentions={handleAtMentions}
        gitReviewOpen={rightPanelOpen && activeFileTabId === GIT_REVIEW_TAB_ID}
        onNewAgent={setNewTerminalProvider}
        onAgentTerminalRemoved={handleAgentTerminalRemoved}
        onCodexSessionChanged={handleCodexSessionChanged}
        requestedModule={isMobile ? mobileSidebarModule : undefined}
        explorerRevealKey={isMobile ? mobileExplorerRevealKey : undefined}
        explorerRevealRequest={explorerRevealRequest}
        cwdResetKey={sidebarCwdResetKey}
        onOpenSettings={() => setSettingsOpen(true)}
      />
    </>
  );

  return (
    <WorkspaceActionsProvider value={workspaceActions}>
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
      ref={layoutRootRef}
      className={isResizing ? "layout-resizing" : undefined}
      style={{
        display: "flex",
        height: "100dvh",
        overflow: "hidden",
        background: "var(--bg)",
        ...layoutStyle,
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
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenActivityItem={handleOpenActivityItem}
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
            <TabBar ariaLabel="Workspace tabs" tabs={workspaceTabs} activeTabId={activeWorkspaceTabId} onSelectTab={handleSelectWorkspaceTab} onCloseTab={handleCloseWorkspaceTab} />
          </div>
          {showWorkspaceTabBar && topRightControls}
        </div>
        {/* Pi-specific controls are only relevant while the Pi workspace is active. */}
        <TopBar
          activeWorkspaceTabId={activeWorkspaceTabId}
          showWorkspaceTabBar={showWorkspaceTabBar}
          handleSidebarToggle={handleSidebarToggle}
          sidebarOpen={sidebarOpen}
          showChat={showChat}
          handleViewFullHistory={handleViewFullHistory}
          selectedSession={selectedSession}
          isMobile={isMobile}
          sessionStats={sessionStats}
          autoNameStatus={autoNameStatus}
          handleAutoName={handleAutoName}
          branchTree={branchTree}
          branchActiveLeafId={branchActiveLeafId}
          handleBranchLeafChange={handleBranchLeafChange}
          activeTopPanel={activeTopPanel}
          toggleTopPanel={toggleTopPanel}
          systemPrompt={systemPrompt}
          systemPromptLoading={systemPromptLoading}
          contextUsage={contextUsage}
          rightPanelOpen={rightPanelOpen}
          copiedSessionField={copiedSessionField}
          handleCopySessionField={handleCopySessionField}
          topRightControls={topRightControls}
        />

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
                    <span style={{ color: "var(--text-dim)", marginRight: 6 }}>2.</span>Add models via <strong style={{ color: "var(--text)" }}>Settings → Models</strong>
                  </div>
                </div>
              </div>
            )
          ) : null}
          </div>
          <CenterWorkspace state={center} renderTab={(tab) => {
            if (tab.kind === "claude-chat") return <ClaudeChatTabView tab={tab} activeCwd={activeCwd} onStatusChange={handleCodexTabStatus} onConfigurationChange={handleClaudeTabConfiguration} onCreated={handleClaudeChatCreated} />;
            const terminal = tab.terminalId ? terminals[tab.terminalId] ?? null : null;
            return tab.kind === "codex-chat" && (terminal || tab.sourceSessionId || tab.newChat)
              ? <CodexChatTabView tab={tab} terminal={terminal} activeCwd={activeCwd} onStatusChange={handleCodexTabStatus} onConfigurationChange={handleCodexTabConfiguration} onCreated={handleCodexChatCreated} />
              : <TerminalTabView tab={tab} terminals={terminals} split={terminalSplit} workspaceTabs={workspaceTabs} isMobile={isMobile} activeTerminalPaneId={activeTerminalPaneId} onActivatePane={setActiveTerminalPaneId} terminalRestartingId={terminalRestartingId} terminalRestartError={terminalRestartError} terminalRestoreErrors={terminalRestoreErrors} isActive={activeWorkspaceTabId === tab.id} onConnectionChange={handleTerminalConnection} onSetSplit={setTerminalSplit} onActivateTab={activateWorkspaceTab} onRestart={(target) => void restartUnavailableTerminal(target)} onTerminalChange={handleTerminalChanged} onTerminalStarted={handleTerminalCreated} onOpenCodexChat={handleOpenCodexChat} onBeginSplitResize={beginTerminalSplitResize} />;
          }} />
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
              ariaLabel="File and tool tabs"
              tabs={fileTabs}
              activeTabId={activeFileTabId ?? ""}
              onSelectTab={(id) => dispatchSide({ type: "activate", id })}
              onCloseTab={handleCloseFileTab}
              onCloseTabs={handleCloseFileTabs}
              onToggleTabLocked={handleToggleFileTabLocked}
              onRevealFile={handleRevealFileInExplorer}
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
            title={!activeCwd ? "Select a workspace to review Git changes" : (rightPanelOpen && activeFileTabId === GIT_REVIEW_TAB_ID ? "Close Git Review" : "Open Git Review")}
            aria-label={rightPanelOpen && activeFileTabId === GIT_REVIEW_TAB_ID ? "Close Git Review" : "Open Git Review"}
            aria-pressed={rightPanelOpen && activeFileTabId === GIT_REVIEW_TAB_ID}
            style={{ width: 36, height: 36, padding: 0, border: "none", borderLeft: "1px solid var(--border)", background: "transparent", color: activeCwd ? "var(--text-muted)" : "var(--text-dim)", cursor: activeCwd ? "pointer" : "not-allowed", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="6" cy="6" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="12" cy="18" r="2" />
              <path d="M8 6h8M6 8v4a6 6 0 0 0 6 6M18 8v4a6 6 0 0 1-6 6" />
            </svg>
          </button>
          {!isMobile && (
            <button
              type="button"
              onClick={() => setRightPanelOpen(false)}
              title="Hide file panel"
              aria-label="Hide file panel"
              style={rightPanelHeaderButtonStyle}
            >
              <PanelRightClose size={16} />
            </button>
          )}
        </div>

        {/* File content */}
        <div style={{ flex: 1, overflow: "hidden", ...(chatHidden ? { width: "auto", minWidth: 0 } : {}) }}>
          <SidePanel tab={activeFileTab} renderTab={(tab) => tab.kind === "file"
            ? <FileTabView tab={tab} activeCwd={activeCwd} gitRefreshKey={explorerRefreshKey} onMentionLines={rightPanelOpen ? handleFileLineMention : undefined} />
            : <GitTabView activeCwd={activeCwd} gitRefreshKey={explorerRefreshKey} onRepoChanged={handleExplorerRefresh} />
          } />
        </div>
      </div>
    </div>
    {isMobile && !rightPanelFullscreen && <nav className="mobile-main-nav" aria-label="Mobile navigation">
      <button type="button" aria-pressed={!sidebarOpen && !rightPanelOpen} onClick={() => { setSidebarOpen(false); setRightPanelOpen(false); }}><PanelsTopLeft size={18} /><small>Workspace</small></button>
      <button type="button" aria-pressed={sidebarOpen && mobileSidebarModule === "agents"} onClick={() => { prepareMobileOverlayHistory(); setMobileSidebarModule("agents"); setRightPanelOpen(false); setSidebarOpen(true); }}><Bot size={18} /><small>Agents</small></button>
      <button type="button" aria-pressed={sidebarOpen && mobileSidebarModule === "explorer"} onClick={() => { prepareMobileOverlayHistory(); setMobileSidebarModule("explorer"); setMobileExplorerRevealKey((key) => key + 1); setRightPanelOpen(false); setSidebarOpen(true); }}><Files size={18} /><small>Files</small></button>
      <button type="button" disabled={!activeCwd} aria-pressed={rightPanelOpen && activeFileTabId === GIT_REVIEW_TAB_ID} onClick={() => { setSidebarOpen(false); if (!(rightPanelOpen && activeFileTabId === GIT_REVIEW_TAB_ID)) { prepareMobileOverlayHistory(); handleOpenGitReview(); } else setRightPanelOpen(false); }}><GitBranch size={18} /><small>Git</small></button>
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
      <PanelRightOpen size={16} />
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
    {settingsOpen && <SettingsPanel
      isDark={isDark}
      cwd={activeCwd ?? selectedSession?.cwd ?? newSessionCwd}
      sessionId={selectedSession?.id ?? null}
      onClose={() => { setSettingsOpen(false); setModelsRefreshKey((key) => key + 1); }}
      onToggleTheme={() => toggleTheme()}
      onModelsChanged={() => setModelsRefreshKey((key) => key + 1)}
      onPluginsReloaded={() => setSessionKey((key) => key + 1)}
    />}
    </WorkspaceActionsProvider>
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
