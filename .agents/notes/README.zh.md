# Agent 决策记录

[English](README.md) | 中文

Agent 决策记录保存项目中长期有效的决策和提案。

## 目录与命名

每条记录位于 `{lifecycle}/{class}/YYYY-MM-DD-topic.md`。

- Lifecycle 是 `proposed`、`implemented` 或 `rejected`。
- Class 是下方封闭集合之一。
- 日期是首次提出日期。

## 生命周期

- `proposed`：正在评审、尚未交付的提案。
- `implemented`：已经交付的决策；保持事实最新。
- `rejected`：已考虑并拒绝；仅在有价值时保留。

## 分类

| Class | 覆盖 |
|---|---|
| `feature` | 新的用户或 Agent 可见能力。 |
| `bug-fix` | 缺陷或缺口修复。 |
| `simplification` | 在不增加能力的前提下减少表面。 |
| `architecture` | 已交付源码的结构。 |
| `process` | 围绕代码的工具、策略或工作流。 |
| `testing` | 测试基础设施和策略。 |

## 文件格式

每条活跃记录以以下内容开头：

```markdown
# Agent Note: <title>

Status: implemented
```

Implemented 记录需要 `## Problem`、`## Decision`、`## Alternatives considered` 和 `## Consequences`。Proposed 记录需要 `## Problem`、`## Proposal`、`## Alternatives considered`、`## Acceptance criteria` 和 `## Risks`。Rejected 记录需要 `## Problem`、`## Proposal`、`## Alternatives considered`，并在 status 行给出理由。

## 中文对应文件

每条记录都有 `.zh.md` 对应文件和 `.i18n.yaml` 记录。一次改动同时更新三者。

## 归档

`archived/` 是冻结的历史树。不要编辑归档记录。参见 [archived/AGENTS.md](archived/AGENTS.md)。
