English | [中文](claude-code.zh.md)

# Claude Code integration

DAB targets Claude Code `>=2.1.277` and writes only public configuration formats. It is the only implemented target in this phase.

## What Claude Code reads

- `.claude/CLAUDE.md` for project instructions, a symlink to `AGENTS.md` by default.
- `.claude/agents/` for project subagents.
- `.claude/skills/` for project skills.
- `.claude/rules/` for path-scoped rules.
- `.claude/settings.json` for permissions and hooks.
- `.claude/settings.local.json` for local user settings, owned by the user.

`AGENTS.md` remains the only authored instruction source. Global scope uses the same layout under `$HOME`, with instructions in `~/.agents/AGENTS.md`.

## Instruction artifact

- `.claude/CLAUDE.md` is a symlink to `../AGENTS.md` in project scope and `../.agents/AGENTS.md` in global scope.
- Some Claude Code builds gate native `AGENTS.md` loading, and some filesystems cannot follow the link reliably. Set `instructions: generated` on the target to write the `@../AGENTS.md` import shim instead.
- Set `instructions: disabled` to write no instruction artifact and remove a managed one.
- A root `CLAUDE.md` is user-owned and always fatal; merge its content into `AGENTS.md` and remove it.
- The artifact is recorded as `generated`, never `native`, because DAB materializes the file Claude Code reads.

```yaml
targets:
  - provider: claude-code
    enabled: true
    options:
      instructions: generated
```

## Ownership and conflicts

- DAB links individual agents, skills and rules rather than whole directories. This keeps provider-specific files possible later and makes ownership explicit.
- A path is managed only when the generated record lists it: a symlink to the expected source, or a generated file matching its hash.
- An existing physical copy, directory or foreign symlink is unmanaged. `dab detect` reports it, and `dab normalize` refuses to write while it exists.
- `dab normalize --fix` backs up each unmanaged path under `.dab/backups/` before replacing it. Review the backup paths before running it.
- Identity checks use real paths, so a symlinked `.claude` directory that escapes the scope root fails instead of writing outside it.

## Memory model

- Shared team facts live in `.agents/memory/` and are reviewed in pull requests.
- Personal auto memory stays machine-local and is never committed.
- Agents may use `memory: user` or `memory: local`, but `memory: project` is rejected because it creates a second team memory store.
- `dab eval` is planned for v0.2 and will use an empty memory directory.
- In global scope, ancestor and personal-memory checks are skipped because user-level Claude data is not a project artifact.

## Permissions and hooks

Project policy is compiled into `.claude/settings.json`. Project deny rules are a hard boundary for Claude Code file tools, but `Bash`, wrapper commands and other tools can bypass path rules. Agent definitions can narrow tools and append hooks, but cannot remove project hooks. Hook scripts are checked for path escapes, duplicate ids, line endings, executability and secrets.

## Global settings

- `~/.claude/settings.json` is user-owned in this phase. DAB reports a warning and does not read, write or merge the file.
- `$HOME/.gitignore` is read-only as well.
- Global instructions, agents, skills and rules are still aligned through projection files under `$HOME`.
- Explicit global settings adoption and merge is a later plan; keep global permissions and hooks in your own settings until then.

## Troubleshooting

1. Run `dab detect --json` and read the diagnostics by code.
2. Run `dab normalize --dry-run` to inspect planned repairs.
3. Run `dab normalize --fix` only after reviewing backup paths.
4. Run `dab policy explain --target claude-code --agent <name>` to inspect effective permissions.
5. Run `dab --help` for the command list.
