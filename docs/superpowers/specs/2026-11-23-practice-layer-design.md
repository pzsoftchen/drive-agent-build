# DAB Practice Layer 设计

## 状态

已批准；实现计划：[2026-11-23-practice-layer.md](../plans/2026-11-23-practice-layer.md)。本文档不包含实现代码。

## 背景

DAB v0.1.1 实现的是 DAD 的配置治理层：把 `AGENTS.md` 和 `.agents/` 编译为 `.claude/`，并提供 `init`、`detect`、`normalize` 和 `policy explain`。它证明了 authored source、projection、drift detection、decision record 和 shared memory 的价值，但还没有把“优秀 agent 项目如何工作”的实践本身作为一等公民。

用户在存量项目上执行 `normalize` 时，发现它不会像 deepseek-harness 那样在 `docs/` 下建立 `AGENTS.md` 和 `architecture.md`。这不是 `normalize` 的回归：`init` 的 `templateFiles()` 和 `normalize` 的 `minimalSourcePlan()` 都没有 docs 模板，二者共享渲染函数但没有共享规划器。deepseek-harness 的对应文件也不是 DAB 生成的，而是该项目自身长期演进的文档规范。

DAB 的产品方向应超出“agent 配置编译器”：凡是有利于 Drive Agent Development 或 Drive Agent as a Builder 的可复用实践，都应能被 DAB 表达、生成、检查和传承。deepseek-harness 是这类实践的优秀样本，但应借鉴其机制，而不是复制其领域内容。

## 目标

- 引入 Practice Layer：用 profile 选择实践包，用统一的 authored scaffold planner 生成缺失文件，用 `detect` 检查，用 skill/rule 引导。
- 首个实践包是 documentation pack：在 project scope 生成单语的 `docs/AGENTS.md` 和 `docs/architecture.md`；语言由项目配置或检测决定，不默认生成双语。
- 第二个 v1 实践包是 authoring pack：安装 `dab-*` skills，让项目里的 agent 按证据填写 docs 骨架和决策记录，而不是由 DAB 自动编造内容。
- `init` 和 `normalize` 共享同一个 planner；`init` 使用 full 模式，`normalize` 使用 adoption/converge 模式。
- `normalize` 在 uninitialized、partial 和 initialized 的 project scope 上都能补齐缺失的 practice artifacts（docs 和 authoring skills）。
- 新增默认 profile `generic`；`feature` 保留为兼容别名，有效行为等同 `generic`。
- 只写缺失文件，绝不覆盖已有 authored 文件；支持 dry-run；任何 blocking practice 冲突阻止全部写入，policy skip 只跳过对应产物。

## 非目标

- 不复制 deepseek-harness 的领域文档（Cordis、API gateway 等）、CI 编排、review ownership 或具体字数。
- 不自动编造 `docs/architecture.md` 的架构内容；只生成带 TODO 的骨架和扫描事实。
- 不新增命令，不改变 `.claude/` 的 ownership、manifest 或 projection 语义。
- v1 不实现 delivery skills pack、Agent Notes 完整生命周期管理（proposed/rejected/archived 的 scaffold 与检查）或 docs budgets；authoring pack 只提供写作方法与 skill。
- 不自动调用 LLM 填写内容；`normalize` 不执行 agent。v1 不实现 docs/architecture 的 `--ai` 提议；未来如果实现，也只能生成草稿，不能成为权威。
- 不自动更新已安装的 `dab-*` skill；v1 只写缺失文件，并报告版本落后。
- 不生成 global scope 的 `docs/` 或 authoring skills；`$HOME/docs` 和全局 `dab-*` skill 不属于 DAB 的项目实践范围。
- 不默认生成双语文档或翻译；bilingual 是后续可选 pack，不进入 generic profile。
- 不通过 `--fix` 覆盖或备份 authored docs/skills。

## 概念模型

### Profile

Profile 是用户可见的“项目/工作方式”打包，不是 docs/delivery 这样的实践维度。它决定启用哪些实践包；角色模板是后续 profile 能力，v1 不实现。实践包本身是内部组合单元。

v1 只支持两个值：

| profile | 含义 | 有效行为 |
|---|---|---|
| `generic` | 默认的通用 profile，适用于没有专门模板的项目 | `core` + `documentation` + `authoring`（project scope） |
| `feature` | v0.1 的旧 profile 名称，保留为兼容别名 | 等同 `generic` |

新 manifest 默认写 `profile: generic`。显式 `--profile feature` 仍写入 `feature`，用于兼容旧工作流。未知 profile 必须 fail loud，不能静默回退。

### Practice pack

Practice pack 是内部单元，包含：

- `targets(context)`：声明本 pack 的候选文件和目录路径（不含内容）；这是静态候选声明，context.anchors 为空，存在性由 planner 统一 stat 后过滤。
- `files(context)`：缺失时生成的模板；context 的 anchors 包含已存在路径和本 plan 的 targets。
- `directories`：缺失时创建的目录；它不抑制已存在目录的子文件。需要“用户已有 skill 目录优先”的 pack 用 `skipChildrenWhenExists` 声明。
- `checks(context)`：`detect` 使用的检查。
- `guidance`：声明随包分发的 skill 或 rule；skill 内容通过 `files()` 进入同一份 plan，报告时按 `.agents/skills/dab-*` 路径归类为 `practices.skills`。v1 的 authoring pack 通过它分发 `dab-*` skills，documentation pack 仍只提供文件和检查。

