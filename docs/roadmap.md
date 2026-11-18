English | [中文](roadmap.zh.md)

# Roadmap

DAB ships in narrow phases. Each phase must produce working, testable software before the next starts.

## v0.1 Config Governance

- Authored source: `AGENTS.md` and `.agents/`.
- Generated output: `.claude/`.
- Commands: `dab init`, `dab detect`, `dab normalize`, `dab policy explain`.
- Bilingual documentation gates.
- Status: implemented on `main`; pending a tagged release.

## v0.1.x Cross-harness alignment

This is the first v0.1.x priority. Project and global scopes are configured independently; DAB provides no `dab global` command and never merges scopes.

- Foundation: location-based scope roots, v2 manifests with `scope` and `targets`, the target adapter contract, ownership and failure semantics. Status: implemented on `main`; pending release.
- Claude target: symlink-first instructions, per-entry projections, project settings, managed/unmanaged conflicts and `--fix` backups. Status: implemented on `main`; pending release.
- Codex adapter: native subagents and skills, mapped settings. Status: next.
- DSH adapter: native subagents and skills, mapped profile and settings. Status: after Codex.
- Global settings adoption/merge: explicit opt-in with backups for each target. Status: after DSH.
- Global `$HOME/.gitignore` stays read-only in every plan.

## v0.2 Evidence

- `dab run --record` with a `RunRecord`.
- `dab eval --suite <id> --compare baseline`.
- Three existing-repo feature tasks with deterministic tests.
- Record time, attempts and cost.
- Status: planned.

## v0.3 Memory

- `dab memory promote`.
- Shared memory review and expiry checks.
- Agent Note archive workflow.
- Status: planned.

## Non-goals

- GUI, independent agent loop, plugin marketplace or team permissions.
- Automatic DAD migration or Windows junction support.
- Cross-scope inheritance or merge.
