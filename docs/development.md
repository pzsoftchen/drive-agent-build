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
- `node dist/cli.js detect --strict` checks this repository's generated configuration and fails on warnings.
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

Published product docs are paired. Run `pnpm run verify-translation-pairing --write` after confirming both sides, then `pnpm doc-sync`. Agent instructions, skills and roles are English single-source and covered by link, wrap and configured budget gates. Internal specs and plans under `docs/superpowers/` are Chinese-only by design; they are excluded from pairing but stay covered by link and wrap checks.

## Release

Update the version only in `package.json`; `dab --version` reads it from there. Update `CHANGELOG.md` and its Chinese pair, run the full suite and `pnpm doc-sync`, run `npm pack` and install the tarball in a temporary directory for a CLI smoke test, then tag the release.
