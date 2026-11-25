[English](development.md) | 中文

# 开发

DAB 使用 TypeScript ESM 和 Node `>=24.9`。仓库本身也使用自己的 Agent 配置。

## 初始化

```bash
pnpm install
pnpm build
node dist/cli.js normalize
pnpm test
```

## 检查

- `pnpm test` 运行单元和集成测试。
- `pnpm typecheck` 检查 TypeScript。
- `pnpm doc-sync` 运行翻译配对、链接、排版、预算和 Agent 决策记录格式检查。
- `node dist/cli.js detect --strict` 检查本仓库的生成配置，并在存在 strict warning 时失败；non-strict warning 仍只是 warning。
- `node dist/cli.js normalize --dry-run` 展示待执行的投影变更。
- `node scripts/dab-check.mjs` 运行本仓库自己的项目门禁：先 `source`，再 code 和 docs 命令。加 `--strict` 会在 check 和 advisory warning 时失败，加 `--json` 输出机器可读结果。
- `pnpm build && node dist/cli.js normalize` 会在 `package.json` 或 `gates.yaml` 变化后刷新 dogfood 门禁 runner 和快照。

## 开发循环

1. 阅读 `AGENTS.md` 和相关 skill。
2. 在 `test/` 写一个失败测试。
3. 在 `src/` 做最小实现。
4. 运行聚焦测试，然后运行 `pnpm test`。
5. 更新英文、中文文档和 `.i18n.yaml` 记录。
6. 运行 `pnpm doc-sync`。
7. 运行 `node dist/cli.js detect`。

## 生成配置

`.claude/` 是生成目录并已加入 gitignore。修改 `.agents/` 后运行 `node dist/cli.js normalize`。先用 `--dry-run` 检查计划，只对已审阅的冲突使用 `--fix`。

`.agents/gates.yaml` 是 authored 并提交。`scripts/dab-check.mjs` 和 `scripts/dab-gates.json` 是生成文件并提交，使 CI 和其他 checkout 无需 normalize 就获得同一个 runner。Normalize 更新未修改的较旧 runner 或过期快照，并保留被修改、无版本和较新的文件且产生 warning。DAB 不生成 CI 文件；请手动把 `node scripts/dab-check.mjs --strict` 接入 provider。

## 测试

测试使用临时仓库和真实文件。覆盖正常路径、冲突路径、拒绝路径和恢复路径。优先断言真实行为，而不是 mock 行为。

## 文档

文档流程：[docs/AGENTS.md](AGENTS.md)。

## 发布

把 `package.json` 更新到发布版本，然后运行 `pnpm build && node dist/cli.js normalize`，刷新 dogfood `dab-*` skill markers 和 `dab.yaml` source 哈希。更新 `CHANGELOG.md` 及其中文配对、README/roadmap 的发布状态和链接，运行完整测试、`pnpm doc-sync`、`npm pack`，并在临时目录安装 tarball 做 CLI 冒烟测试。提交 normalize 后的树，再打 `v<version>` tag。

Release workflow 由 `v*` tag 触发。它检查 tag 与 `package.json` 一致，运行 normalize 并拒绝生成漂移，运行完整测试和 pack 冒烟测试，以 npm provenance 发布 `@saydone/dab`，通过 `npm-release` environment，并创建 GitHub Release。`npm-release` environment 需要维护者批准。0.1.1 的 bootstrap 是手动发布；0.1.2 及以后使用 GitHub OIDC。新包或新仓库仍需为该 workflow 的 `.github/workflows/release.yml` 和 `npm-release` environment 做一次性的 npm Trusted Publisher 配置。
