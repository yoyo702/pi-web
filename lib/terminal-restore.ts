export interface RestorableTerminalTab {
  id: string;
  kind: string;
  terminalId?: string;
}

export interface RestorableTerminalSplit {
  primaryTabId: string;
  secondaryTerminalId: string;
}

/** Select only missing panes; a surviving pane must never be restarted. */
export function getMissingSplitTerminalTabs<T extends RestorableTerminalTab>(tabs: T[], split: RestorableTerminalSplit | null, availableTerminalIds: Set<string>): T[] {
  if (!split) return [];
  const primary = tabs.find((tab) => tab.kind === "terminal" && tab.id === split.primaryTabId);
  const secondary = tabs.find((tab) => tab.kind === "terminal" && tab.terminalId === split.secondaryTerminalId);
  const selected: T[] = [];
  for (const tab of [primary, secondary]) {
    if (!tab?.terminalId || availableTerminalIds.has(tab.terminalId) || selected.some((item) => item.id === tab.id)) continue;
    selected.push(tab);
  }
  return selected;
}
