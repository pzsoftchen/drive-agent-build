# Agent Note: 实践层

Status: implemented

[English](2026-11-23-practice-layer.md) | 中文

## Problem

DAB v0.1.1 只治理配置，却没有生成让项目的 agent 工作保持可读的实践。`dab init` 和 `dab normalize` 各自维护脚手架路径，二者都不创建项目文档或写作 skills，`dab detect` 也无法报告缺失或落后的文档实践。deepseek-harness 的样本说明 docs 和 authoring skills 很重要，但复制它的领域内容无法普遍适用。

## Decision

- Profile 选择实践包。`generic` 是默认值，`feature` 保留为行为相同的兼容别名，生产注册表组合 `core`、`documentation` 和 `authoring`。Documentation 和 authoring packs 只在 project scope 运行。
- 一个共享的 `planAuthoredScaffold` 服务 `init`（`full`）和 `normalize`（未初始化或 partial scope 用 `adoption`，已初始化 scope 用 `converge`）。Pack 声明 targets，planner 对它们做 stat，并用现有路径和计划路径构建 anchors，只渲染缺失文件。
- Documentation pack 只拥有 `docs/AGENTS.md` 和 `docs/architecture.md`。生成的 docs 使用由 `docs.language`（`auto`、`en` 或 `zh`）决定的单一语言，从不创建 `.zh.md` 或 `.i18n.yaml` 配对。`auto` 采样现有 docs、根 `AGENTS.md`、`README.md`、`package.json` description 和 locale，然后默认 `en`；`{ value, source }` 解析结果会被报告。
- Authoring pack 安装 `dab-doc-writing`、`dab-architecture-writing` 和 `dab-decision-notes`，位于 `.agents/skills/` 下。每个 skill 都是带 `dab-skill: <name>@<version>` 标记的 authored 副本。DAB 跳过已存在的 skill 目录，且从不更新已安装 skill；没有 authored source 的物理 `.claude/skills/dab-<name>` 条目由 `init` 保持 pending，并由 `normalize` 导入。
- 已有的 `.agents/rules/docs-bilingual.md` 是项目政策：规则保留，缺失的 documentation targets 以 `practice.docs-bilingual-policy` 被 policy skip，已有 docs 作为 skipped 保留，authoring skills 和 target 写入继续。
- `dab detect` 只读运行相同的 packs。它增加 `Documentation` 组和 `Skills` 中的 authoring 条目，检查链接、行首 `TODO:` 或 `TODO(owner):` 标记、空架构章节和版本标记，并把 policy skip 和未加版本标记的 authored skills 视为 non-strict warning。
- DAB dogfood 该层：自身的 `docs/AGENTS.md` 指南和 `dab-*` skills 是由 `dab detect` 检查的 authored 文件，同时已有的双语规则继续让产品 docs 保持配对。

## Alternatives considered

**为每种实践提供独立 profile（`docs`、`delivery`）。** 拒绝：profile 是项目工作方式，不是实践维度；实践包保持内部组合，并统一在一个 profile 下。

**增加 `.agents/practices.yaml` 做组合。** 推迟：现有 manifest 的 `profile` 字段足以承载 v1，在真实组合需求出现前新增文件只会扩大表面。

**只发布 skill 库，不做确定性脚手架和检查。** 拒绝：只有 skills 无法收敛存量项目，也无法让 CI 知道 docs 缺失或落后。

**默认生成双语文档。** 拒绝：配对和翻译维护属于项目政策，不是通用默认值。Generic profile 只写一种语言；bilingual pack 可以后续提供。

**让 `normalize` 调用 LLM 填写文档。** 拒绝：`normalize` 保持确定性，不执行 agent 或内容生成。Authoring skills 指导项目自己的 agent。

## Consequences

- 带 `.agents/rules/docs-bilingual.md` 的存量 v0.1.1 项目不会获得生成的缺失 docs；已有 docs 作为 `skipped` 保留。缺失 docs 会收到 `practice.docs-bilingual-policy` warning，项目仍获得 authoring skills；迁移路径是删除该规则或等待 bilingual pack。
- 已安装的 `dab-*` skills 是 authored 副本。DAB 版本升级后它们会保持落后，直到人或 agent 审阅并合入新文本；`dab detect` 报告落后标记，但从不覆盖 skill。
- 可导入的物理 `.claude/skills/dab-*` 目录不会被重复创建：`init` 将其报告为 pending，`dab normalize` 导入后，后续运行会把它投影。非目录条目以 warning pending 报告为 `practice.skill-import-conflict`，不提供 import 提示，init 从不写入或替换它。
- `feature` manifest 获得与 `generic` 相同的实践行为，因此一次 normalize 可能新增此前不存在的 docs 和 skills。`--dry-run` 和 `practices` JSON 会先展示计划。
- 新的 generic 项目不再获得双语规则。DAB 自身保留该规则，因此自己的 documentation pack 被 policy skip，而其他项目获得单语 docs；项目规则优先。
- 命令读取的每个 authored source parent 都会在发现之前校验：`.agents/agents`、`.agents/hooks`、`.agents/memory`、`.agents/policies` 或 `.agents/adapters` 处的普通文件、悬空链接、访问拒绝或符号链接循环是受治理的 `path.conflict`，会在写入前阻断 project 和 global 运行；`.agents/rules` 和 `.agents/skills` 保持 practice 自有的诊断。不可读的 practice skill 目录是受治理的路径错误，而不是后续的发现错误。
- Detect score 包含 practice 条目，`--strict` 会在 practice 内容缺失或落后时失败，但两个 non-strict 的政策与保留类 warning 除外。

## Verification

- `pnpm test`：59 个测试文件、660 个测试通过。
- `pnpm typecheck`：无错误。
- `pnpm doc-sync`：配对、链接、排版、预算和 Agent Note 检查通过。
- `pnpm build`：TypeScript 编译通过。
- `node dist/cli.js detect --strict`：`19/19 (100%)`，退出码 `0`。
- `node dist/cli.js normalize --dry-run`：无写入，也没有待处理的 target 变更。
- `git diff --check`：干净。

## Related

- [架构](../../../../docs/architecture.zh.md)
- [CLI](../../../../docs/user/cli.zh.md)
- [设计规格](../../../../docs/superpowers/specs/2026-11-23-practice-layer-design.md)
