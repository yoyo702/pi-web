import type { ClaudeRuntimeStatus, CodexRuntimeStatus } from "./workspace-status-store";
import type { ClaudePermissionMode, CodexApprovalPolicy } from "./workspace/tabs";

const CODEX_POLICIES: readonly string[] = ["untrusted", "on-request", "never"] satisfies CodexApprovalPolicy[];
const CLAUDE_MODES: readonly string[] = ["default", "acceptEdits", "plan", "bypassPermissions"] satisfies ClaudePermissionMode[];

/** Settings for a Codex chat opened without a tab: its live runtime's, else a new chat's defaults. */
export function codexReopenSettings(runtime?: Pick<CodexRuntimeStatus, "settings"> | null): { approvalPolicy: CodexApprovalPolicy; model?: string; reasoningEffort?: string; serviceTier?: string } {
  const settings = runtime?.settings;
  const approvalPolicy = settings && CODEX_POLICIES.includes(settings.approvalPolicy) ? settings.approvalPolicy as CodexApprovalPolicy : "untrusted";
  return {
    approvalPolicy,
    ...(settings?.model ? { model: settings.model } : {}),
    ...(settings?.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
    ...(settings?.serviceTier ? { serviceTier: settings.serviceTier } : {}),
  };
}

/** Settings for a Claude chat opened without a tab: its live process's, else a new chat's defaults. */
export function claudeReopenSettings(runtime?: Pick<ClaudeRuntimeStatus, "model" | "permissionMode"> | null): { permissionMode: ClaudePermissionMode; model?: string } {
  const permissionMode = runtime?.permissionMode && CLAUDE_MODES.includes(runtime.permissionMode) ? runtime.permissionMode as ClaudePermissionMode : "default";
  return { permissionMode, ...(runtime?.model ? { model: runtime.model } : {}) };
}
