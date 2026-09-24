import type { SessionInfo } from "./types";

export interface SessionLineage {
  isFork: boolean;
  parent: SessionInfo | null;
  root: SessionInfo;
  depth: number;
  missingParent: boolean;
  lineageComplete: boolean;
}

export function getSessionDisplayTitle(session: SessionInfo): string {
  return session.name || session.firstMessage.slice(0, 50) || session.id.slice(0, 12);
}

export function sortSessionsByRecent(sessions: SessionInfo[]): SessionInfo[] {
  return [...sessions].sort((a, b) => {
    const modified = b.modified.localeCompare(a.modified);
    if (modified !== 0) return modified;
    return b.created.localeCompare(a.created) || a.id.localeCompare(b.id);
  });
}

export function resolveSessionLineage(session: SessionInfo, sessions: SessionInfo[] | ReadonlyMap<string, SessionInfo>): SessionLineage {
  const byId: ReadonlyMap<string, SessionInfo> = Array.isArray(sessions)
    ? new Map(sessions.map((candidate) => [candidate.id, candidate]))
    : sessions;
  const directParent = session.parentSessionId ? byId.get(session.parentSessionId) ?? null : null;
  if (!session.parentSessionId) {
    return { isFork: false, parent: null, root: session, depth: 0, missingParent: false, lineageComplete: true };
  }
  if (!directParent) {
    return { isFork: true, parent: null, root: session, depth: 1, missingParent: true, lineageComplete: false };
  }

  let root = directParent;
  let depth = 1;
  let lineageComplete = true;
  const visited = new Set([session.id]);
  while (root.parentSessionId && !visited.has(root.id)) {
    visited.add(root.id);
    const parent = byId.get(root.parentSessionId);
    if (!parent || visited.has(parent.id)) {
      lineageComplete = false;
      break;
    }
    root = parent;
    depth += 1;
  }
  if (root.parentSessionId && visited.has(root.id)) lineageComplete = false;
  return { isFork: true, parent: directParent, root, depth, missingParent: false, lineageComplete };
}
