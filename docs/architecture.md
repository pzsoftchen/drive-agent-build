English | [中文](architecture.zh.md)

# Architecture

DAB is conceptually a driving system for Builder-directed agent work. This repository implements its control plane: it compiles authored source facts into harness configuration and keeps the two sides comparable. Claude Code is the only implemented target in this phase.

## Current implementation boundary

- The current `main` branch implements the DAD configuration-governance foundation.
- v0.2 targets evidence for one development task at a time.
- A DAB goal loop, task graph, `GoalRun`, `TaskRun` and cross-task learning model are not part of the current architecture.

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

A complete v2 project manifest (`dab normalize` writes the `generated` records):

```yaml
version: 2
scope: project
project:
  id: example
  name: Example
profile: feature
targets:
  - provider: claude-code
    enabled: true
    options:
      minVersion: 2.1.277
      instructions: symlink
paths:
  agents: .agents
  claude: .claude
generated:
  targets:
    - provider: claude-code
      settings:
        path: .claude/settings.json
        sha256: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      instructions:
        path: .claude/CLAUDE.md
        mode: symlink
        sha256: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      projections: []
```

- A target adapter maps common facts into one harness and parses that target's provider options. Adapters never own agent, skill or rule definitions.
- The current adapter foundation is transitional: shared command code still contains Claude-specific prechecks and path assumptions that future targets must isolate.
- Common facts live in `.agents/`; provider-specific policy lives in `.agents/adapters/<provider>.yaml`; provider options live in the target's `targets` entry.
- Each target records its own settings, instructions and projections under `generated.targets`, keyed by provider.
- Only `claude-code` has an adapter in this phase. An enabled `codex` or `dsh` target fails with `target.unsupported` instead of being skipped or partially written.
- Codex, DSH and global settings adoption/merge are later plan series, not part of this phase.

## Ownership and failure semantics

- The manifest's `generated` record is the ownership authority for a target path.
- A recorded instruction artifact or projection symlink that drifts is repaired in place (`repair`/`repair-link`) without `--fix` or a backup. A recorded settings file that differs from the expected content is backed up and rewritten, even when it is a symlink or directory.
- An unrecorded path that does not already match the expected artifact is unmanaged. `normalize` and `detect` report it, and `normalize` writes nothing without `--fix`.
- A physical file or directory at a projection target is a conflict even when recorded. `dab normalize --fix` moves it into a timestamped `.dab/backups/` directory before replacing it; unmanaged symlinks and settings files require the same `--fix`.
- `normalize` adopts and records an unrecorded symlink that already points at the expected source, or an instruction artifact that already matches the configured mode, without a rewrite.
- A configured target with no safe mapping fails with `target.unsupported`. One failing target blocks writes for every target, and `--dry-run` runs the same precheck and exit codes without writing.
- A root `CLAUDE.md` is user-owned and is always a fatal conflict.

## Claude Code instructions

- `.claude/CLAUDE.md` is a symlink to the scope's instructions by default: `../AGENTS.md` in project scope and `../.agents/AGENTS.md` in global scope.
- `instructions: generated` writes an import shim instead: `@../AGENTS.md` in project scope and `@../.agents/AGENTS.md` in global scope. Use it when a Claude Code build cannot follow the symlink.
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

## Frontmatter compatibility

- Agent, skill and rule files are projected into Claude Code and can gain new top-level fields before DAB knows them.
- DAB validates every field it interprets, keeps unknown top-level fields, and reports them as warnings with the source file.
- A warning suggests the closest known field when an unknown top-level field looks like a typo. Typos in scope or permission keys can change effective behavior, so treat these warnings as errors in CI.
- Unknown fields in DAB-owned structures such as hooks, policies, manifests and memory entries remain errors.
- This keeps a Claude Code upgrade from breaking every agent while preserving fail-loud behavior for configuration DAB owns.

## JSON output contract

- Every command that supports `--json` includes `schemaVersion: 1` at the top level.
- The version covers the top-level envelope and any nested provider payloads. Commands use different payload shapes (`targets`, `target`, `normalize`); nested payloads do not carry their own version.
- JSON paths are relative to the scope root, except `init.root`, which identifies the initialized scope.
- `--json` cannot be combined with `--help` or `--version`.
- Releases may add fields; removing a field or changing its meaning requires a new schema version.
- The CLI JSON is the public contract. Imported TypeScript result types are implementation details.

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

Every published product document uses `foo.md`, `foo.zh.md` and `foo.i18n.yaml`. The gate checks language switches, section structure, fenced code, inline code, link locale and hashes. Instruction files such as `AGENTS.md` stay English-only. Internal working plans under `docs/superpowers/` stay Chinese-only and are checked for links and formatting, not pairing.

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
- All commands reject Windows in v0.1; junction support is deferred.
