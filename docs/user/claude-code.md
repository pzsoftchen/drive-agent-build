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

## Frontmatter compatibility

- Agent, skill and rule frontmatter may gain new top-level fields as Claude Code evolves.
- DAB validates the fields it interprets and emits a warning for unknown top-level fields; the fact is still projected.
- A warning suggests a close known field (for example `pathz` → `paths`). A typo in a scope or permission key can widen the effective rule or tool set, so treat these warnings as errors in CI.
- Unknown fields in DAB-owned hook, policy, manifest or memory YAML remain errors.

## Instruction artifact

- `.claude/CLAUDE.md` is a symlink to `../AGENTS.md` in project scope and `../.agents/AGENTS.md` in global scope.
- Some Claude Code builds gate native `AGENTS.md` loading, and some filesystems cannot follow the link reliably. Set `instructions: generated` on the target to write the import shim instead: `@../AGENTS.md` in project scope and `@../.agents/AGENTS.md` in global scope.
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
- The generated record decides ownership. A recorded instruction artifact or projection symlink that drifts is repaired in place (`repair`/`repair-link`) without `--fix` or a backup.
- Recorded settings that differ from the expected content are backed up and rewritten, even when the path is a symlink or directory.
- A physical `.claude/agents/*.md` file or `.claude/skills/<dir>` directory is an import candidate, not an unmanaged conflict. Other unrecorded paths that do not already match the expected artifact are unmanaged. `dab normalize --fix` backs an unmanaged path up under `.dab/backups/` before replacing or removing it; without `--fix`, `normalize` refuses to write.
- An entry symlink not recorded as a projection is repaired by `--fix` when an authored `.agents` source exists, after the link is backed up. A link with no authored source is a conflict and must be removed manually; DAB never imports or deletes an unmanaged link.
- `normalize` adopts and records an unrecorded symlink already pointing at the expected source, or an instruction artifact already matching the configured mode, without a rewrite. Identity checks use real paths, so a symlinked `.claude` directory that escapes the scope root fails instead of writing outside it.

## Adoption and import

- `dab normalize` copies physical `.claude/agents/*.md` files and `.claude/skills/<dir>/SKILL.md` directories into the authored `.agents` tree. Rules, `.claude/settings.json`, hooks and `CLAUDE.md` are not imported in this phase.
- `.agents` is the source of truth. An existing source file or skill directory is never overwritten; when the `.claude` content differs, normalize warns and keeps the `.agents` copy.
- The original `.claude` entry is backed up under `.dab/backups/<timestamp>/` and replaced with a per-entry symlink. A first import copies the whole skill directory, including extra files; when `.agents/skills/<name>` already exists, extra skill files are not merged and stay in the backup.
- Imports use the `.claude` basename or directory name. The frontmatter `name` remains the fact id; a mismatch warns but does not rename the entry.
- Imports do not need `--fix`. A directory symlink at `.claude/agents` or `.claude/skills` is a conflict because DAB owns entries one by one.
- `dab detect` runs the same import plan read-only in every phase, so an initialized scope reports `[IMPORTABLE]` and does not also report the same entry as unmanaged or physical-copy drift.
- `dab init` never imports: it keeps its existing behavior on an existing `.claude` tree, and adoption/import remains normalize's job.
- `dab normalize --dry-run` previews the import, backup and symlink plan, including planned backup paths. Human output lists adoption source actions, import actions and backups.
- Any invalid candidate blocks every write: no source adoption, imports or backups. A run that imports new entries records their projections on the next run, so rerun `dab normalize` to make `dab detect` clean.
- Global scope uses the same rules under `$HOME`: physical entries under `$HOME/.claude` are imported into `~/.agents` and linked back. `~/.claude/settings.json` and `$HOME/.gitignore` stay read-only.

## Authoring skills

- `dab-doc-writing`, `dab-architecture-writing` and `dab-decision-notes` are authored copies installed at `.agents/skills/<name>/SKILL.md` and projected to `.claude/skills/<name>` as per-entry symlinks.
- The canonical templates live in `skills/<name>/SKILL.md` inside the installed `@saydone/dab` package and are included in its npm `files`. DAB reads them from the package root; it never calls `npx skills`, a network installer or a remote registry.
- Each installed copy carries a `<!-- dab-skill: <name>@<version> sha256=<hash> -->` marker. `dab init` installs missing skills only. `dab normalize` updates an unmodified copy whose marker version is older, and migrates a legacy marker without a hash when the body matches the current template. Modified, newer, unversioned and marker-mismatched copies are preserved with warnings; managed updates create no backups.
- `dab detect` reports the current, stale, newer, modified, legacy, unversioned and marker-mismatch states. `practice.skill-stale` fails `--strict`; the preserved states do not.

## Memory model

- Shared memory is an advanced, opt-in capability. DAB does not scaffold `.agents/memory/` by default; existing files are still preserved and validated.
- Durable team knowledge lives in `.agents/notes/` and project docs. When a project opts into shared memory, its reviewed facts live in `.agents/memory/`.
- Personal auto memory stays machine-local and is never committed.
- Agents may use `memory: user` or `memory: local`, but `memory: project` is rejected because it creates a second team memory store.
- `dab eval` is planned for v0.2 and will use an empty memory directory.
- In global scope, ancestor and personal-memory checks are skipped because user-level Claude data is not a project artifact.

## Permissions and hooks

Hooks are an advanced, opt-in capability. DAB does not scaffold `.agents/hooks/` by default; existing hooks are still validated and projected into `.claude/settings.json`.

Project policy is compiled into `.claude/settings.json`. Project deny rules are a hard boundary for Claude Code file tools, but `Bash`, wrapper commands and other tools can bypass path rules. Agent definitions can narrow tools and append hooks, but cannot remove project hooks. Agent hooks must invoke a generated command from a managed `.agents/hooks/<id>/` entry; arbitrary inline shell commands are rejected. The accepted form is `node "${CLAUDE_PROJECT_DIR}/.agents/hooks/<id>/<entry>"` for node hooks or `"${CLAUDE_PROJECT_DIR}/.agents/hooks/<id>/<entry>"` for exec hooks; agent hook ids must not collide with project hook ids. Hook scripts are checked for path escapes, duplicate ids, line endings, executability and secrets.

## Global settings

- `~/.claude/settings.json` is user-owned in this phase. DAB reports a warning and does not read, write or merge the file.
- `$HOME/.gitignore` is read-only as well.
- Global instructions, agents, skills and rules are still aligned through projection files under `$HOME`.
- Explicit global settings adoption and merge is a later plan; keep global permissions and hooks in your own settings until then.

## Troubleshooting

1. Run `dab detect --json` and read the diagnostics by code; `[IMPORTABLE]` entries identify `.claude` agents and skills that normalize will adopt in initialized and preflight scopes.
2. Run `dab normalize --dry-run` to inspect planned source and repair actions; add `--json` and read `adoption.imports` to preview imports.
3. Run `dab normalize` to adopt and import, and rerun it after an import to record the new projections.
4. Run `dab normalize --fix` only after reviewing backup paths for non-import conflicts.
5. Run `dab policy explain --target claude-code --agent <name>` to inspect effective permissions.
6. Run `dab --help` for the command list.
