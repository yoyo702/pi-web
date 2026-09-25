# Agents 工作区 PRD

## 背景与目标

TianForge pi 不应把 Codex、Claude 和 Terminal 做成与产品割裂的测试侧栏。Agents 应成为项目工作区的一等能力，与 Pi、Explorer 和文件标签共同工作。

## 用户场景

- 在当前项目启动 Shell、Codex 或 Claude。
- 恢复、Fork、重命名、归档或删除 Codex Session。
- 查看、搜索、删除当前项目的 Claude 会话，在终端中恢复或 Fork，在聊天中打开或 Fork。
- 在 Chat 与 Terminal 两种交互界面之间选择。
- 保留模型、推理强度、权限策略等每个标签的配置。
- 在运行、审批或失败时获得清晰反馈并可终止任务。

## 已实现范围

- Agents 与 Pi 作为左侧主要模块，不占用测试用右侧栏。
- Agent/Terminal 在中央工作区以标签打开，支持多标签和终端分屏。
- 支持 Shell、Codex、Claude 三种启动类型。
- Codex 支持 Chat 和 Terminal Session；Chat 支持模型、推理、服务等级和审批策略。
- Claude 支持 Chat 和 Terminal Session；Chat 支持模型、权限模式、权限卡片、图片和 Fork。
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

## Claude 会话目录

- 数据来源：Claude Code 为每个会话写一个 JSONL 文件，位置是 `<配置目录>/projects/<编码后的 cwd>/<会话 id>.jsonl`。
  - 配置目录默认是 `~/.claude`，设置了 `CLAUDE_CONFIG_DIR` 时用它（测试用临时目录，不碰真实数据）。
  - 编码规则：cwd 中所有非字母数字字符替换为 `-`。超过 200 个字符时，Claude 会截断并加哈希后缀，所以按前 200 个字符匹配目录。
  - 同名的 `<会话 id>/` 目录存放子代理记录和大的工具结果。
- 实现：`server/agents/claude-sessions.cjs`（读取）和 `claude-sessions-api.cjs`（接口）。
  - 列表：`GET /api/claude/sessions?cwd=&q=&cursor=&limit=`。
  - 删除：`POST /api/claude/sessions/:id/delete`，请求体为 `{cwd}`。
  - cwd 必须在授权目录内（与终端相同的检查）。
  - 文件路径不返回给浏览器。
- 读取方式：会话文件可达几十 MB，服务端是单进程，所以不整读。
  - 头部按 64 KiB 分块读，读到第一条真实用户消息为止，最多读 4 MiB。从中取 cwd、git 分支、创建时间和第一条消息。超过 1 MiB 的单行（如粘贴的图片、大的 hook 输出）直接跳过，不解析。
  - 尾部读最后 256 KiB，取最新的标题。
  - 缓存：尾部按文件大小和修改时间缓存，变化后重读。头部找到第一条消息后就不再变化，文件只是变长时继续使用缓存，不重读。
  - 列出某个目录时，清除该目录下已删除文件的缓存；缓存超过 5000 条时整体清空。
- 列表规则：
  - 只列文件名是 UUID 的文件；只列记录的 cwd 与当前目录一致的会话，因为 `/a/b-c` 和 `/a/b/c` 编码后同名。
  - 没有用户消息的文件不显示：打开后就退出的会话，或只含标题记录的小文件，没有可恢复的内容。
  - 已知限制：前 4 MiB 内找不到用户消息的会话（例如第一条消息本身超过 1 MiB，或只执行过斜杠命令、`!` 命令），同样不显示，也不能在这里恢复或删除。
  - “第一条消息”跳过 Claude 注入的用户记录：`isMeta`、`isSidechain`、压缩摘要、工具结果，以及以 `<command-name>`、`<local-command-…>`、`<task-notification>`、`<system-reminder>`、`<bash-input>` 等开头的文本。
  - 标题优先级：用户自定义标题（`/rename`）> Claude 生成的标题 > 第一条消息。
  - 按文件修改时间倒序，每页 50 条（单次请求最多 200）。游标是偏移量。
  - 刷新会从头重读当前已显示的行数，超过 200 行时分多次请求。切换目录或搜索词时先清空列表，旧目录的行不能再点击。
  - “加载更多”失败只在该按钮上显示重试，已加载的行保留。
  - 搜索匹配标题、第一条消息和会话 id。
