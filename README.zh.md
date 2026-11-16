[English](README.md) | 中文

# DAB：驱动 Agent 成为构建者

DAB 是面向使用 Agent 构建软件的个人开发者的项目级控制面。它把 `AGENTS.md` 和 `.agents/` 编译为受治理的 Claude Code 配置，检测漂移，并让编写源和生成配置保持可比较。

## 为什么需要 DAB

- 直接写进 `.claude/` 的 Agent 配置会与项目指令逐渐脱节。
- 个人自动记忆很有用，但它不是团队事实源。
- 只更新一侧时，双语文档必然腐化。
- 构建者需要可重复的配置，而不是一次性提示词。

## v0.1 做什么

| 范围 | 行为 |
|---|---|
| 编写源 | `AGENTS.md` 和 `.agents/` |
| 生成输出 | `.claude/` |
| 命令 | `dab init`、`dab detect`、`dab normalize`、`dab policy explain` |
| 文档 | 带哈希的中英文三件套 |
| 运行时 | macOS 和 Linux 上 Claude Code `>=2.1.277` |

## 快速开始

```bash
pnpm install
pnpm build
pnpm link --global
node dist/cli.js init /path/to/project
cd /path/to/project
dab detect
```

典型的本地循环是：

```bash
dab init
dab normalize --dry-run
dab policy explain
dab detect
```

## 工作原理

1. `dab init` 扫描仓库并写入最小的 `AGENTS.md`、角色、Skill、规则和策略骨架。
2. `dab normalize` 把策略编译为 `.claude/settings.json`，把编写条目投影为符号链接，并把哈希记录到 `dab.yaml`。
3. `dab detect` 在不写入的前提下比较生成字节、链接目标、frontmatter、敏感信息、记忆和 AGENTS.md。
4. `dab policy explain` 展示最终生效的权限和 hooks，包括角色收窄和运行时限制。

## DAB 不保证什么

- 路径 deny 规则是工具级护栏，不是沙箱；`Bash` 和其他工具可以绕过。
- Hooks 是可信的可执行代码；DAB 只检查元数据和静态安全，不检查运行时行为。
- v0.1 不运行 Agent Loop，也不比较配置结果。
- 生成的 `.claude/` 输出是构建产物，不要手工编辑。

## 状态与边界

- v0.1 是单开发者、macOS 和 Linux、Claude Code 优先的版本。
- 不实现 GUI、独立 Agent Loop、模板市场或自动记忆提升。
- Windows junction、多 harness 同步和自动 DAD 迁移不在范围内。
- 生成配置是构建产物；`dab.yaml` 和 `.agents/` 是评审面。

## 文档

- [路线图](docs/roadmap.zh.md)
- [架构](docs/architecture.zh.md)
- [开发](docs/development.zh.md)
- [CLI](docs/user/cli.zh.md)
- [Claude Code 集成](docs/user/claude-code.zh.md)
- [Agent 决策记录 0001](.agents/notes/implemented/architecture/2026-11-16-agents-source-tree.zh.md)
- [Agent 决策记录 0002](.agents/notes/implemented/architecture/2026-11-16-claude-md-compat-shim.zh.md)

## 许可证

MIT。
