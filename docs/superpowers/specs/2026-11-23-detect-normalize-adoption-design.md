# DAB Detect Checklist 与 Normalize 接入设计

## 状态

已批准。实现计划：[2026-11-23-detect-normalize-adoption.md](../plans/2026-11-23-detect-normalize-adoption.md)。

## 背景

存量项目执行 `dab detect` 时，如果项目没有 `dab.yaml` 或 `.agents/`，会在 source root 解析阶段退出 2，只给一句 `no dab.yaml or .agents directory found`。用户习惯是先只读检查缺失项，再执行修复；当前唯一的预览是 `dab init --dry-run`，不符合这个习惯。

同时，存量项目可能已有 `.claude/agents/` 和 `.claude/skills/`。当前 `normalize` 会把它们当成 unmanaged/target conflict，`--fix` 只会备份后替换，不会把事实导入 `.agents/`。用户希望把这些事实导入 `.agents/agents/` 和 `.agents/skills/`，使 detect 列表收敛。

## 目标

- `detect` 在未初始化、部分初始化和已初始化的 project/global scope 上都能只读运行，输出 checklist。
- `normalize` 在未初始化/部分初始化 scope 上执行 adoption：创建最小 authored source，导入 `.claude/agents` 和 `.claude/skills`，备份原文件，按现有 per-entry symlink 模型对齐。
- Global scope 与 project scope 使用同一套 adoption/import 规则，但只处理 agents/skills；`~/.claude/settings.json` 和 `$HOME/.gitignore` 保持只读。
- `init` 保持一次性初始化/profile 入口；不新增 import/audit 命令。
- 保留 `.dab/backups/`，复用现有备份机制。
- 第一版只做 agents 和 skills；rules、settings、hooks、instructions 后续。

## 非目标

- 不改成目录级 symlink；继续 per-entry symlink。
- 不新增独立 import/audit 命令。
- 不在本版实现 profile 推断/管理；profile 字段来自 manifest，`init --profile` 是后续工作。
- 不自动导入 `.claude/settings.json`、hooks、rules、`CLAUDE.md` 或根 `CLAUDE.md`。
- 不重写已有 `.agents` authored source。
- 不支持 Devin/其他 target。
- 不在 v1 导入 global settings、hooks、instructions 或 `$HOME/.gitignore`。

## 用户流程

### 新项目/空项目

```bash
dab init --profile feature
dab normalize
dab detect
```

### 存量项目，尚未初始化

```bash
dab detect
# checklist: missing AGENTS.md/.agents/dab.yaml; importable .claude agents/skills
dab normalize --dry-run
# adoption + import plan, no writes
dab normalize
# create minimal source, import agents/skills, backup .claude originals, align symlinks
dab detect
# checklist converges
```

### 已初始化项目

```bash
dab detect
dab normalize          # managed drift
dab normalize --fix    # unmanaged conflicts
dab detect
```

### Global scope

```bash
cd ~/.agents
dab detect
dab normalize --dry-run
dab normalize
dab detect
```

`~/.agents` 必须存在；如果完全缺失，先运行 `dab init ~/.agents`。global 不写 `~/.claude/settings.json` 或 `$HOME/.gitignore`。

## phase 与项目根目录

Project marker 为 `dab.yaml`（可解析）和 `.agents/`；global marker 为 `~/.agents/dab.yaml` 和 `~/.agents/`。

- `initialized`：两个 marker 都存在且 manifest 有效；沿用现有 root 解析。
- `partial`：只有一个 marker，或 manifest 存在但解析失败；使用已有 marker 所在目录作为 root，报告缺失/无效项；缺失的 marker/skeleton 可补齐，但已存在的 authored `dab.yaml` 不会被覆盖。
- `uninitialized`：project 无 marker；从 cwd 向上找最近的 git root 作为 root，找不到时使用 cwd。global 的 root 是 `$HOME`；如果 `~/.agents` 完全不存在，先 `dab init ~/.agents`，不从任意 cwd 隐式推断 global。
- `dab.yaml` 存在但解析失败：detect 报 `[ERROR]`；normalize 不覆盖 authored manifest，零写入；用户修复后重跑。
- `detect` 在 uninitialized/partial 时只读，exit 2；`Profile` 显示 `not initialized`，partial 且 manifest 有效时显示 manifest profile。
- `normalize` 对 uninitialized 和 partial 都执行 adoption；project 和 global 使用同一规则。

