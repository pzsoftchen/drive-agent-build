[English](README.md) | 中文

# DAB：驱动 Agent 成为构建者

DAB 是长期方向：驱动 Agent 成为构建者。当前实现路径是 DAD（Drive Agent Development）：先让 Agent 通过受治理的项目配置变得可靠可驾驶，再证明单个开发任务能够完成并通过验收。

## DAB 位于哪里

工作模型是 `Agent = Model + Harness`。DAB 不是这个等式中的第三项；它是配置 harness、治理工作如何收敛为可交付结果的控制面。

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
                 Harness loop: think -> act -> observe -> continue
                               |
                               v
                         Model + Project
                               | evidence
                               +--------------> DAD / DAB
```

不同角色承担不同责任：

- Builder 是对意图、约束、判断和验收负责的人。
- Agent 是在 harness 内执行构建工作的执行主体。
- DAB 是控制面；本仓库实现它。
- Harness 是执行引擎，提供循环、工具、上下文、权限和会话。

### 嵌套循环

- Harness Loop 负责局部执行：`think -> act -> observe -> continue`。
- DAD 任务循环负责把一个开发任务驾驶到完成，并产生验收证据。
- DAB 目标循环是研究方向，负责把多个任务分解、集成并收敛为一个通过验收的整体目标。

单任务闭包属于 DAD；当多个任务必须收敛到一个更大目标时，DAB 才开始。

DAB 不替代模型，不实现 Agent Loop，也不成为另一个 runtime。概念模型见 [DAB 为什么存在](docs/concepts/why-dab.zh.md)；上图是可视化概览。

## DAB 要解决的问题

DAB 存在，是因为 Agent 能力和项目配置本身不会自动产生可靠交付。它按顺序解决四个问题：

1. 配置漂移与跨 Agent 干扰：同一事实被复制到多个 target，生成配置被手改，target 专属语义混进共享指令。
2. 不可执行的工程纪律：实践只存在于提示词和对话中，而不是配置和检查。
3. 未被度量的单任务交付：Agent 活动被误认为已接受的工作，验收不可复现。
4. 没有模型的目标级交付：拆解、集成、整体验收和跨任务学习都没有定义。

前两个问题是地基；第三个验证开发循环；第四个是研究。详细论证见 [DAB 为什么存在](docs/concepts/why-dab.zh.md)。

## 路线一瞥

路线是能力阶梯。版本是里程碑，不是路线本身。

| 层 | 问题 | 证据门禁 |
|---|---|---|
| L1 配置治理与目标隔离 | 编写事实能否投影到每个 target，而不漂移、不跨 Agent 泄漏？ | `detect --strict`、幂等 `normalize`、外部手改检测、共享指令原样透传不注入 target 专属内容、跨 Agent 合同测试。 |
| L2 工程纪律 | 项目规则是否显式、尽可能可强制，并能跨 target 移植？ | 每条规则都有强制级别；gate 规则有检查；target 专属规则放在 adapter overlay。 |
| L3 单任务交付 | 单个开发任务能否用可复现证据完成并通过验收？ | 固定任务集、基线对比、稳定的 harness 事件、记录耗时/成本/干预/范围越界。 |
| L4 目标级交付 | 多个任务能否集成为一个被接受的目标？ | L3 使用中反复出现目标级失败，然后最小目标循环原型。 |

证据门禁和版本映射见 [路线图](docs/roadmap.zh.md)。

## 当前状态

当前发布 `0.1.2` 包含 Claude Code 治理基础和实践层。能力和里程碑状态见 [路线图](docs/roadmap.zh.md)。

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

- `dab init` 写入项目编写骨架，包括 `docs/AGENTS.md`、`docs/architecture.md`、`.agents/gates.yaml` 和 `dab-*` authoring skills，并在安全时运行 normalize。它不生成高级 hooks 或共享记忆。
- `dab normalize` 编译策略、生成指令和投影产物、补齐缺失的 docs 和 authoring skills、管理 project 门禁产物、更新未修改的较旧受管 authoring skills，并记录哈希。
- `dab detect` 在不写入的情况下检查编写事实、生成输出、所有权、作用域和门禁接线。
- `dab policy explain` 展示选定 target 的最终规则和 hooks。

Generic profile 聚焦配置漂移，以及 docs、notes 和 skills 纪律。Hooks 与共享记忆保持高级、可选：已有 hooks 仍会被校验并在适用时编译，已有记忆仍会被保留和校验。

## 项目门禁

`dab init` 和 `dab normalize` 生成项目本地的门禁入口。在本地和 CI 运行同一个命令：

```bash
node scripts/dab-check.mjs
node scripts/dab-check.mjs --strict
node scripts/dab-check.mjs --json
```

- `.agents/gates.yaml` 是 authored、project-only；`scripts/dab-check.mjs` 和 `scripts/dab-gates.json` 是生成文件。runner 读取快照，不内嵌项目命令。
- 固定 `source` gate 运行 `dab detect --strict`。`code` gate 按配置运行项目 test、typecheck、lint 和 build 命令；`docs` 可选。Mode 为 `required`、`check`、`advisory` 和 `off`。
- 退出码 `0` 表示 required gate 通过，`1` 表示 required 失败或 strict warning，`2` 表示配置、快照或 runner 错误。未解析命令是 `CONFIG`，永不视为通过；`mode: off` 是显式豁免。
- scanner 在不执行构建工具的情况下检测 Node、Python、Go、Rust、Java Maven、Java Gradle、Android、iOS SwiftPM 和 iOS Xcode。Xcode 需要 shared scheme 和 destination 或 Fastlane 命令；否则 runner 报告 `CONFIG`。
- `dab detect` 增加 project-only 的 `Verification` 组。缺失或过期产物会让 `--strict` 失败；被修改、无版本和较新的生成文件、空命令集以及缺少 CI 接线保持非 strict。
- DAB 不生成 CI 文件，但提供片段和 detect 提示。配置、技术栈细节和 CI 示例见[项目门禁](docs/user/gates.zh.md)。

## 设计原则

- DAB 是控制面，不是 Agent runtime。
- 构建者保留意图、约束、验收和判断；Agent 负责执行。
- Harness 可以替换。Claude Code 是第一个目标，不是 DAB 的定义。
- 应当跨会话保留的知识放在可评审文件中，而不是隐藏在提示词里。
- 可重复性优先于一次性提示；编写事实和生成配置必须始终可比较。

## DAB 不保证什么

- 0.1.x 系列当前是单开发者、macOS 和 Linux、Claude Code 优先的实现。
- 它不实现 DAB 目标循环、任务图、跨任务学习或自动记忆提升。
- v0.2 里程碑将验证单个开发任务，不代表 DAB 已被证明。
- 路径 deny 规则是工具级护栏，不是沙箱。
- Hooks 是可信的可执行代码；DAB 只检查元数据和静态安全，不检查运行时行为。
- Windows junction、GUI、插件市场和自动 DAD 迁移不在范围内。

## 文档

完整文档：[docs](https://github.com/pzsoftchen/drive-agent-build/tree/main/docs)

- [文档指南](docs/AGENTS.md)
- [DAB 为什么存在](docs/concepts/why-dab.zh.md)
- [工程纪律](docs/concepts/engineering-discipline.zh.md)
- [路线图](docs/roadmap.zh.md)
- [架构](docs/architecture.zh.md)
- [开发](docs/development.zh.md)
- [CLI](docs/user/cli.zh.md)
- [项目门禁](docs/user/gates.zh.md)
- [Claude Code 集成](docs/user/claude-code.zh.md)
- [Superpowers 文档](docs/superpowers/README.md)
- [Agent 决策记录 0001](.agents/notes/implemented/architecture/2026-11-16-agents-source-tree.zh.md)
- [Agent 决策记录 0002](.agents/notes/implemented/architecture/2026-11-16-claude-md-compat-shim.zh.md)
- [Agent 决策记录 0003](.agents/notes/implemented/architecture/2026-11-23-practice-layer.zh.md)
- [Agent 决策记录 0004](.agents/notes/implemented/architecture/2026-11-24-managed-skills.zh.md)
- [Agent 决策记录 0005](.agents/notes/implemented/process/2026-11-24-route-and-discipline-docs.zh.md)
- [Agent 决策记录 0006](.agents/notes/implemented/architecture/2026-11-25-cross-agent-contract.zh.md)
- [Agent 决策记录 0007](.agents/notes/implemented/architecture/2026-11-25-g1-gates.zh.md)

## 许可证

MIT。
