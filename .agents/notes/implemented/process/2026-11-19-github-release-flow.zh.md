# Agent Note: GitHub npm 发布流程

Status: implemented

[English](2026-11-19-github-release-flow.md) | 中文

## 问题

首次 npm 发布需要一条从 tag 到公开包的可重复、可审计路径。从本地机器发布会混合验证、凭据和发布说明，而且 trusted publishing 无法在包存在之前配置。

## 决策

- 包名是 `@saydone/dab`，并设置 `publishConfig.access: public`；bin 仍然是 `dab`。
- `v*` tag 运行 `.github/workflows/release.yml`。verify job 运行完整测试、generated-config 检查、pack 冒烟测试，并上传 tarball。
- publish job 等待 `npm-release` environment，该 environment 要求维护者作为 required reviewer。它使用 GitHub OIDC 和 `id-token: write`，以 `npm publish --provenance --access public` 发布，并在 npm 成功后创建 GitHub Release。
- 当版本已存在时，workflow 跳过 `npm publish`，因此重跑和首次手动 bootstrap 都是幂等的。
- 0.1.1 的 bootstrap 使用 npm 2FA 和 `--access public` 手动发布；npm Trusted Publisher 在包存在后为 workflow 和 `npm-release` environment 配置。0.1.2 及以后使用 OIDC，不需要长期 token。

## 备选方案

**只做手动发布。** 被拒绝，因为它依赖本地状态、跳过 pack 冒烟测试，也不产生 provenance。

**用 GitHub Release published 触发。** 不作为主流程，因为 release 页面会在 npm 成功之前存在。tag push 让 release 页面成为最后一步。

**保存长期 NPM_TOKEN。** 被拒绝，因为 OIDC 避免了可复用的发布凭据。短期 token 只作为 bootstrap 选项。

**发布 verify job 构建的 tarball。** 推迟；workflow 从 tag commit 重新构建，tarball 是确定性的。发布上传的 artifact 是后续加固步骤。

## 后果

- `npm-release` environment 需要维护者批准；npm Trusted Publisher 已为本仓库配置，但新包或新仓库仍需自己的一次性条目。
- 与 `package.json` 不一致的 tag 会在发布前失败。
- 0.1.1 的 bootstrap 是手动步骤；0.1.2 及以后完全由 tag 驱动。
- 部分完成的发布可以安全重跑，因为版本检查是幂等的。

## 验证

- `test/release.test.ts` 检查包身份、发布配置、release workflow 内容和 README 安装路径。
- CI 运行 `npm pack` 和 scoped `npx @saydone/dab` 冒烟测试。
- `pnpm test`、`pnpm typecheck` 和 `pnpm doc-sync` 通过。
- `v0.1.1` tag run（`45116029166`）通过。publish job 跳过了 `npm publish`，因为 `@saydone/dab@0.1.1` 已存在，并创建了 [GitHub Release](https://github.com/pzsoftchen/drive-agent-build/releases/tag/v0.1.1)。
- `v0.1.2` tag run（`45387402531`）在配置 Trusted Publisher 和 `npm-release` environment 后端到端通过：verify 通过，publish job 获得批准，npm 以 provenance 发布 `0.1.2`，并创建了 [GitHub Release](https://github.com/pzsoftchen/drive-agent-build/releases/tag/v0.1.2)。npm 现在以 `0.1.2` 作为 latest。

## 相关

- [开发发布章节](../../../../docs/development.zh.md#发布)
- [CLI 安装章节](../../../../docs/user/cli.zh.md#安装)
- [发布前契约](../architecture/2026-11-18-pre-release-contracts.zh.md)