## detect checklist

人类输出参考：

```text
dab detect
Scope: project
Root: /path/to/project
Profile: feature

Instructions
  [OK] AGENTS.md
  [OK] .claude/CLAUDE.md -> ../AGENTS.md

Agents
  [OK] .agents/agents/ (2 entries)
  [OK] .claude/agents/implementer.md -> ../../.agents/agents/implementer.md
  [IMPORTABLE] .claude/agents/reviewer.md -> .agents/agents/reviewer.md

Skills
  [OK] .agents/skills/ (3 entries)
  [OK] .claude/skills/doc-sync -> ../../.agents/skills/doc-sync
  [IMPORTABLE] .claude/skills/pdf-tools -> .agents/skills/pdf-tools

...
score: 22/27 (81%)
next: dab normalize
```

Global scope 使用相同分组，头部为 `Scope: global` 和 `Root: $HOME`。

状态：

| 标签 | 含义 |
|---|---|
| `[OK]` | 符合 |
| `[MISSING]` | 应有但缺失 |
| `[WARN]` | 非致命问题 |
| `[ERROR]` | 错误 |
| `[IMPORTABLE]` | 存在未托管的 `.claude` fact，可导入 `.agents` |

- 分组：Instructions、Agents、Skills、Rules、Policy、Hooks、Memory、Notes、Generated target、Safety。
- 每项给出 file/path、当前状态和下一步。
- `score` = OK 项数 / 全部项数；WARN/MISSING/ERROR/IMPORTABLE 不算 OK。score 仅供参考，不决定退出码。
- `Profile` 来自 manifest；未初始化时显示 `not initialized`。
- 未初始化时 `detect` 不写入，退出码保持 2（config error）。
- 已初始化时保持现有退出码和 `--strict` 语义。
- `--json` 保留现有字段，追加 `phase`、`checklist`、`score`、`nextActions`；`schemaVersion` 仍为 1（只增字段）。

## normalize adoption 与 import

### 共享初始化

把 `init` 中的扫描、最小 authored skeleton、manifest、冲突预检抽成共享 `initializeSource()`：

- `init` 使用 full/profile 模式。
- `normalize` adoption 使用 minimal 模式。
- profile 参数留在共享层；normalize 默认 `feature`。

minimal skeleton（仅缺失时创建）：

- `AGENTS.md`（复用 init 的 scan 模板）
- `dab.yaml`（claude-code target，默认 options）
- `.agents/policies/project.yaml`
- `.agents/adapters/claude-code.yaml`
- `.agents/agents/`
- `.agents/skills/`
- `.agents/memory/INDEX.md`
- `.agents/notes/`、`.agents/rules/`、`.agents/hooks/`

不在 minimal 模式创建默认 agents/skills；这些属于 `init --profile` 的职责，避免与导入的现有事实冲突。

Global 使用 `~/.agents/AGENTS.md`、`~/.agents/dab.yaml` 和相同的 `.agents/` 子目录；`initializeSource` 按 scope 解析路径。

### 导入规则

#### Agents

Project 路径为 `.claude/agents` → `.agents/agents`；global 路径为 `$HOME/.claude/agents` → `~/.agents/agents`。

- 扫描 `.claude/agents/*.md` 的普通文件。
- 用 `AgentFrontmatterSchema` 校验；未知顶层字段按现有 R8 策略保留并 warning；已知字段非法则报错；all-or-nothing 预检会阻止全部写入。
- 保留 `.claude/agents/<file>.md` 的 basename；写入 `.agents/agents/<basename>`。
- frontmatter `name` 是 fact ID；若与 basename 不一致，warning，不重命名。
- 若 `.agents/agents/<basename>` 已存在：
  - 内容相同 → 不重写 `.agents`，但仍备份 `.claude` 并替换为 symlink。
  - 内容不同 → `.agents` 是 source of truth；备份 `.claude` 并替换为 symlink，warning。
- 若 `.claude/agents/...` 是 symlink：
  - 指向预期 `.agents/agents/<basename>` → 已 managed，跳过。
  - 指向其他位置 → conflict，不导入。

#### Skills

Project 路径为 `.claude/skills` → `.agents/skills`；global 路径为 `$HOME/.claude/skills` → `~/.agents/skills`。

