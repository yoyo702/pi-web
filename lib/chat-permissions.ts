/** A chat permission choice; `danger` is the confirmation text shown before switching to it. */
export type PermissionOption = { value: string; label: string; danger?: string };

/**
 * One wording for every dangerous permission: bypass templates in terminals
 * (Agents "Run anyway") and Full access / Bypass permissions in chats.
 */
export function dangerousPermissionWarning(provider: "codex" | "claude", where: "terminal" | "chat"): string {
  if (provider === "claude") return `Claude skips its permission confirmations in this ${where}, so it may edit files and run commands without asking.`;
  // A Codex chat keeps its sandbox; only the approval prompts stop.
  return where === "terminal"
    ? "Codex skips all approval and sandboxing in this terminal, so it may edit files and run commands without asking."
    : "Codex stops asking for approval in this chat, so it may edit files and run commands without asking.";
}

export const CODEX_CHAT_PERMISSION_OPTIONS: PermissionOption[] = [
  { value: "untrusted", label: "Restricted" },
  { value: "on-request", label: "Ask when needed" },
  { value: "never", label: "Full access", danger: dangerousPermissionWarning("codex", "chat") },
];

export const CLAUDE_CHAT_PERMISSION_OPTIONS: PermissionOption[] = [
  { value: "default", label: "Ask before edits" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "plan", label: "Plan mode" },
  { value: "bypassPermissions", label: "Bypass permissions", danger: dangerousPermissionWarning("claude", "chat") },
];
