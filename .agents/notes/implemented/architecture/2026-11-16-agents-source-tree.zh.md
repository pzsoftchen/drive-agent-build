# Agent Note: AGENTS.md 与 .agents 作为事实源

Status: implemented

[English](2026-11-16-agents-source-tree.md) | 中文

## 问题

DAB 为已有代码和测试的项目管理 Claude Code 配置。直接写进 `.claude/` 的配置会与文档脱节，生成文件也经常被手工修改。项目需要一个编写源和确定性的投影。

## 决策

`AGENTS.md` 和 `.agents/` 是唯一的 Agent 配置编写源。`dab normalize` 把它们编译为 `.claude/settings.json`，并把 agents、skills 和 rules 投影为逐项符号链接。生成的 `.claude/CLAUDE.md` 垫片导入 `AGENTS.md`。生成输出加入 gitignore，永远不手工编辑。

## 备选方案

**直接维护 `.claude/`。** 被拒绝，因为它形成两个 home 并必然漂移。

**提交生成配置。** 被拒绝，因为生成文件会被手工修改并与源分叉。

**使用单个可变的 `settings.json` 作为源。** 被拒绝，因为 agents、skills 和 rules 会失去编写结构。

## 后果

- Agent、skill 或 rule 的修改只有一个 home 和一个投影步骤。
- 漂移可检测：`dab detect` 比较生成字节和符号链接目标与编写树。
- 用户无需阅读生成的 JSON 就能评审编写树。
- 必须运行 `dab normalize`；修改 `.agents/` 后也是如此。

## 验证

`pnpm test` 覆盖投影所有权、确定性 settings、幂等 normalize 和漂移检测。`node dist/cli.js detect` 在本仓库通过。`node dist/cli.js normalize --dry-run` 报告无变化。

## Update 2026-11-17

Manifest v2 使用 `targets[].options.instructions`，不再使用 `target.claudeMdShim`。默认的 `.claude/CLAUDE.md` 工件是指向该 scope `AGENTS.md` 的符号链接。生成的导入垫片保留为显式 fallback：project scope 为 `@../AGENTS.md`，global scope 为 `@../.agents/AGENTS.md`。以上事实描述 v2 之前的垫片时期，保留为历史背景。

## 相关

- [架构](../../../../docs/architecture.zh.md)
- [Claude Code 集成](../../../../docs/user/claude-code.zh.md)
