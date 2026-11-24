[English](roadmap.md) | 中文

# 路线图

DAB 是长期方向。产品路线先走 DAD：先证明单个开发任务能够被可靠完成，再用这些证据判断是否有必要实现 DAB 目标循环。

## v0.1 DAD 配置治理

- 编写源：`AGENTS.md` 和 `.agents/`。
- 生成输出：`.claude/`。
- 命令：`dab init`、`dab detect`、`dab normalize`、`dab policy explain`。
- 双语文档门禁。
- 状态：已于 2026-11-23 发布 `v0.1.1`。
- 发布：[npm](https://www.npmjs.com/package/@saydone/dab) · [GitHub Release](https://github.com/pzsoftchen/drive-agent-build/releases/tag/v0.1.1)

## v0.1.x DAD 基础层

- scope root、v2 manifest、target adapter、所有权和失败语义已在 `v0.1.1` 发布。
- symlink 优先的 Claude Code 指令、逐项投影和 project settings 已在 `v0.1.1` 发布。
- Project 和 global scope 保持独立；DAB 不提供 `dab global` 命令，也从不合并 scope。
- Codex 和 DSH adapter 推迟到 DAD 任务循环完成评测之后。

## v0.1.x DAD 实践层

- `generic` 是默认 profile；`feature` 保留为行为相同的兼容别名。
- `init` 和 `normalize` 通过同一个 planner 生成单语 `docs/AGENTS.md`、`docs/architecture.md` 和 `dab-*` authoring skills。
- `detect` 报告 Documentation 组和 authoring skill 状态；`normalize` 补齐缺失的实践文件，不覆盖 authored docs 或 skills。
- 已有 `.agents/rules/docs-bilingual.md` 的项目保留该规则，生成的 docs 被 policy skip。
- Generic profile 聚焦配置漂移，以及 docs、notes 和 skills 纪律。
- Hooks 与共享记忆是高级、可选能力。`init` 和 adoption 不生成它们；已有 hooks 会被校验并在适用时编译，已有记忆由 `init` 和 `normalize` 保留，并由 `init` 和 `detect` 校验。
- 状态：已实现，尚未发布。

## v0.2 DAD 任务证据

这是下一步。它只验证单个开发任务，不代表 DAB 已被证明。

- 增加面向单个开发任务的 `dab run --record`。
- 增加 `dab eval --suite <id> --compare baseline`。
- 使用三个存量仓库功能任务和确定性测试。
- 记录耗时、尝试次数、成本、人工干预和范围越界。
- 在实现前要求 Harness 稳定提供尝试、工具活动、证据、权限和预算事件。
- 状态：计划中，下一步。

## v0.3 DAD 加固与记忆

- 增加 `dab memory promote`。
- 评审共享记忆的过期和替代关系。
- 完成 Agent Note 归档工作流。
- 针对 v0.2 观察到的 hooks、策略解释、恢复和交接失败进行加固。
- 状态：计划中。

## v0.4 DAD 跨 Harness Adapter

- DAD 任务证据契约稳定后增加 Codex adapter。
- Codex 验证通用能力后增加 DSH adapter。
- 增加显式的 global settings adoption 和 merge，并保留备份。
- `$HOME/.gitignore` 保持只读。
- 状态：计划在 v0.2 证据之后。

## DAB 研究门槛

DAB 目前不是已排期的实现阶段。只有 DAD 实践反复暴露目标级失败时才启动研究。

- 在足够多的真实项目和任务上运行 DAD，建立失败画像。
- 区分单任务循环失败，与多任务拆解、集成或整体验收导致的目标级失败。
- 只原型实现解决已观察问题所需的最小目标循环。
- 在证据出现前，不承诺任务图、`GoalRun`、`TaskRun` 或跨任务学习模型。
- 状态：未排期研究。

## 非目标

- 在研究门槛之前实现 DAB。
- GUI、独立 Agent runtime、插件市场或团队权限。
- 自动 DAD 迁移或 Windows junction 支持。
- 跨 scope 继承或合并。
