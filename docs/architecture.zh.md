[English](architecture.md) | 中文

# 架构

DAB 在产品概念上是驾驶系统，用来驾驶由构建者主导的 Agent 工作。本仓库实现的是它的控制面：把编写的源事实编译为 harness 配置，并让两侧保持可比较。本阶段只有 Claude Code 是已实现的 target。

## 当前实现边界

- 当前 `main` 分支实现的是 DAD 配置治理基础。
- v0.2 只面向单个开发任务的证据。
- DAB 目标循环、任务图、`GoalRun`、`TaskRun` 和跨任务学习模型不属于当前架构。

## 事实源

| 事实 | 编写位置 | 投影 |
|---|---|---|
| 项目指令 | `AGENTS.md` | `.claude/CLAUDE.md` 符号链接或生成垫片 |
| 角色 | `.agents/agents/` | `.claude/agents/` 符号链接 |
| Skills | `.agents/skills/` | `.claude/skills/` 符号链接 |
| Authoring skill 模板 | DAB 包内的 `skills/` | `.agents/skills/dab-*` 下的副本 |
| 规则 | `.agents/rules/` | `.claude/rules/` 符号链接 |
| 共享安全策略 | `.agents/policies/project.yaml` | `.claude/settings.json` |
| Claude Code 策略 | `.agents/adapters/claude-code.yaml` | `.claude/settings.json` |
| Hooks（可选，高级） | `.agents/hooks/` | `.claude/settings.json` |
| 共享记忆（可选，高级） | `.agents/memory/` | 按需读取 |
| 个人记忆 | Claude Code 自动记忆 | 机器本地 |
| 决策 | `.agents/notes/` | 按需读取 |
| 元数据 | `dab.yaml` | 逐 target 的生成记录 |

Global scope 使用同样的结构，编写位置是 `~/.agents/`，target root 是 `$HOME`。Project 和 global scope 相互独立：DAB 从不合并两者，也不提供 `dab global` 命令。

## Scope 与 Roots

| Scope | Source root | Manifest | Target roots |
|---|---|---|---|
| Project | `<repo>/.agents/` 和 `<repo>/AGENTS.md` | `<repo>/dab.yaml` | `<repo>` 下 |
| Global | `~/.agents/` 和 `~/.agents/AGENTS.md` | `~/.agents/dab.yaml` | `$HOME` 下 |

- 位置决定 scope。Manifest 的 `scope` 字段只校验解析出的 scope，绝不覆盖它。
- `dab init [path]` 把 `path` 或当前目录作为确切的 source root，并在缺失时创建它。`dab init ~/.agents` 引导 global scope。
- 其他命令从当前目录向上查找最近的、包含 `dab.yaml` 或 `.agents/` 的目录。位于 `$HOME/.agents` 内时改用 global scope。
- `scope: global` 的 manifest 必须解析到 `$HOME/.agents`；`scope: project` 的 manifest 不得解析到那里。
- `dab init` 拒绝在已有 source root 内部创建 source root，因此嵌套 `.agents` tree 是错误。
- Project 命令只写入仓库根下；global 命令只写入 `$HOME` 下。超出 scope root 的 target path 是错误。

## Adoption 阶段

`dab detect` 和 `dab normalize` 在需要 manifest 之前先解析 phase：

| Phase | Markers |
|---|---|
| `initialized` | `dab.yaml` 可解析且 `.agents/` 存在。 |
| `partial` | 只有一个 marker 存在，或 `dab.yaml` 存在但无法解析。 |
| `uninitialized` | 两个 marker 都不存在。 |