`PracticeContext` 至少包含 `{ root, scope, scan, profile, mode, anchors, version, manifest?, docsLanguage?, proposals? }`；root 是 scope 根目录，manifest 是现有 authored manifest（如有），docsLanguage 是解析后的 `{ value, source }`，version 只用于生成 `dab-skill` 标记。

规划器签名改为 `planAuthoredScaffold(input)`：

```ts
interface AuthoredScaffoldInput {
  root: string;
  scope: 'project' | 'global';
  scan: ScanResult;
  profile: 'generic' | 'feature';
  mode: 'full' | 'adoption' | 'converge';
  manifest?: ProjectManifest;
  proposals?: { agentsMdAddition?: string; agents?: AiProposalAgent[] };
}
```

两阶段解析解决 anchors 循环：planner 先调用 `targets()` 收集候选路径，再 stat 现有路径，anchors = 现有路径 ∪ targets，最后调用 `files()` 生成内容。`docsLanguage` 只从现有内容检测，不把同一次 plan 新建的 root `AGENTS.md` 当作语言信号。未知 profile 在 manifest/CLI 校验阶段 fail loud，不进入 planner。

v1 的组成：

- `core`：基线，不是实践包；提供现有的 AGENTS.md、dab.yaml、policies、adapters、memory、notes 目录、rules、hooks、agents/skills（full 模式）。
- `documentation`：第一个实践包，提供单语的 `docs/AGENTS.md` 和 `docs/architecture.md`。
- `authoring`：第二个实践包，提供 `dab-doc-writing`、`dab-architecture-writing`、`dab-decision-notes` 三个 skill，指导 agent 用证据填充文档和决策记录。
- 后续 pack：`delivery`（code review、pre-push、PR description、simplification）、`notes`（proposed/rejected 生命周期与归档检查）等。

本设计的 `skills` 特指 authoring pack 的 `.agents/skills/dab-*`；core 的 `feature-delivery`/`doc-sync` 和从 `.claude/skills` 导入的条目不在 `practices.skills` 中。

### 三种交付方式

- **Scaffold**：`init` / `normalize` 只创建缺失的 practice artifacts（docs 和 authoring skills）。
- **Check**：`detect` 报告缺失、链接、路径冲突、TODO 和 authoring skill 状态。
- **Guide**：authoring skills 指导 agent 如何用代码、测试和命令证据维护这些实践；DAB 不替 agent 执行内容生成。

## 共享 authored scaffold planner

新增内部规划器 `planAuthoredScaffold(input)`，作为 `init` 和 `normalize` 的唯一 authored 文件规划入口。`input` 携带 root、scope、scan、resolved profile、mode、现有 manifest 和 `init --ai` proposals；规划器负责 stat、语言检测、anchors 和 pack 调用。

### 模式

| mode | 调用方 | 内容 |
|---|---|---|
| `full` | `init` | core full skeleton + documentation pack + authoring pack |
| `adoption` | `normalize`（uninitialized/partial） | core minimal skeleton + documentation pack + authoring pack |
| `converge` | `normalize`（initialized） | documentation pack + authoring pack 的缺失文件 |

`full` 保持现有 `init` 的 agents/skills/rules/hooks 模板，唯一移除的是 `.agents/rules/docs-bilingual.md`；`init --ai` 的 `agentsMdAddition` 和 proposed agents 通过 `proposals` 输入 core 渲染。`adoption` 不创建 core 的默认 agents/skills（feature-delivery、implementer 等），但会安装 namespaced 的 `dab-*` authoring skills，这是对“minimal adoption 不建默认 skills”的有意例外；`converge` 不补 core 文件，只补 docs 和缺失的 authoring skills，避免 `normalize` 变成第二次 `init`。

### 输出

```ts
interface AuthoredScaffoldPlan {
  profile: 'generic' | 'feature';
  mode: 'full' | 'adoption' | 'converge';
  files: Record<string, string>;       // 仅缺失的 authored 文件（core/docs/skills）
  directories: string[];               // 仅缺失目录（plan-wide，含 core）
  skipped: string[];                   // 已存在、被保留的路径
  policySkipped: string[];             // 因项目规则刻意不创建的路径（bilingual policy）
  diagnostics: Diagnostic[];           // 路径冲突、逃逸
  manifest?: ProjectManifest;          // full/adoption 需要的模板 manifest
  docsLanguage: { value: 'en' | 'zh'; source: string };
}
```

规划规则：

- 目标路径已存在：加入 `skipped`，不修改、不覆盖、不备份；语言检测可只读标题/首段用于选择新文件语言，这是唯一读取例外。
- 目标路径类型不符（例如 `docs/AGENTS.md` 是目录）：error，整个 plan 阻塞。
- 目标路径的父级是逃逸 root 的 symlink：error，整个 plan 阻塞。
- documentation 和 authoring 只适用于 project scope；global scope 的两个 pack 都为空。
- `converge` 不生成 manifest，也不补 core 文件。
- 规划只读；dry-run 与真实写入使用同一份 plan。
- anchors 是现有路径加上 `targets()` 声明、且不会被 policy skip 的路径；模板据此决定可选链接，不链接不存在且不会创建的路径。

### 与现有代码的关系

现有 `templateFiles()` 和 `minimalSourcePlan()` 改为调用 planner，或由 planner 取代；`renderAgentsMd`、`renderDabYaml` 等渲染函数继续复用。`planSourceWrites()` 继续负责实际写入，但输入来自 planner。

`init` 的 authored 冲突检查、`normalize` 的 adoption preflight、`detect` 的 preflight 都读取同一份 pack 定义，避免“生成一套、检查另一套”。

