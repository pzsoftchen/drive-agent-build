[English](roadmap.md) | 中文

# 路线图

DAB 按窄阶段交付。每个阶段必须先产出可运行、可测试的软件，再进入下一阶段。

## v0.1 配置治理

- 编写源：`AGENTS.md` 和 `.agents/`。
- 生成输出：`.claude/`。
- 命令：`dab init`、`dab detect`、`dab normalize`、`dab policy explain`。
- 双语文档门禁。
- 状态：已交付。

## v0.1.x 采用与结构

- `dab init --dry-run`，以及把生成冲突交给 `dab normalize --fix`。
- DSH 风格的 Agent 决策记录 lifecycle 和 class 树。
- `HarnessAdapter` seam、能力模型和 artifact 模型。
- 用 `dab.lock` 保存生成状态。
- 状态：下一步。

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

## v0.4 Harness Adapters

- Codex adapter。
- DSH adapter。
- 同一编写树，adapter 专属产物和 launch。
- 状态：计划中。

## 非目标

- GUI、独立 Agent Loop、插件市场或团队权限。
- 自动 DAD 迁移或 Windows junction 支持。