- Project root 是最近的、包含 `dab.yaml` 或 `.agents/` 的祖先目录；未初始化 project 使用最近的 `.git` 祖先目录，找不到时使用当前目录。
- 仅当当前目录位于 `~/.agents` 内时才选择 global scope。root 是 `$HOME`，source root 是 `~/.agents`；完全缺失的 `~/.agents` 需要先运行 `dab init ~/.agents`。
- 无效的 authored `dab.yaml` 会报告为 `[ERROR]`，且永不被覆盖。`normalize` 以配置错误（YAML 语法错误为 `config.yaml`，schema 或版本错误为 `config.invalid`）停止并零写入。
- Adoption 只写入缺失的最小 source 文件；现有 authored 文件永不被替换。
- `dab detect` 在任何 phase 都只读。未初始化和 partial scope 会输出 checklist 并退出 `2`；已初始化 scope 保持正常的 `0`/`3`/`4` 退出码和 `--strict` 语义。

## Detect Checklist

- `dab detect` 按 Instructions、Documentation、Agents、Skills、Rules、Policy、Hooks、Memory、Notes、Generated target 和 Safety 分组。
- Hooks 和 Memory 组从不报告缺失的可选文件；从未选择启用的项目不会被报告为缺失。
- 状态包括 `[OK]`、`[MISSING]`、`[WARN]`、`[ERROR]` 和 `[IMPORTABLE]`。`[IMPORTABLE]` 表示物理 `.claude/agents` 或 `.claude/skills` 条目可导入 `.agents`。
- Detect 在每个 phase（包括 `initialized`）运行只读 import 计划；可导入条目不会同时报告为 unmanaged 或 physical-copy 投影漂移。
- `score` 统计全部条目中的 `[OK]` 条目。它仅供参考，绝不决定退出码。
- `nextActions` 是非 OK 条目去重后的 `next` 提示；被阻止的 preflight（例如无效 manifest 或 `$HOME` 冲突）不会建议 `dab normalize`。
- JSON payload 追加 `scope`、`root`、`phase`、`profile`、`checklist`、`score` 和 `nextActions`，同时保留 `targets`、`diagnostics` 和 `summary`；`schemaVersion` 保持 `1`。
- 未初始化和 partial scope 返回这一完整结果对象，其中 `ok: false`、`exitCode: 2`，不再使用保留给用法、校验和后端错误的 `{ ok: false, error }` 信封。

## 实践层

