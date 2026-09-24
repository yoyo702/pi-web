import { getFileName } from "../file-paths";
import { GIT_REVIEW_TAB_ID, PI_TAB, fileTabId, terminalTabId, type CenterTab, type CodexChatTab, type SideTab, type TerminalTab } from "./tabs";

export interface TerminalSplit {
  primaryTabId: string;
  secondaryTerminalId: string;
  direction: "horizontal" | "vertical";
  ratio: number;
  reversed: boolean;
}

/** Center workspace for one cwd. The Pi tab is always first. */
export interface CenterState {
  tabs: CenterTab[];
  activeId: string;
  /** Tabs visited since hydration stay mounted (terminal buffers, chat state). */
  mountedIds: string[];
  split: TerminalSplit | null;
}

/** Right panel for one project. */
export interface SideState {
  tabs: SideTab[];
  activeId: string | null;
  open: boolean;
}

export function initialCenterState(): CenterState {
  return { tabs: [PI_TAB], activeId: PI_TAB.id, mountedIds: [PI_TAB.id], split: null };
}

export function initialSideState(): SideState {
  return { tabs: [], activeId: null, open: false };
}

export type CenterAction =
  | { type: "hydrate"; state: CenterState }
  | { type: "open"; tab: TerminalTab | CodexChatTab; mergeExisting?: Partial<TerminalTab> | Partial<CodexChatTab> }
  | { type: "activate"; id: string }
  /** User tab selection: selecting the split's secondary pane exits the split. */
  | { type: "select"; id: string }
  | { type: "remove"; id: string }
  | { type: "removeWhere"; predicate: (tab: CenterTab) => boolean }
  | { type: "update"; update: (tab: CenterTab) => CenterTab }
  | { type: "setSplit"; split: TerminalSplit | null | ((current: TerminalSplit | null) => TerminalSplit | null) };

function mount(state: CenterState): CenterState {
  return state.mountedIds.includes(state.activeId) ? state : { ...state, mountedIds: [...state.mountedIds, state.activeId] };
}

export function centerReducer(state: CenterState, action: CenterAction): CenterState {
  switch (action.type) {
    case "hydrate":
      return mount({ ...action.state, mountedIds: [PI_TAB.id] });
    case "open": {
      const exists = state.tabs.some((tab) => tab.id === action.tab.id);
      const tabs = !exists
        ? [...state.tabs, action.tab]
        : action.mergeExisting
          ? state.tabs.map((tab) => tab.id === action.tab.id ? { ...tab, ...action.mergeExisting } as CenterTab : tab)
          : state.tabs;
      return mount({ ...state, tabs, activeId: action.tab.id });
    }
    case "activate":
      return mount(state.activeId === action.id ? state : { ...state, activeId: action.id });
    case "select": {
      const split = state.split && action.id === terminalTabId(state.split.secondaryTerminalId) ? null : state.split;
      return mount({ ...state, split, activeId: action.id });
    }
    case "remove": {
      if (action.id === PI_TAB.id) return state;
      const index = state.tabs.findIndex((tab) => tab.id === action.id);
      const activeId = state.activeId !== action.id
        ? state.activeId
        : state.tabs[index - 1]?.id ?? state.tabs[index + 1]?.id ?? PI_TAB.id;
      const split = state.split && (state.split.primaryTabId === action.id || terminalTabId(state.split.secondaryTerminalId) === action.id) ? null : state.split;
      return mount({
        tabs: state.tabs.filter((tab) => tab.id !== action.id),
        activeId,
        mountedIds: state.mountedIds.filter((id) => id !== action.id),
        split,
      });
    }
    case "removeWhere": {
      const tabs = state.tabs.filter((tab) => tab.id === PI_TAB.id || !action.predicate(tab));
      if (tabs.length === state.tabs.length) return state;
      return { ...state, tabs, activeId: tabs.some((tab) => tab.id === state.activeId) ? state.activeId : PI_TAB.id };
    }
    case "update": {
      let changed = false;
      const tabs = state.tabs.map((tab) => {
        const next = action.update(tab);
        if (next !== tab) changed = true;
        return next;
      });
      return changed ? { ...state, tabs } : state;
    }
    case "setSplit": {
      const split = typeof action.split === "function" ? action.split(state.split) : action.split;
      return split === state.split ? state : { ...state, split };
    }
  }
}

