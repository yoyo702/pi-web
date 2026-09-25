import type { TerminalSession } from "./agents/terminal";
import type { ProjectWorkspace } from "./project-workspaces";
import type { SessionInfo } from "./types";
import type { CodexRuntimeStatus } from "./workspace-status-store";

/**
 * Per-item activity shown by the project rail. Everything here is derived from
 * the pushed workspace status snapshot plus two pieces of memory the rail keeps
 * between snapshots: what was running last time, and what finished recently.
 */
export type RailActivityState = "approval" | "failed" | "working" | "completed";
export type WorkspaceActivityState = RailActivityState | "idle";

interface RailActivityItemBase {
  /** Stable identity: `pi:<sessionId>`, `terminal:<terminalId>`, `codex:<threadId>`. */
  key: string;
  id: string;
  label: string;
  state: RailActivityState;
  /** Directory used to match the item to a project workspace. */
  cwd: string;
}

export type RailActivityItem =
  | (RailActivityItemBase & { kind: "pi"; session: SessionInfo })
  | (RailActivityItemBase & { kind: "terminal"; terminal: TerminalSession })
  | (RailActivityItemBase & { kind: "codex"; runtime: CodexRuntimeStatus });

/** What opening an activity item or notification needs: the session, terminal or Codex chat and its directory. */
export type ActivityTarget =
  | { kind: "pi"; id: string; session: SessionInfo }
  | { kind: "terminal"; id: string; cwd: string }
  | { kind: "codex"; id: string; cwd: string };

export function activityTarget(item: RailActivityItem): ActivityTarget {
  if (item.kind === "pi") return { kind: "pi", id: item.id, session: item.session };
  if (item.kind === "terminal") return { kind: "terminal", id: item.id, cwd: item.terminal.cwd };
  return { kind: "codex", id: item.id, cwd: item.runtime.cwd };
}

export interface RailCompletedEntry {
  until: number;
  item: RailActivityItem;
}

export interface WorkspaceActivity {
  state: WorkspaceActivityState;
  working: number;
  approval: number;
  failed: number;
  completed: number;
  items: RailActivityItem[];
}

/** How long a finished session/terminal/Codex run stays listed as completed. */
export const RECENTLY_COMPLETED_MS = 30_000;
/** How long an ended terminal keeps reporting completed/failed. */
export const ENDED_TERMINAL_MS = 5 * 60_000;

const STATE_PRIORITY: Record<RailActivityState, number> = { approval: 0, failed: 1, working: 2, completed: 3 };

export function terminalActivityLabel(terminal: Pick<TerminalSession, "title" | "provider">): string {
  // Same fallback the workspace tab uses, so the row and the tab it opens match.
  return terminal.title || (terminal.provider === "shell" ? "Terminal" : `${terminal.provider} terminal`);
}

export function sessionActivityLabel(session: Pick<SessionInfo, "id" | "name" | "firstMessage">): string {
  const name = session.name?.trim();
  if (name) return name;
  const first = session.firstMessage?.replace(/\s+/g, " ").trim();
  if (first) return first.length > 60 ? `${first.slice(0, 59)}…` : first;
  return session.id.slice(0, 8);
}

export function codexActivityLabel(threadId: string): string {
  return `Codex chat · ${threadId.slice(0, 8)}`;
}

export interface RailActivityInput {
  terminals: TerminalSession[];
  runningSessionIds: string[];
  codexRuntimes: CodexRuntimeStatus[];
  /** Sessions known from the last /api/sessions response. */
  sessionsById: ReadonlyMap<string, SessionInfo>;
  /** `running` from the previous computation; null before the first one. */
  previousRunning: ReadonlyMap<string, RailActivityItem> | null;
  /** `completed` from the previous computation. */
  completed: ReadonlyMap<string, RailCompletedEntry>;
  now: number;
}

export interface RailActivityResult {
  /** Items running right now, keyed by item key (feed back as `previousRunning`). */
  running: Map<string, RailActivityItem>;
  /** Recently completed items still inside their window (feed back as `completed`). */
  completed: Map<string, RailCompletedEntry>;
  /** Every non-idle item: running, ended terminals, and recently completed. */
  items: RailActivityItem[];
  /** Earliest moment an item leaves its window (Infinity when none will). */
  nextExpiry: number;
}