- `profile` 选择 `init` 和 `normalize` 生成的实践。`generic` 是默认值；`feature` 是行为相同的兼容别名，已有的 authored manifest 优先于 CLI flag。
- Practice pack 在 `targets()` 中声明候选路径，在 `files()` 中声明渲染内容，并按需声明自有目录或 `skipChildrenWhenExists`。生产注册表组合 `core`、`documentation` 和 `authoring`；documentation 和 authoring pack 只在 project scope 运行。
- `planAuthoredScaffold` 是 `init` 和 `normalize` 背后唯一的 authored 文件规划器。`init` 使用 `full`，`normalize` 对未初始化或 partial scope 使用 `adoption`，对已初始化 scope 使用 `converge`。它 stat 候选路径，用现有路径和计划路径构建 anchors，并且只渲染缺失文件，因此 planner 永不覆盖现有 authored 文件。存在的根 `AGENTS.md`（或 global `.agents/AGENTS.md`）只作为 anchor，不会被规划或写入，因此 converge 只在它存在时才从生成的 docs 链接它。现有 target 在保留前会先校验：documentation 文件必须是可读的普通文件或指向仓库内普通文件的符号链接，skill 目录必须是真实目录或指向仓库内具备读与搜索权限目录的符号链接。逃逸链接、特殊文件以及不可读的文件或目录在任何写入前都是受治理的错误。
- Documentation pack 拥有 `docs/AGENTS.md` 和 `docs/architecture.md`。它只写一种语言，从不创建 `.zh.md` 或 `.i18n.yaml` 配对；`docs/AGENTS.md` 是 AGENTS 文件，继续豁免配对。
- `docs.language` 为 `auto`、`en` 或 `zh`。`auto` 采样现有的 `docs/AGENTS.md`、`docs/architecture.md`、根 `AGENTS.md`、`README.md`、`package.json` description 和 locale，然后默认 `en`。解析结果携带 `{ value, source }`，并由 `init`、`normalize` 和 `detect` 报告。
- `.agents/rules/docs-bilingual.md` 是项目政策信号，不是错误：缺失的 documentation targets 被 policy skip，规则本身保留。已有 docs 作为 skipped 保留，因此悬空的 docs 路径不会阻止 skills 或 target 写入。
- Hooks 与共享记忆是高级、可选能力。`init` 和 normalize adoption 不创建 `.agents/hooks/` 或 `.agents/memory/`；已有 hooks 由 `init`、`normalize` 和 `detect` 校验并在适用时编译，已有记忆文件由 `init` 和 `normalize` 保留，并由 `init` 和 `detect` 校验。
- Authoring pack 拥有 `.agents/skills/dab-doc-writing`、`.agents/skills/dab-architecture-writing` 和 `.agents/skills/dab-decision-notes`。脚手架会保留已存在的 skill 目录。当只有可导入的物理 `.claude/skills/dab-*` 目录存在时，`init` 丢弃对应模板并把 import 报告为 pending，由 `normalize` 执行。非目录条目以 warning pending 报告为 `practice.skill-import-conflict`，且不提供 import 提示。Canonical 模板 body 位于已安装包的 `skills/<name>/SKILL.md`；marker 和受管更新流程见 Managed authoring skills。
- `.agents/rules` 或 `.agents/skills` 处的普通文件是受治理的路径错误：`normalize` 和 `detect` 报告 `practice.docs-path` 或 `practice.skill-path`，`init` 报告 `path.conflict`，且不会执行任何 practice 写入。只有精确的 practice parent 可以把自身事实集收窄为空；不可读的嵌套 skill 目录按 skill 报告 `skill.unreadable`，同级 skills 仍可被发现和投影。`.agents/agents`、`.agents/hooks`、`.agents/memory`、`.agents/notes`、`.agents/policies` 或 `.agents/adapters` 处的普通文件、悬空链接、访问拒绝或符号链接循环是受治理的 `path.conflict`，在 `init`、`normalize` 和 `detect` 中；project 和 global 运行都会在写入或发现之前阻断。缺少读与搜索权限的 source parent 是同样的受治理冲突；best-effort secret scan 可能跳过不可读子树，因此访问错误由 parent probe 而不是 scan 负责。
- `normalize` 在 target planning 之前规划 practice 写入，因此新文件会在同一次运行中被投影。Practice 错误阻止所有写入，包括 `.claude`；policy skip 不会。
- `detect` 只读运行相同的 packs。它在 Instructions 之后增加 `Documentation` 组，并在 `Skills` 中增加 authoring 条目。Preflight（未初始化和 partial scope）只报告存在性、policy skip、语言和路径状态；在已初始化 scope 中，内容检查覆盖两个文档文件中的链接、行首 `TODO:` 或 `TODO(owner):` 标记、空架构章节和受管 skill 状态。
- `normalize --json` 为 project scope 增加 `practices`，包含 `profile`、`mode`、`language`、`created`、`skipped`、`policySkipped`、`directories`、`skills` 和 `diagnostics`；`policySkipped` 只列出因双语规则而跳过的缺失 docs，已有 docs 报告为 `skipped`；global scope 省略它。`detect --json` 通过 `checklist` 在既有 `schemaVersion: 1` 下携带新条目。

## 受管 authoring skills

