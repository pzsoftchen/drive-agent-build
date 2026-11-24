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
| Hooks (optional, advanced) | `.agents/hooks/` | `.claude/settings.json` |
| Shared memory (optional, advanced) | `.agents/memory/` | Read on demand |
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

## Adoption phases

`dab detect` and `dab normalize` resolve a phase before a manifest is required:

| Phase | Markers |
|---|---|
| `initialized` | `dab.yaml` parses and `.agents/` exists. |
| `partial` | Only one marker exists, or `dab.yaml` exists but cannot be parsed. |
| `uninitialized` | Neither marker exists. |

- A project root is the nearest ancestor with `dab.yaml` or `.agents/`; an uninitialized project uses the nearest `.git` ancestor, falling back to the current directory.
- Global scope is selected only when the current directory is inside `~/.agents`. The root is `$HOME` and the source root is `~/.agents`; a completely missing `~/.agents` needs `dab init ~/.agents` first.
- An invalid authored `dab.yaml` is reported as `[ERROR]` and is never overwritten. `normalize` stops with a configuration error (`config.yaml` for YAML syntax errors, `config.invalid` for schema or version errors) and zero writes.
- Adoption writes only missing minimal source files; existing authored files are never replaced.
- `dab detect` is read-only in every phase. Uninitialized and partial scopes exit `2` with a checklist; initialized scopes keep the normal `0`/`3`/`4` exit codes and `--strict` semantics.

## Detect checklist

- `dab detect` groups entries as Instructions, Documentation, Agents, Skills, Rules, Policy, Hooks, Memory, Notes, Generated target and Safety.
- The Hooks and Memory groups never report a missing optional file; a project that never opted in is not reported as missing.
- Statuses are `[OK]`, `[MISSING]`, `[WARN]`, `[ERROR]` and `[IMPORTABLE]`. `[IMPORTABLE]` means a physical `.claude/agents` or `.claude/skills` entry can be imported into `.agents`.
- Detect runs the read-only import plan in every phase, including `initialized`; an importable entry is not also reported as unmanaged or physical-copy projection drift.
- `score` counts `[OK]` entries over all entries. It is informational and never decides the exit code.
- `nextActions` are the distinct `next` hints of non-OK entries; a blocked preflight, such as an invalid manifest or a `$HOME` collision, does not suggest `dab normalize`.
- The JSON payload adds `scope`, `root`, `phase`, `profile`, `checklist`, `score` and `nextActions` while retaining `targets`, `diagnostics` and `summary`; `schemaVersion` stays `1`.
- Uninitialized and partial scopes return this full result object with `ok: false` and `exitCode: 2` instead of the `{ ok: false, error }` envelope used for usage, validation and backend errors.

## Practice layer

