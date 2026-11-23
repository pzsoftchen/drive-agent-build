# Agent Note: Detect checklist and normalize adoption

Status: implemented

English | [中文](2026-11-23-detect-normalize-adoption.zh.md)

## Problem

`dab detect` failed before printing anything when a project had no `dab.yaml` or `.agents/`, and `dab normalize` treated existing `.claude/agents` and `.claude/skills` facts as unmanaged conflicts. Users wanted a read-only checklist first, then a normalize that adopts the missing minimal source and imports those facts. The first implementation also hard-blocked recorded projection symlink drift, wrote source before the `.agents`/`.claude` disjoint preflight, imported during `dab init`, and hid the import plan from dry runs and human output.

## Decision

- Detect resolves the adoption phase before requiring a manifest. Uninitialized and partial scopes print a checklist, never write, and exit `2` with the same full result object as initialized scopes; the `{ ok: false, error }` envelope stays for usage, validation and backend errors. `schemaVersion` remains `1` because the change only adds fields.
- Detect runs the same read-only import plan in initialized scopes, so a physical `.claude` agent or skill is `[IMPORTABLE]` and is not also reported as unmanaged or physical-copy drift.
- Normalize adoption creates only missing minimal source, then imports physical `.claude/agents` and `.claude/skills` entries, backing up the originals under `.dab/backups/` and replacing them with per-entry symlinks. Any invalid candidate or unsafe path blocks every write.
- `dab init` suppresses imports; it keeps its existing behavior on an existing `.claude` tree, and adoption/import remains normalize's job.
- The generated projection record decides managed symlink drift: recorded entry symlinks are repaired or removed by the projection plan without `--fix`. An unrecorded entry symlink with an authored `.agents` source is backed up and replaced by `--fix`; a link with no authored source needs manual removal because DAB never imports or deletes unmanaged links.
- The source-write preflight checks real-path containment and `.agents`/`.claude` disjointness, including direct lexical symlink aliases whose target is missing, before creating any minimal source.
- `normalize --dry-run` lists source, import, backup and symlink actions with planned backup paths. Human output shows adoption source actions, import actions and adoption backups on real runs too.

## Alternatives considered

**Add a separate `dab import` command.** Rejected: import is part of adoption and the user asked for no new command.

**Let init keep importing.** Rejected: init is a one-time initializer, and importing during init replaces user files with backups as an unexpected side effect.

**Keep the detect error envelope for uninitialized scopes.** Rejected: the checklist is the product surface for existing projects; documenting the payload change and pinning it with a compatibility test is preferable to hiding the checklist behind an error.

**Always treat unmanaged entry symlinks as fatal, even with `--fix`.** Rejected: an authored source makes backup-and-replace safe and matches existing unmanaged projection behavior. Links without a source stay manual conflicts.

**Report imported targets as physical copies in detect.** Rejected: it would contradict `[IMPORTABLE]` and the plain normalize that imports them.

## Consequences

- Existing projects can inspect and converge with `dab detect` and `dab normalize` without `dab init`.
- Managed drift repair works again without `--fix`; one stale link no longer blocks every write.
- A rejected aliased layout produces zero filesystem writes.
- JSON consumers see adoption actions in top-level `actions` and a full uninitialized/partial detect payload; both are additive under `schemaVersion: 1`.
- Unmanaged entry symlinks without an authored source still require a manual step.

## Verification

- Command tests cover uninitialized, partial and initialized detect payloads, `[IMPORTABLE]` in initialized scopes, and the uninitialized result shape.
- Normalize tests cover managed agent and skill drift with and without `--fix`, unmanaged symlink repair with an authored source, aliased and dangling `.agents`/`.claude` trees with zero writes, dry-run import/backup/symlink plans, and human output.
- Init tests assert existing `.claude` agents and skills are neither imported nor backed up.
- `pnpm test`, `pnpm typecheck` and `pnpm doc-sync` pass.

## Related

- [Architecture](../../../../docs/architecture.md)
- [CLI](../../../../docs/user/cli.md)
- [Claude Code integration](../../../../docs/user/claude-code.md)
- [Design spec](../../../../docs/superpowers/specs/2026-11-23-detect-normalize-adoption-design.md)
