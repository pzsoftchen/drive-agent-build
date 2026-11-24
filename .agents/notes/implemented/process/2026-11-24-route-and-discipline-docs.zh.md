# Agent Note: 路线与纪律文档

Status: implemented

[English](2026-11-24-route-and-discipline-docs.md) | 中文

## Problem

DAB 的文档描述的是发布顺序，不是能力路线。理念和路线分散在 `README.md`、`Why DAB exists` 和 `Roadmap` 中；工程纪律没有自己的文档，跨 Agent 隔离的主张没有证据门禁。README 和 Why DAB 还重复了同一张概念图和状态材料，因此没有任何文档是路线的唯一来源。

## Decision

- 路线分为四个能力层：L1 配置治理与目标隔离、L2 工程纪律、L3 单任务交付、L4 目标级交付。
- L1 的证据门禁是：干净项目上的 `detect --strict`、幂等 `normalize`、外部手改检测、目标中立的共享指令，以及跨 Agent 合同测试。合同测试是配置面检查；完整 Codex 和 DSH adapter 仍在 v0.4。
- `docs/concepts/engineering-discipline.md` 拥有纪律集合、强制级别、可移植性和来源。README 拥有入口摘要和系统位置图；Why DAB 拥有问题和概念模型；Roadmap 拥有路线、门禁和状态；Architecture 拥有实现事实。
- DAB 是长期方向和产品名；DAD 是当前开发专属路径；`dab` 是 CLI。
- 公开纪律是可识别工程实践的综合。deepseek-harness 样本只是一个参考，不是规范。

## Alternatives considered

**把路线保留为发布列表。** 拒绝：发布版本不展示依赖、证据门禁，也不说明每层“完成”意味着什么。

**把 L1 缩窄为单 target 治理。** 拒绝：这会让跨 Agent 隔离的主张没有被证明，而文档又把它当前提。

**在 v0.2 之前提前完整第二 adapter。** 暂时拒绝：完整 adapter 会扩大表面。跨 Agent 合同测试是最小的配置面门禁；完整 adapter 仍在 v0.4。

**把纪律放进 Why DAB 或 Roadmap。** 拒绝：纪律会没有主人，并在问题陈述和发布计划之间漂移。

**把 deepseek-harness 当作规范纪律。** 拒绝：它只是样本。它的 docs 和 authoring skills 影响了实践层，但领域内容不可普遍化。

## Consequences

- 能力状态和计划工作放在 Roadmap；概念文档描述当前模型并链接到路线。
- 跨 Agent 合同测试存在之前，L1 没有被完整验证。Roadmap 的状态记录了这个缺口。
- README 拥有系统位置图和路线一瞥；Why DAB 链接到该图，而不是重复它。详细状态表和计划工作留在 Roadmap。
- 纪律文档必须随规则和强制级别保持更新。行为约定不得写成强制门禁。

## Verification

- `pnpm test`：62 个测试文件、795 个测试通过。
- `pnpm typecheck`：无错误。
- `pnpm doc-sync`：无问题。
- `node dist/cli.js detect --strict`：`19/19 (100%)`，退出码 `0`。
- `node dist/cli.js normalize --dry-run`：manifest 无变更。
- `git diff --check`：干净。
- 英文和中文文档结构配对，链接可解析。

## Related

- [路线图](../../../../docs/roadmap.zh.md)
- [工程纪律](../../../../docs/concepts/engineering-discipline.zh.md)
- [DAB 为什么存在](../../../../docs/concepts/why-dab.zh.md)
