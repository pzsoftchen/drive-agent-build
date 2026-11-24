# Agent Note: Detect checklist 与 normalize adoption

Status: implemented

[English](2026-11-23-detect-normalize-adoption.md) | 中文

## Problem

`dab detect` 在项目没有 `dab.yaml` 或 `.agents/` 时会在输出任何内容前就失败；`dab normalize` 又把现有 `.claude/agents` 和 `.claude/skills` 事实当作 unmanaged 冲突。用户希望先看到只读 checklist，再让 normalize 采用缺失的最小 source 并导入这些事实。第一版实现还会硬性阻止已记录的 projection 符号链接漂移、在 `.agents` / `.claude` 的 disjoint 预检前写入 source、在 `dab init` 期间导入，并把 import 计划隐藏在 dry run 和人类输出之外。

## Decision

- Detect 在需要 manifest 之前解析 adoption phase。未初始化和 partial scope 打印 checklist、从不写入，并以 `2` 退出，payload 与已初始化 scope 相同的完整结果对象；`{ ok: false, error }` 信封保留给用法、校验和后端错误。`schemaVersion` 仍为 `1`，因为改动只追加字段。
- Detect 在已初始化 scope 运行同一份只读 import 计划，因此物理 `.claude` agent 或 skill 会显示为 `[IMPORTABLE]`，且不会同时报告为 unmanaged 或 physical-copy 漂移。
- Normalize adoption 只创建缺失的最小 source，然后导入物理 `.claude/agents` 和 `.claude/skills` 条目，把原文件备份到 `.dab/backups/` 并替换为逐项符号链接。任何非法候选或不安全路径都会阻止所有写入。
- `dab init` 抑制 import；它在现有 `.claude` 树上保持既有行为，adoption/import 仍是 normalize 的职责。
- 生成记录决定 managed 符号链接漂移：已记录的条目符号链接由 projection 计划修复或移除，无需 `--fix`。已有 authored `.agents` source 的未记录条目符号链接由 `--fix` 备份并替换；没有 authored source 的链接需要手动移除，因为 DAB 从不导入或删除 unmanaged 链接。
- Source 写入预检在创建任何最小 source 之前检查真实路径包含关系以及 `.agents` / `.claude` 的 disjoint 性，包括目标缺失的直接词法符号链接别名。
- `normalize --dry-run` 列出 source、import、backup 和 symlink 动作及计划备份路径。真实运行时人类输出也会显示 adoption source 动作、import 动作和 adoption 备份。

## Alternatives considered

**增加独立的 `dab import` 命令。** 拒绝：import 属于 adoption，且用户要求不增加命令。

**让 init 继续导入。** 拒绝：init 是一次性初始化器，在 init 期间替换用户文件并产生备份是意外副作用。

**未初始化 scope 保留 detect 错误信封。** 拒绝：checklist 是存量项目的产品界面；明确记录 payload 变化并用兼容性测试固定，比把 checklist 藏在错误后面更好。

**即使有 `--fix`，也始终把 unmanaged 条目符号链接视为致命。** 拒绝：有 authored source 时备份并替换是安全的，也与现有 unmanaged projection 行为一致。没有 source 的链接仍是手动冲突。

**在 detect 中把可导入 target 报告为 physical copy。** 拒绝：这会与 `[IMPORTABLE]` 以及普通 normalize 的导入行为矛盾。

## Consequences

- 存量项目用 `dab detect` 和 `dab normalize` 即可检查并收敛，无需 `dab init`。
- Managed 漂移修复无需 `--fix`；一个过期链接不再阻止所有写入。
- 被拒绝的别名布局产生零文件系统写入。
- JSON 消费者会在顶层 `actions` 中看到 adoption 动作，并看到未初始化/partial detect 的完整 payload；两者都是在 `schemaVersion: 1` 下的追加。
- 没有 authored source 的 unmanaged 条目符号链接仍需要手动步骤。

## Verification

- 命令测试覆盖未初始化、partial 和已初始化 detect payload、已初始化 scope 的 `[IMPORTABLE]`，以及未初始化结果形状。
- Normalize 测试覆盖有/无 `--fix` 的 managed agent 和 skill 漂移、有 authored source 的 unmanaged 符号链接修复、别名和悬空 `.agents` / `.claude` 树零写入、dry run 的 import/backup/symlink 计划以及人类输出。
- Init 测试断言现有 `.claude` agents 和 skills 既不被导入也不被备份。
- `pnpm test`、`pnpm typecheck` 和 `pnpm doc-sync` 通过。

## Related

- [架构](../../../../docs/architecture.zh.md)
- [CLI](../../../../docs/user/cli.zh.md)
- [Claude Code 集成](../../../../docs/user/claude-code.zh.md)
- [设计规格](../../../../docs/superpowers/specs/2026-11-23-detect-normalize-adoption-design.md)