- `profile` selects the practices that `init` and `normalize` scaffold. `generic` is the default; `feature` is a compatibility alias with the same behavior, and an authored manifest wins over the CLI flag.
- A practice pack declares candidate paths in `targets()`, rendered content in `files()` and, when needed, owned directories or `skipChildrenWhenExists`. The production registry composes `core`, `documentation` and `authoring`; the documentation and authoring packs run in project scope only.
- `planAuthoredScaffold` is the single authored-file planner behind `init` and `normalize`. `init` uses `full`, `normalize` uses `adoption` for uninitialized or partial scopes and `converge` for initialized scopes. It stats candidates, builds anchors from existing plus planned paths and renders only missing files, so existing authored files are never overwritten. Existing targets are validated before they are preserved: a documentation file must be a regular readable file or an in-root symlink to one, and a skill directory must be a real directory or an in-root symlink to a directory with read and search permission. Escaping links, special files and unreadable files or directories are governed errors before any write.
- The documentation pack owns `docs/AGENTS.md` and `docs/architecture.md`. It writes one language and never creates `.zh.md` or `.i18n.yaml` pairs; `docs/AGENTS.md` is an AGENTS file and stays pairing-exempt.
- `docs.language` is `auto`, `en` or `zh`. `auto` samples existing `docs/AGENTS.md`, `docs/architecture.md`, root `AGENTS.md`, `README.md`, the `package.json` description and the locale, then defaults to `en`. The resolution carries `{ value, source }` and is reported by `init`, `normalize` and `detect`.
- `.agents/rules/docs-bilingual.md` is a project policy signal, not an error: missing documentation targets are policy-skipped and the rule is preserved. Existing docs are preserved as skipped, so a dangling docs path cannot block skills or target writes.
- Hooks and shared memory are advanced, opt-in capabilities. `init` and normalize adoption do not create `.agents/hooks/` or `.agents/memory/`; existing files are still discovered, validated and managed by `init`, `normalize` and `detect`.
- The authoring pack owns `.agents/skills/dab-doc-writing`, `.agents/skills/dab-architecture-writing` and `.agents/skills/dab-decision-notes`. An existing skill directory is preserved. When only an importable physical `.claude/skills/dab-*` directory exists, `init` drops its template and reports the import pending, which `normalize` performs. A non-directory entry is reported as a warning pending with `practice.skill-import-conflict` and no import hint. Each rendered body carries a `dab-skill: <name>@<version>` marker; DAB never updates an installed skill automatically and reports a stale marker instead.
- A regular file at `.agents/rules` or `.agents/skills` is a governed path error: `normalize` and `detect` report `practice.docs-path` or `practice.skill-path`, `init` reports `path.conflict`, and no practice write runs. A regular file, dangling link, denied access or symlink loop at `.agents/agents`, `.agents/hooks`, `.agents/memory`, `.agents/notes`, `.agents/policies` or `.agents/adapters` is a governed `path.conflict` in `init`, `normalize` and `detect`; project and global runs block before writes or discovery. A source parent without read and search permission is the same governed conflict; the best-effort secret scan may skip an unreadable subtree, so the parent probe, not the scan, owns access errors.
- `normalize` plans practice writes before target planning so new files are projected in the same run. A practice error blocks every write, including `.claude`; a policy skip does not.
- `detect` runs the same packs read-only. It adds a `Documentation` group after Instructions and authoring entries to `Skills`, and checks links in the two documentation files, line-start `TODO:` or `TODO(owner):` markers, empty architecture sections and skill version markers.
- `normalize --json` adds project-scope `practices` with `profile`, `mode`, `language`, `created`, `skipped`, `policySkipped`, `directories`, `skills` and `diagnostics`; `policySkipped` lists only missing docs skipped by the bilingual rule, while existing docs are reported as `skipped`; global scope omits it. `detect --json` carries the new entries in `checklist` under the existing `schemaVersion: 1`.

## Core loop

1. `dab init` scans a repository and writes the full authored skeleton for one scope.
2. `dab normalize` adopts missing minimal source, imports physical Claude agents and skills and fills missing practice files, then prechecks every enabled target and writes target output only when all prechecks pass.
3. `dab detect` checks drift, ownership, phase and scope without writing.
4. `dab policy explain --target <provider>` shows the effective result for one target.

## Targets and adapters

A complete v2 project manifest (`dab normalize` writes the `generated` records):