- Canonical 模板位于 DAB 仓库和已安装包的 `skills/<name>/SKILL.md`；`package.json` 发布 `skills`。`init` 和 `normalize` 从 package root 读取它们，因此不涉及网络、`npx skills` 或外部安装器。
- `.agents/skills/<name>/SKILL.md` 的已安装副本在 frontmatter 之后带 `<!-- dab-skill: <name>@<version> sha256=<hex> -->`。`version` 是渲染该副本的 DAB 包版本，`sha256` 是移除 marker 行后的 UTF-8 body 哈希。
- `normalize` 在 target planning 之前规划每个 `dab-*` skill。缺失文件会创建；hash 匹配且版本相同会跳过；hash 匹配且版本严格较旧会用当前模板和 marker 原子重写；无 hash 的 legacy marker 在去掉 marker 后 body 与当前模板逐字节一致时迁移。已修改 body、较新或无法解析的版本、不同的 legacy body、缺失 marker 和指向其他 skill 的 marker 会保留并产生诊断。不是普通文件、逃逸 root 或无法读取的路径是阻断性的 `practice.skill-path` 错误。skill 文件本身即使是解析到 root 内的符号链接也是该错误；所在 skill 目录可以是指向 root 内的符号链接。
- 每次受管写入前，`normalize` 会重新读取目标并校验计划的 marker、版本和 body hash。planning 之后被修改、删除或新建的目标会以 `practice.skill-concurrent-change` warning 保留而不是写入；缺失 skill 使用独占创建，因此并发创建的文件不会被替换。
- 受管更新要求稳定的数字版本。像 `0.1.3-beta.1` 这样的 prerelease DAB 版本无法比较，因此已安装 skills 会保留且不会自动更新；prerelease 创建的 skill 带有后续稳定版本也会保留的 marker。
- 更新只针对 `dab-*` skills。用户自定义 skills 永不被触碰。受管更新不创建 `.dab/backups/` 条目，已修改文件绝不会被覆盖或备份；已安装包和 git 历史就是记录。`init` 只安装缺失 skills。
- CRLF 很重要：legacy 迁移和 modified 检测都比较字节，因此仅有 CRLF 换行差异的 body 会保留。
- `detect` 把受管状态映射到 Skills 组：

| 状态 | 诊断 | `--strict` |
|---|---|---|
| current | 无 | 通过 |
| stale | `practice.skill-stale` | 失败 |
| newer 或无法比较 | `practice.skill-newer` | 通过 |
| modified | `practice.skill-modified` | 通过 |
| legacy 可迁移 | `practice.skill-legacy` info | 通过 |
| legacy body 不同 | `practice.skill-legacy` warning | 通过 |
| unversioned 或 marker 不匹配 | `practice.skill-unversioned` 或 `practice.skill-marker-mismatch` | 通过 |
| 路径或读取错误 | `practice.skill-path` | 失败 |

- `normalize --json` 新增 `practices.skills.updated`、`migrated`、`modified`、`newer`、`legacy`、`unversioned`、`markerMismatch` 和 `concurrent`，作为 `schemaVersion: 1` 下的追加字段；人类输出使用 `update skill`、`migrate skill` 和 `skip skill ... (...)` 动作。

## 核心循环

1. `dab init` 扫描仓库并为一个 scope 写入完整的编写骨架。
2. `dab normalize` 先采用缺失的最小 source、导入物理 Claude agents 和 skills、补齐缺失的 practice 文件并更新未修改的较旧受管 authoring skills，再预检每个启用的 target，并在全部预检通过后才写入 target 输出。
3. `dab detect` 在不写入的前提下检查漂移、所有权、phase 和 scope。
4. `dab policy explain --target <provider>` 展示单个 target 的最终结果。

## Target 与 Adapter

完整的 v2 project manifest（`dab normalize` 写入 `generated` 记录）：

```yaml
version: 2
scope: project
project:
  id: example
  name: Example
profile: generic
docs:
  language: auto
targets:
  - provider: claude-code
    enabled: true
    options:
      minVersion: 2.1.277
      instructions: symlink
paths:
  agents: .agents
  claude: .claude
generated:
  targets:
    - provider: claude-code
      settings:
        path: .claude/settings.json
        sha256: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      instructions:
        path: .claude/CLAUDE.md
        mode: symlink
        sha256: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      projections: []
```

- Target adapter 把 common facts 映射到一个 harness，并解析该 target 的 provider options。Adapter 绝不拥有 agent、skill 或 rule 定义。
- 当前 adapter 基础层是过渡性的：共享命令仍包含 Claude 专属的预检查与路径假设，后续 target 必须把这些能力收进各自 adapter。
- Common facts 位于 `.agents/`；provider 专属策略位于 `.agents/adapters/<provider>.yaml`；provider options 位于 target 的 `targets` 条目。
- 每个 target 在 `generated.targets` 下按 provider 记录自己的 settings、instructions 和 projections。
- 本阶段只有 `claude-code` 有 adapter。启用 `codex` 或 `dsh` target 会以 `target.unsupported` 失败，而不是跳过或写入部分配置。
- Codex、DSH 和 global settings adoption/merge 属于后续计划系列，不在本阶段。

