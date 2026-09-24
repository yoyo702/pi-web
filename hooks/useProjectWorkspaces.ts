"use client";

import { useCallback, useEffect, useState } from "react";
import {
  PROJECT_WORKSPACES_STORAGE_KEY,
  RECENT_PROJECTS_STORAGE_KEY,
  parseProjectWorkspaceSnapshot,
  parseRecentProjects,
  recoverProjectWorkspaceSnapshot,
  updateRecentProjects,
  type ProjectWorkspace,
} from "@/lib/project-workspaces";
import type { SessionInfo } from "@/lib/types";

function sortPinnedFirst(workspaces: ProjectWorkspace[]): ProjectWorkspace[] {
  return workspaces.sort((left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)));
}

/**
 * The project rail's workspace list and active project, persisted in
 * localStorage. Activation (switching cwd, sessions, and tabs) stays in
 * AppShell; this hook only owns the list itself.
 */
export function useProjectWorkspaces() {
  const [projectWorkspaces, setProjectWorkspaces] = useState<ProjectWorkspace[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [persistenceEnabled, setPersistenceEnabled] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(PROJECT_WORKSPACES_STORAGE_KEY);
    const restored = parseProjectWorkspaceSnapshot(stored);
    if (restored.workspaces.length > 0) {
      setProjectWorkspaces(restored.workspaces);
      setActiveProjectId(restored.activeId);
      setPersistenceEnabled(true);
      setHydrated(true);
      return;
    }

    // A different protocol/host is a new browser origin, so its localStorage
    // starts empty even though it talks to the same TianForge server. Seed the
    // rail from durable Pi sessions instead of presenting an empty product.
    const controller = new AbortController();
    void fetch("/api/sessions", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as { sessions?: SessionInfo[] };
        const recovered = recoverProjectWorkspaceSnapshot(data.sessions ?? []);
        setProjectWorkspaces(recovered.workspaces);
        setActiveProjectId(recovered.activeId);
        setPersistenceEnabled(true);
      })
      .catch(() => {
        // Keep the app usable when the first request is temporarily offline.
        // We deliberately do not create the storage key in this case so the
        // next page load can attempt recovery again.
      })
      .finally(() => {
        if (!controller.signal.aborted) setHydrated(true);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!hydrated || !persistenceEnabled) return;
    try { localStorage.setItem(PROJECT_WORKSPACES_STORAGE_KEY, JSON.stringify({ workspaces: projectWorkspaces, activeId: activeProjectId })); } catch { /* storage may be unavailable */ }
  }, [activeProjectId, projectWorkspaces, hydrated, persistenceEnabled]);

  const rememberRecentProject = useCallback((workspace: ProjectWorkspace) => {
    try {
      const recent = parseRecentProjects(localStorage.getItem(RECENT_PROJECTS_STORAGE_KEY));
      localStorage.setItem(RECENT_PROJECTS_STORAGE_KEY, JSON.stringify(updateRecentProjects(recent, workspace.projectRoot, workspace.label)));
    } catch { /* local storage may be unavailable */ }
  }, []);

  const reorderProjectWorkspaces = useCallback((sourceId: string, targetId: string) => {
    setProjectWorkspaces((current) => {
      const sourceIndex = current.findIndex((workspace) => workspace.id === sourceId);
      const targetIndex = current.findIndex((workspace) => workspace.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0) return current;
      const next = [...current];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      return sortPinnedFirst(next);
    });
  }, []);

  const renameProjectWorkspace = useCallback((workspace: ProjectWorkspace, label: string) => {
    const nextLabel = label.trim();
    if (!nextLabel) return;
    const renamed = { ...workspace, label: nextLabel };
    setProjectWorkspaces((current) => current.map((candidate) => candidate.id === workspace.id ? renamed : candidate));
    rememberRecentProject(renamed);
  }, [rememberRecentProject]);

  const togglePinnedProjectWorkspace = useCallback((workspace: ProjectWorkspace) => {
    setProjectWorkspaces((current) => sortPinnedFirst(current
      .map((candidate) => candidate.id === workspace.id ? { ...candidate, pinned: !candidate.pinned } : candidate)));
  }, []);

  return {
    projectWorkspaces,
    setProjectWorkspaces,
    activeProjectId,
    setActiveProjectId,
    projectWorkspacesHydrated: hydrated,
    rememberRecentProject,
    reorderProjectWorkspaces,
    renameProjectWorkspace,
    togglePinnedProjectWorkspace,
  };
}
