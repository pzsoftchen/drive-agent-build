English | [中文](claude-code.zh.md)

# Claude Code integration

DAB targets Claude Code `>=2.1.277` and writes only public configuration formats.

## What Claude Code reads

- `AGENTS.md` for project instructions, through the generated shim.
- `.claude/agents/` for project subagents.
- `.claude/skills/` for project skills.
- `.claude/rules/` for path-scoped rules.
- `.claude/settings.json` for permissions and hooks.
- `.claude/settings.local.json` for local user settings, owned by the user.

## The generated shim

Some builds gate native `AGENTS.md` loading. DAB therefore generates `.claude/CLAUDE.md` with `@../AGENTS.md`. `AGENTS.md` remains the only authored instruction source. An unmanaged CLAUDE.md is reported by `dab detect`.

## Memory model

- Shared team facts live in `.agents/memory/` and are reviewed in pull requests.
- Personal auto memory stays machine-local and is never committed.
- Agents may use `memory: user` or `memory: local`, but `memory: project` is rejected because it creates a second team memory store.
- `dab eval` is planned for v0.2 and will use an empty memory directory.

## Projections

DAB links individual agents, skills and rules rather than whole directories. This keeps provider-specific files possible later and makes ownership explicit. A physical copy at a projection target is a conflict; `--fix` backs it up before replacing it.

## Permissions and hooks

Project policy is compiled into `.claude/settings.json`. Project deny rules are a hard boundary. Agent definitions can narrow tools and append hooks, but cannot remove project hooks. Hook scripts are checked for path escapes, duplicate ids, line endings, executability and secrets.

## Troubleshooting

1. Run `dab detect --json` and read the diagnostics by code.
2. Run `dab normalize --dry-run` to inspect planned repairs.
3. Run `dab normalize --fix` only after reviewing backup paths.
4. Run `dab policy explain --agent <name>` to inspect effective permissions.
5. Run `dab --help` for the command list.
