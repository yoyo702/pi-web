import type { ClaudeChatTab, CodexChatTab, FileTab, GitTab, Tab, TerminalTab } from "./tabs";

export type TabSlot = "center" | "side";

export interface TabKindDefinition<T extends Tab = Tab> {
  kind: T["kind"];
  slot: TabSlot;
  /** Validate and normalize a persisted tab; null drops it. */
  parse(raw: Record<string, unknown>, scope: { cwd?: string }): T | null;
}

const hasIdentity = (raw: Record<string, unknown>) => typeof raw.id === "string" && typeof raw.label === "string";

/**
 * Registry of tab kinds (data half): which slot a kind lives in and how to
 * validate/normalize it when restoring from storage. Views are dispatched
 * separately, by kind, in AppShell's `renderTab` callbacks (see the
 * "Workspace panels and tab kinds" section of AGENTS.md for the full list of
 * places to touch when adding a kind).
 */
export const TAB_KINDS: { [K in Tab["kind"]]: TabKindDefinition<Extract<Tab, { kind: K }>> } = {
  // The Pi tab is fixed and never persisted.
  pi: { kind: "pi", slot: "center", parse: () => null },
  terminal: {
    kind: "terminal",
    slot: "center",
    parse: (raw, scope) => hasIdentity(raw) && raw.cwd === scope.cwd ? raw as unknown as TerminalTab : null,
  },
  "codex-chat": {
    kind: "codex-chat",
    slot: "center",
    // A restored chat is not running until its panel reconnects.
    parse: (raw, scope) => hasIdentity(raw) && raw.cwd === scope.cwd ? { ...(raw as unknown as CodexChatTab), status: "idle" } : null,
  },
  "claude-chat": {
    kind: "claude-chat",
    slot: "center",
    parse: (raw, scope) => hasIdentity(raw) && raw.cwd === scope.cwd ? { ...(raw as unknown as ClaudeChatTab), status: "idle" } : null,
  },
  file: {
    kind: "file",
    slot: "side",
    parse: (raw) => hasIdentity(raw) && typeof raw.filePath === "string" ? raw as unknown as FileTab : null,
  },
  git: { kind: "git", slot: "side", parse: (raw) => hasIdentity(raw) ? raw as unknown as GitTab : null },
};

export function parsePersistedTab(raw: unknown, slot: TabSlot, scope: { cwd?: string }): Tab | null {
  if (!raw || typeof raw !== "object") return null;
  const kind = (raw as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !Object.hasOwn(TAB_KINDS, kind)) return null;
  const definition = TAB_KINDS[kind as Tab["kind"]] as TabKindDefinition;
  return definition.slot === slot ? definition.parse(raw as Record<string, unknown>, scope) : null;
}
