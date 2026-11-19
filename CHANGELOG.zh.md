[English](CHANGELOG.md) | 中文

# 变更日志

## 未发布

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
