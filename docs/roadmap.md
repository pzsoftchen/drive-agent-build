English | [中文](roadmap.zh.md)

# Roadmap

DAB is the long-term direction. The product route follows DAD first: prove reliable single-task development, then use that evidence to decide whether a DAB goal loop is justified. This page owns the capability route, its evidence gates and the release milestones. The problem statement and conceptual model are in [Why DAB exists](concepts/why-dab.md).

## Capability route

The route has four layers. A layer is not complete because a release shipped; it is complete when its evidence gate passes.

| Layer | Problem | DAB mechanism | Evidence gate | Status |
|---|---|---|---|---|
| L1 Config governance and target isolation | Configuration drifts across targets, generated files are edited by hand, and target-specific semantics leak into shared instructions. | Authored source, per-target projections, ownership records, drift detection, adapter overlays. | `detect --strict` is clean; `normalize` is idempotent; foreign edits are detected without silent overwrite; common fact discovery does not read provider overlays; shared instructions are passed through without target-specific injection; the cross-agent contract test passes. | Claude Code implementation released; common fact discovery is provider-independent and the cross-agent contract test passes. |
| L2 Engineering discipline | Rules live in prompts and conversations and cannot be reproduced. | Explicit rules with enforcement levels; docs, notes and managed skills; gates where possible. | Every rule has an enforcement level; every gate rule has a check; behavioral rules are labeled; target-specific rules live in adapter overlays. | Practice layer released; enforcement matrix documented in [Engineering discipline](concepts/engineering-discipline.md). |
| L3 Single-task delivery | Agent activity is confused with accepted work; acceptance is not reproducible. | Task evidence, fixed task suite, baseline comparison and stable harness events. | Three existing-repository tasks with deterministic tests; baseline comparison; recorded time, attempts, cost, interventions and scope violations. | Planned for v0.2. |
| L4 Goal-level delivery | Decomposition, integration, overall acceptance and cross-task learning have no model. | DAB goal loop, only after L3 evidence. | Real DAD use produces recurring goal-level failures; a minimal prototype addresses them. | Research; not scheduled. |

A status is a snapshot, not a gate. The evidence gate decides whether a layer is validated.

## Dependency and order

- L1 and L2 are the foundation for the DAD task loop. They co-evolve: the discipline model defines what the configuration model must carry, and the configuration model determines what can be checked.
- L3 depends on L1 and L2. It measures one development task under governed configuration and explicit discipline.
- L4 is evidence-triggered, not date-triggered. Finishing L1-L3 is necessary but not sufficient; DAB research starts only when real L3 use exposes recurring goal-level failures.
- The route is a capability ladder, not a waterfall. A release can advance more than one layer, and a later discovery can send work back to an earlier layer.

## Evidence gates

- L1: `detect --strict` exits `0` on a clean project; a second `normalize` produces no changes; a hand edit to generated output is detected and not silently overwritten; shared instructions contain no target-specific semantics; the cross-agent contract test passes. The contract test is a configuration-level check, not a full adapter; full Codex and DSH adapters remain v0.4.
- L2: each rule in [Engineering discipline](concepts/engineering-discipline.md) has an enforcement level; each `gate` rule has a failing test or a CLI check; each `behavioral` rule is labeled; provider-specific rules live in `.agents/adapters/<provider>.yaml`.
- L3: three existing-repository feature tasks with deterministic tests; stable harness events for attempts, tool activity, evidence, permissions and budgets; a baseline comparison; recorded time, attempts, cost, interventions and scope violations.
- L4: real DAD use produces recurring goal-level failures; a minimal goal-loop prototype addresses the observed failures; no task graph, `GoalRun`, `TaskRun` or cross-task learning model is committed before that evidence.

## Release milestones

### v0.1 DAD Config Governance

- Advances: L1.
- Authored source: `AGENTS.md` and `.agents/`.
- Generated output: `.claude/`.
- Commands: `dab init`, `dab detect`, `dab normalize`, `dab policy explain`.
- Bilingual documentation gates.
- Status: released as `v0.1.2` on 2026-11-24.
- Release: [npm](https://www.npmjs.com/package/@saydone/dab) · [GitHub Release](https://github.com/pzsoftchen/drive-agent-build/releases/tag/v0.1.2)

### v0.1.x DAD Foundation

- Advances: L1.
- Scope roots, v2 manifests, target adapters, ownership and failure semantics are released in `v0.1.1`.
- Symlink-first Claude Code instructions, per-entry projections and project settings are released in `v0.1.1`.
- Project and global scopes remain independent; DAB provides no `dab global` command and never merges scopes.
- Codex and DSH adapters are deferred until the DAD task loop is measured.

### v0.1.x DAD Practice Layer

- Advances: L2.
- `generic` is the default profile; `feature` remains a compatibility alias with the same behavior.
- `init` and `normalize` scaffold single-language `docs/AGENTS.md` and `docs/architecture.md` and the `dab-*` authoring skills from one planner.
- `detect` reports a Documentation group and authoring skill state; `normalize` fills missing practice files while preserving authored docs, modified skills and user-defined skills.
- The `dab-*` authoring skills have canonical templates in `skills/`, a version/hash marker and managed updates: `normalize` updates unmodified older copies, migrates byte-identical legacy markers, and preserves modified, differing legacy, newer and unversioned copies.
- Projects with `.agents/rules/docs-bilingual.md` keep the rule and are policy-skipped for generated docs.
- The generic profile focuses on configuration drift and the documentation, notes and skills discipline.
- Hooks and shared memory are advanced, opt-in capabilities. `init` and adoption do not scaffold them; existing hooks are validated and compiled where applicable, and existing memory is preserved by `init` and `normalize` and validated by `init` and `detect`.
- Status: released in `0.1.2`.

### v0.2 DAD Task Evidence

- Advances: L3.
- This is the next milestone. It validates one development task at a time and does not prove DAB.
- Add `dab run --record` for a single development task.
- Add `dab eval --suite <id> --compare baseline`.
- Use three existing-repository feature tasks with deterministic tests.
- Record time, attempts, cost, interventions and scope violations.
- Require stable harness events for attempts, tool activity, evidence, permissions and budgets before implementing this phase.
- Status: planned; next.

### v0.3 DAD Hardening and Memory

- Advances: L2 and L3 support.
- Add `dab memory promote`.
- Review shared-memory expiry and supersession.
- Complete the Agent Note archive workflow.
- Harden the failure modes observed during v0.2: hooks, policy explanation, recovery and handoff.
- Status: planned.

### v0.4 DAD Cross-harness Adapters

- Advances: L1 cross-agent coverage.
- Add the Codex adapter after the DAD task evidence contract is stable.
- Add the DSH adapter after Codex validates the common capabilities.
- Add explicit global-settings adoption and merge with backups.
- Keep `$HOME/.gitignore` read-only.
- Status: planned after v0.2 evidence.

## DAB Research Gate

DAB is not a scheduled implementation phase. Research starts only when DAD practice shows recurring failures at the goal level.

- Run DAD on enough real projects and tasks to establish its failure profile.
- Identify failures caused by multi-task decomposition, integration or overall acceptance rather than a single task loop.
- Prototype only the smallest goal-level loop needed to address observed failures.
- Do not commit to a task graph, `GoalRun`, `TaskRun` or cross-task learning model before that evidence exists.
- Status: unscheduled research.

## Non-goals

- A DAB implementation before the research gate.
- GUI, independent agent runtime, plugin marketplace or team permissions.
- Automatic DAD migration or Windows junction support.
- Cross-scope inheritance or merge.
