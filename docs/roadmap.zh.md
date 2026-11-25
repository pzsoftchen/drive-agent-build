[English](roadmap.md) | 中文

# 路线图

DAB 是长期方向。产品路线先走 DAD：先证明单个开发任务能够被可靠完成，再用这些证据判断是否有必要实现 DAB 目标循环。本页拥有能力路线、证据门禁和发布里程碑。问题陈述和概念模型在 [DAB 为什么存在](concepts/why-dab.zh.md)。

## 能力路线

路线有四层。一个层不是因为发布了版本就算完成；只有当证据门禁通过时，它才算完成。

| 层 | 问题 | DAB 的机制 | 证据门禁 | 状态 |
|---|---|---|---|---|
| L1 配置治理与目标隔离 | 配置在多个 target 之间漂移，生成文件被手改，target 专属语义混进共享指令。 | 编写源、逐 target 投影、所有权记录、漂移检测、adapter overlay。 | `detect --strict` 干净；`normalize` 幂等；外部手改能被发现且不静默覆盖；公共事实发现不读取 provider overlay；共享指令原样透传，不注入 target 专属内容；跨 Agent 合同测试通过。 | Claude Code 实现已发布；公共事实发现与 provider 无关，跨 Agent 合同测试通过。 |
| L2 工程纪律 | 规则只存在于提示词和对话中，无法复现。 | 带强制级别的显式规则；docs、notes 和受管 skills；能强制的地方使用门禁。 | 每条规则都有强制级别；每条 gate 规则都有检查；行为约定有标注；target 专属规则放在 adapter overlay。 | 实践层已发布；强制矩阵记录在 [工程纪律](concepts/engineering-discipline.zh.md)。 |
| L3 单任务交付 | Agent 活动被误认为已接受的工作；验收不可复现。 | 任务证据、固定任务集、基线对比和稳定的 harness 事件。 | 三个存量仓库任务和确定性测试；基线对比；记录耗时、尝试次数、成本、人工干预和范围越界。 | 计划在 v0.2。 |
| L4 目标级交付 | 拆解、集成、整体验收和跨任务学习没有模型。 | 只在 L3 证据之后启动的 DAB 目标循环。 | 真实 DAD 使用产生反复出现的目标级失败；最小原型能解决这些失败。 | 研究阶段；未排期。 |

状态是快照，不是门禁。证据门禁决定一个层是否已被验证。

## 依赖与顺序

- L1 和 L2 是 DAD 任务循环的基础。它们共同演化：纪律模型定义配置模型必须承载什么，配置模型决定哪些规则可以被检查。
- L3 依赖 L1 和 L2。它在受治理的配置和显式纪律下度量单个开发任务。
- L4 由证据触发，不由日期触发。完成 L1-L3 是必要条件，但不是充分条件；只有当真实 L3 使用反复暴露目标级失败时，DAB 研究才启动。
- 路线是能力阶梯，不是瀑布。一个发布可以推进多个层，后来的发现也可以把工作送回更早的层。

## 证据门禁

- L1：`detect --strict` 在干净项目上以 `0` 退出；第二次 `normalize` 不产生变更；生成输出的手改能被发现且不被静默覆盖；共享指令不包含 target 专属语义；跨 Agent 合同测试通过。合同测试是配置面检查，不是完整 adapter；完整 Codex 和 DSH adapter 仍在 v0.4。
- L2：[工程纪律](concepts/engineering-discipline.zh.md) 中的每条规则都有强制级别；每条 `gate` 规则都有失败测试或 CLI 检查；每条 `behavioral` 规则都有标注；provider 专属规则位于 `.agents/adapters/<provider>.yaml`。
- L3：三个存量仓库功能任务和确定性测试；稳定的 harness 事件覆盖尝试、工具活动、证据、权限和预算；基线对比；记录耗时、尝试次数、成本、人工干预和范围越界。
- L4：真实 DAD 使用产生反复出现的目标级失败；最小目标循环原型能解决已观察到的失败；在证据出现前，不承诺任务图、`GoalRun`、`TaskRun` 或跨任务学习模型。

## 发布里程碑

### v0.1 DAD 配置治理

- 推进：L1。
- 编写源：`AGENTS.md` 和 `.agents/`。
- 生成输出：`.claude/`。
- 命令：`dab init`、`dab detect`、`dab normalize`、`dab policy explain`。
- 双语文档门禁。
- 状态：已于 2026-11-24 发布 `v0.1.2`。
- 发布：[npm](https://www.npmjs.com/package/@saydone/dab) · [GitHub Release](https://github.com/pzsoftchen/drive-agent-build/releases/tag/v0.1.2)

### v0.1.x DAD 基础层

- 推进：L1。
- scope root、v2 manifest、target adapter、所有权和失败语义已在 `v0.1.1` 发布。
- symlink 优先的 Claude Code 指令、逐项投影和 project settings 已在 `v0.1.1` 发布。
- Project 和 global scope 保持独立；DAB 不提供 `dab global` 命令，也从不合并 scope。
- Codex 和 DSH adapter 推迟到 DAD 任务循环完成评测之后。

### v0.1.x DAD 实践层

- 推进：L2。
- `generic` 是默认 profile；`feature` 保留为行为相同的兼容别名。
- `init` 和 `normalize` 通过同一个 planner 生成单语 `docs/AGENTS.md`、`docs/architecture.md` 和 `dab-*` authoring skills。
- `detect` 报告 Documentation 组和 authoring skill 状态；`normalize` 补齐缺失的实践文件，同时保留 authored docs、已修改 skills 和用户自定义 skills。
- `dab-*` authoring skills 在 `skills/` 中有 canonical 模板，并使用版本/hash marker 和受管更新：`normalize` 更新未修改的较旧副本，迁移 body 逐字节一致的 legacy markers，并保留 modified、body 不同的 legacy、newer 和 unversioned 副本。
- 已有 `.agents/rules/docs-bilingual.md` 的项目保留该规则，生成的 docs 被 policy skip。
- Generic profile 聚焦配置漂移，以及 docs、notes 和 skills 纪律。
- Hooks 与共享记忆是高级、可选能力。`init` 和 adoption 不生成它们；已有 hooks 会被校验并在适用时编译，已有记忆由 `init` 和 `normalize` 保留，并由 `init` 和 `detect` 校验。
- 状态：已在 `0.1.2` 发布。

### v0.2 DAD 任务证据

- 推进：L3。
- 这是下一步。它只验证单个开发任务，不代表 DAB 已被证明。
- 增加面向单个开发任务的 `dab run --record`。
- 增加 `dab eval --suite <id> --compare baseline`。
- 使用三个存量仓库功能任务和确定性测试。
- 记录耗时、尝试次数、成本、人工干预和范围越界。
- 在实现前要求 Harness 稳定提供尝试、工具活动、证据、权限和预算事件。
- 状态：计划中，下一步。

### v0.3 DAD 加固与记忆

- 推进：L2 和 L3 的支持。
- 增加 `dab memory promote`。
- 评审共享记忆的过期和替代关系。
- 完成 Agent Note 归档工作流。
- 针对 v0.2 观察到的 hooks、策略解释、恢复和交接失败进行加固。
- 状态：计划中。

### v0.4 DAD 跨 Harness Adapter

- 推进：L1 的跨 Agent 覆盖。
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
