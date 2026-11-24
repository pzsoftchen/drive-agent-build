# Agent Note: 受管 authoring skills

Status: implemented

[English](2026-11-24-managed-skills.md) | 中文

## Problem

三个 `dab-*` authoring skills 原本是 `src/init/practice-authoring.ts` 中的 Markdown 字符串。项目只会收到一次副本，因此 DAB 升级时无法区分未修改的旧模板与用户分叉；`practice.skill-stale` 会一直存在，却没有安全的处理方式。把安装委托给 `npx skills` 会给以 `.agents` 为源、离线、all-or-nothing 的工作流引入网络访问、外部安装器、target 路径假设和非确定性。

## Decision

- Canonical 模板位于仓库和已安装包的 `skills/<name>/SKILL.md`；`package.json` 发布 `skills`。`init` 和 `normalize` 从 package root 读取它们。不调用 `npx skills`，也不访问网络或远程 registry。
- `.agents/skills/<name>/SKILL.md` 的已安装副本在 frontmatter 之后带 `<!-- dab-skill: <name>@<version> sha256=<hex> -->`。版本是 DAB 包版本；hash 是移除 marker 后的 UTF-8 body 的 SHA-256。
- `planManagedSkills` 在 target planning 之前分类每个已安装 skill。缺失则创建。hash 匹配且版本相同则跳过。hash 匹配且版本严格较旧则原子更新。无 hash 的 legacy marker 且去掉 marker 后 body 逐字节一致则迁移 marker 和 hash。已修改 body、较新或无法解析的版本、不同的 legacy body、缺失 marker 和指向其他 skill 的 marker 会保留并产生诊断。不是普通文件、逃逸符号链接和不可读路径是阻断性的 `practice.skill-path` 错误。
- 受管更新只写 `dab-*` 文件，不创建备份。已修改文件绝不会被覆盖或备份；包和 git 历史就是记录。`init` 只安装缺失 skills。
- `detect` 把相同状态映射到 Skills 组。`practice.skill-stale` 保持 strict；`practice.skill-newer`、`practice.skill-modified`、`practice.skill-legacy`、`practice.skill-marker-mismatch` 和 `practice.skill-unversioned` 是 non-strict warning，因为它们描述被保留的 authored 内容。
- `normalize --json` 新增 `practices.skills.updated`、`migrated`、`modified`、`newer`、`legacy`、`unversioned` 和 `markerMismatch`，位于 `schemaVersion: 1` 下；人类输出使用 `update skill`、`migrate skill` 和 `skip skill ... (...)`。
- 0.1.2 发布包含受管更新。存量 0.1.1 项目只有无 hash 的 legacy markers，仅在 body 逐字节一致时迁移。DAB 自身的 dogfood skills 通过运行 `dab normalize` 迁移，而不是手工编辑。

## Alternatives considered

**运行时 `npx skills` 安装。** 拒绝：网络访问、外部安装器、target 路径假设、非确定性和供应链面与离线的 `.agents` 事实源冲突。

**把版本和 hash 存入 manifest generated record。** 拒绝：marker 随文件移动，不依赖 manifest 记录，并且在项目复制或移动 skill 后仍然有效。

**把已安装 skills 设为只读。** 拒绝：跨文件系统不可移植，并且会阻止正当分叉。受管且 fork-aware 才是契约。

**保持 copy-once 安装。** 拒绝：每次 DAB 发布都会让旧 skills 落后，且 DAB 无法区分分叉与旧模板。

**覆盖已修改 skill 并备份。** 拒绝：这会静默夺走用户内容并形成第二个事实源。已修改 skills 保持不动。

## Consequences

- DAB 升级只更新 hash 证明 body 未修改的 skills。已修改、较新和无版本 skills 保持原位，因此 `detect` 可能在人审阅前保持非干净；对保留类状态，`--strict` 仍会通过。
- hash 覆盖移除 marker 后的 body，因此可以重写 marker 而不改变内容 hash。仅 CRLF 差异无法通过逐字节 legacy 比较，会保留。
- `init` 和 `normalize` 运行时依赖包内 `skills/` 目录；省略该目录的包在渲染 skill 时会显式失败。Release 测试覆盖 npm `files` 条目。
- 0.1.1 项目带 legacy markers，未修改时会在下次 normalize 迁移。编辑过 authoring skill 的项目保留其分叉，warning 会一直存在直到人工调和。
- 受管更新不创建 `.dab/backups/` 条目，因此未修改旧模板的恢复依赖 git 或之前安装的包。
- DAB dogfood 同一路径：`.agents/skills/dab-*` 是 `skills/` 的受管副本，迁移后 `dab detect --strict` 干净。
- 0.1.2 是第一个可以更新已安装 authoring skills 的版本；它不改变 manifest schema 或 projection 所有权。

## Verification

- `pnpm test`：62 个测试文件、785 个测试通过。
- `pnpm typecheck`：无错误。
- `pnpm doc-sync`：配对、链接、排版、预算和 Agent Note 检查通过。
- `pnpm build`：TypeScript 编译通过。
- `node dist/cli.js detect --strict`：normalize 迁移三个 dogfood skills 后为 `19/19 (100%)`，退出码 `0`。
- `node dist/cli.js normalize --dry-run`：迁移后无写入，也没有待处理变更。
- `dab normalize` 把三个 dogfood skill markers 从无 hash 的 `0.1.1` 迁移为带 hash 的 `0.1.1`，并更新 `dab.yaml` source 哈希；第二次 dry run 报告无变更。
- `git diff --check`：干净。

## Related

- [架构](../../../../docs/architecture.zh.md)
- [CLI](../../../../docs/user/cli.zh.md)
- [Claude Code 集成](../../../../docs/user/claude-code.zh.md)
- [设计规格](../../../../docs/superpowers/specs/2026-11-24-managed-skills-design.md)
