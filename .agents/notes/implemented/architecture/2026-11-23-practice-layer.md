# Agent Note: Practice layer

Status: implemented

English | [中文](2026-11-23-practice-layer.zh.md)

## Problem

DAB v0.1.1 governed configuration but did not scaffold the practices that keep a project's agent work legible. `dab init` and `dab normalize` had separate scaffolding paths, neither created project documentation or writing skills, and `dab detect` had no way to report a missing or stale documentation practice. The deepseek-harness sample showed that docs and authoring skills matter, but copying its domain content would not generalize.

## Decision

- Profiles select practice packs. `generic` is the default, `feature` remains a compatibility alias with the same behavior, and the production registry composes `core`, `documentation` and `authoring`. Documentation and authoring packs are project-scope only.
- One shared `planAuthoredScaffold` serves `init` (`full`) and `normalize` (`adoption` for uninitialized or partial scopes, `converge` for initialized scopes). Packs declare targets, the planner stats them and builds anchors from existing plus planned paths, and only missing files are rendered.
- The documentation pack owns exactly `docs/AGENTS.md` and `docs/architecture.md`. Generated docs use one language determined by `docs.language` (`auto`, `en` or `zh`) and never create `.zh.md` or `.i18n.yaml` pairs. `auto` samples existing docs, root `AGENTS.md`, `README.md`, the `package.json` description and the locale, then defaults to `en`; the `{ value, source }` resolution is reported.
- The authoring pack installs `dab-doc-writing`, `dab-architecture-writing` and `dab-decision-notes` under `.agents/skills/`. Each skill is an authored copy with a `dab-skill: <name>@<version>` marker. DAB skips an existing skill directory and never updates an installed skill; a physical `.claude/skills/dab-<name>` entry with no authored source is left pending by `init` and imported by `normalize`.
- An existing `.agents/rules/docs-bilingual.md` is project policy: it is preserved, missing documentation targets are policy-skipped with `practice.docs-bilingual-policy`, existing docs are skipped, and authoring skills and target writes continue.
- `dab detect` runs the same packs read-only. It adds a `Documentation` group and authoring entries in `Skills`, checks links, line-start `TODO:` or `TODO(owner):` markers, empty architecture sections and version markers, and treats policy skips and unversioned authored skills as non-strict warnings.
- DAB dogfoods the layer: its own `docs/AGENTS.md` guide and `dab-*` skills are authored files checked by `dab detect`, while its existing bilingual rule keeps its product docs paired.

## Alternatives considered

**Give each practice its own profile (`docs`, `delivery`).** Rejected: a profile is a project working style, not a practice dimension; practice packs stay internal and compose under one profile.

**Add `.agents/practices.yaml` for composition.** Deferred: the existing manifest `profile` field carries v1, and a new file would add surface before real composition needs appear.

**Ship a skill library without deterministic scaffolding or checks.** Rejected: skills alone cannot converge an existing project or tell CI that docs are missing or stale.

**Generate bilingual documentation by default.** Rejected: pairing and translation maintenance are project policy, not a generic default. The generic profile writes one language; a bilingual pack can follow.

**Let `normalize` call an LLM to fill documentation.** Rejected: `normalize` stays deterministic and does not execute agents or content generation. Authoring skills guide the project's own agent.

## Consequences

- Existing v0.1.1 projects with `.agents/rules/docs-bilingual.md` do not receive generated missing docs; existing docs are preserved as `skipped`. Missing docs get `practice.docs-bilingual-policy` warnings and the project still receives authoring skills; deleting the rule or waiting for a bilingual pack is the migration path.
- Installed `dab-*` skills are authored copies. A DAB version bump leaves them stale until a person or agent reviews and merges the new text; `dab detect` reports the stale marker but never overwrites the skill.
- An importable physical `.claude/skills/dab-*` directory is not duplicated: `init` reports it pending, and `dab normalize` imports it before later runs project it. A non-directory entry is reported as a warning pending with `practice.skill-import-conflict` and no import hint, and init never writes or replaces it.
- `feature` manifests receive the same practice behavior as `generic`, so a normalize can add docs and skills that did not exist before. `--dry-run` and the `practices` JSON expose the plan first.
- New generic projects no longer get the bilingual rule. DAB itself keeps the rule, so its own documentation pack is policy-skipped while other projects get single-language docs; project rules win.
- Every authored source parent a command reads is validated before discovery: a regular file, dangling link, denied access or symlink loop at `.agents/agents`, `.agents/hooks`, `.agents/memory`, `.agents/notes`, `.agents/policies` or `.agents/adapters` is a governed `path.conflict` that blocks project and global runs before writes; `.agents/rules` and `.agents/skills` stay practice-owned diagnostics. Access-denied source parents and unreadable practice skill directories are governed path errors instead of later discovery errors; the best-effort secret scan may skip unreadable subtrees but does not own those errors.
- The detect score includes practice entries, and `--strict` fails on missing or stale practice content except the two non-strict policy and preserved warnings.

## Verification

- `pnpm test`: 59 test files, 698 tests pass.
- `pnpm typecheck`: no errors.
- `pnpm doc-sync`: pairing, links, wrap, budgets and Agent Note checks pass.
- `pnpm build`: TypeScript compiles.
- `node dist/cli.js detect --strict`: `19/19 (100%)`, exit `0`.
- `node dist/cli.js normalize --dry-run`: no writes and no pending target changes.
- `git diff --check`: clean.

## Related

- [Architecture](../../../../docs/architecture.md)
- [CLI](../../../../docs/user/cli.md)
- [Design spec](../../../../docs/superpowers/specs/2026-11-23-practice-layer-design.md)
