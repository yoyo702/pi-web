# TianForge pi

[English](./README.md) | [日本語](./README.ja.md)

TianForge 是基于 [pi 编程智能体](https://github.com/badlogic/pi-mono) 构建的本地开发工作台；产品字标中的小号 `pi` 用于说明底层技术来源。它会读取本机的 pi 会话文件，在浏览器里提供多项目会话管理、实时对话、Agent 终端、Git 审查和项目文件预览。

## 快速开始

TianForge pi 要求 Node.js 22.19.0 或更高版本。可通过 `node --version` 检查当前版本。

**无需安装，直接运行：**

```bash
npx @agegr/pi-web@latest
```

**或全局安装后使用：**

```bash
npm install -g @agegr/pi-web
pi-web
```

启动后打开 [http://127.0.0.1:30141](http://127.0.0.1:30141)。命令行版本会在服务就绪后尝试自动打开浏览器。TianForge pi 默认仅监听 `127.0.0.1`。

**可选参数：**

```bash
pi-web --port 8080              # 自定义端口
pi-web --hostname 0.0.0.0       # 在可信网络中开放访问
pi-web -p 8080 -H 0.0.0.0       # 组合使用
pi-web --no-open                # 不自动打开浏览器

PORT=8080 pi-web                # 也支持环境变量
PI_WEB_HOSTNAME=0.0.0.0 pi-web  # 显式开放网络访问
PI_WEB_NO_OPEN=1 pi-web         # 适用于后台服务或开机自启
```

可设置 `PI_WEB_PASSWORD` 启用密码认证。只要监听非 loopback 地址就必须设置该变量；认证会保护整个 TianForge pi（聊天、文件、Git、设置和终端）：

```bash
PI_WEB_PASSWORD='请使用强密码' pi-web --hostname 0.0.0.0
```

登录后的浏览器拥有 TianForge pi 服务用户的本机权限。请勿直接暴露到互联网；应使用 HTTPS 和可信网络。

登录会话使用由密码派生的密钥签名，因此修改 `PI_WEB_PASSWORD` 会让所有浏览器退出登录。从 0.8.1 及更早版本升级后，所有设备也需要重新登录一次。

### 允许的访问地址（Host）

为防御 DNS rebinding 攻击，TianForge pi 只响应 `Host` 请求头属于本机的请求：`localhost`、回环地址、本机主机名和 `<主机名>.local`，以及本机当前的局域网 / Tailscale IP。Tailscale Serve 域名（`*.ts.net`）默认允许。

如果通过其他名称访问——自定义域名、反向代理或 DNS 别名——需要把它加到 `PI_WEB_ALLOWED_HOSTS`（逗号分隔；以 `*.` 开头表示匹配任意子域名）。设置该变量会替换默认的 `*.ts.net`，如果仍在使用 Tailscale Serve，请一并写上：

```bash
PI_WEB_ALLOWED_HOSTS='pi.example.com,*.ts.net' pi-web --hostname 0.0.0.0
```

未被允许的地址会返回 `421 unrecognized Host header; set PI_WEB_ALLOWED_HOSTS to allow it`。换了新地址后页面打不开时，请先检查这一项。

## HTTP 代理

TianForge pi 的服务端模型请求和 API 请求会读取标准的 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY` 环境变量。

macOS 或 Linux：

```bash
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
npx @agegr/pi-web@latest
```

Windows PowerShell：

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:7890"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:NO_PROXY = "localhost,127.0.0.1"
npx @agegr/pi-web@latest
```

## 功能介绍

- **多项目并行工作**：项目空间独立保存会话、文件标签和 Agent；切换项目不会中断后台任务，运行状态和完成消息会持续同步。
- **快速切换长会话**：最近会话保存在浏览器内存和 IndexedDB 中，切回时先立即恢复缓存，再与磁盘校准；历史消息按页加载，避免一次解析和渲染全部内容。
- **把历史工作接回来**：打开网页就能按项目找到以前的 pi 对话，不必在终端里翻文件或记住会话路径。
- **放心试不同方向**：可以从某条历史消息重新开始，也可以复制出一条独立的新路线，探索方案时不怕弄乱原来的对话。
- **跨分支工作**：在侧边栏切换 Git worktree，让新会话和 Explorer 跟随你选择的 checkout。
- **边聊边看项目文件**：左侧浏览项目文件，右侧打开源码、文档、图片、音频和 PDF；右侧工作区可明确展开或收起，文件标签支持滚轮横向滚动、锁定、批量关闭、复制路径和在 Explorer 中定位。
- **按需查看生成目录**：Explorer 默认隐藏 `.git`、`node_modules`、`dist` 等隐藏或生成内容，可用工具栏开关显示；macOS `._*` 元数据始终过滤。
- **一个空间管理多个仓库**：Git Review 会发现工作区内的嵌套 Git 仓库，并记住当前选择的仓库。
- **随时掌握会话状态**：在顶部就能看到上下文占用、花费、压缩结果和系统提示，长会话不再像黑箱。
- **交互式 AI CLI 终端**：可在右侧面板启动、重连本机 Codex 或 Claude 终端；只有你明确要求时，Pi 才会读取、发送文本或停止终端。
- **少离开当前界面**：模型、登录/API key、模型测试和技能开关都能在网页里处理，配置 agent 时不用在多个工具之间来回切换。

## 注意事项

- **数据目录**：默认读取 `~/.pi/agent/sessions` 下的会话文件。可通过环境变量 `PI_CODING_AGENT_DIR` 指定其他 pi agent 目录。
- **会话文件**：路径形如 `~/.pi/agent/sessions/<编码后的工作目录>/<时间戳>_<uuid>.jsonl`。
- **模型配置**：Models 面板读写 pi agent 目录下的 `models.json`，模型列表和默认模型由 pi 的配置解析得到。
- **Bash 防卡死**：模型发起的 Bash 调用默认有 300 秒超时，避免异常子进程永久阻塞会话和 steer 队列。可通过 `TIANFORGE_BASH_TIMEOUT_SECONDS` 设置其他正数，或设为 `0` 恢复 pi 的无限等待；模型显式指定的超时优先。
- **文件访问**：文件浏览和预览面向当前选择的项目目录，以及会话中已出现过的工作目录。显式添加的根目录保存在 `~/.pi-web/allowed-roots.json`，重启服务后仍有效。
- **Git worktree**：什么时候显示切换器、新建目录在哪里、删除会影响什么，见 [TianForge pi 里的 Worktree](./docs/worktrees.zh-CN.md)。
- **Fork 与会话内分支不同**：Fork 会创建新的 `.jsonl` 文件；“Edit from here” 是同一会话文件里的分支。
- **消息同步**：TianForge pi 和终端 `pi` 共用同一批会话文件。后台任务、浏览器缓存、分页加载和并发写入边界见 [TianForge pi 里的消息同步](./docs/sync.zh-CN.md)。

## 开发

```bash
npm install
npm run dev
```

默认开发服务器通过 HTTP 运行在 [http://127.0.0.1:30141](http://127.0.0.1:30141)，仅允许本机访问，不需要密码、证书或 `mkcert`。需要从局域网内的其他设备通过 HTTPS 测试时，请显式运行 `npm run dev:https`。

点击网页右上角的二维码按钮，可以选择当前的局域网或 Tailscale 地址、复制访问链接，或直接用手机扫码。弹窗会识别服务是否仍仅监听本机；如不可访问，使用 `npm run dev:https` 重启即可。二维码不会包含服务密码。

通过 Tailscale 长期访问时，推荐使用 Tailscale Serve 提供浏览器信任的 `*.ts.net` HTTPS 地址，避免 Android 将 `mkcert` 证书视为“不私密”并把 PWA 降级为普通快捷方式。保持 `npm run dev:https` 运行，并只需配置一次：

```bash
tailscale serve --bg https+insecure://127.0.0.1:30141
tailscale serve status
```

之后使用 `serve status` 输出的 `https://<设备名>.<tailnet>.ts.net/`。`--bg` 配置会持久保留，电脑或 Tailscale 重启后无需重复执行；TianForge 服务本身仍需运行。开发模式已允许 `**.ts.net` 来源，保证 Next.js HMR WebSocket 能通过两级 tailnet 域名完成握手。直接访问 `https://100.x.y.z:30141` 仍使用本机 `mkcert` 证书，手机必须另行信任根 CA。

移动端会始终显示 PWA 安装入口：Android 在浏览器提供安装事件时显示“Install app”，iOS 显示“分享 → 添加到主屏幕”的操作说明。浏览器支持 Fullscreen API 时还会另外显示一键全屏按钮；从安装后的 TianForge 图标启动不会显示浏览器地址栏。

开发模式默认把 Turbopack 的内存目标限制为 1536 MB，避免服务连续运行多天、经历大量热更新后耗尽 Node 堆。内存充足或大型项目需要调整时，可在启动前设置 `PI_WEB_TURBOPACK_MEMORY_MB`（最小 512），例如 `PI_WEB_TURBOPACK_MEMORY_MB=2048 npm run dev`。修改后需要重启开发服务器。

交互终端使用原生 `node-pty`。安装时 TianForge pi 会自动检查其 `spawn-helper` 的可执行权限，运行时也会再次自修复；如果包管理器完全阻止原生依赖安装，请在具备原生构建工具链的环境中批准脚本，或运行 `npm exec -- node-gyp rebuild --directory=node_modules/node-pty`。

常用检查：

```bash
node_modules/.bin/tsc --noEmit
npm run lint
```

开发时不要运行 `next build` / `npm run build`，它会写入 `.next/`，容易影响正在运行的 dev server。发布流程再执行构建。

## 项目结构

```
app/
  api/
    agent/          # 创建/驱动 AgentSession，提供 SSE 事件流
    auth/           # OAuth 和 API key 管理
    cwd/browse/     # 服务端目录浏览
    cwd/validate/   # 自定义工作目录校验
    default-cwd/    # 获取 pi 默认工作目录
    files/          # 文件列表、读取、预览、watch
    git/            # Git 状态、diff、历史和嵌套仓库发现
    home/           # 当前用户 home 目录
    models/         # 可用模型、默认模型、thinking levels
    models-config/  # 读写 models.json、测试模型
    sessions/       # 会话读取、重命名、删除、上下文、HTML 导出
    skills/         # skills 列表、搜索、安装、启停
components/
  AppShell.tsx        # 主布局、URL 状态、顶部面板、文件标签
  ProductBrand.tsx    # TianForge 主品牌与小号 pi 字标
  SessionSidebar.tsx  # 项目选择、会话树、Explorer
  DirectoryPicker.tsx # 支持浏览和路径输入的工作目录选择器
  ChatWindow.tsx      # 消息区、SSE、拖拽图片、minimap
  ChatInput.tsx       # 输入栏、模型/工具/thinking/compact/slash controls
  MessageView.tsx     # 消息、thinking、tool call/result 渲染
  ModelsConfig.tsx    # 模型和认证配置面板
  SkillsConfig.tsx    # 技能管理面板
  FileExplorer.tsx    # 文件树
  FileViewer.tsx      # 源码、diff、图片、音频、PDF、DOCX 预览
lib/
  directory-browser.ts # 目录规范化和安全枚举工具
  http-dispatcher.ts  # 服务端 fetch 的 HTTP(S) 代理配置
  rpc-manager.ts      # AgentSessionWrapper 生命周期和全局 registry
  session-reader.ts   # 解析 .jsonl 会话文件和分支上下文
  session-snapshot-cache.ts # 最近会话的内存/IndexedDB 快照
  session-background-sync.ts # 后台会话事件归并和缓存更新
  git-repositories.ts # 工作区内 Git 仓库发现
  normalize.ts        # 规范化 toolCall 字段名
  file-access.ts      # 文件读取安全边界
  file-paths.ts       # 文件路径编码/相对路径工具
  markdown.ts         # Markdown/Mermaid/KaTeX 插件配置
  pi-types.ts         # pi 相关类型
hooks/
  useAgentSession.ts  # 会话加载、发送命令、SSE 状态机
  useAudio.ts         # 完成提示音
  useDragDrop.ts      # 图片拖拽
  useTheme.ts         # 主题切换
bin/
  pi-web.js           # npm CLI 入口
instrumentation.ts    # 初始化服务端 HTTP dispatcher
```
