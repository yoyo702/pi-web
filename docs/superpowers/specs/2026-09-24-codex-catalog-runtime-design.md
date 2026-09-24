# Codex 会话目录与运行时修复设计

日期：2026-09-24
状态：第 1、2、3 批已实施

## 背景

对本机 codex-cli 0.155.1 的 app-server 协议（`codex app-server generate-ts --out /tmp/codex-proto`）与现有集成对比后发现：

- 会话目录（`server/agents/codex-sessions.cjs`）以 `~/.codex/session_index.jsonl` 为准，而该文件只记录起过名字的会话：本机 30 个交互会话中 20 个在网页上不可见，分叉出的会话也不可见；上限 250 条；索引中重复的 id 会显示两行。
- 网页聊天的每个请求都调用 `requireSession`（完整目录扫描 + 最多 250 个会话摘要），分叉出的新会话不在索引中，打开聊天报 “Codex session not found”。
- 改名直接改写索引文件，归档/取消归档/删除走 CLI；运行中的会话也能被删除或归档。
- 运行时：
  - `codex-app-server.cjs` 的空闲关闭不看 `activeTurnId`，关闭聊天标签 30 秒后中断正在进行的一轮。
  - `codex-app-api.cjs` 在每个请求（含 GET 与 15 秒对账）上接管会话，按 `sourceSessionId` 停掉 Codex 终端；分叉终端记录的是父会话 id，因此打开父会话聊天会误杀分叉终端；“新建 / 继续最近” 终端没有会话 id，无法阻止与聊天同时写同一会话。
  - `error{willRetry:true}` 被当成结束；`turn/completed` 的 `turn.error` 不显示；只发图片（无 `text`）时报错；所有错误返回 400；请求体未使用 `server/http-body.cjs`。

## 目标

第 1 批（会话目录）：
1. 列表使用 app-server 的 `thread/list`：所有交互会话可见（含未命名、分叉），按 id 去重，分页加载，无 250 上限。
2. 支持按项目目录（`cwd`）、归档状态、标题搜索（`searchTerm`，另外支持按 id 精确匹配）过滤。
3. 每行显示：名称（无名称时显示 `preview` 第一条消息）、更新时间、模型、分叉来源（`forkedFromId`）。
4. 改名、归档、取消归档、删除改用 `thread/name/set`、`thread/archive`、`thread/unarchive`、`thread/delete`。运行中（有聊天运行时且非空闲，或有 Codex 终端在写该会话）的会话拒绝归档和删除，返回明确错误。
5. 聊天请求的会话校验改用 `thread/read`（不含 turns）或目录缓存，不再完整扫描；分叉出的会话可以直接打开聊天。
6. 目录使用一个长期运行、共享的 app-server 连接（与各会话的运行时进程分开）；该连接不可用时，列表退回现有的文件扫描实现，不显示空白。

第 2 批（运行时）：
1. 空闲关闭：有进行中的一轮（`activeTurnId`）或未决审批时不关闭运行时进程；一轮结束后再按原空闲时间关闭。关闭聊天标签不影响正在进行的一轮。
2. 单写者：
   - 只有写操作接管会话：发送消息、回复审批、中断、压缩、代码审查。GET、SSE、对账不再接管。
   - 接管时只停止确实在写该会话的终端：`resume` 终端按 `sourceSessionId`；`fork` 终端不按父会话 id 匹配。
   - 同一目录里有运行中的、会话未知的 Codex 终端（`new`、`resume-last`、`fork`）时，写操作返回可识别的冲突错误；前端提示“先停止该终端 / 取消”，用户确认后停止终端再重试。
3. 错误处理：
   - `error{willRetry:true}` 显示“重试中”，不结束运行。
   - `turn/completed` 带 `turn.error` 时显示失败原因。
   - 允许只发图片。
   - 接口错误按类型返回 400/403/404/409/500，并使用 `server/http-body.cjs` 读取请求体。

第 2 批实施说明：
- 界面文字为英文，冲突和错误提示均为英文。
- 冲突提示除“停止终端 / 取消”外还有“Continue anyway”（`terminals: "ignore"`）：终端可能在做别的会话，由用户判断。
- GET 与 SSE 不接管；若有 `resume` 终端正在写该会话且没有聊天运行时，返回 409 `terminal_owns_session`，前端显示“Stop terminal”，确认后调用新增的 `POST /api/codex/chat/:id/claim`（`{terminals:"ignore"}`，只停止该 `resume` 终端）再重新加载。
- SSE 等运行时就绪后才返回 200，恢复失败时返回 JSON 错误，避免浏览器反复重连、反复启动进程。
- 显示给浏览器的 Codex 错误文本中的文件路径替换为 `<path>`。
- 空闲计时在运行时就绪后才开始；运行时带 `runtimeId`，SSE id 为 `runtimeId:seq`，运行时重启后前端从头重放。
- 另一 Codex 客户端（如 ChatGPT 桌面端）占用会话时返回 409 `writer_conflict` 并说明原因。
- 归档/删除期间加删除锁：不启动聊天运行时，也不创建 `resume` 终端。
- 创建 `resume` 终端时若聊天正在运行一轮，返回 409，不再中断手机上发起的一轮。