- 面板：
  - 只在 Claude 分组展开时加载。页面可见时每 30 秒刷新一次；Claude 终端启动或结束时也会刷新。
  - 每行显示标题、第一条消息（与标题不同时）、文件大小和更新时间；悬停显示 git 分支和会话 id。
  - 被 `resume` 终端打开的会话不在历史中重复显示，由该终端行显示会话标题。
- 恢复 / Fork：点击会话或菜单打开启动对话框，可选择动作（Resume / Fork）和权限（保留确认 / 危险跳过）。
  - 恢复：`claude --resume <id>`。同一会话同一时间只能有一个 `resume` 终端，第二个返回 409 `session_busy`。
  - Fork：`claude --resume <id> --fork-session`，写入新会话，原会话不变，可以与恢复同时进行。
  - 跳过权限时加上 CLI 帮助中探测到的跳过参数（`--dangerously-skip-permissions`）。
  - Claude 终端不支持 `resume-last`。会话 id 不是 UUID 时返回 400，会话不在当前目录时返回 404。
- 删除：删除会话文件和同名的 `<id>/` 目录，不可恢复，需要确认。
  - 为避免删掉 Claude 正在写入的文件（之后会被重新创建成残缺的会话），以下情况返回 409 `session_busy`：
    - 有 `resume` 终端正在恢复该会话；
    - 同目录下有运行中的 Claude 终端（任何启动方式），且它在该会话最后一次修改之前启动。`new`、`fork` 终端写入的会话 id 未知；在任何 Claude 终端里，用户都可以 `/clear` 开始新会话，或 `/resume` 其他会话。
  - 检查与删除在同一个同步步骤中完成，中间不会有新的终端启动。
  - 已知限制：在普通 Shell 终端或 pi-web 之外手动运行的 `claude` 无法检测。删除前请确认它已退出。
- 接口错误码：400 参数错误，403 目录未授权，404 会话不存在（包括会话文件无法读取），409 会话正在使用，其余 500（只返回通用提示，详情写服务端日志）。

## Codex 聊天运行时

- 每个会话一个 `codex app-server` 运行时进程（`server/agents/codex-app-server.cjs`），所有浏览器共用。没有页面在看、也没有进行中的一轮和未决审批时，30 秒后关闭；有进行中的一轮或等待审批时一直保留，一轮结束（或审批回复）后再开始空闲计时。因此在手机上发起一轮后锁屏或关闭标签，这一轮会继续跑完，在电脑上打开同一会话可继续看到。
- 运行时每次启动有新的 `runtimeId`；SSE 事件 id 为 `runtimeId:seq`。运行时重启后，浏览器按新运行时从头重放事件，不会因序号重置而漏事件。运行时退出时推送 `codex/closed`，聊天显示 “Reconnecting”；事件流在运行时就绪（`thread/resume` 成功）后才建立；新运行时无法恢复会话（如 `writer_conflict`）时直接返回 JSON 错误，浏览器不再反复重连，显示 “Codex chat disconnected: <原因>” 与 “Reconnect” 按钮。浏览器的 EventSource 读不到被拒绝时的响应，所以聊天会用普通请求再访问一次同一个事件地址，读出 JSON 错误作为原因（这次请求本身也会尝试恢复一次；此时已能连上或服务器不可达时，只显示 “Codex chat disconnected.”）。原因是终端占用（`terminal_owns_session`）时同时显示终端占用提示。
- 新建聊天：Agents 面板 Codex 行的聊天按钮（“New Codex chat”）在当前项目打开空白聊天标签（标题 “Codex Chat · New chat”），此时不启动 Codex、不建会话。第一条消息调用 `POST /api/codex/chat`（`{cwd, text, images, model, effort, serviceTier, approvalPolicy}`，目录须是已授权的项目，否则 403），服务端启动运行时、`thread/start` 建会话并发出这条消息，返回 201 `{threadId, turn}`；之后与打开已有会话相同。标签名改为第一条消息（前 60 字），默认审批策略 `untrusted`。建会话或第一轮失败时不留运行时，消息留在输入框，重试会新建会话。建会话期间切换项目，切回后标签已指向新会话。第一条消息之前不能用 `/compact`、`/review`、Fork。
  - 新会话刚建好时 Codex 列表可能还没有它：只要它的运行时在，打开聊天仍可用（历史为空）。
  - 之后从 Agents 面板再次打开同一会话，复用这个标签，不另开；会话还没有名字时保留标签原名（第一条消息），不改回 “Codex Chat”。
