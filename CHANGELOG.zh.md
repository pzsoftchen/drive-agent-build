[English](CHANGELOG.md) | 中文

# 变更日志

## 未发布

- `dab init` 默认写入 `profile: generic` 和 `docs.language: auto`。`--profile generic|feature` 选择 manifest profile；`feature` 是行为相同的兼容别名。`docs.language` 接受 `auto`、`en` 或 `zh`；`auto` 从项目内容和 locale 解析，并在人类输出和 JSON 中报告 `{ value, source }`。
- `dab init` 和 `dab normalize` 生成单语 `docs/AGENTS.md` 和 `docs/architecture.md`，不生成 `.zh.md` 或 `.i18n.yaml` 配对，并安装 `dab-doc-writing`、`dab-architecture-writing` 和 `dab-decision-notes` authoring skills。已有 docs 和 skill 目录永不被覆盖，已安装的 `dab-*` skills 也永不自动更新。
- `dab init` 现在会把可导入的物理 `.claude/skills/dab-*` 目录标记为 pending，跳过对应的 authoring 模板，并把 import 留给 `dab normalize`；非目录条目以 warning pending 报告为 `practice.skill-import-conflict`，不提供 import 提示。它从不写入或替换该物理条目。
- Generic skeleton 不再生成 `.agents/rules/docs-bilingual.md`；已有的 authored 规则会保留，并以 `practice.docs-bilingual-policy` 对缺失的单语 docs 做 policy skip。已有 docs 作为 skipped 保留，悬空的 docs 路径不会阻断它们。Authoring skills 和 target 写入继续。
- `dab normalize` 在 target planning 之前为未初始化、partial 和已初始化 project scope 补齐缺失的实践文件。`--json` 为 project scope 追加 `practices`，包含 `profile`、`mode`、`language`、`created`、`skipped`、`policySkipped`、`directories`、`skills` 和 `diagnostics`；dry run 和 practice 写入前被阻断的运行保留计划条目，被后续 target 失败阻断的运行报告已写入的文件，global scope 省略该对象。
- Practice 路径校验拒绝逃逸符号链接、特殊文件和不可读 target。已有 docs 必须是可读普通文件或指向它的仓库内符号链接；skill 目录必须是真实目录或指向具备读与搜索权限目录的仓库内符号链接。`.agents/rules` 或 `.agents/skills` 处的普通文件在 `init`、`normalize` 和 `detect` 中是受治理的诊断，而不是内部错误。`.agents/agents`、`.agents/hooks`、`.agents/memory`、`.agents/notes`、`.agents/policies` 或 `.agents/adapters` 处的普通文件、悬空链接、访问拒绝或符号链接循环是受治理的 `path.conflict`，project 和 global 运行都会在写入或发现之前阻断。缺少读与搜索权限的 source parent 同样受治理；best-effort secret scan 可能跳过不可读子树，但访问错误由 parent probe 报告。
- `dab detect` 增加 `Documentation` 组和 `Skills` 中的 authoring skill 条目，检查链接、行首 TODO 标记、空架构章节和 skill 版本标记。缺失的实践文件、TODO、空章节和落后 skills 会让 `--strict` 失败；双语 policy skip 和未加版本标记的保留 skills 保持信息性。
- DAB 现在 dogfood 实践层：自身的 `docs/AGENTS.md` 指南和 `dab-*` authoring skills 位于 authored source tree，并由 `dab detect` 检查。
- `dab detect` 为未初始化、partial 和已初始化的 project/global scope 输出只读 checklist，包含 `[OK]`、`[MISSING]`、`[WARN]`、`[ERROR]` 和 `[IMPORTABLE]` 状态、score 和 next actions；JSON 追加 `scope`、`root`、`phase`、`profile`、`checklist`、`score` 和 `nextActions`。已初始化 scope 也会把可导入的物理条目报告为 importable，而不是 unmanaged 或 physical-copy 漂移。
- 未初始化和 partial 的 `dab detect --json` 结果现在是完整 checklist 对象，包含 `ok: false` 和 `exitCode: 2`，不再使用错误信封；`schemaVersion` 仍为 `1`。
- `dab normalize` 采用缺失的最小 source，并把物理 `.claude/agents` 和 `.claude/skills` 条目导入 `.agents`，将原文件备份到 `.dab/backups/` 后替换为逐项符号链接。非法 import 会阻止所有写入，`--fix` 仍只处理非 import 冲突。
- `dab normalize --dry-run` 列出 import、backup 和 symlink 动作以及计划备份路径；真实运行时人类输出也会显示 adoption source 动作、import 动作和备份。
- Managed projection 符号链接漂移无需 `--fix` 即可修复；有 authored source 的 unmanaged 条目符号链接由 `--fix` 修复，没有 authored source 的链接需要手动移除。`dab init` 从不导入现有 `.claude` 条目。
- Global scope 获得相同的 checklist 和 adoption/import 行为；`~/.claude/settings.json` 和 `$HOME/.gitignore` 保持只读，Global source 完全缺失时仍以 `dab init ~/.agents` 作为显式入口。
- `dab init` 仍是一次性 full profile 初始化入口；已有项目使用 `dab detect` 和 `dab normalize`。

## 0.1.1 — 2026-11-23

- 以 `@saydone/dab` 发布 CLI，并增加 GitHub Actions release workflow、npm provenance 和逐 tag 的 GitHub Release。
- `schemaVersion: 1` 已加入每个 `--json` 结果，并拒绝 `--json` 与 `--help` 或 `--version` 组合使用。
- Agent、skill 和 rule frontmatter 现在保留未知顶层字段，并以 did-you-mean 提示发出警告（包含字母转置）；DAB 自有 YAML 仍然严格。
- 增加 `dab detect --strict`，在项目/配置类 warning 时让 CI 失败。
- `dab normalize --json` 包含绝对 `root`；`dab init --json` 包含 `root` 和 `scopeRoot`，生成与 backup 路径相对于它们。
- 统一所有命令的 Windows 平台守卫，并将 normalize 的 Claude Code 版本检查减少为一次。
- 文件与诊断排序不再依赖 locale，使哈希和 JSON 在不同机器上保持稳定。
- `dab --version` 现在从 `package.json` 读取版本。
- 增加相互独立的 project/global scope、v2 manifest 和逐 target 生成记录。
- 增加 target adapter 基础层和 symlink 优先的 Claude Code 指令产物。
- 增加 DAB、DAD 及其嵌套交付层级的中英文概念模型。
- 明确区分已实现的治理能力与计划中的证据能力。
- 将 Roadmap 重排为 DAD 优先，并以真实目标级交付失败作为 DAB 的研究门槛。

## 0.1.0 — 2026-11-16

- 初始 `dab` CLI，包含 `init`、`detect`、`normalize` 和 `policy explain`。
- Claude Code-first adapter，生成确定性的 `.claude/settings.json` 和逐项符号链接。
- 生成 `.claude/CLAUDE.md` 导入垫片，兼容 AGENTS.md。
- 双语文档门禁，覆盖配对、链接、排版、预算和 Agent 决策记录。
- 共享策略与 Claude Code adapter 分层，采用 deny 优先编译。
