# Git Review PRD

## 背景与目标

用户需要在不离开 TianForge pi 的情况下查看改动、暂存文件、检查历史并完成常见 Git 操作，同时确保高风险操作有明确确认。

## 已实现范围

- Changes 与 History 两个主要视图。
- 文件列表、diff、提交列表和提交详情。
- 暂存、取消暂存。丢弃（单文件或整组，包括未跟踪文件）会把改动保存为一条名为 "TianForge: discarded changes" 的 stash，可在 stash 列表中恢复；冲突文件无法 stash，仍重置到 HEAD，确认框会单独说明。仓库还没有任何提交时拒绝丢弃；其他文件还有未解决的冲突时也拒绝（两者都返回 409，而不是 500）。
- 行级和 hunk 级操作：Changes 组可暂存或丢弃选中的行，Staged 组可取消暂存选中的行，Untracked 文件可只暂存部分行。点击行号左侧的选择框选中一行，Shift+点击或拖动选中一段；每个 hunk 标题上有整段操作按钮。重命名文件只支持整文件操作。
- 提交和基础远端同步操作。
- 提交前检查（Commit 输入框上方的 “Pre-commit checks”，默认收起，只做提示，从不阻止提交）：
  - Staged changes：本地扫描暂存区新增的行，提示冲突标记、调试语句（`console.log`、`debugger` 等）、新增 TODO/FIXME、疑似密钥（不显示内容）和超过 1 MB 的文件；点击跳到该文件的 staged diff。
  - Open work：本仓库里仍在运行或最近一次失败的项目任务（“Task: <脚本>” 终端），以及仍在工作或等待审批的 Claude/Codex 终端和聊天。
  - AI review：点击 “Review with AI” 后用 Pi 默认模型总结暂存的改动并列出最多 5 个可能的问题；暂存内容变化后标记 “Staged changes changed since this review.”。
- 分支查看与切换。
- stash 查看与管理。
- commit、push、fetch、pull、切换分支和 stash（丢弃会保存为 stash，大的未跟踪文件可能较慢）最长等待 5 分钟（其他 Git 命令 10 秒），超时提示会说明是哪条命令、等了多久。
- 查看某个文件的 diff 失败（认证过期、超时等）时显示具体错误原因并可 Retry，不与真正不支持预览的二进制/超大文件混淆。
- 自动发现工作区根目录和嵌套 Git 仓库，支持切换并按工作区记住选择。
- 面板全屏、恢复以及内部区域拖动调整。
- 项目切换时按项目保存右侧面板标签和打开状态。

## 交互原则

- 全屏仅放大最右侧工作面板，不调用浏览器 Fullscreen API。
- 放大与还原使用不同图标和可访问名称。
- 文件列表和详情区域可调整尺寸并保存。
- 丢弃、删除 worktree 等不可逆操作必须二次确认（包括丢弃选中的行）。
- 提交前检查只提示不拦截；AI review 只在用户点击时调用模型，diff 作为不可信数据发送并有长度上限。
- 行级操作由服务端基于最新 diff 重建补丁；若 diff 在选择后已变化（fingerprint 不一致），拒绝操作并刷新 diff，要求重新选择。
- dirty worktree 默认拒绝删除，用户明确确认后才能强制处理。

## 验收标准

- Git 状态与 Explorer 标记一致。
- 切换项目后不显示上一个项目的 diff。
- 面板全屏时覆盖可用工作区域，并可恢复原布局。
- 外部 Git 修改后能刷新状态和已打开 diff。
- 只暂存 / 取消暂存 / 丢弃选中的行，其他行保持不变；diff 变化后旧选择不会被应用。
- 提交前检查的提醒随暂存内容刷新，Commit 按钮不受检查结果影响。
- 同一工作区包含多个 Git 仓库时，所有状态、diff、历史和写操作只作用于当前选择的仓库。

## 后续计划

- 冲突解决界面。
- 跨项目、跨仓库 Git 状态总览。

## 依赖

- [Workspace Explorer](./workspace-explorer.md)
- [多项目工作区](./multi-project-workspaces.md)
- [Git Worktrees 技术文档](../worktrees.zh-CN.md)