## Documentation Pack v1

### 范围

Documentation pack 只在 project scope 生效。global scope 的 `$HOME` 不是项目文档根，DAB 不生成 `$HOME/docs/`。

### 文件

| 文件 | 作用 |
|---|---|
| `docs/AGENTS.md` | 文档分层、放置规则、写作规则、slop checklist、验证方式 |
| `docs/architecture.md` | 从扫描事实生成的架构骨架 |

两个文件使用解析后的单一语言生成；不生成 `.zh.md`、`.i18n.yaml` 或任何配对文件。

documentation pack 只提供文件和检查；`dab-doc-writing`、`dab-architecture-writing` 和 `dab-decision-notes` 由 authoring pack 提供。这样 docs 骨架和写作方法分开，`normalize` 可以只补缺失项。

v1 的 documentation pack 依赖 authoring pack：`docs/AGENTS.md` 会引用 `dab-doc-writing` 和 `dab-architecture-writing`。未来若允许单独启用 documentation pack，模板必须按 available packs 裁剪这些引用，不能指向未安装的 skill。

新生成的 project root `AGENTS.md` 由 core 拥有；planner 根据 docs pack 是否启用和 anchors，把 Documentation 段作为 `renderAgentsMd` 的参数传入，documentation pack 不直接写 `AGENTS.md`。段内链接只在对应 docs 文件存在或本次创建时出现；docs pack 被 policy skip 或没有 docs 目标时不生成该段；已有 `AGENTS.md` 不修改；global scope 不生成该段。

### `docs/AGENTS.md` 模板

模板是通用的文档标准，不包含 deepseek-harness 的领域内容。必须包含：

- 文档层级：root `AGENTS.md`、`docs/AGENTS.md`、`docs/architecture.md`、`.agents/notes/`、cookbook/postmortem 等按项目需要扩展。
- 放置规则：一个事实只有一个 home；上层文档链接下层 owner，不复制细节。
- 写作规则：描述当前状态；一段一行；使用相对链接；代码块、表格、列表保持结构。
- slop checklist：重复规则、历史叙述、实现状态标注、手抄目录、推理过程、段落墙、强调膨胀。
- 验证：`dab detect` 检查缺失、链接和 TODO；项目的 doc-sync 命令由项目自己提供。
- 引用 `dab-doc-writing` 和 `dab-architecture-writing`：文档规范和 architecture 骨架的 TODO 由这两个 skill 指导填写。
- 项目特定部分用 `TODO:` 标记，由使用者补齐。

模板只链接存在或同一次计划中会创建的文件：`architecture.md` 在存在或本次计划中创建时链接（`docs/architecture.md` 缺失且未生成时省略）；`../AGENTS.md` 仅在 anchor 中存在或本次创建时写入链接；`.agents/notes/` 只用行内代码提及，不对目录生成 Markdown 链接。`converge` 在缺少 `../AGENTS.md` 时省略该链接，不创建 core 文件，也不生成会立刻被 `detect` 判为错误的文档。不得链接不存在的示例文件。

### `docs/architecture.md` 模板

模板是“作者文档的起点”，不是自动维护的架构真相。生成时只写入扫描可确认的事实：

- 项目名、编程语言、包管理器。
- 源码目录。
- test/build/lint/typecheck 命令；缺失时单独一行写 `TODO: add a <command> command`，保证行首匹配。
- 顶层布局说明（按 `sourceDirs` 列出），放在 `## Project facts`；`## Composition` 只写组件关系和运行时结构，留 TODO。

固定章节：

```text
# Architecture

## Project facts
## System purpose
## Composition
## Runtime flow
## Module boundaries
## Extension points
## Invariants
## Verification
```

除 Project facts 和 Verification 的扫描事实外，其余章节写 `TODO:` 占位，不编造组件、调用链或边界。文件头包含一行说明：DAB 只创建这个骨架，之后它是 authored 文档，DAB 不会覆盖。

### 文档语言

Documentation pack 生成单一语言，不生成配对文件。项目语言通过 manifest 的 `docs.language` 控制：

```yaml
docs:
  language: auto   # auto | en | zh
```

- `auto` 的解析顺序：现有 `docs/AGENTS.md` → 现有 `docs/architecture.md` → root `AGENTS.md` → `README.md` → `package.json` description → locale（`LC_ALL` 优先于 `LANG`，只有 `zh*` 是中文信号）→ 默认 `en`。两份 docs 都存在时以 `docs/AGENTS.md` 为准；显式 `docs.language: en|zh` 直接采用，跳过检测。
- 识别方式：读取候选文本的标题/首段，跳过代码块；CJK 字符占非空白字符 ≥20% 且至少 8 个 CJK 字符判为 `zh`，否则 `en`。`source` 记录 `config`、`docs/AGENTS.md`、`docs/architecture.md`、`AGENTS.md`、`README.md`、`package.json`、`locale` 或 `default`。
- 检测结果是启发式，必须在 `init`/`normalize` 的人类输出和 JSON 中报告 `{ value, source }`；dry-run 可见，不能静默。
- locale 只有以 `zh` 开头才作为 `zh` 信号；其他 locale（包括 `C`/`POSIX`）视为无信号，最终落到 `default: en`。同一次 plan 新建的 root `AGENTS.md` 不作为语言信号，只读现有内容。
- 如果 `auto` 没有任何语言信号，使用 `en` 并报告 `source: default`；这不是静默回退，因为输出记录了来源。
- 显式 `docs.language` 未知值 fail loud；v1 支持 `auto`、`en`、`zh`。
- 现有 `docs/AGENTS.md` 或 `docs/architecture.md` 存在时，不生成/覆盖；语言只影响缺失文件的生成。
- 如果项目已有 `.agents/rules/docs-bilingual.md`，generic documentation pack 不生成单语 docs（避免违反项目规则）；`init`/`normalize` skip 并报告 `practice.docs-bilingual-policy`，next 为删除该规则（bilingual pack 尚未提供）。已有规则不删除。
- 语言检测只使用项目内容和 locale；DAB 不知道 agent 会话语言，不能把它当作信号。
- DAB 仓库自身保留双语规则；`docs/AGENTS.md` 作为 AGENTS 文件继续豁免 pairing，`isPairingCandidate` 不变。

