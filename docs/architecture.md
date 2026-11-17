English | [中文](architecture.zh.md)

# Architecture

DAB is a control plane, not an agent runtime. It compiles authored source facts into harness configuration and keeps the two sides comparable. Claude Code is the only implemented target in this phase.

## Source of truth

| Fact | Authored home | Projection |
|---|---|---|
| Project instructions | `AGENTS.md` | `.claude/CLAUDE.md` symlink or generated shim |
| Roles | `.agents/agents/` | `.claude/agents/` symlinks |
| Skills | `.agents/skills/` | `.claude/skills/` symlinks |
| Rules | `.agents/rules/` | `.claude/rules/` symlinks |
| Shared safety policy | `.agents/policies/project.yaml` | `.claude/settings.json` |
| Claude Code policy | `.agents/adapters/claude-code.yaml` | `.claude/settings.json` |
| Hooks | `.agents/hooks/` | `.claude/settings.json` |
| Shared memory | `.agents/memory/` | Read on demand |
| Personal memory | Claude Code auto memory | Machine-local |
| Decisions | `.agents/notes/` | Read on demand |
| Metadata | `dab.yaml` | Per-target generated records |

The same shape applies at global scope with `~/.agents/` as the authored home and `$HOME` as the target root. Project and global scopes are independent: DAB never merges them and offers no `dab global` command.

## Scopes and roots

| Scope | Source root | Manifest | Target roots |
|---|---|---|---|
| Project | `<repo>/.agents/` and `<repo>/AGENTS.md` | `<repo>/dab.yaml` | under `<repo>` |
| Global | `~/.agents/` and `~/.agents/AGENTS.md` | `~/.agents/dab.yaml` | under `$HOME` |

- Location determines scope. The manifest's `scope` field validates the resolved scope and never overrides it.
- `dab init [path]` treats `path`, or the current directory, as the exact source root and creates it when missing. `dab init ~/.agents` bootstraps the global scope.
- Other commands walk upward from the current directory to the nearest directory containing `dab.yaml` or `.agents/`. Inside `$HOME/.agents`, they use global scope instead.
- A `scope: global` manifest must resolve to `$HOME/.agents`; a `scope: project` manifest must not.
- `dab init` refuses to create a source root inside an existing one, so a nested `.agents` tree is an error.
- Project commands write only under the repository root; global commands write only under `$HOME`. A target path outside the scope root is an error.

## Core loop

1. `dab init` scans a repository and writes the authored skeleton for one scope.
2. `dab normalize` resolves the scope root, prechecks every enabled target, and writes only when all prechecks pass.
3. `dab detect` checks drift, ownership and scope without writing.
4. `dab policy explain --target <provider>` shows the effective result for one target.

## Targets and adapters

A v2 manifest declares `scope`, `targets` and the per-target generated records:

```yaml
version: 2
scope: project
targets:
  - provider: claude-code
    enabled: true
    options:
      minVersion: 2.1.277
      instructions: symlink
paths:
  agents: .agents
  claude: .claude
```

- A target adapter maps common facts into one harness and parses that target's provider options. Adapters never own agent, skill or rule definitions.
- Common facts live in `.agents/`; provider-specific policy lives in `.agents/adapters/<provider>.yaml`; provider options live in the target's `targets` entry.
- Each target records its own settings, instructions and projections under `generated.targets`, keyed by provider.
- Only `claude-code` has an adapter in this phase. An enabled `codex` or `dsh` target fails with `target.unsupported` instead of being skipped or partially written.
- Codex, DSH and global settings adoption/merge are later plan series, not part of this phase.

## Ownership and failure semantics

- A target path is managed only when the manifest's generated record says DAB created it: a symlink to the expected source, or a generated file matching its recorded hash.
- Any other existing file, directory or foreign symlink is unmanaged. `normalize` and `detect` report a conflict, and `normalize` writes nothing while a conflict exists.
- `dab normalize --fix` moves an unmanaged target path into a timestamped `.dab/backups/` directory before adopting it. Without `--fix`, DAB never replaces or deletes an unmanaged path.
- A configured target with no safe mapping is an error. One failing target blocks writes for every target, so a run never leaves a half-aligned tree.
- `--dry-run` runs the same precheck and exit codes without writing.
- A root `CLAUDE.md` is user-owned and is always a fatal conflict.

## Claude Code instructions

- `.claude/CLAUDE.md` is a symlink to the scope's instructions by default: `../AGENTS.md` in project scope and `../.agents/AGENTS.md` in global scope.
- `instructions: generated` writes the `@../AGENTS.md` import shim instead. Use it when a Claude Code build cannot follow the symlink.
- `instructions: disabled` writes no instruction artifact and removes a managed one.
- A managed artifact is repaired in place. An unmanaged artifact needs `--fix`, which backs it up first.
- Instructions are recorded as `generated` status, never `native`, because DAB materializes the artifact Claude Code reads.

## Global settings

- Global scope may align instructions, agents, skills and rules under `$HOME`.
- `~/.claude/settings.json` is user-owned in this phase: DAB reports a warning and does not read, write or merge it.
- `$HOME/.gitignore` is user-owned and read-only as well.
- Explicit global settings adoption and merge is a later plan.

## Components

- `src/cli.ts` dispatches commands and owns exit codes.
- `src/commands/` implements `init`, `detect`, `normalize` and `policy explain`.
- `src/model/` parses authored files, resolves scopes and discovers agents, skills, rules, hooks and memory.
- `src/adapter/types.ts` defines the target adapter contract.
- `src/adapter/registry.ts` maps provider names to adapters; only `claude-code` is registered.
- `src/adapter/claude-code/` compiles policy, renders settings and manages instruction and projection artifacts.
- `src/detect/` contains drift and safety checks.
- `src/init/` scans repositories and renders templates.
- `src/docs/` runs the bilingual documentation gates.

## Generated outputs

- `.claude/settings.json` is a deterministic project artifact; global settings are read-only in this phase.
- `.claude/CLAUDE.md` is a symlink to the scope's instructions by default, with the generated import shim as an explicit fallback.
- `.claude/agents/`, `.claude/skills/` and `.claude/rules/` contain per-entry symlinks.
- `dab.yaml` stores `scope`, `targets` and per-target generated records with source hashes, target hashes and projection lists.
- `.dab/backups/` stores originals before `--fix` adopts an unmanaged path.

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
- Adapters map facts and parse provider options; they never own agent, skill or rule definitions.
- Unsupported provider semantics fail loudly instead of silently widening permissions; one failing target blocks all writes.
- DAB does not merge project and global scopes and does not adopt global settings in this phase.
- Path deny rules are tool-level guardrails, not a sandbox; `Bash`, `Grep`, `Glob`, `NotebookEdit` and wrapper commands can bypass them.
- Hooks are trusted executable code; DAB checks metadata and static safety, not runtime behavior.
- v0.1 has no eval loop; `docs/roadmap.md` carries evidence work.
- v0.1 accepts only the default `.agents` and `.claude` paths.
