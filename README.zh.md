[English](README.md) | 中文

# DAB：驱动 Agent 成为构建者

DAB 是面向使用 Agent 产出持久成果的构建者的项目级控制面。第一版面向开发者：它把 `AGENTS.md` 和 `.agents/` 编译为受治理的 Claude Code 配置，检测漂移，并让编写源和生成配置保持可比较。

## DAB 背后的想法

我从个人杠杆正在发生变化这一点开始思考 DAB。当 Agent 承担越来越多执行工作时，我相信构建者的优势不再是亲手完成每一步，而是设计让 Agent 可靠构建的条件：目标、上下文、角色、能力、权限、验证和可持续学习。

两个判断影响了我的想法：

- 一位 DeepSeek 算子开发者判断，工作重心可能从设计、编写和优化算子，转向驾驶 Agent 完成这些工作。
- 李彦宏提出的 Builder，把创造者的范围从编写代码的人扩展到更广泛的人群。

第一个判断让新角色变得具体，第二个判断让它的范围变得更大。我在 DAB 中把两者合在一起：**Drive Agent as Builder**。

我最早实践的是一个更窄的版本：DAD（Drive Agent Development，驱动 Agent 开发），它指定义 Agent 应该如何开展开发工作，并驾驶 Agent 按这个过程执行。DAD 让我看到了编写源、显式投影、漂移检测、决策记录和共享记忆的价值。DAB 继承这套工程纪律，但移除“只有软件值得构建”的假设。我从开发场景开始，是因为我自己就是第一位构建者，而不是因为开发就是终点。

## 原则

- DAB 是控制面，不是 Agent runtime。
- 构建者掌握意图、约束、验收和判断；Agent 负责执行。
- Harness 可以替换。Claude Code 是第一个目标，不是 DAB 的定义。
- 应当跨会话保留的知识放在可评审文件中，而不是隐藏在提示词里。
- 可重复性优先于一次性提示；编写事实和生成配置必须始终可比较。

## 为什么需要控制面

- 模型有能力，不代表工作可以重复。
- 只存在于对话中的工作流无法交接、评审或在更换 Agent 后继续使用。
- 个人自动记忆很有用，但它不是团队事实源。
- 只更新一侧时，双语文档必然腐化。
- 构建者需要受治理的配置，而不是一次性提示词。

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
