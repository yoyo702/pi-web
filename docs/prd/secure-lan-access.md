# 安全局域网访问 PRD

## 背景与目标

Pi Web 会暴露本机项目文件、Session 和 Terminal。局域网访问必须默认安全，同时尽量减少开发时重复输入配置的成本。

## 已实现范围

- Loopback 模式可在无密码时通过 HTTP 运行。
- 非 Loopback 监听必须配置密码。
- 开发脚本生成并复用本地 HTTPS 证书。
- 启动时列出可访问的局域网 IPv4 HTTPS 地址。
- 开发密码持久化到用户目录并限制文件权限。
- 登录使用 POST，密码不进入 URL、历史记录或 Referer。
- 登录 Session 使用安全 Cookie，并设置有效期。
- API 未认证返回 401，页面请求跳转登录页。
- 修改请求执行同源校验；Terminal WebSocket 同样校验认证与 Origin。
- Next.js HMR 与 Terminal WebSocket 由统一 upgrade 入口分发。

## 安全原则

- 密码、API Key 和 OAuth Token 不返回给状态接口。
- 登录失败限流，错误信息不泄露内部配置。
- HTTPS 证书必须覆盖当前局域网 IP；设备端需要信任对应根证书。
- 认证只授予当前 Pi Web 实例能力，不扩大文件访问白名单。
- 不因开发便利而允许无密码绑定 `0.0.0.0`。

## 验收标准

- 手机通过可信 HTTPS 地址可以登录并加载完整 JS 应用。
- 未登录设备不能直接读取页面数据或连接 Terminal。
- 密码不会出现在 GET 请求、URL 或服务日志中。
- HMR 失败不会造成生产模式问题；开发模式下页面可正常 Hydration。

## 后续计划

- 登录设备与 Session 管理界面。
- 主动退出全部设备。
- 可配置认证有效期和受信任网络段。
- 对高风险 Terminal 模式增加二次认证选项。
