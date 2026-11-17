# DAB 跨 Harness 对齐规范

## 状态

提案。本 spec 需要批准后，才能编写实现计划。

## 摘要

DAB 使用 `AGENTS.md` 和 `.agents/` 作为 Agent 配置的唯一编写源。Claude Code、Codex 和 DSH 是执行目标。DAB 让每个目标对齐同一 source 并检测漂移。原生格式直接透传；优先 symlink 而不是 copy；adapter 只映射差异和 provider 专属设置。

## 问题

- 复制到 `.claude`、Codex profile 或 DSH profile 的配置会与 source 漂移。
- Provider 专属的 agent、skill 或 rule 定义会形成第二个事实源。
- global 和 project 层由手工各自对齐。
- 在 symlink 可用时复制文件会制造本可避免的漂移。
- 即使 harness 已接受原生格式，把所有事实经过新的中性 schema 映射也会增加转换。

## 目标

- `AGENTS.md` 和 `.agents/` 是 global 与 project scope 的唯一 source。
- 每个 scope 对齐自己的 harness 配置。DAB 不合并 global 和 project 层。
- 原生透传优先；symlink 优先；只有 symlink 不可行时才 copy。
- Adapter 只拥有映射和 provider 专属选项，绝不拥有 agent、skill 或 rule 定义。
- 每个 target 只写入其 scope 的 target roots；project scope 永不写 user-global 配置。
- `dab detect` 报告来自同一 source 的 per-target 和 cross-target 漂移。
- Claude Code 仍是第一个 target；Codex 和 DSH 在同一模型上跟进。

## 非目标

- 不提供 `dab global` 命令。
- DAB 不做 global 或 project 继承与合并。
- 不为已经原生支持的事实引入通用中性 schema。
- 不允许 adapter 拥有 agent、skill 或 rule 定义。
- symlink 可用时不 copy。
- 不做 GUI、agent loop、eval、memory promotion、插件市场或 Windows junction。

## 核心模型

四层：

```text
source -> common fact model -> harness adapter -> generated target config
```

- Source：当前 scope 的 `AGENTS.md` 和 `.agents/`。
- Common fact model：agents、skills、rules、policies、hooks、memory 和 notes。
- Adapter：把 common facts 映射到 harness，并添加 provider 专属选项。
- Generated target config：harness 配置根下的文件。

Source 保持权威。生成配置永远不手工编辑。

## Source 事实与 Adapter Overlay

- Common facts 位于 `.agents/agents/`、`.agents/skills/`、`.agents/rules/`、`.agents/policies/`、`.agents/hooks/`、`.agents/memory/` 和 `.agents/notes/`。
- 当某个 common fact 仅对部分 target 可用时，可以声明 `providers`。定义仍留在 `.agents`。
- Provider 专属字段位于 `.agents/adapters/<provider>.yaml`，以 fact ID 为 key。
- Overlay 可以添加 provider 选项；不得重定义 fact 的 name、description、prompt、body 或 common capabilities。
- Overlay ID 在 `.agents` 中不存在时是错误。
- Provider 专属 agent、skill 或 rule 目录不属于 source 模型。

## Capability Matrix

| 事实 | Claude Code | Codex | DSH |
|---|---|---|---|
| Instructions | native | native | native |
| Subagents | native | native | native |
| Skills | native | native | native |
| Rules | native | mapped 或 unsupported | mapped 或 unsupported |
| Policies | mapped | mapped | mapped |
| Hooks | mapped | mapped | mapped |

- `native`：harness 接受 source 格式且不需要内容转换；直接投影。
- `mapped`：adapter 只转换差异字段或格式。
- `not-applicable`：fact 声明了排除该 target 的 `providers`；这是预期覆盖，不是漂移。
- `unsupported`：已配置的 target 应当承载该 fact，但没有安全映射；adapter 明确失败并指出 source fact。
- Claude Code 的 instructions 投影为 `.claude/CLAUDE.md` 指向 `../AGENTS.md` 的 symlink。如果 target 无法读取该 symlink，DAB 记录 generated import shim，并报告为 `generated`，而不是 `native`。
- 矩阵由 adapter 测试验证，并在 harness 变化时更新。

## Artifact 选择

模式为 `symlink`、`generated`、`copy` 和 `unsupported`。

选择顺序：

1. 原生格式且支持 symlink：`symlink`。
2. 格式或 provider 选项不同：`generated`。
3. 原生内容但 harness 不能跟随 symlink：`copy`，并给出明确原因。
4. 没有安全映射：`unsupported`。

规则：

