English | [中文](CHANGELOG.zh.md)

# Changelog

## 0.1.2 — 2026-11-24

- `dab init` now writes `profile: generic` and `docs.language: auto` by default. `--profile generic|feature` selects the manifest profile; `feature` is a compatibility alias with the same practice behavior. `docs.language` accepts `auto`, `en` or `zh`, is resolved from project content and locale when `auto`, and reports `{ value, source }` in human output and JSON.
- `dab init` and `dab normalize` adoption no longer scaffold advanced `.agents/hooks/` or `.agents/memory/` files; the generic profile focuses on drift detection/repair and the documentation, notes and skills discipline. Existing authored hooks and shared memory are untouched: hooks are still validated and compiled where applicable, memory is still preserved and validated, and `dab detect` omits their checklist groups when absent.
- `dab init` and `dab normalize` scaffold single-language `docs/AGENTS.md` and `docs/architecture.md` without `.zh.md` or `.i18n.yaml` pairs, plus the `dab-doc-writing`, `dab-architecture-writing` and `dab-decision-notes` authoring skills. Existing docs and skill directories are never overwritten; managed `dab-*` skills are updated only when their marker hash proves they are unmodified.
- Authoring skills now come from canonical `skills/<name>/SKILL.md` templates shipped in the npm package. Installed `.agents/skills/dab-*` copies carry a `<!-- dab-skill: <name>@<version> sha256=<hash> -->` marker whose hash covers the marker-stripped body; DAB reads the package templates directly and never calls `npx skills` or a network installer.
- `dab normalize` now manages installed `dab-*` skills before target planning: it creates missing skills, updates an unmodified copy whose marker version is older, and migrates a legacy marker without a hash when the body matches the current template. It preserves and warns about modified bodies, newer or uncomparable versions, differing legacy bodies, missing markers and markers naming another skill, and managed updates create no backups. `dab detect` reports the corresponding states: `practice.skill-stale` remains strict, while the preserved states do not fail `--strict`. `normalize --json` adds `practices.skills.updated`, `migrated`, `modified`, `newer`, `legacy`, `unversioned` and `markerMismatch`.
- `dab init` now leaves an importable physical `.claude/skills/dab-*` directory pending, skips that authoring template and leaves the import to `dab normalize`; a non-directory entry is reported as a warning pending with `practice.skill-import-conflict` and no import hint. It never writes or replaces the physical entry.
- The generic skeleton no longer generates `.agents/rules/docs-bilingual.md`; an existing authored rule is preserved and policy-skips missing single-language docs with `practice.docs-bilingual-policy`. Existing docs are preserved as skipped and never blocked by a dangling docs path. Authoring skills and target writes continue.
- `dab normalize` fills missing practice files in uninitialized, partial and initialized project scopes before target planning. `--json` adds project-scope `practices` with `profile`, `mode`, `language`, `created`, `skipped`, `policySkipped`, `directories`, `skills` and `diagnostics`; a dry run and a run blocked before practice writes keep planned entries, a run blocked by a later target failure reports the files it wrote, and global scope omits the object.
- Practice path validation rejects escaping symlinks, special files and unreadable targets. Existing docs must be regular readable files or in-root symlinks to one; skill directories must be real directories or in-root symlinks to a directory with read and search permission. A regular file at `.agents/rules` or `.agents/skills` is a governed diagnostic in `init`, `normalize` and `detect` instead of an internal error. A regular file, dangling link, denied access or symlink loop at `.agents/agents`, `.agents/hooks`, `.agents/memory`, `.agents/notes`, `.agents/policies` or `.agents/adapters` is a governed `path.conflict`, and project and global runs block before writes or discovery. A source parent without read and search permission is governed the same way; the best-effort secret scan may skip unreadable subtrees, but access errors come from the parent probe.
- An unreadable nested skill directory is reported as `skill.unreadable` instead of silently emptying every skill fact. Sibling skills still validate and project, and `init`, `normalize` and `detect` never report the project healthy; `normalize` writes no Claude target output in that run.
- `dab normalize` converge links an existing root `AGENTS.md` from generated `docs/AGENTS.md` and omits the link when `AGENTS.md` is absent.
- `dab detect` adds a `Documentation` group and authoring skill entries in `Skills`, checking links, line-start TODO markers, empty architecture sections and skill version markers. Missing practice files, TODOs, empty sections and stale skills fail `--strict`; bilingual policy skips and preserved skill states stay informational.
- DAB now dogfoods the practice layer: its own `docs/AGENTS.md` guide and `dab-*` authoring skills live in the authored source tree and are checked by `dab detect`.
- `dab detect` prints a read-only checklist for uninitialized, partial and initialized project and global scopes, with `[OK]`, `[MISSING]`, `[WARN]`, `[ERROR]` and `[IMPORTABLE]` states, a score and next actions; JSON adds `scope`, `root`, `phase`, `profile`, `checklist`, `score` and `nextActions`. Initialized scopes also report importable physical entries instead of unmanaged or physical-copy drift.
- Uninitialized and partial `dab detect --json` results are now the full checklist object with `ok: false` and `exitCode: 2` instead of the error envelope; `schemaVersion` stays `1`.
- `dab normalize` adopts missing minimal source and imports physical `.claude/agents` and `.claude/skills` entries into `.agents`, backing up originals under `.dab/backups/` and replacing them with per-entry symlinks. Invalid imports block every write, and `--fix` still covers non-import conflicts only.
- `dab normalize --dry-run` lists import, backup and symlink actions and planned backup paths; human output also shows adoption source actions, import actions and backups on real runs.
- Managed projection symlink drift is repaired without `--fix`; an unmanaged entry symlink with an authored source is repaired by `--fix`, while a link with no authored source needs manual removal. `dab init` never imports existing `.claude` entries.
- Global scope gets the same checklist and adoption/import behavior; `~/.claude/settings.json` and `$HOME/.gitignore` remain read-only and `dab init ~/.agents` is still the explicit entry point for a missing global source.
- `dab init` remains the one-time full-profile initializer; existing projects use `dab detect` and `dab normalize`.