- 只发图片（无文字）也可以发送。
- Codex 请求的处理（服务端 `server/agents/codex-requests.cjs` 按类型校验回答）：
  - 命令审批：Allow once / Allow for session / Deny / Deny and stop；Codex 建议了命令规则时多一个 “Always allow `<命令前缀>`”，建议了网络规则时按主机显示 “Always allow/block <host>”（规则内容取自请求，浏览器只传选择）。
  - 文件改动审批：Allow once / Allow for session / Deny / Deny and stop。
  - 额外权限（网络、文件读写）：Allow for this turn / Allow for session / Deny，授予的正是请求的权限；卡片列出全部请求的路径（含通配和特殊路径条目）。
  - Codex 提问（“Codex has a question”）：每个问题选一项或填写答案，全部回答后才能 Submit。
  - MCP 服务请求输入：链接模式显示链接（仅 http/https 可点击），完成后点 Done；表单模式按字段填写后 Submit；都可 Decline / Cancel。
  - 其他请求（如动态工具调用 `item/tool/call`、ChatGPT 登录刷新）立即回错误，聊天显示 “Codex asked for …, which Codex Chat does not support; it was declined.”，这一轮不会卡住。
  - 回答格式错误返回 400，卡片保留；请求已不存在返回 409 `approval_expired`。
- 运行中插话：Codex 在跑时，Enter 或 “Steer” 把消息加入当前这一轮（`POST /api/codex/chat/:id/steer`，app-server `turn/steer`）；“Queue” 排到下一轮，斜杠命令在运行中总是排队。这一轮刚结束或不能插话（review、compact）时返回 409 `no_active_turn`，消息自动排队，这一轮结束后按普通消息发送。插话不会启动运行时，只作用于本聊天已在运行的一轮；请求失败时消息放回输入框。
- 文件改动显示为差异：新增文件全部为 “+” 行，删除文件全部为 “-” 行，修改显示 Codex 给出的 hunk（重命名时目标为新路径）；默认折叠，点开文件行查看。
- 任务列表：`turn/plan/updated` 显示为 “Tasks” 卡片（“n/m done”，○ 待做 / ◐ 进行中 / ● 完成），每轮一张，更新时移到最新位置。Codex 不把计划更新写入会话文件，所以只在运行时事件里可见（实时或重放缓冲）；运行时关闭后重新打开，任务列表不再显示。
- Fork（都在新标签打开，原聊天不变）：
  - 输入框 “More → Fork chat” 复制整个会话。
  - 用户消息上的 “New session” 从这条消息分叉：保留它之前的各轮（`POST /api/codex/chat/:id/fork`，`{lastTurnId}` 为上一轮的 id，含该轮），这条消息放进新标签的输入框，可修改后发送。会话第一条消息没有之前的轮，不显示该按钮；运行中不能 Fork。
  - 服务端在单独的短命 app-server 进程里调用 `thread/fork`（`excludeTurns: true`），等进程退出后才返回。原因：app-server 对它加载过的每个会话（包括 fork 出的新会话）一直保持写入者身份，`thread/unsubscribe` 也不释放；在原会话的运行时里 fork，新会话的运行时会报 “already has an active writer”。Fork 不启动运行时，也不检查终端占用。
- 错误显示：
  - `error` 且 `willRetry: true`：显示 “Codex is retrying: …”，这一轮继续，收到新的条目或一轮开始后提示消失。
  - `turn/completed` 带 `turn.error`：显示 “Turn failed: …”。
  - 会话被另一个 Codex 客户端（如 ChatGPT 桌面端）占用（app-server 报 “already has an active writer”）：409 `writer_conflict`，提示完全退出该应用后重试，或从 Agents 面板 Fork。
- 聊天接口错误码：400 参数错误，403 目录未授权，404 会话不存在；409 用于已归档、正在归档/删除或有一轮在跑（`session_busy`）、终端占用（`terminal_owns_session`、`terminal_conflict`）、`writer_conflict`、审批已过期（`approval_expired`）、没有进行中的一轮（`no_active_turn`）；503 app-server 不可用；其余 500。app-server 自身的错误（`rpc_error`）、超时和运行时退出原因会显示，但其中的文件路径替换为 `<path>`；其他 500/503 只返回通用提示，详情写服务端日志（stderr 只进日志）。