- 扫描 `.claude/skills/<dir>/SKILL.md` 的目录。
- 用 `SkillFrontmatterSchema` 校验；保留 `.claude/skills/<dir>` 目录名；frontmatter `name` 是 fact ID，若不一致 warning，不重命名。
- 目标不存在时：复制整个 skill 目录到 `.agents/skills/<dir>/`，保留额外文件；不跟随逃逸 root 的 symlink。
- 目标已存在：`.agents` 是 source of truth；不合并额外文件。备份整个 `.claude/skills/<dir>` 并替换为 symlink；额外文件只保留在备份中并 warning。
- symlink 规则同 agents。

#### 导入后的 replacement

对每个已确认可导入（包括 `.agents` 已存在且内容相同的）`.claude/agents/<name>.md` 和 `.claude/skills/<name>`：

1. 备份原路径到 `.dab/backups/<timestamp>/<relative>`。project 在 `<repo>/.dab/backups`；global 在 `$HOME/.dab/backups`。
2. 替换为 per-entry symlink：
   - `.claude/agents/<name>.md -> ../../.agents/agents/<name>.md`
   - `.claude/skills/<name> -> ../../.agents/skills/<name>`
   - global 使用同一相对路径：`$HOME/.claude` → `$HOME/.agents`。

备份失败则中止，不替换。`normalize --dry-run` 展示 import、backup、symlink 计划，不写入。

### 冲突与 all-or-nothing

- Import 在每次 `normalize` 执行，不只 adoption；已初始化 scope 中（project 或 global）新出现的 importable agents/skills 也会迁移。
- Import 预检复用完整 fact discovery 语义，不只 schema：包括 `memory: project`、`permissionMode: auto/bypassPermissions`、agent hooks、tools token、重复 name、skill kebab-case 等。
- 任一 import 候选非法，或存在需要 `--fix` 的非 import 冲突（settings、instructions、rules、root `CLAUDE.md`、unmanaged symlink）时，normalize **零写入**；先修复或 `--fix` 再重跑。
- `--fix` 只处理非 import 的 unmanaged 冲突；import 路径本身是受控迁移，不需要 `--fix`。
- Apply 阶段的 I/O 失败：不自动事务回滚；停止，报告已写文件和 backups；重跑幂等。
- 已有 `.agents` source 永不覆盖；`.claude` 侧通过备份/替换解决，内容差异写 warning。
- 已有 authored `dab.yaml` 解析失败时，normalize 不覆盖并零写入；用户修复后重跑。
- 根 `CLAUDE.md` 仍是 fatal conflict。

## 备份

- 保留现有 `.dab/backups/`，不新增备份系统。
- 备份用于：
  - `--fix` 替换/移除 unmanaged 路径；
  - import 替换 `.claude` 原文件/目录；
  - rollback 和审计。
- `.agents` 导入副本不等于备份：skill 目录可能包含额外文件，原文件元数据、symlink 形态和失败回滚都需要原始备份。
- 这里的 rollback 是手动恢复；现有 normalize 没有自动事务回滚。
- Project `.dab/` 已在 `.gitignore`；global 备份位于 `$HOME/.dab/backups`，`$HOME/.gitignore` 不在本版管理中。
- 备份只在有替换时产生；global 不修改 `$HOME/.gitignore`。
- 本设计不移除 `.dab/backups/`。如果担心目录膨胀，后续单独设计 retention/cleanup，不在本次范围内。

## init 与 profile

- `init` 继续负责一次性初始化/full skeleton；profile 参数预留在共享初始化层。
- `init --profile` 的 profile 体系是后续工作；本设计不实现 profile 推断。
- 存量 scope 的推荐入口是 `detect` -> `normalize`；`init` 主要用于新项目、global 初始化或需要 profile 模板的场景。
- global 初始化使用 `dab init ~/.agents`；完全缺失 `~/.agents` 时，这是识别 global scope 的显式入口。
- `init` 在已有 `.claude` 的 project/global scope 上仍保持现有行为：写缺失 authored 文件，报告 pending conflicts；不自动导入。导入由 normalize 负责。

## JSON 与退出码

`detect --json`：

- `scope: "project" | "global"`
- `root: string`
- `phase: "uninitialized" | "partial" | "initialized"`
- `checklist: [...]`
- `score: { ok, total, percent }`
- `nextActions: string[]`
- 保留 `targets`、`diagnostics`、`summary`
- `schemaVersion: 1`（只增字段）

`normalize --json`：

