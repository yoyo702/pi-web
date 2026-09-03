# TianForge pi 产品需求文档索引

本目录记录 TianForge pi 已实现及计划中的产品能力。一个主要功能对应一份 PRD；实现细节仍以代码、`AGENTS.md` 和相关技术文档为准。

## 功能索引

| 功能 | 状态 | 产品入口 | 文档 |
| --- | --- | --- | --- |
| 多项目工作区 | 迭代中 | 页面最左侧项目栏 | [multi-project-workspaces.md](./multi-project-workspaces.md) |
| Agents 工作区 | 迭代中 | 左侧 Agents、中央工作区标签 | [agent-workspace.md](./agent-workspace.md) |
| Workspace Explorer | 已实现，持续优化 | 左侧 Explorer | [workspace-explorer.md](./workspace-explorer.md) |
| Git Review | 已实现，持续优化 | 右侧 Git 面板 | [git-review.md](./git-review.md) |
| 安全局域网访问 | 已实现 | HTTPS 服务与登录页 | [secure-lan-access.md](./secure-lan-access.md) |
| Session 可靠性 | 迭代中 | Pi/Codex/Terminal Session | [session-reliability.md](./session-reliability.md) |
| 响应式工作区布局 | 已实现，持续优化 | 桌面与移动端整体界面 | [responsive-workspace.md](./responsive-workspace.md) |

## 产品结构

```text
项目栏
  └─ 项目工作区
      ├─ Pi Session
      ├─ Agents（Codex / Claude / Terminal）
      ├─ Explorer
      ├─ 中央多标签工作区
      └─ Git Review / 文件查看器
```

## 状态定义

- `已实现`：核心流程可用，并有基础验证。
- `迭代中`：核心流程可用，但仍有明确的体验或可靠性工作。
- `规划中`：已确认产品方向，尚未进入完整实现。

## 维护规则

1. 新增主要功能时，先创建独立 PRD，再将其加入本索引。
2. PRD 描述用户目标、范围、流程、状态和验收标准，不堆叠底层实现代码。
3. 功能行为发生变化时，同一提交内更新对应 PRD。
4. 跨模块需求分别写入各自 PRD，并在“依赖”章节互相链接。
5. 小型交互优化并入所属大功能，不单独创建零散文档。

## 相关技术文档

- [跨进程 Session 同步](../sync.zh-CN.md)
- [Git Worktrees](../worktrees.zh-CN.md)
- [发布流程](../release.md)
