# Session 可靠性 PRD

## 背景与目标

TianForge pi、终端 Pi、Codex Chat 和 Agent Terminal 可能同时观察同一项目。产品需要最大限度避免消息重复、状态卡死、审批遗留和 Session 数据损坏。

## 已实现范围

### Pi Session

- 浏览 Session 时只读文件，不创建 AgentSession。
- 发送消息时按 Session ID 复用进程内 AgentSessionWrapper。
- 热更新后通过 `globalThis` 保持注册表。
- Fork 后立即销毁旧 wrapper，避免 parentSession 链污染。
- 页面重新获得焦点和低频轮询时检查文件 mtime；变化后才重载。
- Prompt 前检测外部写入并重载，降低旧内存 Tip 造成分支的风险。
- 运行状态使用 SSE，并通过周期状态核对修复漏失事件。
- 当前会话的逐 token SSE 会合并过时更新并处理背压，完成事件保持完整。
- 后台会话只接收运行状态、工具转换和完整消息等有界事件；过大的消息改为磁盘刷新提示。
- 最近会话使用有数量和消息上限的内存/IndexedDB 快照，项目切换时先恢复缓存再校准。
- 长会话按页加载上下文，桌面首屏 80 条、移动端 40 条，向上滚动继续加载。

### Codex 与 Terminal

- Codex spawn error 和 stderr 均被处理，避免服务器崩溃或管道阻塞。
- Terminal 使用 snapshot + subscribe 协议，避免重连重复和快照间隙丢数据。
- Terminal 与 Chat 交接会处理中断和审批清理。
- Chat 使用单调 run ID，忽略旧运行的迟到事件。
- 文本、Thinking、命令和审批分别按稳定 ID 去重。

## 已知限制

- Pi Session 文件本质上仍是单写者；两个进程同时 Prompt 可能形成分支。
- 普通 Terminal 无法仅凭 PTY 状态准确识别 Agent 是否等待用户输入。
- 浏览器断网期间的实时事件依赖重连后的状态核对。

## 验收标准

- 刷新或重连不会重复已有消息和终端缓冲区。
- 迟到 SSE 不会让已结束任务重新显示为运行中。
- 队列发送失败不会永久停在 queued。
- 过期审批可以清理、拒绝或终止，不阻塞后续对话。
- UTF-8 字符跨读取块边界时不会破坏 JSONL 解析。
- 慢连接或超长回复不会让 SSE 队列和 Node.js 堆内存无限增长。
- 切回后台运行的项目时立即显示缓存状态，并最终与会话文件一致。

## 后续计划

- 将 Pi、Codex 和 Terminal 的状态进一步统一为同一活动协议。
- 更明确的单写者租约和所有权交接协议。
- 审批、运行和恢复流程的故障注入测试。
- Session 修复和诊断工具。

## 相关文档

- [跨进程 Session 同步](../sync.zh-CN.md)
- [Agents 工作区](./agent-workspace.md)