- 原生文件和 skill 目录默认使用 symlink。
- `copy` 是最后手段，必须由 `dab detect` 报告。
- Generated artifacts 记录 source hash、target hash、adapter version 和 overlay hash。
- Copies 记录 source hash、target hash 和无法使用 symlink 的原因。
- Generated artifacts 是构建输出。它们留在 target root 下，位于 `AGENTS.md` 和 `.agents/` 等 authored path 之外。
- 每个 target 只能写入其 scope 的 target roots。

## Target 所有权与冲突

- 只有当 manifest 的 generated record 表明 DAB 创建了某个 target path 时，该 path 才是 managed。Managed 状态包括指向预期 source 的 symlink、与记录 hash 匹配的 generated file，或与 source hash 匹配的 copy。
- target path 上已存在但未 managed 的文件或目录是 unmanaged。`dab normalize` 和 `dab detect` 报告冲突；冲突存在时，`normalize` 不为任何 target 写入。
- `dab normalize --fix` 可以在把 unmanaged target path 移入带时间戳的 backup 后采用它。没有 `--fix` 时，DAB 永不替换或删除 unmanaged path。
- `dab init` 可以创建缺失的 target paths。只要任一 target path 是 unmanaged，它就不写入任何 target configuration，并报告冲突。
- Global 投影的 instructions、agents、skills 和 rules 遵循同一规则。Global settings 是下面覆盖的更严格特例。
- `dab detect` 报告所有 unmanaged 冲突。

## Scope 与 Roots

| Scope | Source root | Manifest | Target roots |
|---|---|---|---|
| Project | `<repo>/.agents/` 加 `<repo>/AGENTS.md` | `<repo>/dab.yaml` | `<repo>` 下 |
| Global | `~/.agents/` 加 `~/.agents/AGENTS.md` | `~/.agents/dab.yaml` | `$HOME` 下 |

- 位置决定 scope。Manifest 的 `scope` 字段验证解析出的 scope，绝不覆盖它。
- `dab init [path]` 使用 `path` 或当前目录作为确切的 source root，并在缺失时创建它。`dab init ~/.agents` 引导 global scope。
- 其他命令检查当前目录是否位于 `$HOME/.agents` 或其下；如果是，global source root 是 `$HOME/.agents`。否则向上查找到最近的、包含 `dab.yaml` 或 `.agents/` 的目录。
- `scope: global` 的 manifest 必须精确解析到 `$HOME/.agents`。`scope: project` 的 manifest 不得解析到那里。不匹配是错误。
- 没有 `scope` 的 legacy manifest 在带版本迁移添加它之前按 project scope 处理。global root 处的 legacy manifest 在迁移前是错误。
- `dab init` 拒绝在已有 source root 内部创建 source root，因此不会创建嵌套 `.agents` tree。
- Project 命令只写入 `<repo>` 下。Global 命令只写入 `$HOME` 下，且绝不写入 `$HOME/.agents`。任何超出 scope root 的 target path 都是错误。
- 如果某个 target 需要 harness 无法从项目读取的 user-global 配置，该 target 在 project scope 为 unsupported。请在 global scope 配置它。
- 两个 scope 独立检查和 normalize；没有跨 scope 合并。

## Manifest 与 Targets

```yaml
scope: project
targets:
  - provider: claude-code
    options: {}
  - provider: codex
    options: {}
  - provider: dsh
    options: {}
```

- target 可以禁用或省略。
- Global manifest 使用 `scope: global`，只配置 user-global target roots，例如 `~/.codex`。
- Provider options 可以选择 profile 或格式，但不得把输出重定向到上面的 scope roots 之外。需要 user-global file 的 options 只在 global manifest 中有效。
- 每个 target 有自己的 generated artifact list 和 hash record。
- Generated record 属于一个 manifest，并以 provider 为 key。
- Source paths 保持相对于 scope root。
- Target paths 必须留在上面的 scope roots 内。

## CLI 行为

- `dab init [path]`：在确切 root 创建 source skeleton，并在 manifest 中配置 targets。
- `dab normalize`：解析 scope root，预检所有已配置 target，并在预检通过时按 artifact selection order 重新生成它们。
- `dab detect`：检查 source-to-target 漂移、overlay 有效性、cross-target 覆盖、unmanaged 冲突和 scope 不匹配。
- `dab policy explain`：解释 per-target 的有效策略和 mapping 状态。
- 现有 flags `--dry-run`、`--fix` 和 `--json` 保持语义。`--dry-run` 运行同一预检且不写入；`--fix` 只在 backup 后采用 unmanaged target path。
- Global settings 默认永不被覆盖。

