# Agents 工作区 PRD

## 背景与目标

TianForge pi 不应把 Codex、Claude 和 Terminal 做成与产品割裂的测试侧栏。Agents 应成为项目工作区的一等能力，与 Pi、Explorer 和文件标签共同工作。

## 用户场景

- 在当前项目启动 Shell、Codex 或 Claude。
- 恢复、Fork、重命名、归档或删除 Codex Session。
- 在 Chat 与 Terminal 两种交互界面之间选择。
- 保留模型、推理强度、权限策略等每个标签的配置。
- 在运行、审批或失败时获得清晰反馈并可终止任务。

## 已实现范围

- Agents 与 Pi 作为左侧主要模块，不占用测试用右侧栏。
- Agent/Terminal 在中央工作区以标签打开，支持多标签和终端分屏。
- 支持 Shell、Codex、Claude 三种启动类型。
- Codex 支持 Chat 和 Terminal Session；Chat 支持模型、推理、服务等级和审批策略。
- Session 支持新建、恢复、Fork、重命名、归档和删除确认。
- Terminal 支持停止、重启、删除记录、清理已结束任务和重连缓冲区。
- Chat 支持中断运行及处理审批卡片。
- 模型和权限配置保存在工作区标签中，刷新后恢复。

## Codex 会话目录

- 会话列表来自一个共享的、长期运行的 `codex app-server`（`server/agents/codex-catalog.cjs`，与各会话的聊天运行时进程分开）：`thread/list` 带 `modelProviders: []`，列出所有模型提供方的交互会话（含未命名、分叉会话；子代理会话不列出）。首次使用时启动，崩溃或超时（15 秒）后下次请求重启，空闲 5 分钟关闭；启动失败（如未安装 CLI、`initialize` 报错）后 30 秒内不再重新启动，直接按不可用处理。
- 列表每页 50 条，按更新时间倒序，Agents 面板用“Load more sessions”按游标加载下一页；定时刷新和改名/归档/删除后的刷新按页重读当前已显示的行数，因此移动到其他页、被归档或删除的会话都能正确更新。切换筛选条件会取消进行中的“加载更多”，定时刷新不会。
- 搜索按会话名称匹配；输入完整会话 id 时也能找到该会话。
- 每行显示名称（未命名时显示第一条消息）、最后一条用户消息、更新时间，以及分叉来源（“Fork of …”）和模型。
- 改名、归档、恢复、删除调用 app-server 的 `thread/name/set`、`thread/archive`、`thread/unarchive`、`thread/delete`，不再改写 `~/.codex/session_index.jsonl`，也不调用 CLI。
- 聊天请求的会话校验走 `thread/read`（不读 turns），分叉出的新会话可直接打开聊天。
- app-server 不可用时：第一页列表与会话校验退回扫描 `~/.codex/sessions` 文件（服务端日志记录一次警告，扫描结果缓存 5 秒）；带游标的“加载更多”、改名、归档、恢复、删除返回 503（`catalog_unavailable`）。
- 会话接口错误码：400 参数错误，403 目录未授权，404 会话不存在，409 已归档/未归档/运行中，503 目录服务不可用，其余 500。500 和 503 只返回通用提示，详细原因（含 app-server 的 stderr）只写服务端日志。
- 会话文件路径只在服务端使用，不返回给浏览器（会话列表和聊天的 `thread/read` 结果都会去掉 `path`）。
- 已归档的会话不能在网页聊天中打开或继续（聊天请求报错，需先恢复）。

## Codex 聊天运行时

- 每个会话一个 `codex app-server` 运行时进程（`server/agents/codex-app-server.cjs`），所有浏览器共用。没有页面在看、也没有进行中的一轮和未决审批时，30 秒后关闭；有进行中的一轮或等待审批时一直保留，一轮结束（或审批回复）后再开始空闲计时。因此在手机上发起一轮后锁屏或关闭标签，这一轮会继续跑完，在电脑上打开同一会话可继续看到。
- 运行时每次启动有新的 `runtimeId`；SSE 事件 id 为 `runtimeId:seq`。运行时重启后，浏览器按新运行时从头重放事件，不会因序号重置而漏事件。运行时退出时推送 `codex/closed`，聊天显示 “Reconnecting”；事件流在运行时就绪（`thread/resume` 成功）后才建立；新运行时无法恢复会话（如 `writer_conflict`）时直接返回 JSON 错误，浏览器不再反复重连，显示 “Codex chat disconnected.” 与 “Reconnect” 按钮，点击后显示具体原因。
- 只发图片（无文字）也可以发送。
- 错误显示：
  - `error` 且 `willRetry: true`：显示 “Codex is retrying: …”，这一轮继续，收到新的条目或一轮开始后提示消失。
  - `turn/completed` 带 `turn.error`：显示 “Turn failed: …”。
  - 会话被另一个 Codex 客户端（如 ChatGPT 桌面端）占用（app-server 报 “already has an active writer”）：409 `writer_conflict`，提示完全退出该应用后重试，或从 Agents 面板 Fork。