```yaml
version: 2
scope: project
project:
  id: example
  name: Example
profile: generic
docs:
  language: auto
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
- A physical `.claude/agents/*.md` file or `.claude/skills/<dir>` directory is an import candidate, not an unmanaged conflict. Other physical projection targets, settings files and unparseable entries remain conflicts; `dab normalize --fix` moves them into a timestamped `.dab/backups/` directory before replacing or removing them.
- An unrecorded entry symlink with an authored `.agents` source is repaired by `--fix`, which backs the link up first. A link with no authored source is a conflict that requires manual removal; DAB never imports or deletes an unmanaged link.
- `normalize` adopts and records an unrecorded symlink that already points at the expected source, or an instruction artifact that already matches the configured mode, without a rewrite.
- A configured target with no safe mapping fails with `target.unsupported`. One failing target blocks writes for every target, and `--dry-run` runs the same precheck and exit codes without writing.
- A root `CLAUDE.md` is user-owned and is always a fatal conflict.

## Normalize adoption and import

- Adoption runs before source-root resolution. An uninitialized or partial scope gets the missing minimal source: `AGENTS.md`, `dab.yaml`, the project policy and the Claude Code policy, plus empty agents, skills, rules and notes directories. Hooks and shared memory are not adopted; an existing tree remains managed. Adoption reuses the `init` renderers but creates no profile agents or core skills; the namespaced `dab-*` authoring skills are the exception.
- Import is a controlled migration, not an unmanaged conflict: physical `.claude/agents/*.md` and `.claude/skills/<dir>/SKILL.md` entries are copied into `.agents`, backed up under `.dab/backups/<timestamp>/`, and replaced with per-entry symlinks. `--fix` is not required.
- `.agents` is the source of truth. An existing source file or skill directory is never overwritten; differing `.claude` content produces a warning. A first import copies the whole skill directory, including extra files; when `.agents/skills/<name>` already exists, extra skill files stay in the backup.
- Import preserves the `.claude` basename or directory name. The frontmatter `name` is the fact id; a mismatch warns but does not rename.
- All-or-nothing gating covers adoption and import: any invalid candidate or unsafe path blocks every source and `.claude` write. After a later target preflight failure, `.claude` stays untouched; an idempotent source copy may already exist.
- Imports run for initialized and uninitialized/partial scopes, in project and global scope. In global scope `.claude` entries link into `~/.agents`; `~/.claude/settings.json` and `$HOME/.gitignore` are never read or written.
- `dab init` never imports or backs up existing `.claude` entries; adoption and import remain normalize's job.
- `dab normalize --dry-run` previews source writes, import, backup and symlink actions with planned backup paths; human output lists adoption source actions, import actions and adoption backups on real runs too.
- Only agents and skills are imported in this phase. Rules, settings, hooks and instructions remain unmanaged or conflicting `.claude` content and need separate adoption.
- Imports are idempotent. A run that imports new entries records their projections on the next run; rerunning `dab normalize` makes the generated record and `dab detect` converge.

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
- `src/adapter/claude-code/adoption.ts` plans and applies agent and skill imports, backups and per-entry symlinks.
- `src/detect/` contains drift and safety checks, checklist rendering, the uninitialized preflight and practice checks.
- `src/init/` scans repositories, renders templates, resolves adoption phases and plans minimal source.
- `src/init/practice.ts` owns the authored scaffold planner and pack registry; `practice-docs.ts` and `practice-authoring.ts` render the documentation and authoring packs, and `docs-language.ts` resolves `docs.language`.
- `src/docs/` runs the bilingual documentation gates.

## Generated outputs

- `.claude/settings.json` is a deterministic project artifact; global settings are read-only in this phase.
- `.claude/CLAUDE.md` is a symlink to the scope's instructions by default, with the generated import shim as an explicit fallback.
- `.claude/agents/`, `.claude/skills/` and `.claude/rules/` contain per-entry symlinks.
- `docs/AGENTS.md` and `docs/architecture.md` are authored project documentation; DAB creates a missing skeleton once and never overwrites it.
- `.agents/skills/dab-*` are authored authoring skills with a version marker, projected as `.claude/skills/` symlinks.
- `dab.yaml` stores `scope`, `targets` and per-target generated records with source hashes, target hashes and projection lists.
- `.dab/backups/` stores originals before `--fix` adopts an unmanaged path and before an import replaces a `.claude` entry.

## Frontmatter compatibility

- Agent, skill and rule files are projected into Claude Code and can gain new top-level fields before DAB knows them.
- DAB validates every field it interprets, keeps unknown top-level fields, and reports them as warnings with the source file.
- A warning suggests the closest known field when an unknown top-level field looks like a typo. Typos in scope or permission keys can change effective behavior, so treat these warnings as errors in CI.
- `dab detect --strict` turns project and configuration warnings into exit code 3 so CI can enforce this policy; environment warnings such as a missing Claude Code binary are excluded.
- Unknown fields in DAB-owned structures such as hooks, policies, manifests and memory entries remain errors.
- This keeps a Claude Code upgrade from breaking every agent while preserving fail-loud behavior for configuration DAB owns.

## JSON output contract

- Every command that supports `--json` includes `schemaVersion: 1` at the top level.
- The version covers the top-level envelope and any nested provider payloads. Commands use different payload shapes (`targets`, `target`, `normalize`); nested payloads do not carry their own version.
- `detect --json` adds `scope`, `root`, `phase`, `profile`, `checklist`, `score` and `nextActions`; `checklist` includes the `Documentation` group and authoring skill entries. `normalize --json` adds `scope`, `adoption` with source actions, imported entries and backups, and project-scope `practices`.
- `normalize --json` includes an absolute `root`; `init --json` includes `root` (source root) and `scopeRoot` (base for created, skipped and nested normalize paths). All other JSON paths are relative to that base.
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
- DAB imports only `.claude/agents` and `.claude/skills` in this phase; rules, settings, hooks and instructions are not adopted.
- DAB never overwrites authored docs or skill directories and never updates installed `dab-*` skills; a stale marker is a warning for manual review.
- DAB does not run an agent or LLM to fill documentation content; `normalize` scaffolds skeletons and `detect` checks structure.
- Global imports write under `$HOME` but never manage `~/.claude/settings.json` or `$HOME/.gitignore`.
- Path deny rules are tool-level guardrails, not a sandbox; `Bash`, `Grep`, `Glob`, `NotebookEdit` and wrapper commands can bypass them.
- Hooks are trusted executable code; DAB checks metadata and static safety, not runtime behavior.
- v0.1 has no eval loop; `docs/roadmap.md` carries evidence work.
- v0.1 accepts only the default `.agents` and `.claude` paths.
- All commands reject Windows in v0.1; junction support is deferred.
