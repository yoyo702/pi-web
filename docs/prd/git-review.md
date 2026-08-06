# Git Review PRD

## 背景与目标

用户需要在不离开 Pi Web 的情况下查看改动、暂存文件、检查历史并完成常见 Git 操作，同时确保高风险操作有明确确认。

## 已实现范围

- Changes 与 History 两个主要视图。
- 文件列表、diff、提交列表和提交详情。
- 暂存、取消暂存、丢弃修改。
- 提交和基础远端同步操作。
- 分支查看与切换。
- stash 查看与管理。
- 面板全屏、恢复以及内部区域拖动调整。
- 项目切换时按项目保存右侧面板标签和打开状态。

## 交互原则

- 全屏仅放大最右侧工作面板，不调用浏览器 Fullscreen API。
- 放大与还原使用不同图标和可访问名称。
- 文件列表和详情区域可调整尺寸并保存。
- 丢弃、删除 worktree 等不可逆操作必须二次确认。
- dirty worktree 默认拒绝删除，用户明确确认后才能强制处理。

## 验收标准

- Git 状态与 Explorer 标记一致。
- 切换项目后不显示上一个项目的 diff。
- 面板全屏时覆盖可用工作区域，并可恢复原布局。
- 外部 Git 修改后能刷新状态和已打开 diff。

## 后续计划

- 行级暂存与取消暂存。
- 提交前检查任务和 AI Review 摘要。
- 冲突解决界面。
- 多项目 Git 状态总览。

## 依赖

- [Workspace Explorer](./workspace-explorer.md)
- [多项目工作区](./multi-project-workspaces.md)
- [Git Worktrees 技术文档](../worktrees.zh-CN.md)
