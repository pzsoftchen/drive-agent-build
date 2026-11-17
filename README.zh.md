[English](README.md) | 中文

# DAB：驱动 Agent 成为构建者

DAB 是面向使用 Agent 产出持久成果的构建者的、可区分作用域的控制面。Project scope 和 global scope 相互独立地配置。第一版面向开发者，并以 Claude Code 为首个目标。

## DAB 位于哪里

工作模型是 `Agent = Model + Harness`。DAB 不是这个等式中的第三项；它负责驾驶 Harness 如何被配置，以及工作如何收敛为可交付结果。

```text
                         Builder
             intent / constraints / acceptance
                              |
                              v
+------------------- DAB driving system -------------------+
| DAD foundation                                           |
| facts / roles / tools / permissions / verification       |
|                                                          |
| Builder delivery loop                                    |
| Frame -> Drive -> Inspect --accepted--> Deliver -> Learn |
|            ^          |                                  |
|            |          +--failed--> Recover               |
|            +-------------------------+                    |
+------------------------------+---------------------------+
                               | configures + directs
                               v
                 Harness: loop / tools / context
                               |
                               v
                         Model + Project
                               | evidence
                               +--------------> DAB
```

不同角色承担不同责任：

- Builder 是对意图、约束、判断和验收负责的人。
- Agent 是在 Harness 中执行构建工作的执行主体。
- DAB 在产品概念上是驾驶系统；本仓库实现的是它的控制面。
- Harness 是执行引擎，提供循环、工具、上下文、权限和会话。

### 两层 Loop

- Harness Loop 负责局部执行：`think -> act -> observe -> continue`。
- DAB 交付循环负责整体结果：`frame -> drive -> inspect -> recover -> deliver -> learn`。
- Harness 决定下一步做什么，DAB 决定工作是否正在收敛到验收状态。

[阅读完整概念说明](docs/concepts/why-dab.zh.md)。

## 当前状态

图中的方式是 DAB 的目标模型。当前 `main` 分支实现的是配置治理基础，证据驱动的交付循环尚未完成。

| 能力 | 状态 |
|---|---|
| 项目编写事实与确定性的 Claude Code 投影 | 已实现 |
| 漂移检测与最终策略解释 | 已实现 |
| 独立的 project/global scope 与 v2 manifest | 已在 `main` 实现，尚未发布 |
| Codex 与 DSH adapter | 在 Claude Code target 之后规划 |
| Run record 与交付循环评测 | 计划在 v0.2 提供 |
| 共享记忆提升 | 计划在 v0.3 提供 |

## 快速开始

前置条件：Node.js `>=24.9`、pnpm、Claude Code `>=2.1.277`、macOS 或 Linux。

```bash
pnpm install
pnpm build
pnpm link --global
dab init /path/to/project
cd /path/to/project
dab normalize --dry-run
dab detect
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
- 它尚未运行自己的交付循环、比较配置或自动提升记忆。
- 路径 deny 规则是工具级护栏，不是沙箱。
- Hooks 是可信的可执行代码；DAB 只检查元数据和静态安全，不检查运行时行为。
- Windows junction、GUI、插件市场和自动 DAD 迁移不在范围内。

## 文档

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
