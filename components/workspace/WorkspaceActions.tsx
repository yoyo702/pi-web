"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { TerminalSession } from "@/lib/agents/terminal";
import type { ClaudePermissionMode, CodexApprovalPolicy } from "@/lib/workspace/tabs";

export interface CodexChatTarget {
  sessionId: string;
  sessionName: string;
  cwd: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  approvalPolicy: CodexApprovalPolicy;
}

export interface ClaudeChatTarget {
  sessionId: string;
  sessionName: string;
  cwd: string;
  model?: string;
  permissionMode?: ClaudePermissionMode;
}

/** A Claude session to fork into a new chat; `at` drops that prompt and what follows. */
export interface ClaudeForkTarget extends ClaudeChatTarget {
  at?: string;
  /** Put in the new chat's composer (the message forked from). */
  draft?: string;
}

/**
 * Commands that open or close workspace tabs. Any component under AppShell
 * (sidebar, chat, viewers, and future status/command UIs) calls these instead
 * of receiving callbacks through props.
 */
export interface WorkspaceActions {
  openFile(filePath: string, options?: { sourceSessionId?: string | null }): void;
  toggleGitReview(): void;
  openTerminal(terminal: TerminalSession, label?: string): void;
  openCodexChat(target: CodexChatTarget): void;
  /** Opens an empty Codex chat in `cwd`; its first message creates the session. */
  newCodexChat(cwd: string): void;
  openClaudeChat(target: ClaudeChatTarget): void;
  /** Opens an empty Claude chat in `cwd`; its first message creates the session. */
  newClaudeChat(cwd: string): void;
  /** Opens a new Claude chat whose first message forks `target`. */
  forkClaudeChat(target: ClaudeForkTarget): void;
  closeTab(tabId: string): void;
  revealInExplorer(filePath: string): void;
}

const WorkspaceActionsContext = createContext<WorkspaceActions | null>(null);

export function WorkspaceActionsProvider({ value, children }: { value: WorkspaceActions; children: ReactNode }) {
  return <WorkspaceActionsContext.Provider value={value}>{children}</WorkspaceActionsContext.Provider>;
}

export function useWorkspaceActions(): WorkspaceActions {
  const actions = useContext(WorkspaceActionsContext);
  if (!actions) throw new Error("useWorkspaceActions must be used inside WorkspaceActionsProvider");
  return actions;
}
