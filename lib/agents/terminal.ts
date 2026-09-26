import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "../file-access";

/** Shared client contracts for optional external agent terminals. */
export type TerminalProvider = "shell" | "codex" | "claude";
/** Codex: confirm, on-request, never, bypass. Claude: confirm, plan, accept-edits, bypass. */
export type CodexPermissionMode = "confirm" | "on-request" | "never" | "bypass";
export type ClaudePermissionMode = "confirm" | "plan" | "accept-edits" | "bypass";
export type TerminalPermissionMode = CodexPermissionMode | ClaudePermissionMode;
export type TerminalLaunchMode = "new" | "resume-last" | "resume" | "fork";
export type TerminalState = "running" | "ended" | "stopped";
/** What a running Claude or Codex terminal is doing; null for shells or when unknown. */
export type TerminalActivity = "working" | "waiting" | "approval";

export interface TerminalLaunchDescriptor {
  provider: TerminalProvider;
  cwd: string;
  permissionMode?: TerminalPermissionMode;
  launchMode?: TerminalLaunchMode;
  noAltScreen?: boolean;
  sourceSessionId?: string;
  model?: string;
  webSearch?: boolean;
  chatMode?: boolean;
}

export interface TerminalStats {
  global: { running: number; records: number; bufferBytes: number };
  workspace: { running: number; records: number; bufferBytes: number };
  limits: { running: number; records: number };
}

export interface TerminalSession {
  id: string;
  provider: TerminalProvider;
  title?: string;
  cwd: string;
  pid: number;
  permissionMode: TerminalPermissionMode;
  launchMode: TerminalLaunchMode;
  noAltScreen: boolean;
  sourceSessionId?: string | null;
  model?: string | null;
  webSearch?: boolean;
  initialPrompt?: string | null;
  chatMode?: boolean;
  chatInputOwned?: boolean;
  cols: number;
  rows: number;
  state: TerminalState;
  createdAt: string;
  endedAt: string | null;
  exitCode: number | null;
  signal: number | null;
  bufferBytes: number;
  bufferTruncated: boolean;
  history: string[];
  activity?: TerminalActivity | null;
}

export class TerminalRequestError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

// This CJS runtime is deliberately shared with the custom HTTP server so
// API routes, Pi tools, and WebSocket clients always address the same PTYs.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const manager = require("@/server/agents/terminal-manager.cjs") as {
  TerminalError: new (code: string, message: string) => Error & { code: string };
  createTerminal(input: { provider: TerminalProvider; cwd: string; cols: number; rows: number; permissionMode: TerminalPermissionMode; launchMode: TerminalLaunchMode; noAltScreen: boolean; sourceSessionId?: string; model?: string; webSearch?: boolean; initialPrompt?: string; chatMode?: boolean; title?: string }): TerminalSession;
  listTerminals(cwd?: string): TerminalSession[];
  terminalStats(cwd?: string): TerminalStats;
  getTerminal(id: string): TerminalSession;
  renameTerminal(id: string, title: string): TerminalSession;
  getBuffer(id: string): { data: Buffer; truncated: boolean; state: TerminalState };
  inputTerminal(id: string, data: string | Buffer): void;
  resizeTerminal(id: string, cols: number, rows: number): void;
  stopTerminal(id: string): TerminalSession;
  removeTerminal(id: string): TerminalSession;
  clearEndedTerminals(input?: { cwd?: string; provider?: TerminalProvider }): string[];
};

function translate<T>(callback: () => T): T {
  try {
    return callback();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string") {
      throw new TerminalRequestError((error as { code: string }).code, error instanceof Error ? error.message : "terminal request failed");
    }
    throw error;
  }
}

export async function resolveTerminalCwd(cwd: string): Promise<string> {
  const candidate = resolve(cwd);
  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch {
    throw new TerminalRequestError("invalid_cwd", "terminal working directory does not exist");
  }
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(canonical, allowedRoots)) {
    throw new TerminalRequestError("forbidden_cwd", "terminal working directory is not an authorized workspace");
  }
  return canonical;
}

export async function createTerminal(input: { provider: TerminalProvider; cwd: string; cols?: number; rows?: number; permissionMode?: TerminalPermissionMode; launchMode?: TerminalLaunchMode; noAltScreen?: boolean; sourceSessionId?: string; model?: string; webSearch?: boolean; initialPrompt?: string; chatMode?: boolean; title?: string }): Promise<TerminalSession> {
  const cwd = await resolveTerminalCwd(input.cwd);
  return translate(() => manager.createTerminal({
    provider: input.provider,
    cwd,
    cols: input.cols ?? 100,
    rows: input.rows ?? 30,
    permissionMode: input.permissionMode ?? "confirm",
    launchMode: input.launchMode ?? "new",
    noAltScreen: input.noAltScreen ?? input.provider === "codex",
    sourceSessionId: input.sourceSessionId,
    model: input.model,
    webSearch: input.webSearch,
    initialPrompt: input.initialPrompt,
    chatMode: input.chatMode,
    title: input.title,
  }));
}

export function listTerminals(cwd?: string): TerminalSession[] { return translate(() => manager.listTerminals(cwd)); }
export function getTerminalStats(cwd?: string): TerminalStats { return translate(() => manager.terminalStats(cwd)); }
export function getTerminal(id: string): TerminalSession { return translate(() => manager.getTerminal(id)); }
export function renameTerminal(id: string, title: string): TerminalSession { return translate(() => manager.renameTerminal(id, title)); }
export function getTerminalBuffer(id: string): { data: Buffer; truncated: boolean; state: TerminalState } { return translate(() => manager.getBuffer(id)); }
export function sendTerminalInput(id: string, data: string | Buffer): void { return translate(() => manager.inputTerminal(id, data)); }
export function resizeTerminal(id: string, cols: number, rows: number): void { return translate(() => manager.resizeTerminal(id, cols, rows)); }
export function stopTerminal(id: string): TerminalSession { return translate(() => manager.stopTerminal(id)); }
export function removeTerminal(id: string): TerminalSession { return translate(() => manager.removeTerminal(id)); }
export function clearEndedTerminals(input?: { cwd?: string; provider?: TerminalProvider }): string[] { return translate(() => manager.clearEndedTerminals(input)); }
