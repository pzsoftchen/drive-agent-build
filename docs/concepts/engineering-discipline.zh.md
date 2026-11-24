[English](engineering-discipline.md) | 中文

# 工程纪律

DAB 把工程纪律当作产品面，而不是留在提示词里的建议。没有纪律的配置治理只是空壳：它把事实投影到 harness，却没有定义工作应该如何开展，也没有定义什么证据能让结果被接受。

纪律属于编写源的一部分。有些规则可以由 CLI 或 CI 强制，有些仍然是行为约定。这个区分是模型的一部分，不是实现细节。

## 纪律集合

以下规则构成默认纪律模型。项目可以自定义，但必须写明每条规则的强制级别和目标可移植性。

| 规则 | 为什么重要 | 强制方式 | 可移植性 |
|---|---|---|---|
| 编写源是唯一来源，生成物永不手改。 | 防止漂移和竞争事实。 | `gate`：由 `normalize` 和 `detect` 检查。 | 目标中立。 |
| 先写测试，再写生产代码。 | 在声明之前先产生证据。 | `behavioral`；项目 CI 可以增加 gate。 | 目标中立。 |
| Fail loud。 | 静默回退和扩权会掩盖失败。 | `gate`：通过诊断和退出码。 | 目标中立。 |
| 最小权限，deny wins。 | 生成的配置不得扩大访问权限。 | `gate`：通过策略编译。 | 共享策略加 adapter overlay。 |
| 文档是变更的一部分。 | 项目知识必须跨会话保留。 | 项目要求时用 `gate`：通过 `doc-sync`；否则为 `behavioral`。 | 目标中立。 |
| 记录持久决策。 | 备选方案和后果保持可评审。 | `gate`：检查 note 格式；内容属于 `behavioral`。 | 目标中立。 |
| 受管更新保留本地修改。 | 生成的模板不得覆盖编写内容。 | `gate`：通过 marker 和 hash 检查。 | 目标中立。 |
| 证据优先于活动。 | 验收需要可复现证据，而不是活动量。 | 在任务评测存在之前为 `behavioral`；L3 证据门禁定义要求。 | 目标中立。 |
| Project 和 global scope 相互独立。 | 静默合并 scope 会改变最终配置。 | `gate`：通过 scope 解析。 | 目标中立。 |

## 强制级别

- `gate`：CLI 或 CI 检查会让变更失败。证据是退出码、诊断或失败测试。
- `check`：`dab detect` 报告 warning 或 error；由 `--strict` 决定是否阻断。`pnpm doc-sync` 的失败属于 `gate`。
- `behavioral`：写在 `AGENTS.md` 或 skill 里的指令。预期 Agent 遵守，但 DAB 无法证明。
- `optional`：hooks、共享记忆或其他可选能力。项目自行决定是否启用。

行为约定不是强制门禁。文档不得把行为约定写成已经强制。

## 可移植性

Common facts 位于 `.agents/`，保持目标中立。Provider 专属策略位于 `.agents/adapters/<provider>.yaml`；adapter 只把事实映射到目标，绝不拥有 agent、skill 或 rule 定义。

如果某个 target 无法表达某条规则，DAB 以 `target.unsupported` 失败，而不是静默丢弃。这与权限和所有权遵循同一个 fail-loud 原则。

当前实现只有一个 target：Claude Code。跨 Agent 覆盖是 [路线图](../roadmap.zh.md) 中的 L1 证据门禁。

## 来源

这套纪律综合了可识别的工程实践：先写测试、文档随变更、决策记录、最小权限、fail loud 和幂等更新。`deepseek-harness` 样本影响了实践层：它说明 docs 和 authoring skills 很重要，但它的领域内容不可普遍化，也没有被复制。实践层的决策记录在 [Agent Note 0003](../../.agents/notes/implemented/architecture/2026-11-23-practice-layer.zh.md)。

这不是诉诸“业界公认”。权威是项目自己的编写规则，以及强制这些规则的检查。来源变化时，用备选方案、后果和验证记录变更。

## 采用方式

- `dab init` 生成纪律文件。
- `dab normalize` 补齐缺失的实践文件，更新未修改的较旧受管 skills，保留已修改副本。
- `dab detect` 在不写入的情况下报告文档、note、skill 和配置状态。
- 项目可以增加规则、选择文档语言或保留用户自定义 skills；必须标注强制级别，并把 provider 专属规则放在 adapter overlay 中。

实现细节在 [架构](../architecture.zh.md)。里程碑在 [路线图](../roadmap.zh.md)。

## 边界

- DAB 治理配置和产物，不治理 Agent 运行时行为。
- Hooks 是可信的可执行代码；DAB 检查元数据和静态安全，不检查运行时行为。
- 路径 deny 规则是工具级护栏，不是沙箱。
- DAB 不运行 LLM 来填写文档。