## Claude 聊天运行时

- 每个会话一个 `claude --print --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio --allow-dangerously-skip-permissions` 进程（`server/agents/claude-chat-runtime.cjs`，接口 `claude-chat-api.cjs`），所有浏览器共用。
  - 打开聊天只读会话文件，不启动进程；第一条消息才启动（已有会话用 `--resume <id>`，新聊天用 `--session-id <新 id>`，Fork 见下）。
  - 没有页面在看、也没有进行中的一轮和未决审批时，30 秒后关闭进程；一轮进行中或有审批时一直保留。因此发起一轮后关掉页面，这一轮会跑完。
  - `--permission-prompt-tool stdio` 让权限请求走 `control_request can_use_tool`，由浏览器回答；不加这个参数，权限请求会被自动拒绝。`--allow-dangerously-skip-permissions` 只是允许之后切到 `bypassPermissions`，不会直接开启它。
- 接口（所有 POST 请求体都带 `cwd`；cwd 须是已授权目录，会话须属于该目录）：
  - `GET /api/claude/chat/:id?cwd=&before=`：返回 `{session, history, cursor, events, runtime, terminal}`。`history` 是会话文件末尾约 512 KiB 的记录（带 `before` 时取更早的一页，只返回 `history`/`cursor`；`cursor` 为 null 表示已到文件开头）。一行超过窗口时窗口扩大；超过 32 MiB 的行跳过。`events` 是运行时缓冲的事件（最多 2000 条），`runtime` 包含 `runtimeId`、是否运行、模型、权限模式、未决请求。`terminal` 非空表示有 `resume` 终端正在写该会话。
  - `GET /api/claude/chat/:id/events?cwd=&after=runtimeId:seq`：SSE。先发 `pi/connected {sessionId, runtimeId}`，事件 id 为 `runtimeId:seq`；`after` 属于当前运行时时只重放之后的事件，否则从头重放；`after` 之后的事件已被挤出缓冲时改发 `pi/reset`（无事件 id），前端重新读取快照（`GET /api/claude/chat/:id`）后再订阅。前端已知的 `runtimeId` 与 `pi/connected` 不同（运行时闲置关闭后被重建）时同样重新读取快照。服务端拒绝事件流（如会话不属于该目录）时，聊天与 Codex 一样再请求一次事件地址读出原因，显示 “Claude chat disconnected: <原因>” 与 “Reconnect”。
  - `POST /api/claude/chat`：新聊天的第一条消息，`{cwd, text, images?, uuid, model, permissionMode, fork?}`，返回 201 `{sessionId}`。带 `fork: {sessionId, at?}` 时新会话是 `sessionId` 的副本（见 Fork）。
  - 消息体（这里和 `/send`）：`text` 与 `images` 至少有一个；`images` 最多 5 张，每张是 `data:image/(png|jpeg|webp|gif);base64,...`（与 Codex 相同），base64 部分不超过 5,000,000 字符（约 3.75 MB 原图），请求体上限 26 MiB。原因：Anthropic API 拒绝超过 5 MB 的 base64 图片，而 Claude 已把图片写进会话，之后每次 `--resume` 都会重发并再次失败。聊天输入框只附加不超过 3.75 MB 的图片，更大的跳过并提示。服务端把图片转成 `{type:"image", source:{type:"base64", media_type, data}}` 内容块放在文字前发给 Claude；推给浏览器的 `user` 事件里图片只剩 `{type:"image"}`（与历史记录的裁剪一致），显示为 “[Image]”。只发图片时会话标题为 “Image”。
  - `POST /api/claude/chat/:id/send`（202）、`/interrupt`、`/respond`（`{requestId, decision: allow|allowSession|deny, message?, updatedInput?}`，204）、`/claim`（停止恢复该会话的终端，204）。
