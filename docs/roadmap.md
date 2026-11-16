English | [中文](roadmap.zh.md)

# Roadmap

DAB ships in narrow phases. Each phase must produce working, testable software before the next starts.

## v0.1 Config Governance

- Authored source: `AGENTS.md` and `.agents/`.
- Generated output: `.claude/`.
- Commands: `dab init`, `dab detect`, `dab normalize`, `dab policy explain`.
- Bilingual documentation gates.
- Status: shipped.

## v0.1.x Adoption and Structure

- `dab init --dry-run` and generated-conflict handoff to `dab normalize --fix`.
- DSH-style Agent Note lifecycle and class tree.
- `HarnessAdapter` seam, capability and artifact model.
- `dab.lock` for generated state.
- Status: next.

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

## v0.4 Harness Adapters

- Codex adapter.
- DSH adapter.
- Same source tree, adapter-specific artifacts and launch.
- Status: planned.

## Non-goals

- GUI, independent agent loop, plugin marketplace or team permissions.
- Automatic DAD migration or Windows junction support.
