# Agent Note: GitHub npm release flow

Status: implemented

English | [中文](2026-11-19-github-release-flow.zh.md)

## Problem

The first npm release needed a repeatable, auditable path from a tagged commit to a public package. Publishing from a laptop mixes verification, credentials and release notes, and trusted publishing cannot be configured before the package exists.

## Decision

- The package is `@saydone/dab` with `publishConfig.access: public`; `dab` remains the bin.
- A `v*` tag runs `.github/workflows/release.yml`. The verify job runs the full suite, generated-config check, pack smoke test and uploads the tarball.
- The publish job waits on the `npm-release` environment, which requires the maintainer as a required reviewer. It uses GitHub OIDC with `id-token: write`, publishes with `npm publish --provenance --access public`, and creates the GitHub Release after npm succeeds.
- The workflow skips `npm publish` when the version already exists, so reruns and the first manual bootstrap are idempotent.
- The first release is published manually with npm 2FA and `--access public`; the npm Trusted Publisher is then configured for this workflow and environment. Later releases use OIDC and no long-lived token.

## Alternatives considered

**Manual publishing only.** Rejected because it depends on local state, skips the pack smoke test and does not produce provenance.

**Trigger on GitHub Release published.** Rejected as the primary flow because the release page would exist before npm succeeds. Tag push keeps the release page as the last step.

**Store a long-lived NPM_TOKEN.** Rejected because OIDC avoids a reusable publish credential. A short-lived token is only a bootstrap option.

**Publish the tarball built in the verify job.** Deferred; the workflow rebuilds from the tagged commit and the tarball is deterministic. Publishing the uploaded artifact is a later hardening step.

## Consequences

- The `npm-release` environment requires maintainer approval; the npm Trusted Publisher still needs one-time configuration.
- A tag that does not match `package.json` fails before publishing.
- The first release remains a manual step; later releases are fully tag-driven.
- Rerunning a partially completed release is safe because the version check is idempotent.

## Verification

- `test/release.test.ts` checks the package identity, publish configuration, release workflow contents and README install paths.
- CI runs `npm pack` and a scoped `npx @saydone/dab` smoke test.
- `pnpm test`, `pnpm typecheck` and `pnpm doc-sync` pass.
- The `v0.1.1` tag run (`45116029166`) passed. The publish job skipped `npm publish` because `@saydone/dab@0.1.1` already existed and created the [GitHub Release](https://github.com/pzsoftchen/drive-agent-build/releases/tag/v0.1.1).

## Related

- [Development release section](../../../../docs/development.md#release)
- [CLI install section](../../../../docs/user/cli.md#install)
- [Pre-release contracts](../architecture/2026-11-18-pre-release-contracts.md)
