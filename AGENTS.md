# DAB — Drive Agent as Builder

DAB turns `AGENTS.md` and `.agents/` into governed Claude Code configuration.
`.claude/` is generated; never edit it by hand.

## Project map

- `src/cli.ts`: command dispatch and exit codes.
- `src/commands/`: `init`, `detect`, `normalize`, `policy explain`.
- `src/model/`: authored source schemas and discovery.
- `src/adapter/claude-code/`: policy compilation, projections and settings.
- `src/detect/`: drift checks.
- `src/init/`: repository scan and templates.
- `src/docs/`: bilingual documentation gates.
- `docs/`: architecture, development and user documentation.
- `.agents/`: agents, skills, rules, policies, hooks and shared memory.

## Commands

- Install: `pnpm install`
- Build: `pnpm build`
- Test: `pnpm test`
- Typecheck: `pnpm typecheck`
- Docs gate: `pnpm doc-sync`
- Normalize generated config: `node dist/cli.js normalize`
- Detect drift: `node dist/cli.js detect`

## Rules

1. `AGENTS.md` and `.agents/` are the only authored agent configuration. Never edit `.claude/` by hand.
2. Write a failing test before production code. Run the focused test, then the full suite.
3. Keep TypeScript ESM, Node `>=24.9`, and the public `dab` command stable.
4. Fail loud: no silent fallback, no silent permission widening, no deletion of unmanaged files.
5. Update English and Chinese documentation in the same change. The pairing record is part of the change.
6. Run `pnpm doc-sync` before committing documentation changes.
7. Record important decisions in `.agents/notes/` with alternatives, consequences and verification.
8. Use `feature-delivery` for scoped work and `doc-sync` when changing paired docs.

## Documentation

- [Architecture](docs/architecture.md)
- [Development](docs/development.md)
- [CLI](docs/user/cli.md)
- [Claude Code integration](docs/user/claude-code.md)
- [Agent Note 0001](.agents/notes/implemented/architecture/2026-11-16-agents-source-tree.md)
- [Agent Note 0002](.agents/notes/implemented/architecture/2026-11-16-claude-md-compat-shim.md)