## 失败语义

- fact 的 `providers` 排除某个 target 时，该 target 为 `not-applicable`。这是预期覆盖，不是漂移，也不影响退出码。
- 已配置且应承载 fact 的 target 出现 `unsupported` 是错误。诊断指出 source fact、target 和 adapter limitation。
- `normalize` 在任何写入前验证所有已配置 target。一个 target 验证失败时，不写入任何 target。
- 验证后的写入或 I/O 失败会停止运行，报告 backups 和所有部分写入，并以非零退出。重跑是幂等的。
- 对于任何漂移、冲突、scope 不匹配或未声明的 unsupported fact，`detect` 以非零退出。
- `--dry-run` 使用与真实运行相同的预检和退出码，但不写入。
- v0.1 没有 partial-target 模式。Target 在 manifest 中包含或省略。

## 漂移检测

漂移类别：

- Source to artifact：target 缺失、symlink 断裂或错误、generated 文件过期、copy 过期。
- Source to overlay：未知 fact ID、重定义 common field、无效 provider option。
- Target to target：已配置 target 缺失、没有声明 provider restriction 的 unsupported，或与同一 source fact 不一致。

`dab detect` 报告 per-target 状态：

```text
agent reviewer: claude=native, codex=native, dsh=mapped
skill doc-sync: claude=native, codex=native, dsh=native
rule testing: claude=native, codex=not-applicable
rule release: claude=native, codex=unsupported (error)
```

- 除非 fact 的 `providers` 列表排除该 target，否则 unsupported fact 是漂移。
- Unmanaged target paths 是作为漂移报告的冲突。

## Global Settings

- `~/.claude/settings.json` 是用户所有的 global settings。
- DAB 默认不得替换它；global target settings 使用显式 adoption 或 merge，并备份。
- Codex 和 DSH 的 global settings 遵循同一规则。
- Unmanaged global 的 instructions、agents、skills 和 rules 遵循上面的 target ownership 规则。
- `dab init` 不创建也不修改 global settings；global settings 需要显式 adoption 或 merge。
- Instructions、agents、skills 和 rules 仍可通过投影文件在 global scope 对齐。

## 迁移

- 现有项目 `.agents` 和 `.claude` 输出继续被支持。
- Claude 专属字段会被盘点；非 common 字段移到 `.agents/adapters/claude-code.yaml`。
- `.claude/CLAUDE.md` instruction artifact 默认 symlink 到 scope 的 `AGENTS.md`。如果 target 无法读取该 symlink，DAB 保留 generated import shim 并记录 fallback 原因。
- `dab.yaml` 增加 `scope` 和 `targets`，并提供版本化迁移。v1 manifest 按 project scope 迁移。
- 现有 managed projections 保留 ownership records。Unmanaged target paths 在通过 `normalize --fix` 采用前都是冲突。

## 测试与验收

- 单元测试：capability matrix、artifact selection、symlink preference、overlay validation、scope resolution、manifest scope validation。
- 集成测试：project 和临时 HOME 的 global fixtures、multi-target alignment、`dab init ~/.agents`、不写真实 home。
- 安全测试：project 命令绝不写到 repository 外；global-only target 在 project scope 为 unsupported；unmanaged global 投影文件需要 `--fix` 和 backup；一个 target 失败会阻止所有写入。
- 漂移测试：broken symlink、generated drift、copy drift、unknown overlay ID、undeclared unsupported target、declared not-applicable fact、unmanaged conflict。
- Instruction 测试：Claude Code symlink artifact 和 generated shim fallback。
- 验收：同一 source 为每个 target 生成正确 symlink 或 generated artifacts；symlink 可用时不 copy；没有 adapter-owned facts；所有 docs gates 通过。

## Rollout

1. Scope resolution、manifest v2、ownership 和 failure semantics。
2. Claude adapter：native-first、symlink-first、instruction artifact、source 字段盘点。
3. Codex adapter：原生 subagents 和 skills，mapped settings。
4. DSH adapter：原生 subagents 和 skills，mapped profile 和 settings。
5. Global settings adoption 和 merge。
6. Alignment 之后的 Evidence 和 memory 阶段。

## Open Implementation Questions

- Codex 和 DSH 在 subagents、skills、rules 和 hooks 上的确切格式与版本。
- Codex 和 DSH 的哪些配置面是 project-local，哪些是 user-global。
- 每个 target 是否跟随 symlink 的 agent 和 skill 目录。
- 第二个 adapter 的选择：推荐先 Codex，因为其配置面更小。
- 每个 target 的 global settings merge UX。
