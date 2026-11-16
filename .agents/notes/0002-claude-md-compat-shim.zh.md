---
status: implemented
date: 2026-11-16
authors: [DAB contributors]
review_by: 2027-05-16
---
[English](0002-claude-md-compat-shim.md) | 中文

# Agent 决策记录 0002：生成的 CLAUDE.md 导入垫片

## 背景

Claude Code 2.1.277 增加了原生 `AGENTS.md` 加载。在开发机器上，缓存的特性开关关闭了它：只有 `AGENTS.md` 时，项目指令没有被加载。根目录 `CLAUDE.md` 或 `.claude/CLAUDE.md` 仍能可靠加载。

## 决策

当 `target.claudeMdShim` 为 true 时，DAB 生成 `.claude/CLAUDE.md`，包含生成头和 `@../AGENTS.md`。`AGENTS.md` 仍是唯一编写指令源。垫片是投影，加入 gitignore，并由 `dab detect` 检查。

## 后果

- 项目指令在开关关闭和开启的 Claude Code 构建上都能加载。
- 根目录 `CLAUDE.md` 仍是未受管冲突；用户必须把它合并进 `AGENTS.md`。
- 垫片增加一个生成文件和一个 manifest 条目。
- 依赖原生加载的用户可以设置 `claudeMdShim: false`。

## 备选方案

- 什么都不做。被拒绝，因为部分机器上原生加载被关闭。
- 把根目录 `CLAUDE.md` 符号链接到 `AGENTS.md`。被拒绝，因为它把生成符号链接放在仓库根目录并与用户文件冲突。
- 要求用户级 Claude Code 设置。被拒绝，因为它不是项目本地配置，容易遗漏。

## 验证

本地探针确认：在开关关闭的构建上，`.claude/CLAUDE.md` 配合 `@../AGENTS.md` 能加载唯一标记，而只有 `AGENTS.md` 不能。`dab detect` 检查垫片存在和漂移；`pnpm test` 覆盖垫片所有权和修复。

## 参考

- [架构](../../docs/architecture.zh.md)
- [Claude Code 集成](../../docs/user/claude-code.zh.md)
