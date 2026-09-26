import type { ProjectWorkspace } from "./project-workspaces";
import type { WorkspaceActivity } from "./rail-activity";
import type { ActivityNotification } from "./workspace-status-store";

export interface ActivitySection {
  workspace: ProjectWorkspace;
  activity: WorkspaceActivity;
}

/**
 * What the activity center lists: the current workspace first (even when it is
 * idle, so the panel always says what is happening here), then every other
 * workspace with something to show, in rail order.
 */
export function activityCenterSections(workspaces: ProjectWorkspace[], activeId: string | null, activityById: Record<string, WorkspaceActivity>): { current: ActivitySection | null; others: ActivitySection[] } {
  const idle: WorkspaceActivity = { state: "idle", working: 0, approval: 0, failed: 0, completed: 0, items: [] };
  const active = workspaces.find((workspace) => workspace.id === activeId);
  const current = active ? { workspace: active, activity: activityById[active.id] ?? idle } : null;
  const others = workspaces.flatMap((workspace) => {
    const activity = activityById[workspace.id];
    return workspace.id !== active?.id && activity && activity.state !== "idle" ? [{ workspace, activity }] : [];
  });
  return { current, others };
}

/** "1 waiting · 2 working"; empty when idle. */
export function activitySummary(activity: Pick<WorkspaceActivity, "approval" | "failed" | "working" | "completed">): string {
  return [
    activity.approval && `${activity.approval} waiting`,
    activity.failed && `${activity.failed} failed`,
    activity.working && `${activity.working} working`,
    activity.completed && `${activity.completed} completed`,
  ].filter(Boolean).join(" · ");
}

/** Counts across every workspace for the activity buttons: running now (working or waiting) and waiting. */
export function activityTotals(activityById: Record<string, WorkspaceActivity>): { active: number; approval: number } {
  let active = 0;
  let approval = 0;
  for (const activity of Object.values(activityById)) {
    active += activity.working + activity.approval;
    approval += activity.approval;
  }
  return { active, approval };
}

/**
 * Notifications that arrived since `seen` (ids already known), newest last.
 * Null `seen` means the log has not loaded before: nothing is new yet.
 */
export function newNotifications(notifications: ActivityNotification[], seen: ReadonlySet<string> | null): ActivityNotification[] {
  if (!seen) return [];
  return notifications.filter((notification) => !seen.has(notification.id)).reverse();
}
