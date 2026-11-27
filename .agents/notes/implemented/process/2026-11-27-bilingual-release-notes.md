# Agent Note: Bilingual release notes

Status: implemented

English | [中文](2026-11-27-bilingual-release-notes.zh.md)

## Problem

DAB already maintained paired English and Simplified Chinese changelogs, but the release workflow used `gh release create --generate-notes`. GitHub generated an English-only body from commit and pull-request metadata, so the GitHub Release did not reflect the reviewed, paired changelog and the Chinese release log was invisible there.

## Decision

- The paired changelog remains the single source of truth. No separate release-note files are introduced.
- `node dist/release/cli.js v<version>` extracts the exact version section from `CHANGELOG.md` and `CHANGELOG.zh.md` and emits one body with `## English` and `## 中文` sections plus links to both versioned changelogs.
- The release workflow builds the release tooling, generates `release-notes.md`, and passes it to `gh release create --notes-file`. If the release already exists, it uses `gh release edit --notes-file` so reruns and retries refresh the body.
- A missing or empty version section fails loud before the GitHub Release is created or edited.
- The tag and package version check, npm publication and `npm-release` approval remain unchanged.

## Alternatives considered

**Keep `--generate-notes`.** Rejected: it produces an English-only body and bypasses the reviewed changelog.

**Add one release-note file pair per version.** Rejected: it duplicates the changelog and creates another bilingual pairing surface that can drift.

**Adopt release-please, semantic-release or projen-style release generation.** Deferred: those tools own versioning, tags and CI more broadly. DAB only needs a deterministic bilingual body from an already reviewed changelog.

**Machine-translate the English notes.** Rejected: the Chinese changelog is authored and reviewed; runtime translation would be less reliable and would add a service dependency.

**Generate the body in the workflow with inline shell parsing.** Rejected: extraction and failure behavior need tests, and the release workflow should call reviewed code.

## Consequences

- Every release must add matching `CHANGELOG.md` and `CHANGELOG.zh.md` sections; a missing or empty section blocks the release job.
- Release notes are deterministic for a given tag and can be regenerated locally with `pnpm build && node dist/release/cli.js v<version>`.
- A rerun updates an existing GitHub Release body instead of leaving stale generated notes.
- The publish job builds before generating notes. npm publication remains the same OIDC/provenance path.
- If only one changelog changes, `doc-sync` and the release notes test do not make the release bilingual; the maintainer must update both sides in the same release change.

## Verification

- `test/release-notes.test.ts` covers exact section extraction, `v` prefixes, missing sections, bilingual rendering and versioned links.
- `test/release.test.ts` checks that the release workflow uses `dist/release/cli.js` and `--notes-file`.
- The sample `v0.1.2` body contains both changelog sections and no `Unreleased` content.
- The full suite, typecheck and doc-sync pass after the change.

## Related

- [Development release section](../../../../docs/development.md#release)
- [Changelog](../../../../CHANGELOG.md)
- [Existing GitHub release flow](2026-11-19-github-release-flow.md)
- [GitHub Release v0.1.2](https://github.com/pzsoftchen/drive-agent-build/releases/tag/v0.1.2)
