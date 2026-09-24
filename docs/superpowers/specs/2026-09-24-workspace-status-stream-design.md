# 统一工作区状态推送设计

日期：2026-09-24
状态：已确认，待实施

## 背景

浏览器通过多个 5 秒轮询获取运行状态：

| 轮询 | 数据 |
| --- | --- |
| `ProjectRail`（5 s） | `/api/terminals`（全部终端）、`/api/sessions?running=1`、`/api/codex/runtime` |
| `useWorkspaceTerminals`（5 s） | `/api/terminals?cwd=`（当前目录终端 + 统计） |
| `AgentsPanel`（5 s） | `/api/codex/sessions`（磁盘上的 Codex 会话目录） |

Pi 会话的运行状态已通过 `/api/agent/running/events`（SSE）推送，但终端和 Codex 运行时没有。PRD 后续计划：“统一 SSE 状态通道，减少周期查询”。

## 目标与非目标

目标：
- 终端和 Codex 运行时状态变化即时推送到页面（最多约 100 ms），替代上述前两个轮询。
- 每个标签页只保持一条状态 SSE 连接（HTTP/1.1 下同源最多 6 个连接，页面已有会话、文件监听等长连接）。
- 空闲时不产生周期请求。

非目标：
- Codex 会话目录（磁盘数据，外部 `codex` CLI 也会修改）仍靠轮询：改为 30 秒兜底，并在终端或 Codex 状态变化时立即刷新一次。
- 项目栏 20 秒一次的 Git 状态轮询不在本次范围。
- 终端输出流不变（仍走各自的 WebSocket）。

## 进程与状态归属

自定义 server（`server/pi-web-server.js`）与 Next 路由运行在同一 Node 进程：

- Pi 会话：`lib/rpc-manager.ts`（`globalThis` 注册表，已有运行状态广播）。
- 终端：`server/agents/terminal-manager.cjs`，状态在 `global.__piWebTerminalState`。
- Codex 运行时：`server/agents/codex-app-server.cjs`，会话表是**模块内局部变量**；Next 路由直接 `require` 会得到另一个空实例。

因此新增一个挂在 `global` 上的状态总线，由状态拥有方把“读取快照”的函数注册进去，SSE 路由只通过总线读取。

## 组件

### 服务端：`server/workspace-status.cjs`

```js
// 状态存放在 global.__piWebWorkspaceStatus，Next 与自定义 server 共享同一实例
registerProvider(kind, getSnapshot)   // kind: "terminals" | "codex_runtimes"
notify(kind, { throttled })           // 状态变化 → 合并推送
subscribe(listener) → unsubscribe     // listener({ type: kind, ...snapshot })
snapshot(kind)                        // 未注册的 kind 返回空快照
```

- 合并：同一 kind 的 `notify` 在 100 ms 内合并为一次推送；`throttled: true`（终端输出导致的缓冲区大小变化）最多每 5 秒推送一次。
- 去重：快照序列化后与上次推送相同则不推送。
- 模块未加载时（从未创建终端 / Codex 会话），快照为空，与实际状态一致。

提供方：
- `terminal-manager.cjs` 注册 `terminals` 提供方：`{ terminals: listTerminals(), limits: terminalStats().limits }`（全部目录；各目录与全局统计由前端从终端列表计算）。在创建、退出、停止、重命名、删除、清理记录时 `notify("terminals")`；输出追加时 `notify("terminals", { throttled: true })`。
- `codex-app-server.cjs` 注册 `codex_runtimes` 提供方：`{ runtimes: listRuntimes() }`。在会话启动/停止、`turn/started`、`turn/completed`、审批请求到达/解决时 `notify("codex_runtimes")`。

### SSE：扩展 `/api/agent/running/events`

保留现有消息，新增两类：

| 消息 | 内容 |
| --- | --- |
| `running`（已有） | `runningSessionIds` |
| `session_event`（已有） | 后台会话的有界事件 |
| `terminals`（新增） | 全部终端的元数据（`TerminalSession[]`）与数量上限 `limits` |
| `codex_runtimes`（新增） | `listRuntimes()` 结果 |

连接建立时先订阅、再发送三类快照，保证订阅与快照之间不漏变化（与现有 `running` 的做法相同）。重连即得到完整快照，断线期间的变化自动补齐。

### 前端：共享状态存储

- `lib/workspace-status-store.ts`（纯逻辑，可 `node --test`）：接收上述消息，维护 `runningSessionIds`、`terminals`、`stats`、`codexRuntimes`；提供按 `cwd` 过滤终端与计算目录统计（`running`、`records`、`bufferBytes`）的选择器。
- `hooks/useWorkspaceStatus.ts`：全局唯一的 `EventSource`（引用计数，最后一个使用者卸载时关闭），用 `useSyncExternalStore` 订阅存储。

迁移：
- `SessionSidebar` 现有的 `running/events` 连接改为使用共享连接（`running`、`session_event` 行为不变）。
- `useWorkspaceTerminals(cwd)`：终端列表与统计来自存储（`/api/terminals?cwd=` 返回规范化后的 `cwd`，前端据此过滤推送的终端，避免 `/tmp` 与 `/private/tmp` 这类符号链接对不上）；保留 `update()`（本地乐观更新，下次推送覆盖）和 `refresh()`（主动请求 `/api/terminals?cwd=` 并写回存储）；删除 5 秒轮询。
- `ProjectRail`：运行角标与活动状态由存储计算；删除 5 秒轮询。Pi 会话的项目归属仍按现有方式（缓存的会话列表，节流刷新）。
- `AgentsPanel`：Codex 会话目录轮询改为 30 秒，并在 `terminals` 或 `codex_runtimes` 变化时立即刷新一次（防抖）。

## 数据量

终端快照包含最近命令历史（每个终端最多 50 条、每条最多 8000 字符，记录上限 100 个），最坏情况较大，但实际通常很小，且只在状态变化时推送并去重。现状是每 5 秒完整拉取同样的数据，本设计的总传输量不会超过现状。若将来成为问题，可改为按终端推送增量。

## 错误处理

- 提供方抛错：该 kind 本次跳过，记录日志，不影响其他 kind 和连接。
- 背压：`terminals` / `codex_runtimes` 为全量快照，浏览器读得慢时只保留最新一份，旧的直接丢弃。
- 连接断开：`EventSource` 自动重连，重连后的快照覆盖存储。

## 测试

- 状态总线：合并、节流、去重、未注册 kind 的空快照、提供方抛错隔离（`server/agents/*.test.cjs`）。
- 前端存储：消息应用、按 `cwd` 选择与统计、乐观更新被后续快照覆盖（`lib/*.test.mjs`）。
- e2e：模拟 SSE 推送 `terminals` / `codex_runtimes`，验证项目栏运行角标与 Agents 终端列表随推送更新，且不再发出 5 秒周期请求。
- 手动：创建、停止终端，项目栏角标即时变化。