### 已有文档

- 任一目标文件已存在：skip，不修改、不覆盖；语言检测可只读其标题/首段用于选择新文件语言；需要重新生成时删除该文件再运行 `normalize`（有 bilingual 规则时不会重新生成，需先删除该规则）。
- 任一目标文件缺失：按解析语言生成单语模板。
- 目标路径类型不符、读取失败或父级逃逸：error，零写入。
- 不生成翻译；需要双语的项目使用后续可选的 bilingual pack。

## Authoring Pack v1

Authoring pack 把 deepseek-harness 的“写作方法”提炼成 skill，而不是复制它的领域内容。skill 只描述流程、证据要求和质量标准；项目的事实仍由项目里的 agent 读取代码、测试和命令后填写。

### Skills

| skill | 用途 | 关键内容 |
|---|---|---|
| `dab-doc-writing` | 编写、重构、审查项目文档 | 先读 `docs/AGENTS.md` 并执行其放置/写作规则；提供 fact-check、审计/审查流程和验证方法；按 `docs.language` 使用单一语言，不生成翻译 |
| `dab-architecture-writing` | 用证据填写 `docs/architecture.md` | 盘点顶层布局、组件、入口、运行时流程、扩展点和不变量；每条结论指向代码/测试/命令；无法验证的内容保留 `TODO(owner): question` |
| `dab-decision-notes` | 编写和维护 Agent Note | 何时写、proposed/implemented/rejected、alternatives/consequences/verification、supersession；v1 不生成完整归档流程 |

三个 skill 都必须遵守：

- 先读 root `AGENTS.md` 和项目规则；`docs/AGENTS.md` 存在时它是文档权威，不存在时（例如 bilingual policy skip）以 root `AGENTS.md` 和项目规则为准。项目规则优先于 skill。
- 每条操作、命令、默认值或行为声明必须有代码、测试、配置或实际执行的证据；不能验证时写 `TODO(owner): question`，不能猜。
- 描述当前状态；一个事实只有一个 home；上层文档链接下层 owner，不复制实现细节。
- 引用项目实际命令（从 `AGENTS.md` 或 `package.json` 读取），不硬编码 `pnpm`、`npm` 或测试框架。
- 使用 `docs.language` 指定的单一语言，运行 `dab detect`，修复链接、TODO 和结构问题；语义正确性仍由 review 或人确认。

`docs/AGENTS.md` 存在时是项目文档标准的权威；不存在时以 root `AGENTS.md` 和项目规则为准。`dab-doc-writing` 只拥有通用工作流、fact-check 和审计方法，必须先读当前权威文件并服从，不复制项目特定规则。模板中的 slop checklist 是项目可编辑的种子，skill 引用它而不另建一套。

### 安装与所有权

- skill 写入 `.agents/skills/dab-<name>/SKILL.md`，由现有 projection 生成 `.claude/skills/dab-<name>`。
- `init` 和 `normalize` 只写缺失的 skill；同名 skill 目录已存在时 skip 并报告为 preserved（仅限 schema-valid 目录；invalid `SKILL.md` 仍按现有 discovery 报 error）；同名路径是普通文件或指向文件的 symlink 时是路径类型不符，error；不覆盖、不合并。
- skill 必须通过现有 `SkillFrontmatterSchema` 校验；`dab-skill` 版本标记放在 body，不使用未知 frontmatter 字段，避免 unknown-field warning。
- `dab-` 前缀用于避免与项目已有 skills 和导入的 `.claude/skills` 冲突。若 `.agents/skills/dab-<name>` 已存在，DAB skip 自己的模板；若只有 `.claude/skills/dab-<name>` 存在，`normalize` 按现有 import 规则导入该事实并 skip 模板，`init` 保持 `suppressImports`、不导入，只 skip 模板并报告 pending conflict；两者都存在时按现有 import 规则处理。路径类型不符、无法导入的 symlink/物理冲突或 skill 校验失败是 error，阻止写入。
- skill body 包含 `<!-- dab-skill: <name>@<version> -->` 标记；`detect` 在版本落后时给出 warning，但 v1 不自动更新。
- `normalize --dry-run` 展示 skill 计划；JSON 的 `practices.skills` 列出 created/skipped。
- global scope 不安装 authoring skills。

### 与 TODO 的关系

DAB 不会在 `normalize` 里调用 LLM 或执行 skill。流程是：

1. `init`/`normalize` 生成 docs 骨架和 authoring skills。
2. `detect` 发现 TODO/空章节时给出 `use dab-architecture-writing` / `use dab-doc-writing`；发现缺失 skill 时给出 `dab normalize`。TODO 检测只匹配行首的 `TODO:` 或 `TODO(owner):`，忽略 fenced code block 和行内代码，避免把模板里的说明文字当成待办。
3. 项目里的 agent 按 skill 读代码、跑命令、填内容。
4. `detect` 再次检查结构、链接和 TODO 残留；语义正确性由 review 或人确认。

