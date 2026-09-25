"use client";

import type { ReactNode } from "react";
import type { CenterState } from "@/lib/workspace/panel-state";
import { terminalTabId, type ClaudeChatTab, type CodexChatTab, type TerminalTab } from "@/lib/workspace/tabs";

/** Mounted external-agent tabs; the Pi tab is rendered by the caller. */
export function CenterWorkspace({ state, renderTab }: { state: CenterState; renderTab: (tab: TerminalTab | CodexChatTab | ClaudeChatTab) => ReactNode }) {
  const splitSecondaryId = state.split ? terminalTabId(state.split.secondaryTerminalId) : null;
  return <>
    {state.tabs.map((tab) => {
      if (tab.kind === "pi" || !state.mountedIds.includes(tab.id) || tab.id === splitSecondaryId) return null;
      return <div key={tab.id} style={{ position: "absolute", inset: 0, display: state.activeId === tab.id ? "block" : "none" }}>{renderTab(tab)}</div>;
    })}
  </>;
}