- 事件：转发 Claude 的 stream-json 记录（`stream_event`、`assistant`、`user`、`result`、`control_request`；`system` 只保留 init/status 中的模型和权限模式），每条加 `piSeq`、`piRuntime`，`assistant` 记录加 `piBlockIndex`（对应流式事件的内容块序号，用于把流式文本替换成最终文本）。另有服务端事件：`pi/resolved`（请求已回答，或 Claude 发来 `control_cancel_request` 取消了它）、`pi/closed`（进程意外退出，附原因）、`pi/stopped`（进程被主动停止）。一轮结束（`result`）后，缓冲中的 `stream_event` 被丢弃，只保留完整记录。前端的运行状态只跟随事件（`user` → 运行中，`result`/`pi/closed`/`pi/stopped` → 空闲），不因 POST 成功而设置。
- 聊天界面（Claude Chat 标签，复用 Codex 聊天的消息列表和输入框）：
  - 标题 “Claude Chat · <会话名> · <目录>”；有更早历史时显示 “Load earlier”。
  - 发送时浏览器生成消息 uuid，先显示为待发送，收到同一 uuid 的记录后替换，不重复显示。
  - Claude 在跑时不能插话：输入框提示 “Queue a message for the next turn…”，消息排队，这一轮结束后发送。服务端对进行中的会话再次发送返回 409 `session_busy`。
  - Esc 或停止按钮中断这一轮（`interrupt` 控制请求）；Claude 以 `result` 结束这一轮，进程保留。
  - 模型：Default / Sonnet / Opus / Haiku；权限模式：Ask before edits（`default`）/ Accept edits / Plan mode / Bypass permissions。都作用于下一条消息：与运行中进程的启动参数不同时，服务端先停止进程再用新参数启动（比较的是启动时请求的模型别名 `launchModel`，不是 Claude 回报的完整模型名，所以同一模型不会每次重启）。
  - “Allow for session” 可能让 Claude 切换权限模式（如接受编辑），`system` 记录回报新模式后，界面和标签配置随之更新。
  - 工具显示：Bash 显示为命令和输出；Edit / MultiEdit / Write 显示为差异；其他工具显示名称、输入和结果。
  - 任务列表：`TaskCreate` / `TaskUpdate`（Claude Code 2.x 的任务工具）和旧的 `TodoWrite` 不显示为工具调用，而是合成一张 “Tasks” 卡片，放在最近一次改动的位置。新任务的编号取自 `TaskCreate` 的结果（“Task #N created …”），`TaskUpdate` 只更新已知编号（`deleted` 删除）；创建在未加载的更早历史里的任务，其更新被忽略。斜杠命令按输入显示，命令输出显示为提示；“[Request interrupted by user]” 显示为 “Interrupted”。`result` 带 `is_error` 时显示错误提示。
  - Fork（都在新标签打开，原会话不变）：输入框 “More → Fork chat” 复制整个会话；用户消息上的 “New session” 从这条消息分叉，只保留它之前的内容，这条消息放进新标签的输入框（浏览器拿不到图片数据，所以这条消息的图片不会带过去，“[Image]” 占位行被去掉，需要重新附加）。会话第一条消息（已加载到文件开头时）没有之前的内容，不显示该按钮；运行中、未连接或还没有会话时不能 Fork。Agents 面板 Claude 会话菜单的 “Fork to Chat” 同样复制整个会话。
    - Claude 只在开始一轮时 Fork，所以新标签先是空白聊天（标题 “<原名> (fork)”，提示第一条消息会开始 Fork），不读原会话。第一条消息调用 `POST /api/claude/chat`，带 `fork: {sessionId, at?}`（`at` 是所选用户消息的 uuid），标签随后与新聊天一样指向新会话。Claude 写出新会话文件之前，读取接口返回 `session.created: true` 和空历史；第一轮结束（`result`）后聊天重新读取一次，显示复制过来的内容。
    - 服务端找到 `at` 这条用户记录，沿 `parentUuid` 往前找到最近的一条消息（`user` 或 `assistant`；中间的 `system`（如 turn_duration）、`attachment` 等记录跳过，因为 Claude 只能在消息处恢复），以 `--resume <原 id> --fork-session --resume-session-at <该消息 uuid> --session-id <新 id>` 启动；不带 `at` 时不加 `--resume-session-at`。（`--resume-session-at` 是 Claude Code 2.1 的隐藏参数，与 `--resume` 一起使用；`--session-id` 与 `--fork-session` 一起时生效，所以新会话 id 由服务端事先决定。）新会话文件写出之前重启进程会再次 Fork；之后就是普通的 `--resume <新 id>`。进程在写出新会话之前退出时，聊天收到 `pi/closed`（`code: "fork_failed"`），显示 “Claude could not fork the session…”，详细原因（stderr）只在服务端日志里；再发一次消息会重试 Fork。聊天空闲关闭后（无人查看 30 秒）这个未写出的会话就不存在了，标签会报会话不存在，需要从原会话重新 Fork。
    - 错误：原会话不在该目录或 `at` 不在会话文件中 404；`at` 之前没有消息 400；`at` 之后会话被压缩过（`/compact` 或自动压缩，文件里有之后的 `compact_boundary`）400，提示从更晚的消息 Fork——Claude 不能在压缩之前的位置恢复；原会话正在跑一轮时 409 `session_busy`（否则会复制半轮）。Fork 不检查原会话是否被终端占用（只读原文件）。
  - 暂不支持：子代理详情、斜杠命令菜单。