- 聊天接口错误码：400 参数错误，403 目录未授权，404 会话不存在；409 用于已归档、正在归档/删除或有一轮在跑（`session_busy`）、终端占用（`terminal_owns_session`、`terminal_conflict`）、`writer_conflict`、审批已过期（`approval_expired`）、没有进行中的一轮（`no_active_turn`）；503 app-server 不可用；其余 500。app-server 自身的错误（`rpc_error`）、超时和运行时退出原因会显示，但其中的文件路径替换为 `<path>`；其他 500/503 只返回通用提示，详情写服务端日志（stderr 只进日志）。

## 状态模型

- `idle`：可输入新任务。
- `running`：模型生成、工具执行或终端进程运行。
- `approval`：存在结构化审批请求。
- `ended`：Terminal 已自然结束。
- `stopped`：用户主动停止。
- `failed/offline`：进程异常或连接不可用。

Codex Chat 的审批来自 app-server 协议；普通 Terminal 不通过输出文本推断审批。

## 所有权规则

- 同一 Session 不能被 Chat 和 Terminal 同时作为写入者。
- Terminal → Chat 交接必须先中断、等待状态落盘，再释放 Terminal。
- 过期审批应清理并给出可继续操作的提示。
- 读取模型或 Session 元数据不得隐式接管正在运行的 Session。
- Codex 聊天只在写操作时接管会话：发送消息、`/compact`、`/review`、回复审批、中断。打开聊天（GET）、事件流（SSE）和对账不接管。
  - 有 `resume` 终端在写该会话：发送时先停止该终端再开始这一轮。若打开聊天时终端仍在写且没有聊天运行时，返回 409 `terminal_owns_session`，聊天显示 “Stop terminal / Cancel”；确认后调用 `POST /api/codex/chat/:id/claim`（`{"terminals":"ignore"}`，只停止恢复该会话的终端，不动同目录其他 Codex 终端）并重新加载历史。
  - 同一目录下有运行中、会话未知的 Codex 终端（`new`、`resume-last`、`fork`）：发送返回 409 `terminal_conflict`（附终端列表），草稿保留，聊天显示 “Stop terminal / Continue anyway / Cancel”。“Stop terminal” 停止这些终端；“Continue anyway” 之后本标签的写请求带 `terminals: "ignore"`，不再询问。之后需再次发送。
  - 停止了终端且聊天运行时空闲时，重启运行时以读取终端写入的最新历史。
- 创建 `resume` 终端时：该会话正在归档/删除（`session_busy`）、聊天标签仍打开（`chat_input_owned`，需先关闭聊天）、聊天正在运行一轮或有审批（`session_busy`）时返回 409，不会中断聊天里正在跑的一轮；聊天空闲则先关闭聊天运行时再启动终端。聊天接管期间，`resume` 终端的输入被拒绝（`chat_input_owned`）。
- 归档或删除 Codex 会话时，整个过程持有删除锁：期间不能启动聊天运行时或创建 `resume` 终端（409 `session_busy`）。若聊天运行时非空闲或有终端正在恢复（`resume`）该会话，返回 409（`session_busy`），面板显示“先停止聊天或终端”；空闲的聊天运行时先关闭，关闭后再检查一次是否有新的写入者，再执行操作；对已归档的会话再次归档直接返回 409，不关闭运行时。
- 只有 `resume` 终端算作其 `sourceSessionId` 会话的写入者；`fork` 终端记录的是父会话 id，但写的是新会话，不会被父会话的聊天停止，父会话也不会因此从列表隐藏。

## 验收标准

- 服务端进程缺失或 spawn 失败时返回可恢复错误，不导致 TianForge pi 崩溃。
- 终端重连不重复或丢失缓冲区输出。
- 切换标签后草稿、模型与权限配置不丢失。
- 审批卡片只针对真实协议审批请求显示。
- 一个 Chat 的消息和 Thinking 不重复渲染。

## 后续计划

- 统一 Agent 活动通知中心。
- 为 Terminal CLI 增加结构化“等待输入”状态。
- 任务模板、批量启动和跨项目任务队列。
- 更细粒度的资源使用和运行时间统计。

## 依赖

- [多项目工作区](./multi-project-workspaces.md)
- [Session 可靠性](./session-reliability.md)
