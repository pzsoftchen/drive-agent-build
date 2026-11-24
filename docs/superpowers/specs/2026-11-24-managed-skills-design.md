# DAB Managed Skills Pack 设计

## 状态

已批准；实现计划：[2026-11-24-managed-skills.md](../plans/2026-11-24-managed-skills.md)。本文档不包含实现代码。

## 背景

DAB 当前的 `dab-doc-writing`、`dab-architecture-writing`、`dab-decision-notes` skills 以内嵌 Markdown 字符串维护在 `src/init/practice-authoring.ts`，安装到目标项目 `.agents/skills/dab-*` 后只写一次。带来的问题：

- skill 正文在 TypeScript 字符串里维护，review、diff、lint 都不如真实 Markdown 文件；
- DAB 发布新版本后，已安装 skill 不会更新，`practice.skill-stale` 会持续存在；
- 用户修改 skill 后，DAB 无法区分“用户分叉”和“旧模板”；
- 如果运行时委托 `npx skills` 安装，会引入网络、外部工具、目标路径和非确定性，与 DAB 的 `.agents` source-of-truth、all-or-nothing、备份和离线可重复语义冲突。

## 目标

- 在 DAB 仓库用 `skills/<name>/SKILL.md` 维护 canonical skill 源文件，并随 npm 包发布。
- `init` / `normalize` 从已安装的 DAB 包读取 skills，不依赖网络或外部安装器。
- 每个安装的 skill body 带版本和内容 hash；`normalize` 能区分：
  - 未修改的旧模板 → 自动更新；
  - 用户修改过的分叉 → 保留，报告 modified；
  - 没有版本/hash 的旧格式 → 保留，报告 legacy/unversioned；
  - 当前版本且未修改 → skip。
- `detect` 报告 stale / modified / legacy 状态，不把用户分叉当成项目健康问题。
- DAB 自身 dogfood 的 `dab-*` skills 也通过同一机制管理，不再手工复制。

## 非目标

- 运行时调用 `npx skills` 或任何外部 skills 安装器。
- 第三方 skill marketplace、远程 registry 或按需下载。
- 把 `dab-*` 文件权限设为只读；DAB 用“managed + fork-aware”，不是文件系统锁。
- 修改 manifest schema 或 generated record 的现有 projection 语义。
- 自动更新用户自定义的 skills（非 `dab-*`）。

## 设计

### Skills 源目录

新增：

```text
skills/
  dab-doc-writing/SKILL.md
  dab-architecture-writing/SKILL.md
  dab-decision-notes/SKILL.md
```

- 这些文件是 canonical 模板，内容为当前 `practice-authoring.ts` 渲染的 skill body（不含 marker）。
- `package.json` 的 `files` 增加 `"skills"`，npm 包和 `npx @saydone/dab` 都携带它们。
- runtime 从 package root 的 `skills/` 读取；本地开发从仓库根读取，不依赖网络。
- `renderAuthoringSkill` 改为读取模板文件并注入当前版本/hash；`authoringPack.files` 已是 async，可自然承载文件读取。

### Marker 格式

每个安装的 `SKILL.md` body 保留：

```html
<!-- dab-skill: <name>@<version> sha256=<hex> -->
```

- `version` 是生成该 skill 的 DAB 包版本。
- `sha256` 是**去掉 marker 行后的文件内容的 SHA-256**（使用稳定的 UTF-8 文本和单一换行格式）。
- 安装时由 DAB 计算并写入；更新前用同一算法重新计算。
- 旧 marker（只有 `name@version`、没有 `sha256`）视为 legacy；如果去掉 marker 后的 body 与当前模板完全一致，可以安全升级 marker/hash；否则视为用户分叉，保留并报告 legacy/unversioned。

### 安装与更新算法

对每个 `dab-*` skill：

1. 目标缺失：写入当前模板 + marker，报告 `create`。
2. marker 和 hash 存在且 hash 匹配：
   - version 等于当前 DAB 版本 → skip。
   - version 较旧 → 用当前模板更新，重写 marker/hash，报告 `update`；这是 DAB-managed 内容，不覆盖用户修改（hash 已证明未修改）。
3. marker 和 hash 存在但 hash 不匹配：视为用户修改/分叉，不写，报告 `skill.modified` warning；DAB 保留该文件且不再自动更新。
4. marker 缺失或 legacy 无 hash：
   - 去掉 marker 后 body 与当前模板一致 → 升级 marker/hash，报告 `migrate`；
   - 否则视为用户分叉/未知来源，不写，报告 `skill.legacy` 或 `skill.unversioned` warning。
5. 任何写入前先完成所有 skill 的检查和 hash 计算；modified/legacy 是 warning，不阻止其他 practice/target 写入。路径类型/逃逸/读失败仍是 blocking error。
6. `--dry-run` 展示 create/update/migrate/skip 计划，不写盘；更新是原子的覆盖写，失败停止并保留可重跑状态。