## 命令行为

### `dab init`

- 默认 `profile: generic`；`--profile generic|feature` 均接受，显式 `feature` 保留在 manifest 中。已存在的 authored manifest 优先，`--profile` 不覆盖它，只影响新建 manifest。
- `full` 模式生成 core full skeleton + documentation pack + authoring pack；generic full 不再生成 `.agents/rules/docs-bilingual.md`。
- `--dry-run` 展示 docs 和 skill 计划；JSON 顶层增加 `language: { value, source }`，`created`/`skipped` 包含这些路径。global scope 也报告 language，但不生成 docs/authoring。
- 已存在的文档和 skill 跳过；冲突按现有 init 规则 fail loud。
- global scope 不生成 docs 或 authoring skills。

### `dab normalize`

- uninitialized/partial：`adoption` 模式，minimal core + documentation pack + authoring pack + Claude imports；有 bilingual 规则时 docs 按 policy skip；保持现有 all-or-nothing 和零写入 gate。
- initialized：`converge` 模式，无 bilingual 规则时补缺失的单语 documentation，有规则时 skip docs，始终补缺失的 authoring skills；在 target planning 之前完成 preflight 和写入。
- preflight 阶段的任何 blocking practice 冲突（包括 skill 路径类型/逃逸）阻止所有写入，包括 `.claude` target 写入；`--fix` 不处理 authored practice 冲突。
- practice 写入发生在 target planning 之前；若 practice 写入完成后 target plan 出现未预期失败，停止且不写 `.claude`，保留已写入的幂等 docs/skills，重跑安全；这与现有 adoption 的 apply 语义一致。
- 已有文档和 skill 永不覆盖；normalize 输出列出 docs 和 skills 的 `create`/`skip`。
- 已有 `.agents/rules/docs-bilingual.md` 且 docs 缺失时，documentation pack skip，不生成不符合规则的单语 docs；报告 policy warning，authoring skills 仍按缺失规则安装。
- dry-run 展示 practice plan；uninitialized/partial 不展示 target plan（target plan 需要已写入的 source，现有行为）。真实运行在 source 写入后才规划和执行 target plan。
- `feature` 别名的存量项目在下次 normalize 时：无 bilingual 规则时补缺失单语 docs，有规则时 skip docs，始终补缺失 authoring skills；这是有意的行为变化，需在 CHANGELOG 和 dry-run 输出中明确。
- global scope 不执行 documentation pack 或 authoring pack。

### `dab detect`

新增 `Documentation` checklist group，位置在 Instructions 之后、Agents 之前。检查项：

| 检查 | 状态 | next |
|---|---|---|
| `docs/AGENTS.md` 缺失（无 bilingual 规则） | `missing` | `dab normalize` |
| `docs/architecture.md` 缺失（无 bilingual 规则） | `missing` | `dab normalize` |
| 项目有 `.agents/rules/docs-bilingual.md` 且 docs 缺失 | `warn` | 删除规则；bilingual pack 尚未提供；不再产生上面的 `missing -> dab normalize` |
| 文档内部链接损坏 | `error` | 修复链接 |
| `docs/architecture.md` 有 `TODO:`/`TODO(owner):` 或空章节 | `warn` | `use dab-architecture-writing` |
| `docs/AGENTS.md` 有 `TODO:`/`TODO(owner):` | `warn` | `use dab-doc-writing` |
| practice 路径类型/逃逸冲突 | `error` | 手工解决 |

Authoring 相关检查放在现有 Skills group：

| 检查 | 状态 | next |
|---|---|---|
| `dab-doc-writing`、`dab-architecture-writing`、`dab-decision-notes` 缺失 | `missing` | `dab normalize` |
| skill 的 `dab-skill` 版本标记落后 | `warn` | 手工审阅并合并；v1 不自动更新 |
| `dab-*` skill 缺少版本标记（用户或 import 所有） | `warn` | 无（保留；DAB 不接管） |
| skill 路径是普通文件/指向文件的 symlink，或存在无法导入的 symlink/物理冲突 | `error` | 手工解决 |

- 链接检查只覆盖 documentation pack 的两个文件（`docs/AGENTS.md`、`docs/architecture.md`），不扫描项目其他 Markdown；全仓 doc gate 属于后续文档/verification 能力。
- schema-valid 的普通同名 `dab-*` skill 目录已存在时 skip，不作为 error，也不产生 next；缺少版本标记同样是 preserved/no-next；invalid `SKILL.md` 仍按现有 discovery 报 error；同名路径是普通文件/指向文件的 symlink，或存在无法导入的 symlink/物理冲突时才是 error。
- 有 bilingual 规则时，缺失 docs 只保留 policy warning，不产生 `missing -> dab normalize`；同一文件不会出现两个 next。
- bilingual policy skip 不是 blocking conflict：它只跳过 documentation pack，不阻止 authoring skills 或 `.claude` target 写入。
- TODO 检查只扫描 pack 负责的 docs 路径（`docs/AGENTS.md`、`docs/architecture.md`，无论内容由 DAB 生成还是用户改写），只匹配行首 `TODO:`/`TODO(owner):` 并忽略代码块和行内代码；TODO 是内容待办，不是结构错误，默认 warning。
- Documentation 组显示解析后的语言和来源，例如 `Language: zh (source: AGENTS.md)`；JSON 的 `checklist[].detail` 以同样字符串携带，不新增结构化字段。`auto` 检测结果不改变退出码。
- 空章节指 architecture 的固定章节（除 Project facts 和 Verification）只有标题、没有正文；忽略空白和 HTML 注释。检测范围只限 pack 负责的 docs 路径。
- `next` 可以是 skill 调用提示（例如 `use dab-architecture-writing`），不要求是 CLI 命令。
- 每个 checklist 的 `warn`/`error` 行都有对应 diagnostic；命令层按文件去重，checklist 与 exit code 都从同一 diagnostic 集合派生：