export function computeRailActivity(input: RailActivityInput): RailActivityResult {
  const { terminals, runningSessionIds, codexRuntimes, sessionsById, previousRunning, now } = input;
  const running = new Map<string, RailActivityItem>();
  for (const terminal of terminals) {
    if (terminal.state !== "running") continue;
    const key = `terminal:${terminal.id}`;
    running.set(key, { key, kind: "terminal", id: terminal.id, label: terminalActivityLabel(terminal), state: "working", cwd: terminal.cwd, terminal });
  }
  for (const id of runningSessionIds) {
    // A session whose project is unknown cannot be placed on a workspace yet.
    const session = sessionsById.get(id);
    if (!session) continue;
    const key = `pi:${id}`;
    running.set(key, { key, kind: "pi", id, label: sessionActivityLabel(session), state: "working", cwd: session.projectRoot || session.cwd, session });
  }
  for (const runtime of codexRuntimes) {
    if (runtime.state === "idle") continue;
    const key = `codex:${runtime.threadId}`;
    running.set(key, { key, kind: "codex", id: runtime.threadId, label: codexActivityLabel(runtime.threadId), state: runtime.state === "approval" ? "approval" : "working", cwd: runtime.cwd, runtime });
  }

  const completed = new Map<string, RailCompletedEntry>();
  for (const [key, entry] of input.completed) if (entry.until > now && !running.has(key)) completed.set(key, entry);
  if (previousRunning) {
    for (const [key, item] of previousRunning) {
      if (running.has(key)) continue;
      // Prefer the latest record so the opener gets current data.
      const latest: RailActivityItem = item.kind === "terminal"
        ? { ...item, terminal: terminals.find((terminal) => terminal.id === item.id) ?? item.terminal }
        : item.kind === "codex"
          ? { ...item, runtime: codexRuntimes.find((runtime) => runtime.threadId === item.id) ?? item.runtime }
          : item;
      completed.set(key, { until: now + RECENTLY_COMPLETED_MS, item: { ...latest, state: "completed" } });
    }
  }

  const items: RailActivityItem[] = [...running.values()];
  let nextExpiry = Infinity;
  // Terminals ended within the window report completed/failed from their exit
  // code. They supersede their own "recently completed" entry so a finished
  // terminal is listed once.
  const endedTerminalKeys = new Set<string>();
  for (const terminal of terminals) {
    if (terminal.state === "running" || !terminal.endedAt) continue;
    const endedAt = Date.parse(terminal.endedAt);
    if (now - endedAt > ENDED_TERMINAL_MS) continue;
    nextExpiry = Math.min(nextExpiry, endedAt + ENDED_TERMINAL_MS);
    const key = `terminal:${terminal.id}`;
    endedTerminalKeys.add(key);
    const failed = terminal.exitCode != null && terminal.exitCode !== 0;
    items.push({ key, kind: "terminal", id: terminal.id, label: terminalActivityLabel(terminal), state: failed ? "failed" : "completed", cwd: terminal.cwd, terminal });
  }
  for (const [key, entry] of completed) {
    nextExpiry = Math.min(nextExpiry, entry.until);
    if (!endedTerminalKeys.has(key)) items.push(entry.item);
  }
  return { running, completed, items, nextExpiry };
}

/** Groups items onto the workspace whose cwd or project root they belong to. */
export function groupRailActivity(items: RailActivityItem[], workspaces: ProjectWorkspace[]): Record<string, WorkspaceActivity> {
  const activities: Record<string, WorkspaceActivity> = {};
  for (const workspace of workspaces) activities[workspace.id] = { state: "idle", working: 0, approval: 0, failed: 0, completed: 0, items: [] };
  for (const item of items) {
    const workspace = workspaces.find((candidate) => item.cwd === candidate.cwd || item.cwd === candidate.projectRoot);
    if (!workspace) continue;
    const activity = activities[workspace.id];
    activity.items.push(item);
    activity[item.state] += 1;
  }
  for (const activity of Object.values(activities)) {
    activity.items.sort((a, b) => STATE_PRIORITY[a.state] - STATE_PRIORITY[b.state]);
    activity.state = activity.approval ? "approval" : activity.failed ? "failed" : activity.working ? "working" : activity.completed ? "completed" : "idle";
  }
  return activities;
}
