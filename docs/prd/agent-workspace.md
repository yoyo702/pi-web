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
