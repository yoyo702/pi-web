import type { ClaudeRuntimeStatus, CodexRuntimeStatus } from "./workspace-status-store";
import type { CenterTab } from "./workspace/tabs";

export interface BusyChat {
  kind: "codex" | "claude";
  /** Codex thread id or Claude session id. */
  id: string;
  cwd: string;
  state: "running" | "approval";
}

/**
 * The server runtime a chat tab would leave running if it closed, or null.
 * Decided from the pushed runtime lists, not the tab's status: a restored tab
 * is always "idle" until its panel reconnects.
 */
export function busyChatForTab(tab: CenterTab, codexRuntimes: CodexRuntimeStatus[], claudeRuntimes: ClaudeRuntimeStatus[]): BusyChat | null {
  if (tab.kind === "codex-chat" && tab.sourceSessionId) {
    const runtime = codexRuntimes.find((item) => item.threadId === tab.sourceSessionId);
    if (runtime && runtime.state !== "idle") return { kind: "codex", id: runtime.threadId, cwd: runtime.cwd, state: runtime.state };
  }
  if (tab.kind === "claude-chat" && tab.sourceSessionId) {
    const runtime = claudeRuntimes.find((item) => item.sessionId === tab.sourceSessionId);
    if (runtime && runtime.state !== "idle") return { kind: "claude", id: runtime.sessionId, cwd: runtime.cwd, state: runtime.state };
  }
  return null;
}
