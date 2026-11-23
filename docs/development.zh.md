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
- `node dist/cli.js detect --strict` 检查本仓库的生成配置，并在存在 warning 时失败。
- `node dist/cli.js normalize --dry-run` 展示待执行的投影变更。

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

## 测试

测试使用临时仓库和真实文件。覆盖正常路径、冲突路径、拒绝路径和恢复路径。优先断言真实行为，而不是 mock 行为。

## 文档

文档流程：[docs/AGENTS.md](AGENTS.md)。

## 发布

只在 `package.json` 中更新版本；`dab --version` 从那里读取。更新 `CHANGELOG.md` 及其中文配对，运行完整测试和 `pnpm doc-sync`，运行 `npm pack` 并在临时目录安装 tarball 做 CLI 冒烟测试，然后打标签。

Release workflow 由 `v*` tag 触发。它检查 tag 与 `package.json` 一致，运行完整测试和 pack 冒烟测试，以 npm provenance 发布 `@saydone/dab`，并通过 `npm-release` environment 创建 GitHub Release。`npm-release` environment 需要维护者批准。首次发布使用 `npm publish --access public` 手动完成；在使用 OIDC 前，为 `.github/workflows/release.yml` 和 `npm-release` environment 配置 npm Trusted Publisher。
