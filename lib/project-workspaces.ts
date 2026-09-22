export const PROJECT_WORKSPACES_STORAGE_KEY = "pi-web:project-workspaces:v1";
export const RECENT_PROJECTS_STORAGE_KEY = "pi-web:recent-projects:v1";

export interface ProjectWorkspace {
  id: string;
  projectRoot: string;
  cwd: string;
  label: string;
  sessionId: string | null;
  lastActive: number;
  pinned?: boolean;
}

export interface RecentProject {
  path: string;
  label: string;
  lastOpened: number;
}

export interface ProjectWorkspaceSnapshot {
  workspaces: ProjectWorkspace[];
  activeId: string | null;
}

export interface RecoverableProjectSession {
  id: string;
  cwd: string;
  modified: string;
  projectRoot?: string;
}

export function projectLabel(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).filter(Boolean).pop() || path;
}

export function upsertProjectWorkspace(
  workspaces: ProjectWorkspace[],
  input: Pick<ProjectWorkspace, "projectRoot" | "cwd"> & Partial<Pick<ProjectWorkspace, "sessionId" | "lastActive" | "label" | "pinned">>,
): ProjectWorkspace[] {
  const id = input.projectRoot;
  const existing = workspaces.find((workspace) => workspace.id === id);
  const next: ProjectWorkspace = {
    id,
    projectRoot: input.projectRoot,
    cwd: input.cwd,
    label: input.label || existing?.label || projectLabel(input.projectRoot),
    sessionId: input.sessionId !== undefined ? input.sessionId : existing?.sessionId ?? null,
    lastActive: input.lastActive ?? Date.now(),
    pinned: input.pinned ?? existing?.pinned ?? false,
  };
  const normalized = workspaces.filter((workspace) => workspace.id !== input.cwd || workspace.id === id);
  const existingIndex = normalized.findIndex((workspace) => workspace.id === id);
  if (existingIndex < 0) return [...normalized, next];
  return normalized.map((workspace, index) => index === existingIndex ? next : workspace);
}

export function parseProjectWorkspaceSnapshot(raw: string | null): ProjectWorkspaceSnapshot {
  if (!raw) return { workspaces: [], activeId: null };
  try {
    const value = JSON.parse(raw) as { workspaces?: unknown; activeId?: unknown };
    const workspaces = Array.isArray(value.workspaces) ? value.workspaces.flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object") return [];
      const item = candidate as Partial<ProjectWorkspace>;
      if (typeof item.projectRoot !== "string" || !item.projectRoot || typeof item.cwd !== "string" || !item.cwd) return [];
      return [{
        id: item.projectRoot,
        projectRoot: item.projectRoot,
        cwd: item.cwd,
        label: typeof item.label === "string" && item.label ? item.label : projectLabel(item.projectRoot),
        sessionId: typeof item.sessionId === "string" ? item.sessionId : null,
        lastActive: typeof item.lastActive === "number" ? item.lastActive : 0,
        pinned: item.pinned === true,
      }];
    }) : [];
    const activeId = typeof value.activeId === "string" && workspaces.some((workspace) => workspace.id === value.activeId) ? value.activeId : workspaces[0]?.id ?? null;
    return { workspaces, activeId };
  } catch {
    return { workspaces: [], activeId: null };
  }
}

/**
 * Rebuild the project rail when this browser origin has no saved UI state.
 * HTTP, HTTPS, localhost, LAN IPs, and Tailscale names each get isolated
 * localStorage, while their Pi sessions still come from the same server.
 */
export function recoverProjectWorkspaceSnapshot(sessions: RecoverableProjectSession[]): ProjectWorkspaceSnapshot {
  const latestByProject = new Map<string, ProjectWorkspace>();

  for (const session of sessions) {
    if (!session.cwd) continue;
    const projectRoot = session.projectRoot || session.cwd;
    const lastActive = Number.isFinite(Date.parse(session.modified)) ? Date.parse(session.modified) : 0;
    const existing = latestByProject.get(projectRoot);
    if (existing && existing.lastActive > lastActive) continue;
    latestByProject.set(projectRoot, {
      id: projectRoot,
      projectRoot,
      cwd: session.cwd,
      label: projectLabel(projectRoot),
      sessionId: session.id,
      lastActive,
      pinned: false,
    });
  }

  const workspaces = [...latestByProject.values()].sort((left, right) => right.lastActive - left.lastActive);
  return { workspaces, activeId: workspaces[0]?.id ?? null };
}

export function parseRecentProjects(raw: string | null): RecentProject[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object") return [];
      const item = candidate as Partial<RecentProject>;
      if (typeof item.path !== "string" || !item.path) return [];
      return [{ path: item.path, label: typeof item.label === "string" && item.label ? item.label : projectLabel(item.path), lastOpened: typeof item.lastOpened === "number" ? item.lastOpened : 0 }];
    }).sort((left, right) => right.lastOpened - left.lastOpened).slice(0, 12);
  } catch { return []; }
}

export function updateRecentProjects(recent: RecentProject[], path: string, label = projectLabel(path), now = Date.now()): RecentProject[] {
  return [{ path, label, lastOpened: now }, ...recent.filter((item) => item.path !== path)].slice(0, 12);
}
