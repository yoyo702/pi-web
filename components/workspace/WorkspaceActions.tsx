"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { TerminalSession } from "@/lib/agents/terminal";
import type { CodexApprovalPolicy } from "@/lib/workspace/tabs";

export interface CodexChatTarget {
  sessionId: string;
  sessionName: string;
  cwd: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  approvalPolicy: CodexApprovalPolicy;
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