## 所有权与失败语义

- Manifest 的 `generated` 记录是 target path 所有权的权威依据。
- 已记录的 instruction 产物或 projection 符号链接发生漂移时会原地修复（`repair`/`repair-link`），不需要 `--fix` 或备份。已记录的 settings 文件与预期内容不一致时会先备份再重写，即使它是符号链接或目录。
- 未记录且尚不匹配预期产物的 path 是 unmanaged。`normalize` 和 `detect` 会报告它，`normalize` 没有 `--fix` 时不写入任何内容。
- 物理 `.claude/agents/*.md` 文件或 `.claude/skills/<dir>` 目录是 import 候选，不是 unmanaged 冲突。其他物理 projection target、settings 文件和无法解析的条目仍是冲突；`dab normalize --fix` 会先把它们移入带时间戳的 `.dab/backups/` 目录再替换或移除。
- 已有 authored `.agents` source 的未记录条目符号链接由 `--fix` 先备份再修复。没有 authored source 的链接是冲突，需要手动移除；DAB 从不导入或删除 unmanaged 链接。
- `normalize` 会采用并记录未记录但已指向预期 source 的符号链接，或已匹配配置模式的 instruction 产物，无需重写。
- 已配置但没有安全映射的 target 会以 `target.unsupported` 失败。一个 target 失败会阻止所有 target 的写入，`--dry-run` 运行同一预检和退出码但不写入。
- 根 `CLAUDE.md` 归用户所有，始终是致命冲突。

## Normalize adoption 与 import

- Adoption 在 source-root 解析前运行。未初始化或 partial scope 会获得缺失的最小 source：`AGENTS.md`、`dab.yaml`、项目策略和 Claude Code 策略，以及空的 agents、skills、rules 和 notes 目录。Hooks 和共享记忆不会被采用；已有的 hooks 和记忆文件保持原位，并保留现有的校验行为。它复用 `init` 的渲染函数，但不创建 profile agents 或 core skills；命名空间的 `dab-*` authoring skills 是例外。
- Import 是受控迁移，不是 unmanaged 冲突：物理 `.claude/agents/*.md` 和 `.claude/skills/<dir>/SKILL.md` 条目会复制到 `.agents`，备份到 `.dab/backups/<timestamp>/`，并替换为逐项符号链接。不需要 `--fix`。
- Import 期间，`.agents` 是事实源：现有 source 文件或 skill 目录永不被覆盖；内容不同的 `.claude` 会产生警告。首次 import 会复制整个 skill 目录（包括额外文件）；当 `.agents/skills/<name>` 已存在时，额外文件保留在备份中。
- Import 保留 `.claude` 的 basename 或目录名。frontmatter `name` 是 fact id；不一致会警告，但不会重命名。
- All-or-nothing 门禁覆盖 adoption 和 import：任何非法候选或不安全路径都会阻止所有 source 和 `.claude` 写入。后续 target 预检失败时，`.claude` 保持不变；幂等的 source 副本可能已经存在。
- Import 对已初始化和未初始化/partial scope 都运行，覆盖 project 和 global scope。Global scope 下 `.claude` 条目链接到 `~/.agents`；`~/.claude/settings.json` 和 `$HOME/.gitignore` 永不读写。
- `dab init` 从不导入或备份现有 `.claude` 条目；adoption 和 import 仍是 normalize 的职责。
- `dab normalize --dry-run` 预览 source 写入、import、backup 和 symlink 动作及计划备份路径；真实运行时人类输出也会列出 adoption source 动作、import 动作和 adoption 备份。
- 本阶段只导入 agents 和 skills。rules、settings、hooks 和 instructions 仍是 unmanaged 或冲突的 `.claude` 内容，需要单独采用。
- Import 是幂等的。导入新条目的那次运行会在下一次运行时记录这些投影；重跑 `dab normalize` 可让生成记录和 `dab detect` 收敛。

