import type { ProjectWorkspace } from "./project-workspaces";
import type { ActivityTarget } from "./rail-activity";
import type { ActivityNotification } from "./workspace-status-store";

/** The workspace a notification belongs to: its cwd first, then its project root. */
export function notificationWorkspace(notification: Pick<ActivityNotification, "cwd" | "projectRoot">, workspaces: ProjectWorkspace[]): ProjectWorkspace | null {
  for (const dir of [notification.cwd, notification.projectRoot]) {
    if (!dir) continue;
    const match = workspaces.find((workspace) => workspace.cwd === dir) ?? workspaces.find((workspace) => workspace.projectRoot === dir);
    if (match) return match;
  }
  return null;
}

export function notificationTarget(notification: ActivityNotification): ActivityTarget {
  if (notification.kind === "pi") {
    // Enough to open the session; the opener refreshes it from the session list.
    return {
      kind: "pi",
      id: notification.targetId,
      session: { path: notification.path ?? "", id: notification.targetId, cwd: notification.cwd, created: "", modified: "", messageCount: 0, firstMessage: notification.title, ...(notification.projectRoot ? { projectRoot: notification.projectRoot } : {}) },
    };
  }
  return { kind: notification.kind, id: notification.targetId, cwd: notification.cwd };
}

const KIND_LABEL: Record<ActivityNotification["kind"], string> = { pi: "Pi session", terminal: "Terminal", codex: "Codex chat" };
const EVENT_LABEL: Record<ActivityNotification["event"], string> = { completed: "Completed", failed: "Failed", approval: "Needs your input" };

export function notificationKindLabel(notification: Pick<ActivityNotification, "kind">): string {
  return KIND_LABEL[notification.kind];
}

export function notificationEventLabel(notification: Pick<ActivityNotification, "event">): string {
  return EVENT_LABEL[notification.event];
}

export function notificationAge(createdAt: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - createdAt) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Marks notifications read for every browser; the new state arrives on the status stream. */
export async function markNotificationsRead(request: { ids: string[] } | { all: true }): Promise<void> {
  if ("ids" in request && request.ids.length === 0) return;
  try {
    await fetch("/api/notifications/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
  } catch { /* best effort: the entry just stays unread */ }
}
