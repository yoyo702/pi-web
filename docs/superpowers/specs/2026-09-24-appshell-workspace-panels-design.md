# AppShell 工作区面板重构设计

日期：2026-09-24
状态：已确认，待实施

## 背景

`components/AppShell.tsx`（约 1,960 行）同时承担：中央工作区标签（Pi、Terminal、Codex Chat）、右侧面板标签（文件、Git Review）、终端分屏、按作用域持久化、项目切换、Pi 会话顶栏，以及向侧栏/聊天/文件查看器层层传递的"打开"回调。

问题：

- 新增一种标签需要同时修改 AppShell 的恢复校验、渲染分支、持久化过滤、TabBar 和 `Tab` 类型。
- `Tab` 是扁平类型，Terminal/Codex 专属字段与文件标签混在一起。
- 面板状态变更分散在二十多处 `setState` 中，无法单元测试。
- 外部入口（状态中心、命令面板）无法直接打开某个文件/终端/会话。

第一轮重构（`fc8bc86`）已抽出边界清晰的 hook：`usePanelResize`、`useSessionMeta`、`useMobileOverlayHistory`、`useProjectWorkspaces`。

## 目标

本次**只重构、行为不变**，为以下扩展留好接口（本次不实现这些功能）：

1. 新增标签/面板类型只需新增一个注册项。
2. 任意组件可直接打开文件、终端、Codex Chat、Git Review。
3. 面板状态是可序列化数据，为布局预设打基础。
4. 边界清晰、文件变小、核心逻辑可单元测试。

非目标：布局预设 UI、状态中心直接打开目标、任何可见行为变化、新增依赖。

## 关键约束：两种作用域

| 区域 | 内容 | 持久化作用域 | 现有存储键 |
| --- | --- | --- | --- |
| 中央工作区 | Pi（固定）、Terminal、Codex Chat、终端分屏 | **cwd**（worktree 各自独立） | `workspaceTabsStorageKey(cwd)`，回退 `WORKSPACE_TABS_STORAGE_KEY` |
| 右侧面板 | 文件、Git Review、展开状态 | **项目** | `rightPanelTabsStorageKey(projectRoot)`，另有内存缓存 |

存储格式保持不变：中央 `{ tabs, activeId, split }`（不含 Pi 标签）；右侧 `{ tabs, activeId, open }`。升级后用户已打开的标签必须原样恢复。

## 模块划分

```
lib/workspace/                     纯逻辑，无 React，可 node --test
  tabs.ts            Tab 判别联合类型、固定 ID 与构造函数
  tab-kinds.ts       标签类型注册表（数据半）：所属区域、持久化校验
  panel-state.ts     纯 reducer：CenterState / SideState
  panel-storage.ts   按作用域读写 localStorage，兼容现有格式
components/workspace/
  tab-views.tsx         标签类型注册表（视图半）：kind → 渲染组件
  WorkspaceActions.tsx  context 与 useWorkspaceActions()
  CenterWorkspace.tsx   中央区域，按注册表渲染
  SidePanel.tsx         右侧面板，按注册表渲染
  TopBar.tsx            Pi 会话顶栏
```

AppShell 保留：组装各模块，以及跨模块流程（项目激活、会话选择/恢复、URL 同步）。

## 标签类型

`Tab` 改为判别联合：`PiTab | TerminalTab | CodexChatTab | FileTab | GitTab`，公共字段为 `id`、`label`、`kind`、`closable?`、`status?`、`locked?`；各种类只携带自己的字段（例如 `TerminalTab` 的 `terminalId`、`terminalProvider`、`terminalPermissionMode` 等，`FileTab` 的 `filePath`、`sourceSessionId`）。TabBar 只依赖公共字段。

## 状态模型

```ts
interface CenterState {
  tabs: Tab[];                 // 首项恒为 Pi 标签
  activeId: string;
  mountedIds: string[];        // 访问过的标签保持挂载
  split: TerminalSplit | null;
}
interface SideState {
  tabs: Tab[];
  activeId: string | null;
  open: boolean;
}
```

Reducer action（与现有处理函数一一对应）：

- 中央：`hydrate`、`open`（可选合并已有标签字段）、`activate`、`select`（用户选择；选中分屏副窗格时退出分屏）、`remove`、`removeWhere`（按谓词移除，如 Codex 归档、终端删除）、`update`（按函数批量更新，如终端状态、Codex 重命名）、`setSplit`。
- 右侧：`hydrate`、`openFile`、`openGitReview`、`activate`、`close`（一个或多个 id）、`toggleLock`、`pathRenamed`、`pathDeleted`、`setOpen`。

不变式：

- 中央区域始终包含不可关闭的 Pi 标签。
- `activeId` 必须指向存在的标签，否则回退（中央回退 Pi；右侧按现有"相邻标签"规则）。
- 关闭多个标签时跳过锁定标签，行为与现有 `handleCloseFileTabs` 一致。
- 标签按注册表的 `slot` 校验：落在错误区域的持久化标签会被 `parsePersistedTab` 丢弃而非迁移（取代现有专门迁移 terminal/codex-chat 的 effect——旧的恢复逻辑本来就按区域过滤，不存在真正的"迁移"）。详见下方"实施偏差"。

