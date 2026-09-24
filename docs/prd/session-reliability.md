# Session 可靠性 PRD

## 背景与目标

TianForge pi、终端 Pi、Codex Chat 和 Agent Terminal 可能同时观察同一项目。产品需要最大限度避免消息重复、状态卡死、审批遗留和 Session 数据损坏。

## 已实现范围

### Pi Session

- 浏览 Session 时只读文件，不创建 AgentSession。
- 发送消息时按 Session ID 复用进程内 AgentSessionWrapper。
- 热更新后通过 `globalThis` 保持注册表。
- Fork 在独立的 SessionManager 上创建分支，不修改源会话；源会话空闲时随即释放，运行中则等运行结束后由空闲计时器释放。
- 释放会话时调用 SDK 的 `dispose()` 中止进行中的任务，并通过 `session_closed` 通知 SSE 关闭，避免孤儿 Agent 在会话删除后重新写回文件。
- 删除会话时只读取文件头来查找子会话，并以“临时文件 + rename”原子改写其父链接；运行中的子会话会跳过并返回失败列表。
- 会话列表按目录缓存解析结果，只重新解析文件有变化的目录。
- pi 0.86+ 写入会话记录的 system 消息（system prompt 与工具声明）只属于模型上下文，不进入聊天记录、分支树和实时事件；System prompt 面板按需启动会话读取实际生效的 prompt。
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
- 新会话的第一条消息只显示一次；删除正在运行的会话后，文件不会被重新写回。

## 后续计划

- 将 Pi、Codex 和 Terminal 的状态进一步统一为同一活动协议。
- 更明确的单写者租约和所有权交接协议。
- 审批、运行和恢复流程的故障注入测试。
- Session 修复和诊断工具。

## 相关文档

- [跨进程 Session 同步](../sync.zh-CN.md)
- [Agents 工作区](./agent-workspace.md)
