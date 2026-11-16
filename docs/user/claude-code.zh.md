[English](claude-code.md) | 中文

# Claude Code 集成

DAB 面向 Claude Code `>=2.1.277`，只写入公开配置格式。

## Claude Code 读取什么

- `AGENTS.md` 提供项目指令，通过生成的垫片加载。
- `.claude/agents/` 提供项目子 Agent。
- `.claude/skills/` 提供项目 Skills。
- `.claude/rules/` 提供路径规则。
- `.claude/settings.json` 提供权限和 hooks。
- `.claude/settings.local.json` 提供本地用户设置，归用户所有。

## 生成的垫片

部分构建会关闭原生 `AGENTS.md` 加载。因此 DAB 生成 `.claude/CLAUDE.md`，内容为 `@../AGENTS.md`。`AGENTS.md` 仍是唯一编写指令源。未受管的 CLAUDE.md 会由 `dab detect` 报告。

## 记忆模型

- 团队共享事实放在 `.agents/memory/`，并在拉取请求中评审。
- 个人自动记忆留在机器本地，从不提交。
- Agent 可以使用 `memory: user` 或 `memory: local`，但 `memory: project` 会被拒绝，因为它会形成第二套团队记忆。
- `dab eval` 计划在 v0.2 提供，并将使用空记忆目录。

## 投影

DAB 逐项链接 agents、skills 和 rules，而不是链接整个目录。这样后续可以保留 provider 专属文件，并让所有权明确。投影目标是物理副本时视为冲突；`--fix` 会在替换前备份。

## 权限与 hooks

项目策略被编译进 `.claude/settings.json`。项目 deny 规则是 Claude Code 文件工具的硬边界，但 `Bash`、包装命令和其他工具可以绕过路径规则。Agent 定义可以收窄工具并追加 hooks，但不能移除项目 hooks。Hook 脚本会检查路径逃逸、重复 id、换行符、执行权限和敏感信息。

## 故障排查

1. 运行 `dab detect --json`，按 code 阅读诊断。
2. 运行 `dab normalize --dry-run` 查看计划的修复。
3. 只有在检查备份路径后才运行 `dab normalize --fix`。
4. 运行 `dab policy explain --agent <name>` 查看最终权限。
5. 运行 `dab --help` 查看命令列表。
