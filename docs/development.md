English | [中文](development.zh.md)

# Development

DAB uses TypeScript ESM and Node `>=24.9`. The repository dogfoods its own agent configuration.

## Setup

```bash
pnpm install
pnpm build
node dist/cli.js normalize
pnpm test
```

## Checks

- `pnpm test` runs the unit and integration suite.
- `pnpm typecheck` checks TypeScript.
- `pnpm doc-sync` runs translation pairing, links, wrap, budgets and Agent Note format.
- `node dist/cli.js detect --strict` checks this repository's generated configuration and fails on strict warnings; non-strict warnings remain warnings.
- `node dist/cli.js normalize --dry-run` shows pending projection changes.
- `node scripts/dab-check.mjs` runs the repository's own project gates: `source`, then code and docs commands. Add `--strict` to fail on check and advisory warnings, or `--json` for machine-readable results.
- `pnpm build && node dist/cli.js normalize` refreshes the dogfood gate runner and snapshot after `package.json` or `gates.yaml` changes.

## Development loop

1. Read `AGENTS.md` and the relevant skill.
2. Write a failing test in `test/`.
3. Implement the smallest change in `src/`.
4. Run the focused test, then `pnpm test`.
5. Update English and Chinese docs and the `.i18n.yaml` record.
6. Run `pnpm doc-sync`.
7. Run `node dist/cli.js detect`.

## Generated configuration

`.claude/` is generated and gitignored. After changing `.agents/`, run `node dist/cli.js normalize`. Use `--dry-run` first to inspect the plan and `--fix` only for reviewed conflicts.

`.agents/gates.yaml` is authored and committed. `scripts/dab-check.mjs` and `scripts/dab-gates.json` are generated and committed so CI and other checkouts get the same runner without a normalize step. Normalize updates an unmodified older runner or stale snapshot and preserves modified, unversioned and newer files with warnings. DAB does not generate CI files; wire `node scripts/dab-check.mjs --strict` into the provider manually.

## Tests

Tests use temporary repositories and real files. They cover normal paths, conflict paths, refusal paths and recovery paths. Prefer real behavior over mock assertions.

## Documentation

Documentation workflow: [docs/AGENTS.md](AGENTS.md).

## Release

Update `package.json` to the release version, then run `pnpm build && node dist/cli.js normalize` to refresh the dogfood `dab-*` skill markers and `dab.yaml` source hashes. Update `CHANGELOG.md` and its Chinese pair, README/roadmap release status and links, run the full suite, `pnpm doc-sync`, `npm pack`, and install the tarball in a temporary directory for a CLI smoke test. Commit the normalized tree, then tag `v<version>`.

Release notes are generated from the matching English and Chinese changelog sections by `node dist/release/cli.js v<version>`. Keep both `CHANGELOG.md` and `CHANGELOG.zh.md` sections for the release; a missing or empty section fails loud. The workflow writes the bilingual body with `--notes-file` and refreshes an existing GitHub Release on rerun.

The release workflow runs on `v*` tags. It verifies the tag matches `package.json`, runs normalize and rejects generated drift, runs the full suite and pack smoke test, publishes `@saydone/dab` with npm provenance through the `npm-release` environment, and creates or updates the bilingual GitHub Release. The `npm-release` environment requires maintainer approval. The 0.1.1 bootstrap was published manually; 0.1.2 and later use GitHub OIDC. A new package or repository still needs a one-time npm Trusted Publisher entry for `.github/workflows/release.yml` with the `npm-release` environment.
