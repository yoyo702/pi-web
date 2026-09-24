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
- 归档或删除 Codex 会话时，若聊天运行时非空闲或有终端正在恢复（`resume`）该会话，返回 409（`session_busy`），面板显示“先停止聊天或终端”；空闲的聊天运行时先关闭，关闭后再检查一次是否有新的写入者，再执行操作；对已归档的会话再次归档直接返回 409，不关闭运行时。
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
