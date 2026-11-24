English | [中文](CHANGELOG.zh.md)

# Changelog

## Unreleased

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