- 权限卡片（`control_request can_use_tool`）：
  - 普通工具：显示命令 / 差异 / 输入 JSON、文件路径和原因；按钮 Allow、Allow for session（仅当 Claude 给出建议规则时，同时应用这些规则）、Deny。
  - `ExitPlanMode`：显示计划，按钮 “Approve plan” / “Keep planning”。
  - `AskUserQuestion`（“Claude has a question”）：每个问题选项或填写 “Other answer”，全部回答后 Submit，答案按问题文本放进 `updatedInput.answers`（多选用 “, ” 连接）；Skip 为拒绝。
  - Claude 取消请求（`control_cancel_request`）或请求已不存在时，卡片消失；回答已过期的请求返回 409 `approval_expired`。
- 入口：Agents 面板 Claude 分组中点击会话，或菜单 “Open in Chat”；分组的聊天按钮（“New Claude chat”）打开空白聊天，第一条消息创建会话，标签名改为第一条消息（前 60 字）。项目栏和通知中的 Claude 聊天条目打开对应标签。
- 状态：运行时状态通过工作区状态 SSE 的 `claude_runtimes` 推送（`idle` / `running` / `approval`），用于项目栏活动、通知（kind `claude`）和 Agents 面板的状态点。
- 接口错误码：400 参数错误（含不支持的模型、权限模式），403 目录未授权，404 会话不存在；409 `session_busy`、`terminal_owns_session`、`approval_expired`、`no_active_turn`；503 进程不可用或控制请求超时（10 秒）；其余 500。

## 活动通知

跑完、失败或等待审批的任务会留下一条通知，手机和电脑共用同一份列表和已读状态：在手机上发起、锁屏后，回到电脑上能看到结果。

- 存储：服务端 `server/notifications.cjs`，写入 `~/.pi-web/notifications.json`（可用环境变量 `PI_WEB_NOTIFICATIONS_FILE` 改路径；测试和 e2e 用临时文件）。不读写 `~/.codex`、`~/.pi`。文件损坏时从空列表开始（服务端日志有警告），写入失败只记日志，列表仍在内存可用。
- 保留：最近 7 天，最多 200 条，超出的旧条目自动删除。每条事件都会同步重写整个文件。同一个通知文件只应由一个 pi-web 进程使用：两个进程（如 `npm start` 和 `npm run dev`）同时写同一文件会互相覆盖，第二个进程应设置不同的 `PI_WEB_NOTIFICATIONS_FILE`。
- 记录的事件：
  - Codex 聊天：一轮完成（Completed）、失败（Failed，带 `turn.error` 原因）、等待审批或提问（Needs your input）；这一轮中途运行时意外退出算失败（用户停止或服务端正常关闭时先停止运行时，不记录）。被中断（interrupted）的一轮不记录；pi-web 不支持而直接拒绝的请求不记录。标题为会话名，无名字时用第一条消息。
  - Pi 会话：等整次运行结束（`agent_settled`）后，按最后一次 `agent_end` 的最后一条助手消息判断：`stopReason: "error"` 记为失败（带错误信息），用户中止（aborted）不记录，其余记为完成。Pi 自动重试成功、或上下文溢出后压缩并继续成功的，只记一条完成。标题为会话名，否则第一条用户消息。worktree 里的会话同时记录项目根目录，用来找到对应项目。
  - 终端：退出码非 0 或被信号结束记为失败（“Exited with code N” / “Killed by signal …”）；Codex/Claude 终端正常退出记为完成；普通 shell 正常退出、用户点 Stop 停止的终端不记录。
