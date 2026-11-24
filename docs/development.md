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

## Tests

Tests use temporary repositories and real files. They cover normal paths, conflict paths, refusal paths and recovery paths. Prefer real behavior over mock assertions.

## Documentation

Documentation workflow: [docs/AGENTS.md](AGENTS.md).

## Release

Update `package.json` to the release version, then run `pnpm build && node dist/cli.js normalize` to refresh the dogfood `dab-*` skill markers and `dab.yaml` source hashes. Update `CHANGELOG.md` and its Chinese pair, README/roadmap release status and links, run the full suite, `pnpm doc-sync`, `npm pack`, and install the tarball in a temporary directory for a CLI smoke test. Commit the normalized tree, then tag `v<version>`.

The release workflow runs on `v*` tags. It verifies the tag matches `package.json`, runs normalize and rejects generated drift, runs the full suite and pack smoke test, publishes `@saydone/dab` with npm provenance through the `npm-release` environment, and creates the GitHub Release. The `npm-release` environment requires maintainer approval. The 0.1.1 bootstrap was published manually; 0.1.2 and later use GitHub OIDC. A new package or repository still needs a one-time npm Trusted Publisher entry for `.github/workflows/release.yml` with the `npm-release` environment.