## Claude Code 指令

- `.claude/CLAUDE.md` 默认是指向 scope 指令的符号链接：project scope 为 `../AGENTS.md`，global scope 为 `../.agents/AGENTS.md`。
- `instructions: generated` 改为写入导入垫片：project scope 为 `@../AGENTS.md`，global scope 为 `@../.agents/AGENTS.md`。当 Claude Code 构建无法跟随符号链接时使用它。
- `instructions: disabled` 不写入指令产物，并移除 managed 产物。
- Managed 产物原地修复。Unmanaged 产物需要 `--fix`，且会先备份。
- 指令记录为 `generated` 状态，绝不是 `native`，因为 DAB 物化了 Claude Code 读取的产物。

## Global Settings

- Global scope 可以在 `$HOME` 下对齐 instructions、agents、skills 和 rules。
- 本阶段 `~/.claude/settings.json` 归用户所有：DAB 报告警告，不读取、不写入、不合并它。
- `$HOME/.gitignore` 同样归用户所有且只读。
- 显式的 global settings adoption 和 merge 属于后续计划。

## 组件

- `src/cli.ts` 分发命令并拥有退出码。
- `src/commands/` 实现 `init`、`detect`、`normalize` 和 `policy explain`。
- `src/model/` 解析编写文件、解析 scope 并发现 agents、skills、rules、hooks 和 memory。
- `src/adapter/types.ts` 定义 target adapter 契约。
- `src/adapter/registry.ts` 把 provider 名映射到 adapter；只注册了 `claude-code`。
- `src/adapter/claude-code/` 编译策略、渲染 settings 并管理指令和投影产物。
- `src/adapter/claude-code/adoption.ts` 规划并应用 agent 和 skill import、备份和逐项符号链接。
- `src/detect/` 包含漂移和安全检查、checklist 渲染、未初始化 preflight 和 practice 检查。
- `src/init/` 扫描仓库、渲染模板、解析 adoption phase 并规划最小 source。
- `src/init/practice.ts` 拥有 authored scaffold planner 和 pack registry；`practice-docs.ts` 和 `practice-authoring.ts` 渲染 documentation 和 authoring packs，`docs-language.ts` 解析 `docs.language`。
- `src/core/skill-marker.ts` 解析、插入和移除受管 skill marker，并对移除 marker 后的 body 做哈希。
- `src/init/skill-templates.ts` 从包内 `skills/` 目录加载 canonical 模板；`src/init/managed-skills.ts` 分类已安装 authoring skills，并应用受管创建、更新和迁移。
- `skills/` 保存随包发布的 canonical authoring-skill 模板。
- `src/docs/` 运行双语文档门禁。

## 生成输出

- `.claude/settings.json` 是确定性的 project 产物；本阶段 global settings 只读。
- `.claude/CLAUDE.md` 默认是指向 scope 指令的符号链接，生成的导入垫片是显式 fallback。
- `.claude/agents/`、`.claude/skills/` 和 `.claude/rules/` 包含逐项符号链接。
- `docs/AGENTS.md` 和 `docs/architecture.md` 是 authored 项目文档；DAB 只创建一次缺失的骨架，永不覆盖。
- `.agents/skills/dab-*` 是带版本/hash marker 的受管 authoring 副本，投影为 `.claude/skills/` 符号链接。
- `dab.yaml` 保存 `scope`、`targets` 以及逐 target 的生成记录，包含 source 哈希、target 哈希和投影清单。
- `.dab/backups/` 在 `--fix` 采用 unmanaged path 前、以及 import 替换 `.claude` 条目之前保存原始文件。

## Frontmatter 兼容性