| code | severity | checklist | strict |
|---|---|---|---|
| `practice.docs-missing` | warning | `missing` | 失败 |
| `practice.skill-missing` | warning | `missing` | 失败 |
| `practice.docs-todo` | warning | `warn` | 失败 |
| `practice.docs-empty` | warning | `warn` | 失败 |
| `practice.skill-stale` | warning | `warn` | 失败 |
| `practice.skill-unversioned` | warning | `warn` | 不失败（信息性） |
| `practice.docs-bilingual-policy` | warning | `warn` | 不失败（项目政策） |
| `practice.docs-link` | error | `error` | 默认 error |
| `practice.docs-path` / `practice.skill-path` | error | `error` | blocking，禁止写入 |
| 既有 skill discovery 的 invalid frontmatter | error | `error` | 沿用现有行为 |

- initialized 的默认退出码不变；`--strict` 对 docs/skills 缺失、TODO、空章节和落后 skill 返回 3；policy skip 和 unversioned 不触发 strict。uninitialized/partial 保持 exit 2。
- Documentation 组在 project scope 的 uninitialized、partial 和 initialized 都显示；uninitialized 或没有有效 manifest 的 partial 使用默认 `generic` + `auto`；有有效 manifest 的 partial 使用 manifest 的 profile 和 `docs.language`。Authoring skill 条目同样在所有 project phase 显示。
- manifest 无效时，Documentation/Authoring 条目仍显示缺失/错误，但不提供 `dab normalize` next action；这是只读展示，不构成 init/normalize 的 generic 回退。
- global scope 不显示 Documentation 组或 authoring skill 条目。
- JSON 的 `checklist` 增加 `Documentation` 条目和 authoring 的 `Skills` 条目；`score` 自动包含这些条目；`schemaVersion` 仍为 1。

## JSON 契约

### `detect --json`

- 保留现有全部字段。
- `checklist` 条目增加 `group: "Documentation"`。
- `checklist[].detail` 仍是字符串；语言以 `Language: <value> (source: <source>)` 的形式出现在 detail，不新增结构化字段。
- 不新增顶层字段；`profile` 仍显示 manifest 中的原始值（`generic` 或 `feature`）。
- `schemaVersion` 保持 1；新增 group 和条目属于 additive change。

### `normalize --json`

- 保留 `targets`、`actions`、`backups`、`settings`、`shimAction`、`gitignore`、`manifestUpdated`、`adoption`；`instructions` 位于 `targets[]` 内，不是顶层字段。
- 新增顶层 `practices`（global scope 没有 practice pack，省略该字段）：

```json
{
  "practices": {
    "profile": "generic",
    "mode": "converge",
    "language": { "value": "zh", "source": "AGENTS.md" },
    "created": ["docs/AGENTS.md", "docs/architecture.md"],
    "skipped": [],
    "policySkipped": [],
    "directories": ["docs", ".agents/skills/dab-architecture-writing"],
    "skills": {
      "created": [".agents/skills/dab-architecture-writing/SKILL.md"],
      "skipped": []
    },
    "diagnostics": []
  }
}
```

- dry-run 中 `created`、`directories` 和 `skills.created` 表示计划创建，不是已写入。
- `practices.profile` 是 manifest 的原始值（`generic` 或 `feature`）；`feature` 的有效行为仍解析为 `generic`。
- `practices.language` 是解析后的 `{ value, source }`；`source` 使用上方枚举值（例如 `AGENTS.md`，不是 `detected:AGENTS.md`）。manifest 中的 `docs.language` 保持原始值（通常是 `auto`）。
- `practices.created`/`skipped` 只描述 docs；`practices.skipped` 只包含已存在、被保留的路径；`practices.policySkipped` 只包含因 bilingual 规则刻意不创建的 docs。`practices.skills` 单独描述 practice planner 写入或跳过的 authoring skills。由 import 产生的 `.agents/skills/dab-*` 出现在 `adoption.imports`，不重复计入 `practices.skills`。
- `practices.directories` 只包含 practice-owned 目录（`docs/`、`.agents/skills/dab-*`），不包含 core 的目录；plan-wide directories 仍在内部 plan 中。
- uninitialized/partial（adoption 模式）由 practice planner 写入的 docs 和 authoring skills 同时出现在 `adoption.sourceActions` 和 `practices.created`/`practices.skills`；dry-run 中两处都是计划动作。converge 模式没有 `adoption.sourceActions`，practice 写入只出现在 `practices`；import 产生的 skill 不在此列。
- project scope 的 blocked/零写入运行仍输出 `practices` 的 planned created/skipped/policySkipped/skills/directories 和 diagnostics；`created` 不代表已写入。global scope 始终省略 `practices`。
- bilingual policy skip 的 docs 进入 `practices.policySkipped`，诊断包含 `practice.docs-bilingual-policy`，不产生 docs `created`。
- `schemaVersion` 仍为 1；这是 additive change。

## 失败与安全

