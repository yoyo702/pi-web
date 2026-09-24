import type { TerminalLaunchMode, TerminalPermissionMode, TerminalProvider } from "../agents/terminal";

export type TabStatus = "idle" | "running" | "approval" | "connecting" | "offline" | "failed" | "ended";
export type CodexApprovalPolicy = "untrusted" | "on-request" | "never";

interface TabBase {
  id: string;
  label: string;
  closable?: boolean;
  status?: TabStatus;
  /** Locked tabs are persisted but protected from close buttons and bulk close actions. */
  locked?: boolean;
}

export interface PiTab extends TabBase { kind: "pi" }

export interface TerminalTab extends TabBase {
  kind: "terminal";
  terminalId?: string;
  terminalProvider?: TerminalProvider;
  terminalPermissionMode?: TerminalPermissionMode;
  terminalLaunchMode?: TerminalLaunchMode;
  terminalNoAltScreen?: boolean;
  terminalModel?: string | null;
  terminalWebSearch?: boolean;
  terminalChatMode?: boolean;
  cwd?: string;
  sourceSessionId?: string | null;
}

export interface CodexChatTab extends TabBase {
  kind: "codex-chat";
  terminalId?: string;
  sourceSessionId?: string | null;
  cwd?: string;
  model?: string | null;
  reasoningEffort?: string;
  serviceTier?: string;
  approvalPolicy?: CodexApprovalPolicy;
  sessionName?: string;
  /** A chat whose thread is created by its first message; `sourceSessionId` is set once it exists. */
  newChat?: boolean;
}

export interface FileTab extends TabBase { kind: "file"; filePath: string; sourceSessionId?: string | null }
export interface GitTab extends TabBase { kind: "git" }

/** Tabs shown in the center workspace (scoped per cwd). */
export type CenterTab = PiTab | TerminalTab | CodexChatTab;
/** Tabs shown in the right panel (scoped per project). */
export type SideTab = FileTab | GitTab;
export type Tab = CenterTab | SideTab;

export const PI_TAB: PiTab = { id: "pi", label: "TianForge pi", kind: "pi", closable: false };
export const GIT_REVIEW_TAB_ID = "git-review";
export const fileTabId = (filePath: string) => `file:${filePath}`;
export const terminalTabId = (terminalId: string) => `terminal:${terminalId}`;
export const codexChatTabId = (id: string) => `codex-chat:${id}`;