## 0.1.1 — 2026-11-23

- Published the CLI as `@saydone/dab` with a GitHub Actions release workflow, npm provenance and a GitHub Release for each tag.
- Added `schemaVersion: 1` to every `--json` result and rejected `--json` with `--help` or `--version`.
- Agent, skill and rule frontmatter now preserves unknown top-level fields and warns with a did-you-mean hint, including transposed letters; DAB-owned YAML remains strict.
- Added `dab detect --strict` to fail CI on project and configuration warnings.
- `dab normalize --json` includes an absolute `root`; `dab init --json` includes `root` and `scopeRoot`, with generated and backup paths relative to them.
- Unified the Windows platform guard across all commands and reduced normalize to one Claude Code version check.
- Made file and diagnostic ordering locale-independent so hashes and JSON stay stable across machines.
- `dab --version` now reads the version from `package.json`.
- Added independent project and global scopes with v2 manifests and per-target generated records.
- Added the target adapter foundation and symlink-first Claude Code instruction artifacts.
- Added the bilingual conceptual model for DAB, DAD and their nested delivery levels.
- Clarified the boundary between implemented governance and planned evidence work.
- Reordered the roadmap around DAD first, with DAB gated on observed goal-level delivery failures.

## 0.1.0 — 2026-11-16

- Initial `dab` CLI with `init`, `detect`, `normalize` and `policy explain`.
- Claude Code-first adapter with deterministic `.claude/settings.json` and per-entry symlinks.
- Generated `.claude/CLAUDE.md` import shim for AGENTS.md compatibility.
- Bilingual documentation gates for pairing, links, wrap, budgets and Agent Notes.
- Shared policy and Claude Code adapter layers with deny-first compilation.