第 3 批（审批补全与运行中插话）：
1. Codex 发给客户端的请求按类型处理，由 `server/agents/codex-requests.cjs` 校验浏览器的回答并生成协议回复：
   - 命令审批（`item/commandExecution/requestApproval`）：`accept`、`acceptForSession`、`decline`、`cancel`；有 `proposedExecpolicyAmendment` 时可“始终允许”该命令前缀，有 `proposedNetworkPolicyAmendments` 时可按主机始终允许/阻止。规则内容取自请求本身，浏览器只传选择（`amendmentIndex`）。
   - 文件改动审批（`item/fileChange/requestApproval`）：`accept`、`acceptForSession`、`decline`、`cancel`。
   - 额外权限（`item/permissions/requestApproval`）：按请求授予网络/文件读写权限（含 `fileSystem.entries` 路径/通配/特殊路径条目，卡片逐条列出“访问方式: 路径”），范围为本轮（`turn`）或本会话（`session`）；拒绝时授予空权限。
   - 向用户提问（`item/tool/requestUserInput`）：每个问题选一个选项或填写答案（`isOther`、`isSecret` 时显示输入框/密码框），回复 `{answers:{[id]:{answers:[...]}}}`。
   - MCP 请求输入（`mcpServer/elicitation/request`）：`url` 模式显示链接（只打开 http/https），点“Done”回复 `accept`；表单模式按 schema 显示字符串、数字、布尔、单选、多选字段；都可 Decline、Cancel。
   - 其他请求（`item/tool/call`、ChatGPT token 刷新、attestation、旧版 `applyPatchApproval`/`execCommandApproval`）立即回 JSON-RPC 错误（-32601），聊天显示“Codex asked for …, which Codex Chat does not support; it was declined.”，这一轮不会一直等待。
2. 运行中插话：Codex 在跑时，按 Enter 或“Steer”调用 `POST /api/codex/chat/:id/steer`（app-server `turn/steer`，带 `expectedTurnId`），消息加入当前这一轮；“Queue”按钮排到下一轮。斜杠命令在运行中总是排队。这一轮已结束或不能插话（如 review、compact）时返回 409 `no_active_turn`，前端自动改为排队，这一轮结束后发送。判断依据：JSON-RPC `error.data` 里的 `activeTurnNotSteerable`（`protocolError` 保留为 `rpcData`），或错误文字 “no active turn” / “expected active turn id”。插话只作用于本聊天已在运行的一轮，不会启动运行时（接管后再检查一次运行时仍在）。插话请求失败时，消息放回输入框，排在期间新输入内容的前面。

## 非目标

- 新建 Codex 聊天、改动/待办展示、从消息分叉（后续批次）。
- 终端内启动 Codex 的方式不变。
- 会话数据只存于 `~/.codex`，本项目不另存副本。

## 组件

### 服务端

- `server/agents/codex-catalog.cjs`（新）：共享 app-server 客户端（懒启动、单例挂在 `global`、崩溃后下次请求重启、空闲一段时间后关闭）。导出 `listThreads({ cwd, archived, searchTerm, cursor, limit })`、`readThread(id)`、`setName`、`archive`、`unarchive`、`remove`。进程不可用时抛出可识别错误（`catalog_unavailable`）。
  - 实施说明：`listModels` 仍留在 `codex-app-server.cjs`（按 cwd 启动、缓存 10 分钟），因为项目级 Codex 配置可能随 cwd 不同；共享连接固定在用户主目录启动。
  - 实施说明：改名、归档、恢复、删除只走 app-server，不再保留 CLI 兜底；app-server 不可用时返回 503。
- `server/agents/codex-sessions.cjs`：`listSessions` 优先使用 `codex-catalog`，失败时退回现有文件扫描；返回结果增加分页游标、`model`、`forkedFromId`（未命名会话以 `preview` 作为名称，不单独返回）；按 id 去重。现有的摘要读取（最后的用户/助手消息，只读文件尾部并缓存）保留，用于当前页。
- `server/agents/codex-sessions-api.cjs` / `codex-app-api.cjs`：使用上述接口；运行中拒绝归档/删除（409）；会话校验走 `readThread`。
- `server/agents/codex-app-server.cjs`：空闲关闭考虑进行中的一轮与未决审批；接管逻辑移到写操作。
- `server/agents/terminal-manager.cjs`：提供“哪些终端在写某个会话 / 某目录下哪些 Codex 终端的会话未知”的查询。

### 前端

- `components/agents/AgentsPanel.tsx`：列表分页（“加载更多”）、显示预览/模型/分叉来源；删除/归档运行中会话时显示服务端错误。
- `components/agents/codex/CodexChatPanel.tsx`：重试中状态、失败原因、只发图片、写冲突提示与确认；第 3 批：按类型的请求卡片（`CodexRequestCard.tsx`）、插话与排队。

## 测试

- 服务端单元测试使用假的 app-server（可执行脚本或注入的传输层）与临时目录，不读写真实 `~/.codex`：分页与去重、过滤、回退到文件扫描、运行中拒绝删除、空闲关闭不打断进行中的一轮、写操作才接管、未知会话终端冲突。
- e2e：Agents 面板列表分页与“加载更多”、聊天错误与重试状态显示、提问卡片、插话与排队（模拟接口）。
- 第 3 批单元测试：各请求类型的回复与非法输入、不支持的请求立即回错误且一轮继续、插话成功与一轮结束后返回 `no_active_turn`。
- 手动只读检查：本机列表能列出全部交互会话。
