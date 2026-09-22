# 安全局域网访问 PRD

## 背景与目标

TianForge pi 会暴露本机项目文件、Session 和 Terminal。局域网访问必须默认安全，同时尽量减少开发时重复输入配置的成本。

## 已实现范围

- `npm run dev` 默认仅通过 `127.0.0.1` 提供 HTTP 服务，不触发证书流程。
- 局域网 HTTPS 是显式模式，通过 `npm run dev:https` 启动。
- Loopback 模式可在无密码时通过 HTTP 运行。
- 非 Loopback 监听必须配置密码。
- 开发脚本生成并复用本地 HTTPS 证书。
- 启动时列出可访问的局域网 IPv4 HTTPS 地址。
- 开发密码持久化到用户目录并限制文件权限。
- 登录使用 POST，密码不进入 URL、历史记录或 Referer。
- 已登录电脑通过同源 `POST /api/auth/pair` 签发 5 分钟有效、仅能兑换一次的手机配对链接；配对 URL 只携带随机令牌，不携带密码。
- 手机端始终提供 PWA 安装入口；Android 使用可用的浏览器安装事件，iOS 引导“分享 → 添加到主屏幕”。标签页全屏作为独立的可选操作，不覆盖安装入口。
- Web App Manifest、图标和空缓存 Service Worker 可在未登录时读取，但不暴露 API、项目或会话数据。
- Tailscale 长期访问推荐用 `tailscale serve --bg https+insecure://127.0.0.1:30141` 暴露受信任的 `*.ts.net` 地址；Serve 配置持久化，TianForge 后端仍独立启停。
- 登录 Session 使用安全 Cookie，并设置有效期。
- API 未认证返回 401，页面请求跳转登录页。
- 修改请求执行同源校验；Terminal WebSocket 同样校验认证与 Origin。
- Next.js 自带的 upgrade listener 只处理 HMR；TianForge 的 listener 只处理 Terminal WebSocket。不要再把 HMR 手工转发给 `app.getUpgradeHandler()`，否则同一握手会被处理两次并在 Tailscale Serve 下表现为 502。
- Next.js 开发来源使用 `**.ts.net` 匹配 `<设备名>.<tailnet>.ts.net`。`*.ts.net` 只匹配单层子域，不能覆盖实际的两层 Tailscale Serve 主机名。

## 安全原则

- 密码、API Key 和 OAuth Token 不返回给状态接口。
- 登录失败限流，错误信息不泄露内部配置。
- HTTPS 证书必须覆盖当前局域网 IP；设备端需要信任对应根证书。
- 认证只授予当前 TianForge pi 实例能力，不扩大文件访问白名单。
- 不因开发便利而允许无密码绑定 `0.0.0.0`。

## 验收标准

- 手机通过可信 HTTPS 地址可以登录并加载完整 JS 应用。
- 手机扫描电脑端二维码可直接登录，无需手工输入服务器密码；二维码过期或已使用时必须重新生成。
- 支持 Fullscreen API 的手机可一键隐藏标签页浏览器栏；不支持时可从主屏幕图标以无地址栏模式启动。
- 未登录设备不能直接读取页面数据或连接 Terminal。
- 密码不会出现在 GET 请求、URL 或服务日志中。
- HMR 失败不会造成生产模式问题；开发模式下页面可正常 Hydration。

## Tailscale Serve 排障记录

- `https://100.x.y.z:30141` 虽在 Tailscale 加密网络内，浏览器看到的仍是 TianForge 的本地 `mkcert` 证书；Android 未安装该根 CA 时会提示连接不私密，PWA 只能退化为普通桌面快捷方式。
- `https://<设备名>.<tailnet>.ts.net/` 由 Tailscale Serve 终止 TLS，并使用浏览器信任的证书，适合作为移动端 PWA 的稳定入口。
- 页面能返回但一直停在 `Loading...`、控制台反复出现 `/_next/webpack-hmr` 失败时，应先检查 HMR WebSocket。Next 开发客户端在握手失败时可能无法完成 hydration，因此不会请求 `/api/sessions`，看起来像“所有数据消失”，但磁盘 Session 并未删除。
- 验证顺序：`tailscale serve status` → 后端 `127.0.0.1:30141` 是否监听 → `.ts.net` 普通 HTTPS → HMR WebSocket → 登录后的 `/api/sessions`。不要用浏览器空白状态推断 Session 文件已丢失。

## 后续计划

- 登录设备与 Session 管理界面。
- 主动退出全部设备。
- 可配置认证有效期和受信任网络段。
- 对高风险 Terminal 模式增加二次认证选项。