- 已读：同一个聊天、会话或终端有新通知时，它之前未读的通知自动标为已读（只需关注最新状态；同一聊天连续两个审批时，只有后一个显示为未读，两个审批卡片仍都在聊天里）。点击通知标为已读，“Mark all read” 全部标为已读；已读状态保存在服务端，所有设备同步。接口 `POST /api/notifications/read`，请求体 `{"ids": [...]}`（最多 500 个）或 `{"all": true}`，返回 `{changed}`；格式错误 400，非 POST 405。
- 推送：通知列表作为 `notifications` 快照（`{notifications, unread}`，新的在前）通过状态 SSE（`/api/agent/running/events`）推送，连接时先发一次完整快照。
- 界面：
  - 项目栏铃铛（“Workspace activity”）的角标为未读数；有等待审批的任务时角标为审批颜色，鼠标悬停显示未读数和等待数。
  - 中间工具栏的 “Workspace activity” 按钮（手机上也有）显示未读数。
  - 两处活动面板底部都有 “Recent” 列表：未读加粗，显示项目、类型、事件、时间，失败时附原因；点击后标为已读，并切换到所在项目打开对应的聊天、会话或终端（项目未打开时只标已读；终端记录只在内存中，服务端重启或 “Clear ended” 之后点击终端通知只切换到所在项目）。没有通知时显示 “No notifications in the last 7 days”。
- 暂未实现：浏览器系统推送（Push API）；正在查看的标签不会自动标为已读。

## 状态模型

- `idle`：可输入新任务。
- `running`：模型生成、工具执行或终端进程运行。
- `approval`：存在结构化审批请求。
- `ended`：Terminal 已自然结束。
- `stopped`：用户主动停止。
- `failed/offline`：进程异常或连接不可用。

Codex Chat 的审批来自 app-server 协议，Claude Chat 的审批来自 stream-json 的 `can_use_tool` 控制请求；普通 Terminal 不通过输出文本推断审批。

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
- Claude 会话：同一会话同一时间只允许一个 `resume` 终端；删除时的写入者判断见“Claude 会话目录”。
  - Claude Chat 与 `resume` 终端互斥：有 `resume` 终端在写该会话时，聊天显示 “This session is open in a Claude terminal” 和 “Stop terminal”，发送返回 409 `terminal_owns_session`；点击后调用 `claim`（先 Ctrl+C 再停止终端）并重新加载历史。
  - 创建 `resume` 终端时：聊天正在跑一轮或有审批返回 409 `session_busy`；聊天空闲则先停止聊天进程，聊天标签可稍后重新打开。
  - 删除 Claude 会话时，聊天进程存在或正在启动返回 409 `session_busy`（“Close the chat first”）。
  - 已知限制：只识别 pi-web 启动的 `resume` 终端。`new` / `fork` 终端里用 `/resume` 切到该会话、普通 Shell 里运行的 `claude`、pi-web 之外的 Claude 都无法检测；两个进程同时写同一会话文件会导致历史错乱。终端所在目录通过符号链接与聊天目录不同时也不会匹配（不做 realpath）。
- 只有 `resume` 终端算作其 `sourceSessionId` 会话的写入者；`fork` 终端记录的是父会话 id，但写的是新会话，不会被父会话的聊天停止，父会话也不会因此从列表隐藏。

## 验收标准

- 服务端进程缺失或 spawn 失败时返回可恢复错误，不导致 TianForge pi 崩溃。
- 终端重连不重复或丢失缓冲区输出。
- 切换标签后草稿、模型与权限配置不丢失。
- 审批卡片只针对真实协议审批请求显示；Codex 的每个请求要么显示卡片，要么立即被拒绝，不会让一轮一直等待。
- 一个 Chat 的消息和 Thinking 不重复渲染。

## 后续计划

- 合并三处活动显示（项目栏铃铛、中间工具栏活动面板、Agents 面板）为一个活动中心；浏览器系统推送（Push API）。
- 为 Terminal CLI 增加结构化“等待输入”状态。
- 任务模板、批量启动和跨项目任务队列。
- 更细粒度的资源使用和运行时间统计。

## 依赖

- [多项目工作区](./multi-project-workspaces.md)
- [Session 可靠性](./session-reliability.md)
