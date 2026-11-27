# Agent Note: 双语发布日志

Status: implemented

[English](2026-11-27-bilingual-release-notes.md) | 中文

## 问题

DAB 已经维护英文和简体中文双语 changelog，但 release workflow 使用 `gh release create --generate-notes`。GitHub 根据 commit 和 pull request 元数据生成英文正文，导致 GitHub Release 不反映已评审的双语 changelog，中文发布日志也不可见。

## 决策

- 双语 changelog 仍是唯一来源，不新增独立的发布日志文件。
- `node dist/release/cli.js v<version>` 从 `CHANGELOG.md` 和 `CHANGELOG.zh.md` 中提取精确版本章节，输出包含 `## English` 和 `## 中文` 的正文，并链接两个版本化 changelog。
- release workflow 先构建 release 工具，再生成 `release-notes.md`，通过 `gh release create --notes-file` 写入；如果 Release 已存在，则使用 `gh release edit --notes-file` 刷新正文。
- 版本章节缺失或为空会在创建/编辑 GitHub Release 之前 fail loud。
- tag/package version 检查、npm 发布和 `npm-release` 审批流程保持不变。

## 备选方案

**继续使用 `--generate-notes`。** 被拒绝：它只生成英文正文，并绕过已评审的 changelog。

**为每个版本增加独立发布日志文件对。** 被拒绝：这会复制 changelog，并增加另一个可能漂移的双语配对面。

**采用 release-please、semantic-release 或 projen 式发布生成。** 推迟：这些工具会接管版本、tag 和更大范围的 CI。DAB 只需要从已评审 changelog 生成确定性的双语正文。

**机器翻译英文日志。** 被拒绝：中文 changelog 已经由人编写和评审；运行时翻译可靠性更低，还会增加服务依赖。

**在 workflow 中用内联 shell 解析生成正文。** 被拒绝：提取和失败行为需要测试，release workflow 应调用已评审代码。

## 后果

- 每次发布都必须同时添加 `CHANGELOG.md` 和 `CHANGELOG.zh.md` 的对应章节；缺失或为空会阻止 release job。
- 对给定 tag，发布日志是确定性的；可以在本地用 `pnpm build && node dist/release/cli.js v<version>` 重新生成。
- 重跑会更新已有 GitHub Release 正文，而不是保留过期的自动生成日志。
- publish job 在生成日志前构建 release 工具。npm 发布仍走原有 OIDC/provenance 路径。
- 只改一侧 changelog 时，`doc-sync` 和 release notes 测试不会自动补齐；维护者必须在同一次发布变更中更新两侧。

## 验证

- `test/release-notes.test.ts` 覆盖精确章节提取、`v` 前缀、缺失章节、双语渲染和版本化链接。
- `test/release.test.ts` 检查 release workflow 使用 `dist/release/cli.js` 和 `--notes-file`。
- `v0.1.2` 的示例正文包含两个 changelog 章节，且不包含 `Unreleased` 内容。
- 完整测试、typecheck 和 doc-sync 在变更后通过。

## 相关

- [开发发布章节](../../../../docs/development.zh.md#发布)
- [变更日志](../../../../CHANGELOG.zh.md)
- [GitHub 发布流程](2026-11-19-github-release-flow.zh.md)
- [GitHub Release v0.1.2](https://github.com/pzsoftchen/drive-agent-build/releases/tag/v0.1.2)
