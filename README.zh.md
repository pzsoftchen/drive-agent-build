[English](README.md) | 中文

# DAB：驱动 Agent 成为构建者

DAB 是长期方向：驱动 Agent 成为构建者。当前实现路径是 DAD（Drive Agent Development）：先让 Agent 通过受治理的项目配置变得可可靠驾驶，再证明单个开发任务能够完成并通过验收。

## DAB 位于哪里

工作模型是 `Agent = Model + Harness`。DAB 不是这个等式中的第三项；它负责驾驶 Harness 如何被配置，以及工作如何收敛为可交付结果。

```text
                         Builder
             intent / constraints / acceptance
                              |
                              v
+------------------- DAB direction (research) --------------+
| Goal loop                                                |
| Frame goal -> Decompose -> Integrate -> Accept -> Learn  |
|                              |                           |
|                              v                           |
| DAD path (current)                                       |
| facts / roles / tools / permissions / verification       |
| Task loop: Frame -> Drive -> Inspect -> Recover          |
|                           accepted -> Complete Task       |
+------------------------------+---------------------------+
                               | configures + directs
                               v
                 Harness loop: think -> act -> observe
                               |
                               v
                         Model + Project
                               | evidence
                               +--------------> DAD / DAB
```

不同角色承担不同责任：

- Builder 是对意图、约束、判断和验收负责的人。
- Agent 是在 Harness 中执行构建工作的执行主体。
- DAB 在产品概念上是驾驶系统；本仓库实现的是它的控制面。
- Harness 是执行引擎，提供循环、工具、上下文、权限和会话。

### 嵌套 Loop

- Harness Loop 负责局部执行：`think -> act -> observe -> continue`。
- DAD 任务循环负责把一个开发任务驾驶到完成，并产生验收证据。
- DAB 目标循环是研究方向，负责把多个任务分解、集成并收敛为一个通过验收的整体目标。

单任务闭包属于 DAD。只有当多个任务必须共同收敛到一个更大目标时，DAB 才真正开始。

[阅读完整概念说明](docs/concepts/why-dab.zh.md)。

## 当前状态

图中的方式是 DAB/DAD 的组合目标模型。DAD 配置治理基础已发布为 `@saydone/dab@0.1.1`。下一步是单任务证据；DAB 尚未排期。

| 能力 | 状态 |
|---|---|
| DAD 编写事实、投影、漂移检测和策略解释 | 已在 0.1.1 发布 |
| DAD 独立的 project/global scope 与 v2 manifest | 已在 0.1.1 发布 |
| DAD 单开发任务证据 | 计划在 v0.2 提供，这是下一步 |
| DAD 记忆与运行加固 | 计划在 v0.3 提供 |
| DAD Codex 与 DSH adapter | 在单任务证据之后 |
| DAB 目标拆解与跨任务收敛 | 研究阶段，以 DAD 证据为前置条件 |

发布：[npm](https://www.npmjs.com/package/@saydone/dab) · [GitHub Release v0.1.1](https://github.com/pzsoftchen/drive-agent-build/releases/tag/v0.1.1)

## 快速开始

前置条件：Node.js `>=24.9`、Claude Code `>=2.1.277`、macOS 或 Linux。

无需安装，直接运行 CLI：

```bash
npx @saydone/dab init /path/to/project
cd /path/to/project
npx @saydone/dab normalize --dry-run
npx @saydone/dab detect
```

全局安装后可使用更短的 `dab` 命令：

```bash
npm install -g @saydone/dab
dab --version
```

npm 包名是 `@saydone/dab`；`npx dab` 会解析到另一个包。

从源码开发：

```bash
pnpm install
pnpm build
pnpm link --global
```

使用 `dab init ~/.agents` 初始化独立的 global scope。

## 命令做什么

- `dab init` 写入项目编写骨架，并在安全时运行 normalize。
- `dab normalize` 编译策略、生成指令和投影产物，并记录哈希。
- `dab detect` 在不写入的情况下检查编写事实、生成输出、所有权和作用域。
- `dab policy explain` 展示选定 target 的最终规则和 hooks。

## DAB 为什么存在

我从个人杠杆正在发生变化这一点开始思考 DAB。当 Agent 承担越来越多执行工作时，我相信构建者的优势不再是亲手完成每一步，而是设计让 Agent 可靠构建的条件。

两个判断影响了我的想法：

- 一位 DeepSeek 算子开发者判断，工作重心可能从设计、编写和优化算子，转向驾驶 Agent 完成这些工作。
- 李彦宏提出的 Builder，把创造者的范围从编写代码的人扩展到更广泛的人群。

我最早实践的是一个更窄的做法：DAD（Drive Agent Development，驱动 Agent 开发），即定义 Agent 应如何开展开发工作，并驾驶 Agent 按这个过程执行。DAB 保留 DAD 的编写事实、投影、漂移检测、决策和共享记忆，再增加前面描述的面向交付的收敛。开发是第一个范围，因为我自己就是第一位构建者，而不是因为开发就是终点。

## 设计原则

- DAB 是控制面，不是 Agent runtime。
- 构建者保留意图、约束、验收和判断；Agent 负责执行。
- Harness 可以替换。Claude Code 是第一个目标，不是 DAB 的定义。
- 应当跨会话保留的知识放在可评审文件中，而不是隐藏在提示词里。
- 可重复性优先于一次性提示；编写事实和生成配置必须始终可比较。

## DAB 不保证什么

- v0.1 当前是单开发者、macOS 和 Linux、Claude Code 优先的实现。
- 它不实现 DAB 目标循环、任务图、跨任务学习或自动记忆提升。
- v0.2 将验证单个开发任务，不代表 DAB 已被证明。
- 路径 deny 规则是工具级护栏，不是沙箱。
- Hooks 是可信的可执行代码；DAB 只检查元数据和静态安全，不检查运行时行为。
- Windows junction、GUI、插件市场和自动 DAD 迁移不在范围内。

## 文档

完整文档：[docs](https://github.com/pzsoftchen/drive-agent-build/tree/main/docs)

- [DAB 为什么存在](docs/concepts/why-dab.zh.md)
- [路线图](docs/roadmap.zh.md)
- [架构](docs/architecture.zh.md)
- [开发](docs/development.zh.md)
- [CLI](docs/user/cli.zh.md)
- [Claude Code 集成](docs/user/claude-code.zh.md)
- [Agent 决策记录 0001](.agents/notes/implemented/architecture/2026-11-16-agents-source-tree.zh.md)
- [Agent 决策记录 0002](.agents/notes/implemented/architecture/2026-11-16-claude-md-compat-shim.zh.md)

## 许可证

MIT。
