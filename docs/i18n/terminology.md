# Terminology / 术语表

This file is maintained in both languages by design and is excluded from the normal pairing gate.

本文件按双语直接维护，不参与普通配对门禁。

| English | 中文 | Note |
|---|---|---|
| Agent | Agent | Keep the English word in technical prose. |
| Agent Builder | Agent 构建者 | DAB's broad role for a person who composes agents. |
| Agent Note | Agent 决策记录 | Decision record stored under `.agents/notes/`. |
| Authored source | 编写源 | Files a person edits and reviews. |
| Auto memory | 自动记忆 | Personal, machine-local Claude Code memory. |
| Baseline | 基线 | Reference configuration in an evaluation. |
| Behavioral rule | 行为约定 | A rule the agent is expected to follow; not a CLI gate. |
| Builder | 构建者 | The person driving agents to produce work. |
| Candidate | 候选配置 | Configuration under evaluation. |
| Capability route | 能力路线 | The four-layer route from configuration governance to goal-level delivery. |
| Cross-agent isolation | 跨 Agent 隔离 | Keeping target-specific configuration out of shared instructions. |
| Drift | 漂移 | Generated output diverging from authored source. |
| Drive | 驱动 | Directing agents toward a goal. |
| DAB | DAB | Drive Agent as Builder; the long-term direction and product name. |
| DAD | DAD | Drive Agent Development; the current development-specific path within DAB. |
| `dab` | `dab` | The CLI and control plane that implements the current DAD path. |
| Delivery loop | 交付闭环 | The outer loop that drives work toward acceptance and handoff. |
| Enforcement | 强制 | How a discipline rule is checked or gated. |
| Engineering discipline | 工程纪律 | The explicit rules and practices DAB projects into a target. |
| Evidence | 证据 | Tests, diffs and records that support a claim. |
| Evidence gate | 证据门禁 | The evidence required before a capability is considered validated. |
| Gate | 门禁 | A check that must pass before merge. |
| Harness | 执行底座 | The runtime that executes agents, such as Claude Code. |
| Driving system | 驾驶系统 | DAB's role: direct and govern an agent without becoming its runtime. |
| Personal memory | 个人记忆 | Machine-local memory that is not shared with the team. |
| Projection | 投影 | Generated representation of authored source. |
| Shared memory | 共享记忆 | Reviewed team facts stored in `.agents/memory/`. |
| Source of truth | 事实源 | The one authored home for a fact. |
| Target-neutral | 目标中立 | A fact that is valid for every target without target-specific semantics. |
| Team fact | 团队事实 | A reviewed fact shared through the repository. |
