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
- `node dist/cli.js detect` 检查本仓库的生成配置。
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

人类文档是配对的。确认两侧后运行 `pnpm run verify-translation-pairing --write`，然后运行 `pnpm doc-sync`。Agent 指令、skills 和 roles 是英文单源，并继续受链接、排版和预算门禁覆盖。除非明确要求，`docs/superpowers/` 下的 specs 和 plans 只使用中文，不参与双语配对，但仍受链接和排版门禁覆盖。

## 发布

更新 `package.json` 中的版本，更新 `CHANGELOG.md` 及其中文配对，运行完整测试和 `pnpm doc-sync`，然后打标签。
