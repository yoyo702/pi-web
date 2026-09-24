import { initialCenterState, initialSideState, type CenterState, type SideState, type TerminalSplit } from "./panel-state";
import { parsePersistedTab } from "./tab-kinds";
import { PI_TAB, type CenterTab, type SideTab } from "./tabs";

// Keys and JSON shapes are shared with already-persisted browser state; do
// not change them without a migration.
export const WORKSPACE_TABS_STORAGE_KEY = "pi-web:workspace-tabs";
export const RIGHT_PANEL_TABS_STORAGE_KEY = "pi-web:right-panel-tabs";
const workspaceTabsStorageKey = (cwd: string) => `${WORKSPACE_TABS_STORAGE_KEY}:${encodeURIComponent(cwd)}`;
const rightPanelTabsStorageKey = (projectRoot: string) => `${RIGHT_PANEL_TABS_STORAGE_KEY}:${encodeURIComponent(projectRoot)}`;

type KeyValueStorage = Pick<Storage, "getItem" | "setItem">;
/** Right-panel state per project kept in memory so quick project switches do not re-read storage. */
export type SideSnapshotCache = Map<string, SideState>;

function parseSplit(value: unknown): TerminalSplit | null {
  if (!value || typeof value !== "object") return null;
  const split = value as Partial<TerminalSplit>;
  if (typeof split.primaryTabId !== "string" || typeof split.secondaryTerminalId !== "string") return null;
  if (split.direction !== "horizontal" && split.direction !== "vertical") return null;
  return {
    primaryTabId: split.primaryTabId,
    secondaryTerminalId: split.secondaryTerminalId,
    direction: split.direction,
    ratio: typeof split.ratio === "number" ? Math.max(20, Math.min(80, split.ratio)) : 50,
    reversed: split.reversed === true,
  };
}

export function loadCenterState(storage: KeyValueStorage, cwd: string): CenterState {
  try {
    const raw = storage.getItem(workspaceTabsStorageKey(cwd)) ?? storage.getItem(WORKSPACE_TABS_STORAGE_KEY);
    const parsed = JSON.parse(raw || "null") as { tabs?: unknown; activeId?: unknown; split?: unknown } | null;
    const restored = Array.isArray(parsed?.tabs)
      ? parsed.tabs.map((tab) => parsePersistedTab(tab, "center", { cwd })).filter((tab): tab is CenterTab => tab !== null)
      : [];
    const tabs: CenterTab[] = [PI_TAB, ...restored];
    const activeId = typeof parsed?.activeId === "string" && tabs.some((tab) => tab.id === parsed.activeId) ? parsed.activeId : PI_TAB.id;
    return { tabs, activeId, mountedIds: activeId === PI_TAB.id ? [PI_TAB.id] : [PI_TAB.id, activeId], split: parseSplit(parsed?.split) };
  } catch {
    return initialCenterState(); // malformed or unavailable browser storage
  }
}

export function saveCenterState(storage: KeyValueStorage, cwd: string, state: CenterState): void {
  try {
    storage.setItem(workspaceTabsStorageKey(cwd), JSON.stringify({ tabs: state.tabs.filter((tab) => tab.id !== PI_TAB.id), activeId: state.activeId, split: state.split }));
  } catch { /* storage quota or privacy mode */ }
}

export function loadSideState(storage: KeyValueStorage, projectId: string, cache: SideSnapshotCache): SideState {
  try {
    const parsed = (cache.get(projectId) ?? JSON.parse(storage.getItem(rightPanelTabsStorageKey(projectId)) || "null")) as { tabs?: unknown; activeId?: unknown; open?: unknown } | null;
    const tabs = Array.isArray(parsed?.tabs)
      ? parsed.tabs.map((tab) => parsePersistedTab(tab, "side", {})).filter((tab): tab is SideTab => tab !== null)
      : [];
    const activeId = typeof parsed?.activeId === "string" && tabs.some((tab) => tab.id === parsed.activeId) ? parsed.activeId : null;
    return { tabs, activeId, open: parsed?.open === true && tabs.length > 0 };
  } catch {
    return initialSideState();
  }
}

export function saveSideState(storage: KeyValueStorage, projectId: string, state: SideState, cache: SideSnapshotCache): void {
  cache.set(projectId, state);
  try {
    storage.setItem(rightPanelTabsStorageKey(projectId), JSON.stringify(state));
  } catch { /* storage may be unavailable */ }
}
