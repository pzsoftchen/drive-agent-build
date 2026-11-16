English | [中文](architecture.zh.md)

# Architecture

DAB is a control plane, not an agent runtime. It compiles authored project facts into Claude Code configuration and keeps the two sides comparable.

## Source of truth

| Fact | Authored home | Projection |
|---|---|---|
| Project instructions | `AGENTS.md` | `.claude/CLAUDE.md` shim |
| Roles | `.agents/agents/` | `.claude/agents/` symlinks |
| Skills | `.agents/skills/` | `.claude/skills/` symlinks |
| Rules | `.agents/rules/` | `.claude/rules/` symlinks |
| Shared safety policy | `.agents/policies/project.yaml` | `.claude/settings.json` |
| Claude Code policy | `.agents/adapters/claude-code.yaml` | `.claude/settings.json` |
| Hooks | `.agents/hooks/` | `.claude/settings.json` |
| Shared memory | `.agents/memory/` | Read on demand |
| Personal memory | Claude Code auto memory | Machine-local |
| Decisions | `.agents/notes/` | Read on demand |
| Metadata | `dab.yaml` | Generated hashes |

## Core loop

1. `dab init` scans a repository and writes the authored skeleton.
2. `dab normalize` compiles policy, writes settings and projects symlinks.
3. `dab detect` checks drift without writing.
4. `dab policy explain` shows the effective result.

## Components

- `src/cli.ts` dispatches commands and owns exit codes.
- `src/commands/` implements `init`, `detect`, `normalize` and `policy explain`.
- `src/model/` parses authored files and discovers agents, skills, rules, hooks and memory.
- `src/adapter/claude-code/` compiles policy, renders settings and manages projections.
- `src/detect/` contains drift and safety checks.
- `src/init/` scans repositories and renders templates.
- `src/docs/` runs the bilingual documentation gates.

## Generated outputs

- `.claude/settings.json` is a deterministic build artifact.
- `.claude/CLAUDE.md` is a generated import shim for `AGENTS.md`.
- `.claude/agents/`, `.claude/skills/` and `.claude/rules/` contain per-entry symlinks.
- `dab.yaml` stores generated hashes and the projection list.
- `.dab/backups/` stores originals before `--fix` replaces conflicts.

## Policy compilation

Shared policy is limited to path read and write restrictions, command execution restrictions and a small capability set. Claude Code-specific rules live in the adapter. Deny wins, and an exact allow/deny conflict fails compilation rather than widening access.

```yaml
version: 1
defaultMode: default
write:
  deny:
    - .claude/settings.json
execute:
  ask:
    - git push
```

## Documentation gates

Every human-facing document uses `foo.md`, `foo.zh.md` and `foo.i18n.yaml`. The gate checks language switches, section structure, fenced code, inline code, link locale and hashes. Instruction files such as `AGENTS.md` stay English-only and are checked by the link, wrap and budget gates.

## Boundaries

- DAB does not run its own agent loop.
- DAB does not import Claude Code internals.
- DAB never edits `.claude/settings.local.json`.
- Unsupported provider semantics fail loudly instead of silently widening permissions.
- Path deny rules are tool-level guardrails, not a sandbox; `Bash`, `Grep`, `Glob`, `NotebookEdit` and wrapper commands can bypass them.
- Hooks are trusted executable code; DAB checks metadata and static safety, not runtime behavior.
- v0.1 has no eval loop; `docs/roadmap.md` carries evidence work.
- v0.1 accepts only the default `.agents` and `.claude` paths.
