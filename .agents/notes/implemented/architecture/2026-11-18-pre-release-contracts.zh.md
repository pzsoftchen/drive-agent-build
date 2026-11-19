# Agent Note: 发布前的公开契约

Status: implemented

[English](2026-11-18-pre-release-contracts.md) | 中文

## 问题

首次 npm 发布会冻结三个仍隐含的公开契约：CLI JSON 输出没有 schema version；agent/skill/rule frontmatter 会拒绝 Claude Code 可能新增的未知顶层字段；已批准的 adapter contract 计划仍有可能在第二个 adapter 到来时暴露的缺口。若不先决定这些，发布后要么破坏用户脚本，要么让每次 Claude Code 新增字段都变成 DAB 失败。

## 决策

- 每个支持 `--json` 的命令现在都包含 `schemaVersion: 1`；发布可以新增字段，但删除或改变字段必须提升版本。
- Agent、skill 和 rule frontmatter 容忍未知顶层字段：DAB 保留字段、投影文件，并以警告形式报告 `agent.unknown-frontmatter`、`skill.unknown-frontmatter` 或 `rule.unknown-frontmatter`。当未知名称看起来像拼写错误时，警告会给出最接近的已知字段。
- DAB 自有结构（hooks、policies、manifests、memory entries）保持严格；其中的未知字段仍然是错误。
- normalize 结果和嵌套 init 结果中的 JSON 路径相对于 scope root。所有命令共用同一个 Windows 守卫，normalize 只执行一次 runtime 版本检查。
- Adapter contract spec 和计划记录剩余缺口：adapter-owned gitignore entries、provider-owned init 扫描和 provider 路径位置。完整重构推迟到 Codex adapter 计划。

## 备选方案

**保持严格 frontmatter。** 被拒绝，因为 Claude Code 会持续新增字段；每次新增都会拒绝本来有效的 agent，并迫使 DAB 紧急发版。

**静默允许未知字段。** 被拒绝，因为拼写错误会变得不可见。警告同时保留兼容性和 fail-loud 信号。

**把近似拼写错误升级为 error。** v0.1 被拒绝，因为未来的 Claude Code 字段可能与 DAB 字段非常接近。带建议的警告既保留兼容性，也让风险可见；CI 应把这些警告视为错误。

**在 JSON 中暴露绝对路径。** 被拒绝，因为公开 JSON 契约不应依赖产生它的机器。

**增加可配置的严格模式。** 推迟：v0.1 只需要一种警告策略，新选项会扩大发布前表面。

**发布前执行完整 adapter contract 重构。** 被拒绝，因为发布仍是 Claude-only，内部结构不是公开 API，而且 DAD 证据才是下一个里程碑。改为记录计划缺口。

**跳过 JSON schema version。** 被拒绝，因为 CLI JSON 已有文档且会被用户脚本化；否则 adapter 重构会变成静默 breaking change。

## 后果

- 带有未来 Claude Code 字段的既有 agent、skill 和 rule 文件继续工作，并显示警告。
- 这三类 fact 的拼写错误字段不再致命；DAB 自有 YAML 仍然严格。scope 或权限 key 的拼写错误仍可能改变实际行为，因此用 did-you-mean 提示和 CI 警告策略缓解。
- JSON 消费者可以根据 `schemaVersion` 分支，并获得相对 scope root 的路径。
- Codex 工作开始时 adapter 计划更大，但发布不会被阻塞。

## 验证

- Focused tests 覆盖 agent、skill 和 rule 的未知字段警告与 did-you-mean 建议、带未知字段 fact 的投影，以及 hook YAML 的严格拒绝。
- Command 和 CLI 测试断言 init、detect、normalize、policy explain、每个命令的错误信封以及 internal-error 信封的 `schemaVersion: 1`。
- 回归测试覆盖单次 runtime 版本检查、相对 JSON 路径、统一 Windows 守卫和 locale 无关排序。
- `pnpm test`、`pnpm typecheck` 和 `pnpm doc-sync` 通过。

## 相关

- [架构](../../../../docs/architecture.zh.md)
- [CLI](../../../../docs/user/cli.zh.md)
- [Adapter contract spec](../../../../docs/superpowers/specs/2026-11-17-adapter-contract.md)
