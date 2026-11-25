# Agent Note: 跨 Agent 合同

Status: implemented

[English](2026-11-25-cross-agent-contract.md) | 中文

## Problem

公共事实发现并非与 provider 无关。`SourceFacts` 同时加载 `.agents/policies/project.yaml` 和 `.agents/adapters/claude-code.yaml`，因此没有 Claude adapter overlay 的项目无法发现公共事实。L1 路线中的跨 Agent 隔离主张没有配置级测试。

## Decision

- 把 source 模型拆成 `CommonFacts`：agents、skills、rules、hooks、公共策略及其路径。`loadCommonPolicy` 只读取 `.agents/policies/project.yaml`。
- 每个 target adapter 加载自己的 overlay。Claude adapter 调用 `loadClaudeCodePolicy`，并把公共策略和 Claude 策略一起编译。缺失或无效的 Claude overlay 是 target 专属配置错误，不是公共事实失败。
- 增加 test-only neutral consumer，读取 `CommonFacts` 并只投影显式公共字段：instructions 文本、agent 的 name/description/body、skill 的 name/description/body、rule 的 name/paths/body、neutral hooks 和公共策略。它从不包含 provider 字段、target options、adapter policy 或 `.claude` 产物。
- 合同测试覆盖：没有 provider overlay 时仍能发现公共事实；provider 字段不改变 neutral view；adapter policy 只属于 target；Claude overlay 缺失时公共事实仍可用。
- L1 的证据门禁使用这个合同；跨 Agent 合同测试已通过。

## Alternatives considered

**不拆 `SourceFacts`，只测试 neutral view。** 拒绝：这只能证明一个独立测试解析器，不能证明生产公共事实路径与 Claude 无关。

**注册一个假的 Codex adapter。** 拒绝：这会假装 target 已被支持，也没有测试公共边界。

**用关键词扫描 `AGENTS.md`。** 拒绝：自由文本让关键词黑名单很脆弱，也不能证明配置边界。

**现在就实现完整 Codex adapter。** 推迟：完整 adapter 属于 v0.4；合同测试是最小的配置级门禁。

## Consequences

- 公共事实发现不再需要 `.agents/adapters/claude-code.yaml`。
- 缺失或无效的 Claude overlay 由 Claude adapter 作为受治理的配置错误报告，并仍阻断写入。
- Provider 专属的 agent 和 skill frontmatter 字段暂时仍留在公共 source 中。neutral 合同把它们当作 provider 专属并排除；把它们移入 adapter overlay 是后续工作。
- 合同证明的是配置面，不是其他 Agent 的运行时行为。完整 Codex 和 DSH adapter 仍在 v0.4。

## Verification

- `pnpm test`：63 个测试文件、803 个测试通过。
- `pnpm typecheck`：无错误。
- `pnpm doc-sync`：无问题。
- `node dist/cli.js detect --strict`：`19/19 (100%)`，退出码 `0`。
- `node dist/cli.js normalize --dry-run`：manifest 无变更。
- `git diff --check`：干净。

## Related

- [路线图](../../../../docs/roadmap.zh.md)
- [架构](../../../../docs/architecture.zh.md)
- [工程纪律](../../../../docs/concepts/engineering-discipline.zh.md)