- 追加 `scope`、`root`、`adoption`（authoredFiles、imports、backups、diagnostics）
- 保留 `targets`、`actions`、`backups`、`settings`、`instructions`

退出码：

- 未初始化/partial `detect`：2（保持现有 config error）
- 已初始化 detect：现有 0/3/4（backend version error 仍为 4；`--strict`）
- normalize：现有 0/2/3/4；import 失败按 validation 3；backend 仍 4

## 兼容性

- 已初始化 scope（project/global）的 managed drift 和其他 unmanaged conflict 行为不变；importable `.claude/agents`/skills 现在会在普通 normalize 中自动迁移，这是本设计的有意行为变化。
- Global scope 与 project 一样支持 agents/skills 的 detect checklist 和 normalize adoption/import；`~/.claude/settings.json` 与 `$HOME/.gitignore` 仍只读。
- per-entry symlink、manifest、ownership 不变。
- 现有 v2 manifest 可读；不要求迁移。
- 人类输出变化不是 JSON 契约；`schemaVersion` 不变。
- `.dab/backups/` 路径和格式不变。

## 实现接缝

- `projection.ts` 使用源 basename/dirname 作为 target；导入必须保留现有 `.claude` 名称。
- `templateFiles` 包含默认 agents/skills；normalize adoption 只复用 minimal render 函数，不使用完整模板。
- `normalizeProject` 先解析 source root；adoption 需要复用 init 的 root 解析和共享 `initializeSource`。
- detect 的 uninitialized/partial 分支不能调用 `loadProjectManifest`/`resolveProjectPaths`；需要 manifest-less preflight paths 或默认 paths。
- 可复用 `writeIfMissing`、`findGeneratedConflicts`、`backupPath`、`applyProjectionActions`。
- Import 的备份/替换在正常 projection plan 之前完成，然后进入现有 normalize 管线。

## 备选方案

- 独立 `dab import`：拒绝；用户不希望增加命令。
- `normalize --import`：拒绝；import 是 adoption 的一部分，不增加额外 flag。
- Global detect-only / `--fix` gate：拒绝；用户选择 C，global 与 project 使用同一自动导入规则。
- 目录级 symlink：拒绝；保留 per-entry ownership。
- 不备份：拒绝；`--fix` 和 replacement 需要 rollback/审计。
- full profile skeleton in normalize：拒绝；会引入默认 agents/skills 与导入事实冲突；profile 留在 init。
- score 使用加权：暂不；OK/总数足够。

## 验收

- 未初始化 project/global `dab detect` 输出 checklist（不是单行报错），exit 2，不写入。
- `dab detect --json` 包含 scope/root/phase/checklist/score/nextActions，schemaVersion 1。
- `dab normalize --dry-run` 在未初始化 scope 展示 adoption/import/backup 计划，不写入。
- `dab normalize` 创建 minimal source，导入合法 `.claude/agents`/`.claude/skills`，备份并替换为 per-entry symlink；之后 detect 显示 OK/IMPORTABLE 消失。
- Global scope 使用临时 HOME fixture 验证 checklist、adoption/import、备份和 symlink；`~/.claude/settings.json` 与 `$HOME/.gitignore` 保持只读，不写真实 HOME。
- Global 的 `[IMPORTABLE]` 在 normalize 后消失。
- 非法 agent/skill 报错且不导入；不产生部分导入。
- 已有 `.agents` source 不被覆盖；same/different content 测试覆盖。
- 备份路径和内容正确；`--dry-run` 列出备份计划。
- 已初始化 scope 的 managed drift/其他 unmanaged conflict 行为不变；现有测试通过。
- `pnpm test`、`pnpm typecheck`、`pnpm doc-sync`。

## 待确认

- Global 完全缺失 `~/.agents` 时，仍需先 `dab init ~/.agents` 才能识别 global（本设计：是）。
- 未初始化 project root：最近 git root，fallback cwd（本设计：是）。
- Skill 目录已有额外文件时：备份后替换并 warning，不合并进 `.agents`（本设计：是）。
- Import 预检是否 all-or-nothing（本设计：是；任一非法条目阻止全部写入）。
- Minimal skeleton 是否包含 `AGENTS.md` 模板（本设计：包含，缺则生成）。
- Score 是否把 WARN 计为不 OK（本设计：是）。
- 未初始化 detect 是否保持 exit 2（本设计：是）。
- 是否需要在后续版本增加备份 retention/cleanup。