## 作用域切换与持久化

- cwd 变化：先保存旧 cwd 的中央状态，再 `hydrate` 新 cwd 的状态；项目变化同理处理右侧状态。
- 时机与现在一致：右侧面板使用 `useLayoutEffect`，避免闪现上一个项目的标签。
- `persistCurrentProjectPanels`（项目切换前的同步保存）由 storage 模块的 `saveCenter` / `saveSide` 取代，调用点不变。
- 损坏或不可用的存储：忽略并使用默认状态（与现在相同）。

## 标签类型注册表

注册表分为两半，使 `lib/workspace/` 保持不依赖 React：

```ts
// lib/workspace/tab-kinds.ts —— 数据：所属区域与持久化校验
interface TabKindDefinition<T extends Tab> {
  kind: T["kind"];
  slot: "center" | "side";
  parse(raw: Record<string, unknown>, scope: { cwd?: string }): T | null;  // 恢复时校验与规范化（如 codex-chat 状态重置为 idle）
}

// components/workspace/tab-views.tsx —— 视图：每种标签的渲染组件
type TabViews = { [K in Tab["kind"]]?: ComponentType<TabViewProps<K>> };
```

注册项：`pi`（center，固定、不持久化）、`terminal`（center）、`codex-chat`（center）、`file`（side）、`git`（side）。`panel-storage` 调用 `parse` 过滤恢复数据，`CenterWorkspace` / `SidePanel` 从 `tab-views` 取组件渲染，不再有按 kind 的 if/else 分支。中央区域访问过的标签一律保持挂载（与现状相同），因此不需要按种类配置挂载策略。

终端分屏仍是终端专属逻辑，放在 terminal 渲染组件内，状态存于 `CenterState.split`。

## 打开操作

```ts
interface WorkspaceActions {
  openFile(path: string, opts?: { sourceSessionId?: string | null }): void;
  toggleGitReview(): void;
  openTerminal(terminal: TerminalSession, label?: string): void;
  openCodexChat(target: CodexChatTarget): void;
  closeTab(id: string): void;
  revealInExplorer(path: string): void;
}
```

AppShell 通过 `WorkspaceActionsProvider` 注入。迁移调用方：SessionSidebar、ChatWindow 与各标签视图改为 `useWorkspaceActions()`，删除 AppShell 到它们的透传 props。FileExplorer、AgentsPanel、FileViewer 这类叶子组件保留原有 props，由其父组件从 context 取操作传入，保证它们可在 Provider 之外复用。

## TopBar

Pi 会话顶栏（分支导航、系统提示、会话信息面板、Token/上下文统计、自动命名、复制字段）移入 `TopBar.tsx`。数据来自 `useSessionMeta` 与分支状态，通过 props 传入；下拉面板开关状态内聚在 TopBar。

## 实施步骤

每步行为不变，完成后运行 `tsc`、`eslint`、`npm test`、`npx playwright test`。

1. `lib/workspace/tabs.ts`、`tab-kinds.ts`、`panel-state.ts`、`panel-storage.ts` 及单元测试；AppShell 改用 `useReducer`，移除迁移 effect（恢复时已按区域过滤）。
2. `tab-views.tsx`、`CenterWorkspace`、`SidePanel`，移除按 kind 的渲染分支。
3. `WorkspaceActions` context，逐个迁移调用方并删除透传 props。
4. 抽出 `TopBar`。
5. 更新 AGENTS.md：新增标签类型的步骤与作用域约束。

## 测试

- reducer：每个 action 与不变式（Pi 标签不可关闭、锁定标签、activeId 回退、slot 归位、路径改名/删除）。
- storage：以**当前格式**的存档作为样例，确认读出结果与现有逻辑一致；损坏数据回退默认值；cwd 过滤（中央只恢复 `cwd` 匹配的终端/Codex 标签）。
- e2e：现有用例覆盖项目切换、会话快照、移动端、Explorer、Git 面板、全屏。
- 重点手测风险：切换项目/worktree 时的保存恢复顺序；刷新后终端分屏恢复。

## 实施偏差 / Deviations

- **视图分发（view dispatch）**：`components/workspace/tab-views.tsx` 只导出各 kind 的视图组件，并没有 `kind → component` 的统一映射表。各视图 props 差异太大（例如 `TerminalTabView` 需要分屏状态与一堆终端回调，`GitTabView` 只需要 cwd），硬套统一签名反而更复杂、更难读。实际分发发生在 AppShell 的两个 `renderTab` 回调（分别对应 `CenterWorkspace` 与 `SidePanel`），按 `tab.kind` switch/if 到对应视图。
- **落错区域的标签**：`lib/workspace/tab-kinds.ts` 的 `parsePersistedTab` 按 `slot` 过滤，标签落在错误区域时直接丢弃（返回 `null`），而不是迁移到正确区域。这与重构前的行为一致——旧的恢复逻辑本来就按区域过滤，不存在"迁移"这一步，因此本次保持原样，不引入新行为。