- Agent、skill 和 rule 文件会投影到 Claude Code，并可能先于 DAB 获得新的顶层字段。
- DAB 校验它解释的每个字段，保留未知顶层字段，并以警告形式报告来源文件。
- 当未知顶层字段看起来像拼写错误时，警告会给出最接近的已知字段。scope 或权限相关 key 的拼写错误会改变实际生效行为，因此 CI 中应把这些警告视为错误。
- `dab detect --strict` 把项目/配置类 warning 转为退出码 3，供 CI 强制执行该策略；缺少 Claude Code 等环境 warning 不计入。
- DAB 自有结构（hooks、policies、manifests、memory entries）中的未知字段仍然是错误。
- 这样 Claude Code 升级不会一次破坏所有 agent，同时保持 DAB 自有配置的 fail-loud 行为。

## JSON 输出契约

- 每个支持 `--json` 的命令都在顶层包含 `schemaVersion: 1`。
- 版本覆盖顶层信封和任意嵌套 provider payload。不同命令使用不同的 payload 形状（`targets`、`target`、`normalize`）；嵌套 payload 不单独携带版本。
- `detect --json` 追加 `scope`、`root`、`phase`、`profile`、`checklist`、`score` 和 `nextActions`；`checklist` 包含 `Documentation` 组和 authoring skill 条目。`normalize --json` 追加 `scope`、包含 source actions、imported entries 和 backups 的 `adoption`，以及 project scope 的 `practices`。
- `normalize --json` 包含绝对 `root`；`init --json` 包含 `root`（source root）和 `scopeRoot`（created、skipped 以及嵌套 normalize 路径的基准）。其他 JSON 路径相对于该基准。
- `--json` 不能与 `--help` 或 `--version` 组合使用。
- 发布可以新增字段；删除字段或改变含义必须提升 schema version。
- CLI JSON 是公开契约。导入的 TypeScript result 类型属于实现细节。

## 策略编译

共享策略只覆盖路径读写限制、命令执行限制和少量能力集合。Claude Code 专属规则放在 adapter 中。deny 优先，精确的 allow/deny 冲突会让编译失败，而不是扩大权限。

```yaml
version: 1
defaultMode: default
write:
  deny:
    - .claude/settings.json
execute:
  ask:
    - git push
```

## 文档门禁

每个正式发布的产品文档使用 `foo.md`、`foo.zh.md` 和 `foo.i18n.yaml`。门禁检查语言切换、章节结构、围栏代码、行内代码、链接 locale 和哈希。`AGENTS.md` 等指令文件保持英文单源。`docs/superpowers/` 下的内部工作计划保持中文单语，只检查链接和排版，不检查配对。

## 边界

- DAB 不运行自己的 Agent Loop。
- DAB 不导入 Claude Code 内部实现。
- DAB 从不编辑 `.claude/settings.local.json`。
- Adapter 只映射 facts 和解析 provider options；绝不拥有 agent、skill 或 rule 定义。
- 无法表达的 provider 语义会显式失败，而不是静默扩大权限；一个 target 失败会阻止所有写入。
- 本阶段 DAB 不合并 project 和 global scope，也不采用 global settings。
- 本阶段 DAB 只导入 `.claude/agents` 和 `.claude/skills`；rules、settings、hooks 和 instructions 不被采用。
- DAB 从不覆盖 authored docs 或已修改的受管 skills；`normalize` 更新未修改的较旧 `dab-*` skill，同时保留 modified、newer 和 legacy 分叉。
- DAB 不运行 agent 或 LLM 来填写文档内容；`normalize` 只生成骨架，`detect` 只检查结构。
- Global import 写入 `$HOME` 下，但从不管理 `~/.claude/settings.json` 或 `$HOME/.gitignore`。
- 路径 deny 规则是工具级护栏，不是沙箱；`Bash`、`Grep`、`Glob`、`NotebookEdit` 和包装命令可以绕过。
- Hooks 是可信的可执行代码；DAB 只检查元数据和静态安全，不检查运行时行为。
- v0.1 没有 eval 循环；证据工作记录在 `docs/roadmap.md`。
- v0.1 只接受默认的 `.agents` 和 `.claude` 路径。
- v0.1 的所有命令都拒绝 Windows；junction 支持推迟到后续版本。
