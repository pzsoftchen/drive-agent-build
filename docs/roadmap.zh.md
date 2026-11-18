[English](roadmap.md) | 中文

# 路线图

DAB 按窄阶段交付。每个阶段必须先产出可运行、可测试的软件，再进入下一阶段。

## v0.1 配置治理

- 编写源：`AGENTS.md` 和 `.agents/`。
- 生成输出：`.claude/`。
- 命令：`dab init`、`dab detect`、`dab normalize`、`dab policy explain`。
- 双语文档门禁。
- 状态：已在 `main` 实现，等待带标签的正式发布。

## v0.1.x 跨 Harness 对齐

这是 v0.1.x 的第一优先级。Project 和 global scope 独立配置；DAB 不提供 `dab global` 命令，也从不合并 scope。

- 基础：基于位置的 scope root、包含 `scope` 和 `targets` 的 v2 manifest、target adapter 契约、所有权与失败语义。状态：已在 `main` 实现，等待发布。
- Claude target：symlink 优先的指令、逐项投影、project settings、managed/unmanaged 冲突和 `--fix` 备份。状态：已在 `main` 实现，等待发布。
- Codex adapter：原生 subagents 和 skills，映射 settings。状态：下一步。
- DSH adapter：原生 subagents 和 skills，映射 profile 和 settings。状态：Codex 之后。
- Global settings adoption/merge：每个 target 显式 opt-in 并备份。状态：DSH 之后。
- Global `$HOME/.gitignore` 在所有计划中保持只读。

## v0.2 证据

- `dab run --record` 和 `RunRecord`。
- `dab eval --suite <id> --compare baseline`。
- 三个存量仓库功能任务，使用确定性测试。
- 记录耗时、尝试次数和成本。
- 状态：计划中。

## v0.3 记忆

- `dab memory promote`。
- 共享记忆评审和过期检查。
- Agent 决策记录归档工作流。
- 状态：计划中。

## 非目标

- GUI、独立 Agent Loop、插件市场或团队权限。
- 自动 DAD 迁移或 Windows junction 支持。
- 跨 scope 继承或合并。
