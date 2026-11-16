[English](CONTRIBUTING.md) | 中文

# 贡献指南

DAB 使用它自己推荐的工作流开发。请先阅读 `AGENTS.md`。

## 开始之前

- 使用 Node `>=24.9` 和 pnpm。
- 运行 `pnpm install` 和 `pnpm build`。
- 阅读 `docs/development.md`。

## 开发循环

1. 为行为写一个失败的测试。
2. 运行聚焦测试并确认失败。
3. 做最小的实现改动。
4. 运行 `pnpm test` 和 `pnpm typecheck`。
5. 更新英文、中文文档和 `.i18n.yaml` 记录。

## 文档改动

- 每个人类文档 `foo.md` 都有 `foo.zh.md` 和 `foo.i18n.yaml`。
- 确认配对后运行 `pnpm run verify-translation-pairing --write`。
- 提交前运行 `pnpm doc-sync`。

## 拉取请求

- 说明行为变化以及证明它的测试。
- 明确列出生成文件、权限变化和迁移说明。
- 决策变化时链接相关 Agent 决策记录。
- 不要提交 `.claude/` 输出。

## 问题

提交 issue 时附上命令、输出和相关编写文件。
