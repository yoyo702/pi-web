export type ProductStatusId =
  | "git-changes"
  | "running"
  | "approval"
  | "failed"
  | "completed"
  | "connecting"
  | "offline"
  | "ended"
  | "unread"
  | "uploaded"
  | "watching"
  | "idle";

export type ProductStatusGroup = "source-control" | "activity" | "connection" | "attention";

export interface ProductStatusDefinition {
  id: ProductStatusId;
  label: string;
  description: string;
  color: string;
  group: ProductStatusGroup;
}

export const PRODUCT_STATUS: Record<ProductStatusId, ProductStatusDefinition> = {
  "git-changes": { id: "git-changes", label: "Git changes", description: "Modified, added, deleted, or untracked files are not committed.", color: "var(--status-git-changes)", group: "source-control" },
  running: { id: "running", label: "Running", description: "An agent, task, terminal, or live process is running.", color: "var(--status-running)", group: "activity" },
  approval: { id: "approval", label: "Waiting for approval", description: "A task needs your confirmation before it can continue.", color: "var(--status-approval)", group: "activity" },
  failed: { id: "failed", label: "Failed", description: "A recent task or process exited with an error.", color: "var(--status-failed)", group: "activity" },
  completed: { id: "completed", label: "Recently completed", description: "A task finished recently; this temporary indicator clears automatically.", color: "var(--status-completed)", group: "activity" },
  connecting: { id: "connecting", label: "Connecting", description: "A live connection is being established.", color: "var(--status-connecting)", group: "connection" },
  offline: { id: "offline", label: "Offline", description: "The live connection is unavailable and may need to be reopened.", color: "var(--status-offline)", group: "connection" },
  ended: { id: "ended", label: "Ended", description: "The process has stopped and only its retained record remains.", color: "var(--text-dim)", group: "connection" },
  unread: { id: "unread", label: "New activity", description: "A background session has new activity you have not opened yet.", color: "var(--status-unread)", group: "attention" },
  uploaded: { id: "uploaded", label: "Newly uploaded", description: "The file was added during the current upload operation.", color: "var(--status-uploaded)", group: "attention" },
  watching: { id: "watching", label: "Live updates", description: "The displayed resource is watching its source for changes.", color: "var(--status-watching)", group: "connection" },
  idle: { id: "idle", label: "Idle", description: "No work or live activity is currently running.", color: "var(--text-dim)", group: "activity" },
};

export const PRODUCT_STATUS_GROUP_LABELS: Record<ProductStatusGroup, string> = {
  "source-control": "Source control",
  activity: "Task activity",
  connection: "Connections",
  attention: "Attention",
};

export const PRODUCT_STATUS_GUIDE: ProductStatusId[] = [
  "git-changes",
  "running",
  "approval",
  "failed",
  "completed",
  "connecting",
  "offline",
  "ended",
  "unread",
  "uploaded",
  "watching",
];

export function getProductStatus(id: ProductStatusId): ProductStatusDefinition {
  return PRODUCT_STATUS[id];
}