- 本设计的 all-or-nothing 指 preflight 发现任何 error 时不写任何文件；写入阶段的 I/O 或后续 target 失败不是事务回滚，保留已写入的幂等 docs/skills，重跑安全。
- 不覆盖、不删除、不备份 authored docs/skills；备份只在现有 `.claude` replacement 和 `--fix` 路径使用。
- authoring skill 只写缺失；schema-valid 的同名 skill 目录已存在时 skip 并报告为 preserved；同名路径是普通文件或指向文件的 symlink 时是路径类型不符，error；skill 版本落后只警告，不自动更新。
- preflight 阶段的 blocking practice 冲突（路径类型、symlink 逃逸、无法导入的 skill 冲突）是 error，阻止本次所有写入；未知 profile 在更早的 manifest/CLI 校验阶段 fail loud。
- bilingual 规则导致的 documentation skip 是 policy skip，不是 blocking conflict；它只跳过 docs，不阻止 skills 或 target 写入。
- `.claude` 和 `.agents` 的 containment、disjoint 检查继续适用于 practice 路径的父级。
- `normalize` 不调用 LLM、不执行 agent、不自动填 TODO；内容生成只能由项目里的 agent 按 skill 执行。
- 规划阶段只读；dry-run 不写任何文件。
- global scope 不生成 docs 或 authoring skills，避免污染 `$HOME`。
- 未知 profile、非法 manifest 在 init/normalize 继续 fail loud，不静默回退到 generic；detect 的 generic preflight 只用于只读展示。

## 兼容性与迁移

- `ProjectManifestSchema.profile` 从 `z.literal('feature')` 扩展为 `z.enum(['generic', 'feature'])`；legacy v1 manifest 仍按 `feature` 读取。
- `ProjectManifestSchema` 增加可选 `docs: { language: 'auto' | 'en' | 'zh' }`，默认 `auto`；现有 manifest 缺失该字段时按 `auto` 处理，未知语言 fail loud。
- 新 `init`/adoption 默认写 `generic` 和 `docs.language: auto`；已有 `feature` manifest 不被改写。
- `feature` 是兼容别名：有效 profile 解析为 `generic`，获得相同的 practice 行为。README、CLI 文档和 roadmap 必须说明这一点。
- generic full skeleton 不再生成 `.agents/rules/docs-bilingual.md`；已有项目保留该规则，`normalize` 不删除；需要双语的项目显式使用后续 bilingual pack。
- 现有 v0.1.1 项目通常已有 `.agents/rules/docs-bilingual.md`；`normalize` 不会自动为它们生成单语 docs，除非删除该规则（bilingual pack 尚未提供），但会补齐 authoring skills。这是行为变化，必须先 `--dry-run` 审阅并写入 CHANGELOG。
- 已安装的 `dab-*` skill 是 authored 文件；后续 DAB 版本不会自动覆盖。`detect` 用 body 标记报告版本落后，项目自行审阅合并。
- `.claude` 的 projection、manifest generated record、ownership 和退出码语义不变。
- DAB 仓库自身要 dogfood documentation pack 和 authoring pack：实现时人工补单语 `docs/AGENTS.md`（作为 AGENTS 文件豁免 pairing），保留现有 `docs/architecture.md` 及其配对记录，并把三个 `dab-*` skill 安装到自身的 `.agents/skills/`，用它们维护文档；不能依赖自动生成覆盖已有文档。

## 验收

