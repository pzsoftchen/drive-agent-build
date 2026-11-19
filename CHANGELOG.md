English | [中文](CHANGELOG.zh.md)

# Changelog

## Unreleased

- Added `schemaVersion: 1` to every `--json` result and rejected `--json` with `--help` or `--version`.
- Agent, skill and rule frontmatter now preserves unknown top-level fields and warns with a did-you-mean hint; DAB-owned YAML remains strict.
- `dab normalize --json` and the nested result in `dab init --json` report `.gitignore` and backup paths relative to the scope root.
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
