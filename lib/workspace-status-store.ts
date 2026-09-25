import type { TerminalSession, TerminalStats } from "./agents/terminal";

export interface CodexRuntimeStatus {
  threadId: string;
  cwd: string;
  owner?: string;
  state: "idle" | "running" | "approval";
  connected?: boolean;
}

/** One entry of the server's activity notification log (server/notifications.cjs). */
export interface ActivityNotification {
  id: string;
  kind: "codex" | "pi" | "terminal";
  event: "completed" | "failed" | "approval";
  /** Codex thread id, Pi session id or terminal id. */
  targetId: string;
  cwd: string;
  /** Main checkout of a worktree cwd. */
  projectRoot?: string;
  title: string;
  detail?: string;
  /** Pi session file. */
  path?: string;
  createdAt: number;
  read: boolean;
}

export interface WorkspaceStatusSnapshot {
  /** null until the first message of that kind arrives */
  runningSessionIds: string[] | null;
  terminals: TerminalSession[] | null;
  terminalLimits: TerminalStats["limits"] | null;
  codexRuntimes: CodexRuntimeStatus[] | null;
  /** Newest first. */
  notifications: ActivityNotification[] | null;
  unreadNotifications: number;
}

export interface WorkspaceStatusStore {
  getSnapshot(): WorkspaceStatusSnapshot;
  subscribe(listener: () => void): () => void;
  /** Apply an SSE message; ignores unknown types. */
  apply(message: unknown): void;
  /** Replace the terminals of one canonical cwd (from GET /api/terminals). */
  replaceTerminalsForCwd(cwd: string, terminals: TerminalSession[], limits: TerminalStats["limits"] | null): void;
  /** Optimistic local edit of one cwd's terminals; the next pushed snapshot wins. */
  updateTerminalsForCwd(cwd: string, update: (terminals: TerminalSession[]) => TerminalSession[]): void;
}

const EMPTY_SNAPSHOT: WorkspaceStatusSnapshot = {
  runningSessionIds: null,
  terminals: null,
  terminalLimits: null,
  codexRuntimes: null,
  notifications: null,
  unreadNotifications: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function createWorkspaceStatusStore(): WorkspaceStatusStore {
  let snapshot: WorkspaceStatusSnapshot = EMPTY_SNAPSHOT;
  const listeners = new Set<() => void>();

  function notify(next: WorkspaceStatusSnapshot): void {
    snapshot = next;
    for (const listener of listeners) listener();
  }

  return {
    getSnapshot(): WorkspaceStatusSnapshot {
      return snapshot;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    apply(message: unknown): void {
      if (!isRecord(message) || typeof message.type !== "string") return;
      switch (message.type) {
        case "running": {
          if (!Array.isArray(message.runningSessionIds)) return;
          notify({ ...snapshot, runningSessionIds: message.runningSessionIds as string[] });
          return;
        }
        case "terminals": {
          if (!Array.isArray(message.terminals)) return;
          const limits = (message.limits ?? null) as TerminalStats["limits"] | null;
          notify({ ...snapshot, terminals: message.terminals as TerminalSession[], terminalLimits: limits });
          return;
        }
        case "codex_runtimes": {
          if (!Array.isArray(message.runtimes)) return;
          notify({ ...snapshot, codexRuntimes: message.runtimes as CodexRuntimeStatus[] });
          return;
        }
        case "notifications": {
          if (!Array.isArray(message.notifications)) return;
          const unread = typeof message.unread === "number" ? message.unread : 0;
          notify({ ...snapshot, notifications: message.notifications as ActivityNotification[], unreadNotifications: unread });
          return;
        }
        default:
          return;
      }
    },

    replaceTerminalsForCwd(cwd: string, terminals: TerminalSession[], limits: TerminalStats["limits"] | null): void {
      const others = (snapshot.terminals ?? []).filter((terminal) => terminal.cwd !== cwd);
      notify({
        ...snapshot,
        terminals: [...others, ...terminals],
        terminalLimits: limits ?? snapshot.terminalLimits,
      });
    },

    updateTerminalsForCwd(cwd: string, update: (terminals: TerminalSession[]) => TerminalSession[]): void {
      const current = snapshot.terminals ?? [];
      const forCwd = current.filter((terminal) => terminal.cwd === cwd);
      const others = current.filter((terminal) => terminal.cwd !== cwd);
      notify({ ...snapshot, terminals: [...others, ...update(forCwd)] });
    },
  };
}

export function terminalsForCwd(snapshot: WorkspaceStatusSnapshot, cwd: string): TerminalSession[] {
  return (snapshot.terminals ?? []).filter((terminal) => terminal.cwd === cwd);
}

export function terminalStatsForCwd(snapshot: WorkspaceStatusSnapshot, cwd: string): TerminalStats | null {
  if (snapshot.terminals === null) return null;
  const workspaceTerminals = terminalsForCwd(snapshot, cwd);
  const globalTerminals = snapshot.terminals;
  const sum = (terminals: TerminalSession[]): { running: number; records: number; bufferBytes: number } => ({
    running: terminals.filter((terminal) => terminal.state === "running").length,
    records: terminals.length,
    bufferBytes: terminals.reduce((total, terminal) => total + (terminal.bufferBytes ?? 0), 0),
  });
  return {
    workspace: sum(workspaceTerminals),
    global: sum(globalTerminals),
    limits: snapshot.terminalLimits ?? { running: 0, records: 0 },
  };
}