- `init` 在空 project 默认生成 `profile: generic`、`docs.language: auto`、core skeleton、2 个 documentation 文件、3 个 authoring skills，并在新 root `AGENTS.md` 加入 Documentation 段（链接只在 docs 文件存在或本次创建时出现）；`--dry-run` 展示这些文件；已有 docs/skills 不被修改。
- 有 bilingual 规则时，新 root `AGENTS.md` 不生成 Documentation 段；没有 docs 目标时同样不生成。
- `init --profile feature` 保留 `feature` 值，但生成同样的 docs 文件和 skills；已有 authored manifest 不被 `--profile` 覆盖。
- `init`/`normalize` 解析 `docs.language`：显式值优先；`auto` 按既定顺序检测，并在人类输出和 JSON 中报告 `{ value, source }`；没有信号时使用 `en` + `source: default`。
- `normalize` 在 uninitialized/partial project 生成 minimal core + authoring pack；无 bilingual 规则时补缺失的单语 docs，有规则时 skip docs；在 initialized project 同样按规则补/skip docs，始终补缺失 skills；重复执行幂等。
- `feature` 别名的 initialized project 在 normalize 后：无 bilingual 规则时补齐缺失 docs，有规则时 skip docs；两种情况都补齐 authoring skills，profile 字段不变。
- 已存在的 `dab-*` skill 不被覆盖；schema-valid 普通同名 skill 目录 skip 且不报 error；invalid `SKILL.md` 按现有 discovery 报 error；同名路径为普通文件/指向文件的 symlink，或无法导入的 symlink/物理冲突才 error；只有 `.claude/skills/dab-*` 时 `normalize` 按现有 import 规则导入，`init` 保持 suppressImports 并 skip 模板。
- TODO 检测忽略代码块和行内代码；只把行首 `TODO:`/`TODO(owner):` 计为待办。
- 已有 `docs/AGENTS.md` 或 `docs/architecture.md` 时绝不覆盖；只生成缺失的单语文件，不生成 `.zh.md`、`.i18n.yaml` 或翻译。
- 已有 `.agents/rules/docs-bilingual.md` 且 docs 缺失时，init/normalize 不生成单语 docs，detect 给 `practice.docs-bilingual-policy` warning；该 warning 不触发 `--strict`；删除规则后重新运行会生成单语 docs。
- `converge` 在缺少 root `AGENTS.md` 时省略该链接；`docs/architecture.md` 缺失且未生成时省略 architecture 链接；`.agents/notes/` 始终以行内代码提及，生成的 docs 通过自身链接检查。
- `detect` 的 Documentation 链接检查不影响 pack 之外的文件；项目里无关的坏链接不会让该组变成 error。
- global scope 的 init/normalize/detect 不产生 `$HOME/docs`，不安装 authoring skills，也不显示 Documentation 组或 authoring skill 条目。
- practice 路径冲突或 symlink 逃逸时零写入，包括 `.claude` target。
- generic 新项目不再生成 `.agents/rules/docs-bilingual.md`；已有项目的该规则不被删除，且会阻止单语 docs 自动生成，直到用户删除规则（bilingual pack 尚未提供）。
- 未知 `docs.language` 在 init/normalize/manifest 校验中 fail loud。
- `detect` 在 initialized project 显示 Documentation 组；无 bilingual 规则时缺失文件为 `missing`，`--strict` 退出 3；有规则时只给 policy warning；normalize 创建后因 TODO 可能是 `warn`，填充 TODO 后变为 `ok`。
- `detect` 在 uninitialized/partial project 显示 Documentation 组和 authoring skill 条目，并在 manifest 有效时给出 `dab normalize` next action；manifest 无效时抑制 next action。
- `detect` 对 `TODO:`/`TODO(owner):`、空章节和落后版本标记给出 warning；前两类和 stale 触发 `--strict` 退出 3，unversioned 只 warning、不触发 strict；填充后对应条目变为 `ok`。
- `detect` 对 blocking practice 路径类型/逃逸冲突给 `error` 和手工 next action；bilingual policy skip 只给 warning，且不触发 `--strict`。
- `docs.language` 检测覆盖：docs/AGENTS 优先于 architecture、LC_ALL 优先于 LANG、同 plan 新建 AGENTS 不作为信号、threshold 边界、无信号 default en；输出 `{ value, source }` 与 JSON 一致。
- 有 bilingual 规则时，normalize 仍写入 authoring skills 和 `.claude` target（除非另有 blocking conflict），不会因为 docs skip 而整体阻断。
- 未知 profile 在 init/normalize/manifest 校验中 fail loud；detect 的 generic preflight 只用于只读展示。
- `normalize --json` 的 `practices`（含 `language`、`directories`）、`practices.skills` 字段在真实运行和 dry-run 下形状正确；global normalize 始终省略 `practices`；project scope 的 blocked 运行仍保留 planned 字段和 diagnostics；`schemaVersion` 保持 1。
- `normalize` 不调用 LLM、不执行 agent；测试断言它只调用版本 runner，不存在内容生成或 LLM 调用入口。
- authoring skill 包含证据要求、`TODO(owner): question` 规则、项目命令引用和 `dab-skill` 版本标记；fixture 测试检查这些必需章节。
- 基线是 54 个测试文件、489 个测试；断言 `profile: feature` 和旧 `docs-bilingual` 行为的测试需要随新默认值有意更新，更新后全套通过；新增覆盖 profile、language、planner、docs pack、authoring pack、skills、converge、global、冲突、JSON、`init --ai` 和 `--strict`。
- `pnpm typecheck`、`pnpm doc-sync`、`dab detect --strict` 在 DAB 仓库通过。

## 备选方案

- **按 docs/delivery 命名 profile**：拒绝。用户明确 profile 不是实践维度；实践包留在内部。
- **新增 `.agents/practices.yaml`**：推迟。v1 用现有 `profile` 字段承载，等组合需求真实出现再升级。
- **纯 skill 库**：拒绝。无法确定性检查，也无法收敛。
- **AI 生成 architecture 内容**：推迟。v1 只生成骨架；`--ai` 的架构提议属于后续能力。
- **新增 `dab practice` 命令**：拒绝。保持命令面稳定，复用 `init`/`normalize`/`detect`。
- **v1 纳入 docs budgets**：推迟。预算需要项目特定配置；v1 先做存在性、链接、TODO 和 authoring skill 检查。
- **generic 默认双语文档**：拒绝。双语是项目特定政策，会引入配对记录、翻译维护和 orphan 状态；改为后续可选的 bilingual pack。
- **复制 deepseek-harness 的 skills 原文**：拒绝。它的 skill 绑定 DSH 的路径、领域和 gate；DAB 只提炼通用的方法、证据要求和质量标准。
- **normalize 直接调用 LLM 填内容**：拒绝。确定性命令不执行 agent；`--ai` 只能生成草稿，必须由人或 agent 确认。
- **v1 自动更新 `dab-*` skill**：推迟。需要 managed skill/hash ownership；v1 只写缺失并警告落后版本。

## 后续

- 详细的工程纪律差距、优先级和验收要点见 [工程纪律差距登记](2026-11-23-practice-layer-gap-register.md)。
- `delivery` pack：code review、pre-push、PR description、simplification 等 skill。
- `notes` pack：proposed/rejected 生命周期、归档 workflow 和跨 note 检查。
- managed skill 更新机制：版本标记、hash ownership、备份和人工确认流程。
- docs budgets 和更完整的文档检查。
- 可选的 bilingual pack：配对记录、术语/风格、翻译 skill 和配对检查；不进入 generic。
- 更多 profile：按项目/工作方式组合 pack，而不是按实践维度命名。