### detect

`Skills` group 对每个 `dab-*` skill 报告：

| 状态 | 条件 | 严重性/next |
|---|---|---|
| `ok` | marker/hash 匹配，version 当前 | — |
| `warn` | marker/hash 匹配，version 较旧 | `dab normalize`；strict 失败 |
| `warn` | hash 不匹配（用户分叉） | 无自动 next；strict 不失败 |
| `warn` | legacy 无 hash，body 不等于当前模板 | 手工确认；strict 不失败 |
| `warn` | 无 marker | 手工确认；strict 不失败 |
| `error` | 路径类型/读失败/逃逸 | 手工解决 |

- `practice.skill-stale` 保持 strict failure（未修改但可更新）；`practice.skill-modified`、`practice.skill-legacy`、`practice.skill-unversioned` 为非 strict warning。
- `practices.skills` JSON 的 created/skipped 继续描述 practice planner 写入/跳过的文件；新增的 managed update 结果可放在 `practices.skills.updated`/`migrated`/`modified` 等 additive 字段（或统一为 actions；实现计划定稿）。`schemaVersion` 保持 1。
- 人类输出显示 `update skill ...`、`migrate skill ...`、`skip skill ... (modified)`。

### 与 init / normalize 的关系

- `init` full：安装当前模板和 marker/hash；不更新已有文件。
- `normalize` adoption/converge：安装缺失 + 管理 update/migrate；在 target planning 之前完成 practice 变更的 preflight。
- 更新只针对 `dab-*`；用户自定义 skills 永不触碰。
- 更新是 DAB-managed 内容的原子写，不使用 `--fix`；如果用户修改过，DAB 不会备份或覆盖（文件保留）。

### 打包与运行时

- `skills/` 进入 npm `files`；`prepack` 只构建 dist，不复制 skills（package root 直接包含）。
- runtime 用 package root 解析 `skills/<name>/SKILL.md`；`npx @saydone/dab` 和全局安装都读取包内文件。
- 本地开发/测试从仓库根读取；测试覆盖 package path 形状。
- 无网络、无 npx、无外部安装器。

### Dogfood

- DAB 自身 `.agents/skills/dab-*` 成为 managed 安装副本；canonical 模板在 `skills/`。
- 发布准备时运行 `dab normalize`：未修改的 DAB dogfood skills 自动更新 marker/hash；用户分叉（如有）保留并告警。
- DAB 自己的 `docs/AGENTS.md` 与 Agent Note 记录该机制。

## 兼容性

- 现有 0.1.1 / PR #8 项目的 `dab-*` skills 没有 hash marker：作为 legacy 处理；body 与当前模板一致时迁移，否则保留并 warning。
- 不修改 manifest schema；现有 projection/ownership/备份语义不变。
- 用户自定义 skills（非 `dab-*`）和 import 的 `.claude/skills` 不受影响。
- 0.1.2 发布后，目标项目的 `dab-*` skills 可以在下次 normalize 中安全更新；不再依赖手工复制。

## 验收

- `skills/` 被 npm pack 包含；`renderAuthoringSkill` 从文件读取并生成带 version/hash 的 marker。
- 新安装 skill 的 marker/hash 可验证；detect 当前版本为 ok。
- 未修改的旧版本 skill 在 normalize 中更新；dry-run 显示 update；文件 hash 仍可验证。
- 用户修改 body 后 normalize 不覆盖，detect 报 modified warning，strict 不失败。
- legacy marker body 与当前模板一致时迁移；不一致时保留并 warning。
- `init` 只安装缺失，不覆盖已有；`normalize` 的 managed update 在 target planning 前完成。
- DAB 自身 dogfood skills 通过 normalize 更新，detect 19/19 保持。
- `pnpm test`、`pnpm typecheck`、`pnpm doc-sync`、`dab detect --strict`、`normalize --dry-run` 通过。

## 备选方案

- **运行时 `npx skills`**：拒绝。网络/外部工具/目标路径/非确定性/供应链问题，且绕过 `.agents` ownership。
- **manifest generated record 存 version/hash**：考虑过；marker 自带 hash 更简单、可随文件移动且不依赖 manifest 记录，因此 v1 采用 marker。
- **文件权限只读**：拒绝。跨平台不可靠，且会阻止用户正当分叉。
- **继续 copy-once**：拒绝。版本会持续 stale，无法区分用户修改。
- **用户修改时覆盖并备份**：拒绝。会静默夺走用户内容；分叉应保留。

## 待确认

- marker 的 hash 行格式是否接受在 skill body 中可见（HTML comment，不影响渲染）。
- managed update 是否需要在 `.dab/backups` 备份未修改的旧模板（本设计：不备份，git/包版本保留历史；用户修改不覆盖）。
