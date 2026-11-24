# Agent Note: Managed authoring skills

Status: implemented

English | [中文](2026-11-24-managed-skills.zh.md)

## Problem

The three `dab-*` authoring skills were Markdown strings inside `src/init/practice-authoring.ts`. A project received a copy once, so a DAB upgrade could not distinguish an unmodified old template from a user fork; `practice.skill-stale` persisted with no safe remedy. Delegating installation to `npx skills` would add network access, an external installer, target-path assumptions and nondeterminism to a `.agents`-owned, offline, all-or-nothing workflow.

## Decision

- Canonical templates live at `skills/<name>/SKILL.md` in the repository and installed package; `package.json` publishes `skills`. `init` and `normalize` read them from the package root. There is no `npx skills`, network or remote registry call.
- An installed copy at `.agents/skills/<name>/SKILL.md` carries `<!-- dab-skill: <name>@<version> sha256=<hex> -->` after its frontmatter. The version is the DAB package version; the hash is SHA-256 of the marker-stripped UTF-8 body.
- `planManagedSkills` classifies each installed skill before target planning. Missing means create. A matching hash with an equal version means skip. A matching hash with a strictly older version means an atomic update. A legacy marker without a hash and a byte-identical marker-stripped body means migrate the marker and hash. A modified body, a newer or unparseable version, a differing legacy body, a missing marker and a marker naming another skill are preserved with a diagnostic. Non-regular files, escaping symlinks and unreadable paths are blocking `practice.skill-path` errors. A symlink at the skill file itself is such an error even when it resolves inside the root; the containing skill directory may be an in-root symlink.
- Each `ManagedSkillWrite` carries the fingerprint observed during planning: expected absence for a create, the marker version and hash for a stale update, and the marker version plus marker-stripped body for a legacy migration. `applyManagedSkillWrites` re-reads the target immediately before writing. A target that changed, disappeared or appeared after planning is preserved with a `practice.skill-concurrent-change` warning, a missing skill is created with an exclusive create so a concurrent file is never replaced, and stale or legacy writes still use atomic replacement. The apply result reports the preserved targets separately from created, updated, migrated and skipped files.
- Managed updates require stable numeric versions. A prerelease DAB version is uncomparable, so installed skills are preserved and never update automatically.
- Managed updates write only `dab-*` files and create no backups. A modified file is never overwritten or backed up; the package and git history are the record. `init` only installs missing skills.
- `detect` maps the same states to the Skills group. `practice.skill-stale` remains strict; `practice.skill-newer`, `practice.skill-modified`, `practice.skill-legacy`, `practice.skill-marker-mismatch` and `practice.skill-unversioned` are non-strict warnings because they describe preserved authored content.
- `normalize --json` adds `practices.skills.updated`, `migrated`, `modified`, `newer`, `legacy`, `unversioned`, `markerMismatch` and `concurrent` under `schemaVersion: 1`; human output uses `update skill`, `migrate skill` and `skip skill ... (...)`.
- Release 0.1.2 ships the managed update. Existing 0.1.1 projects have legacy markers without hashes and migrate only when their bodies are byte-identical. DAB's own dogfood skills were migrated by running `dab normalize`, not by hand-editing.

## Alternatives considered

**Runtime `npx skills` installation.** Rejected: network access, an external installer, target-path assumptions, nondeterminism and supply-chain surface conflict with the offline `.agents` source of truth.

**Store version and hash in the manifest generated record.** Rejected: the marker travels with the file, does not depend on a manifest record, and stays valid when a project copies or moves a skill.

**Make installed skills read-only.** Rejected: not portable across filesystems and it would block legitimate forks. Managed-plus-fork-aware is the contract.

**Keep copy-once installation.** Rejected: every DAB release leaves old skills stale and DAB cannot distinguish a fork from an old template.

**Overwrite a modified skill with a backup.** Rejected: it silently takes user content and creates a second source of truth. Modified skills stay untouched.

## Consequences

- A DAB upgrade updates only skills whose hash proves the body is unmodified. Modified, newer and unversioned skills stay in place, so `detect` can stay non-clean until a person reviews them; `--strict` still passes for preserved states.
- The hash covers the marker-stripped body, so the marker can be rewritten without changing the content hash. CRLF-only differences fail the byte-exact legacy comparison and are preserved.
- `init` and `normalize` now depend on the packaged `skills/` directory at runtime; a package that omits it fails loudly when rendering a skill. The release test covers the npm `files` entry.
- Projects on 0.1.1 have legacy markers and migrate on the next normalize when unmodified. A project that edited an authoring skill keeps its fork, and the warning stays until the person reconciles it.
- Managed updates create no `.dab/backups/` entry, so recovery of an unmodified old template relies on git or the previously installed package.
- A user edit made after planning wins: the apply step preserves it with `practice.skill-concurrent-change` and reports it in `practices.skills.concurrent` rather than claiming an update.
- A prerelease DAB build installs skills with an uncomparable marker and subsequent stable builds preserve them, so managed updates require a stable numeric release.
- DAB dogfoods the same path: `.agents/skills/dab-*` are managed copies of `skills/`, and `dab detect --strict` is clean after migration.
- Release 0.1.2 is the first release that can update installed authoring skills; it does not change the manifest schema or projection ownership.

## Verification

- `pnpm test`: 62 test files, 795 tests pass.
- `pnpm typecheck`: no errors.
- `pnpm doc-sync`: pairing, links, wrap, budgets and Agent Note checks pass.
- `pnpm build`: TypeScript compiles.
- `node dist/cli.js detect --strict`: `19/19 (100%)`, exit `0`, after normalize migrated the three dogfood skills.
- `node dist/cli.js normalize --dry-run`: no writes and no pending changes after the migration.
- `dab normalize` migrated the three dogfood skill markers from `0.1.1` without hashes to `0.1.1` with hashes and updated the `dab.yaml` source hashes; a second dry run reported no changes.
- After the `0.1.2` version bump, `dab normalize` refreshed the same three markers to `0.1.2`; the content hashes stayed the same because the marker is excluded, and the `dab.yaml` source hashes were rewritten. A second dry run reported no changes and `detect --strict` stayed `19/19 (100%)`.
- `git diff --check`: clean.

## Related

- [Architecture](../../../../docs/architecture.md)
- [CLI](../../../../docs/user/cli.md)
- [Claude Code integration](../../../../docs/user/claude-code.md)
- [Practice layer](2026-11-23-practice-layer.md)
- [Design spec](../../../../docs/superpowers/specs/2026-11-24-managed-skills-design.md)
