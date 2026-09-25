"use client";

import { useEffect, useState } from "react";
import { Bot, TerminalSquare } from "lucide-react";
import { ProductStatusDot } from "./ProductStatus";
import { useWorkspaceStatus } from "@/hooks/useWorkspaceStatus";
import { markNotificationsRead, notificationAge, notificationEventLabel, notificationKindLabel, notificationTarget, notificationWorkspace } from "@/lib/activity-notifications";
import type { ProjectWorkspace } from "@/lib/project-workspaces";
import type { ActivityTarget } from "@/lib/rail-activity";
import type { ActivityNotification } from "@/lib/workspace-status-store";

const EVENT_STATUS = { completed: "completed", failed: "failed", approval: "approval" } as const;

/**
 * The server's notification log (finished, failed and waiting runs of the
 * last 7 days), shared by every browser: reading an entry here marks it read
 * on the other devices too. Unread entries are bold.
 */
export function RecentNotifications({ workspaces, onOpen }: {
  workspaces: ProjectWorkspace[];
  /** Opens the entry's session, terminal or Codex chat in its workspace. */
  onOpen: (workspace: ProjectWorkspace, target: ActivityTarget) => void;
}) {
  const { notifications, unreadNotifications } = useWorkspaceStatus();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const entries = notifications ?? [];

  const open = (notification: ActivityNotification) => {
    if (!notification.read) void markNotificationsRead({ ids: [notification.id] });
    const workspace = notificationWorkspace(notification, workspaces);
    if (workspace) onOpen(workspace, notificationTarget(notification));
  };

  return <section aria-label="Recent notifications" style={{ display: "grid", gap: 1 }}>
    <header style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 7px 4px" }}>
      <strong style={{ flex: 1, color: "var(--text-muted)", fontSize: 10, textTransform: "uppercase", letterSpacing: ".04em" }}>Recent{unreadNotifications > 0 ? ` · ${unreadNotifications} unread` : ""}</strong>
      {unreadNotifications > 0 && <button type="button" onClick={() => void markNotificationsRead({ all: true })} style={{ padding: "3px 6px", border: 0, borderRadius: 5, background: "transparent", color: "var(--accent)", cursor: "pointer", font: "600 10px/1 inherit" }}>Mark all read</button>}
    </header>
    {entries.map((notification) => {
      const workspace = notificationWorkspace(notification, workspaces);
      const Icon = notification.kind === "terminal" ? TerminalSquare : Bot;
      const meta = [workspace?.label, notificationKindLabel(notification), notificationEventLabel(notification), notificationAge(notification.createdAt, now)].filter(Boolean).join(" · ");
      return <button
        key={notification.id}
        type="button"
        data-unread={notification.read ? undefined : "true"}
        aria-label={`${notification.title} · ${notificationKindLabel(notification)} · ${notificationEventLabel(notification)}${notification.read ? "" : " · unread"}`}
        title={`${notification.title}${notification.detail ? `\n${notification.detail}` : ""}\n${notification.cwd}${workspace ? "" : "\nThis project is not open."}`}
        onClick={() => open(notification)}
        style={{ width: "100%", minHeight: 40, display: "flex", alignItems: "center", gap: 8, padding: "5px 7px", border: 0, borderRadius: 6, background: "transparent", color: notification.read ? "var(--text-muted)" : "var(--text)", cursor: "pointer", textAlign: "left", font: "11px/1.3 inherit" }}
      >
        <ProductStatusDot status={EVENT_STATUS[notification.event]} size={7} title={notificationEventLabel(notification)} />
        <Icon size={12} aria-hidden="true" style={{ flexShrink: 0, color: "var(--text-dim)" }} />
        <span style={{ minWidth: 0, flex: 1, display: "grid", gap: 2 }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: notification.read ? 400 : 700 }}>{notification.title}</span>
          <small style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)", fontSize: 10 }}>{notification.detail && notification.event === "failed" ? `${meta} · ${notification.detail}` : meta}</small>
        </span>
      </button>;
    })}
    {entries.length === 0 && <div style={{ padding: "10px 7px", color: "var(--text-dim)", fontSize: 11 }}>No notifications in the last 7 days</div>}
  </section>;
}

/** Unread notification count for an activity button; nothing when all are read. */
export function UnreadNotificationBadge() {
  const { unreadNotifications } = useWorkspaceStatus();
  if (unreadNotifications <= 0) return null;
  return <span data-testid="activity-unread-count" aria-label={`${unreadNotifications} unread`} style={{ minWidth: 14, height: 14, display: "grid", placeItems: "center", padding: "0 3px", borderRadius: 999, background: "var(--accent)", color: "white", fontSize: 8, fontWeight: 800 }}>{Math.min(99, unreadNotifications)}</span>;
}
