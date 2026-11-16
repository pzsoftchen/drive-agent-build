English | [中文](CONTRIBUTING.zh.md)

# Contributing

DAB is developed with the same workflow it recommends. Read `AGENTS.md` first.

## Before you start

- Use Node `>=24.9` and pnpm.
- Run `pnpm install` and `pnpm build`.
- Run `node dist/cli.js normalize` after building.
- Read `docs/development.md`.

## Development loop

1. Write a failing test for the behavior.
2. Run the focused test and confirm the failure.
3. Implement the smallest change.
4. Run `pnpm test` and `pnpm typecheck`.
5. Update English and Chinese docs and the `.i18n.yaml` record.

## Documentation changes

- Every human-facing `foo.md` has `foo.zh.md` and `foo.i18n.yaml`.
- Run `pnpm run verify-translation-pairing --write` after confirming the pair.
- Run `pnpm doc-sync` before committing.

## Pull requests

- Explain the behavior change and the tests that prove it.
- Call out generated files, permission changes and migration notes.
- Link the relevant Agent Note when a decision changes.
- Do not commit `.claude/` outputs.

## Questions

Open an issue with the command, output and relevant authored files.
