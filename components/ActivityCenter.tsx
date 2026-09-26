"use client";

import { useEffect } from "react";
import type { CSSProperties } from "react";
import { Bell, Bot, TerminalSquare, X } from "lucide-react";
import { RecentNotifications } from "./RecentNotifications";
import { PushNotificationsToggle } from "./PushNotificationsToggle";
import { getProductStatus, type ProductStatusId } from "@/lib/product-status";
import { activityCenterSections, activitySummary, type ActivitySection } from "@/lib/activity-center";
import { activityTarget, type ActivityTarget, type RailActivityItem, type WorkspaceActivity, type WorkspaceActivityState } from "@/lib/rail-activity";
import type { ProjectWorkspace } from "@/lib/project-workspaces";

const activityStatus: Record<WorkspaceActivityState, ProductStatusId> = { approval: "approval", failed: "failed", working: "running", completed: "completed", idle: "idle" };
export const activityDefinition = (state: WorkspaceActivityState) => getProductStatus(activityStatus[state]);
const activityKindLabel: Record<RailActivityItem["kind"], string> = { pi: "Pi session", terminal: "Terminal", codex: "Codex chat", claude: "Claude chat" };
const activityItemButtonStyle: CSSProperties = { width: "100%", minHeight: 30, display: "flex", alignItems: "center", gap: 8, padding: "0 7px", border: 0, borderRadius: 6, background: "transparent", color: "var(--text)", cursor: "pointer", font: "11px/1.3 inherit", textAlign: "left" };

/** One session, terminal or chat in an activity list. */
export function ActivityItemButton({ item, onOpen }: { item: RailActivityItem; onOpen: () => void }) {
  const Icon = item.kind === "terminal" ? TerminalSquare : Bot;
  const { color, label } = activityDefinition(item.state);
  return <button type="button" aria-label={`${item.label} · ${activityKindLabel[item.kind]} · ${label}`} title={`${activityKindLabel[item.kind]} · ${item.label}\n${item.cwd}`} onClick={onOpen} style={activityItemButtonStyle}>
    <span aria-hidden="true" style={{ width: 8, height: 8, flexShrink: 0, borderRadius: "50%", background: color }} />
    <Icon size={12} aria-hidden="true" style={{ flexShrink: 0, color: "var(--text-dim)" }} />
    <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.label}</span>
    <small style={{ flexShrink: 0, color, fontSize: 10 }}>{label}</small>
  </button>;
}

function WorkspaceSection({ section, current, onSelectWorkspace, onOpen }: { section: ActivitySection; current: boolean; onSelectWorkspace: (workspace: ProjectWorkspace) => void; onOpen: (workspace: ProjectWorkspace, target: ActivityTarget) => void }) {
  const { workspace, activity } = section;
  const { color, label } = activityDefinition(activity.state);
  const summary = activitySummary(activity);
  return <div className="activity-center-workspace" data-current={current ? "true" : undefined}>
    <button type="button" className="activity-center-workspace-header" onClick={() => onSelectWorkspace(workspace)} title={workspace.cwd}>
      <span aria-hidden="true" style={{ width: 10, height: 10, flexShrink: 0, borderRadius: "50%", background: color, boxShadow: `0 0 0 3px color-mix(in srgb,${color} 18%,transparent)` }} />
      <span style={{ minWidth: 0, flex: 1, display: "grid", gap: 4 }}>
        <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }}>{workspace.label}{current && <small style={{ marginLeft: 6, color: "var(--text-dim)", fontWeight: 500, fontSize: 10 }}>Current</small>}</strong>
        <small style={{ color: "var(--text-dim)", fontSize: 10 }}>{summary || "Nothing running"}</small>
      </span>
      {activity.state !== "idle" && <span style={{ color, fontSize: 10 }}>{label}</span>}
    </button>
    {activity.items.length > 0 && <div role="group" aria-label={`${workspace.label} activity items`} style={{ display: "grid", gap: 1, paddingLeft: 22 }}>
      {activity.items.map((item) => <ActivityItemButton key={item.key} item={item} onOpen={() => onOpen(workspace, activityTarget(item))} />)}
    </div>}
  </div>;
}

/**
 * The activity center, opened from the rail bell and the toolbar activity
 * button: the current workspace, the other workspaces with something running,
 * waiting, failed or just finished, the server's recent notifications, and
 * the "Notify this device" switch. A bottom sheet on phones.
 */
export function ActivityCenter({ workspaces, activeId, activityById, onClose, onSelectWorkspace, onOpen }: {
  workspaces: ProjectWorkspace[];
  activeId: string | null;
  activityById: Record<string, WorkspaceActivity>;
  onClose: () => void;
  onSelectWorkspace: (workspace: ProjectWorkspace) => void;
  /** Opens an item or notification (session, terminal, Codex or Claude chat), switching workspace first when needed. */
  onOpen: (workspace: ProjectWorkspace, target: ActivityTarget) => void;
}) {
  const { current, others } = activityCenterSections(workspaces, activeId, activityById);
  const activeCount = others.length + (current && current.activity.state !== "idle" ? 1 : 0);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  const selectWorkspace = (workspace: ProjectWorkspace) => { onClose(); onSelectWorkspace(workspace); };
  const open = (workspace: ProjectWorkspace, target: ActivityTarget) => { onClose(); onOpen(workspace, target); };
  return <div className="activity-center-backdrop" role="dialog" aria-modal="true" aria-label="Workspace activity" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="activity-center">
      <header className="activity-center-header">
        <Bell size={15} color="var(--text-muted)" aria-hidden="true" />
        <strong style={{ flex: 1, color: "var(--text)", fontSize: 13 }}>Workspace activity</strong>
        <span style={{ color: "var(--text-dim)", fontSize: 10 }}>{activeCount} active</span>
        <button type="button" aria-label="Close workspace activity" onClick={onClose} className="activity-center-close"><X size={13} /></button>
      </header>
      <div className="activity-center-body">
        {current && <WorkspaceSection section={current} current onSelectWorkspace={selectWorkspace} onOpen={open} />}
        {others.length > 0 && <div role="group" aria-label="Other workspaces" style={{ display: "grid", gap: 1 }}>
          <div className="activity-center-heading">Other workspaces</div>
          {others.map((section) => <WorkspaceSection key={section.workspace.id} section={section} current={false} onSelectWorkspace={selectWorkspace} onOpen={open} />)}
        </div>}
        {!current && others.length === 0 && <div style={{ padding: 30, textAlign: "center", color: "var(--text-dim)", fontSize: 12 }}>No active, failed, or recently completed tasks</div>}
        <div style={{ marginTop: 4, borderTop: "1px solid var(--border)" }}><RecentNotifications workspaces={workspaces} onOpen={open} /></div>
      </div>
      <PushNotificationsToggle />
    </section>
  </div>;
}