export type SideAction =
  | { type: "hydrate"; state: SideState }
  | { type: "openFile"; filePath: string; label: string; sourceSessionId?: string | null }
  | { type: "openGitReview" }
  | { type: "activate"; id: string }
  | { type: "close"; ids: string[] }
  | { type: "toggleLock"; id: string }
  | { type: "pathRenamed"; oldPath: string; newPath: string; isDir: boolean }
  | { type: "pathDeleted"; path: string; isDir: boolean }
  | { type: "setOpen"; open: boolean };

const isUnder = (value: string, path: string, isDir: boolean) => value === path || (isDir && value.startsWith(`${path}/`));

export function sideReducer(state: SideState, action: SideAction): SideState {
  switch (action.type) {
    case "hydrate":
      return action.state;
    case "openFile": {
      const id = fileTabId(action.filePath);
      const existing = state.tabs.find((tab) => tab.id === id);
      const tabs = !existing
        ? [...state.tabs, { id, label: action.label, kind: "file" as const, filePath: action.filePath, sourceSessionId: action.sourceSessionId }]
        : !action.sourceSessionId || (existing.kind === "file" && existing.sourceSessionId === action.sourceSessionId)
          ? state.tabs
          : state.tabs.map((tab) => tab.id === id ? { ...tab, sourceSessionId: action.sourceSessionId } : tab);
      return { tabs, activeId: id, open: true };
    }
    case "openGitReview": {
      const tabs = state.tabs.some((tab) => tab.id === GIT_REVIEW_TAB_ID)
        ? state.tabs
        : [...state.tabs, { id: GIT_REVIEW_TAB_ID, label: "Git Review", kind: "git" as const }];
      return { tabs, activeId: GIT_REVIEW_TAB_ID, open: true };
    }
    case "activate":
      return state.activeId === action.id ? state : { ...state, activeId: action.id };
    case "close": {
      const requested = new Set(action.ids);
      const removed = new Set(state.tabs.filter((tab) => requested.has(tab.id) && tab.closable !== false && !tab.locked).map((tab) => tab.id));
      if (removed.size === 0) return state;
      const tabs = state.tabs.filter((tab) => !removed.has(tab.id));
      const activeIndex = state.tabs.findIndex((tab) => tab.id === state.activeId);
      const activeId = state.activeId && removed.has(state.activeId)
        ? state.tabs.slice(activeIndex + 1).find((tab) => !removed.has(tab.id))?.id
          ?? state.tabs.slice(0, Math.max(0, activeIndex)).reverse().find((tab) => !removed.has(tab.id))?.id
          ?? null
        : state.activeId;
      // No tabs left means nothing to show — collapse the right panel.
      return { tabs, activeId, open: tabs.length === 0 ? false : state.open };
    }
    case "toggleLock":
      return { ...state, tabs: state.tabs.map((tab) => tab.id === action.id ? { ...tab, locked: !tab.locked } : tab) };
    case "pathRenamed": {
      const renamed = (value: string) => `${action.newPath}${value.slice(action.oldPath.length)}`;
      const tabs = state.tabs.map((tab) => {
        if (tab.kind !== "file" || !isUnder(tab.filePath, action.oldPath, action.isDir)) return tab;
        const filePath = renamed(tab.filePath);
        return { ...tab, id: fileTabId(filePath), filePath, label: tab.filePath === action.oldPath ? getFileName(filePath) : tab.label };
      });
      const activeId = state.activeId?.startsWith("file:") && isUnder(state.activeId.slice(5), action.oldPath, action.isDir)
        ? fileTabId(renamed(state.activeId.slice(5)))
        : state.activeId;
      return { ...state, tabs, activeId };
    }
    case "pathDeleted": {
      const removed = new Set(state.tabs.filter((tab) => tab.kind === "file" && isUnder(tab.filePath, action.path, action.isDir)).map((tab) => tab.id));
      if (removed.size === 0) return state;
      const tabs = state.tabs.filter((tab) => !removed.has(tab.id));
      const activeId = state.activeId && removed.has(state.activeId) ? tabs.at(-1)?.id ?? null : state.activeId;
      return { tabs, activeId, open: tabs.length === 0 ? false : state.open };
    }
    case "setOpen":
      return state.open === action.open ? state : { ...state, open: action.open };
  }
}
