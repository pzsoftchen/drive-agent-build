English | [中文](roadmap.zh.md)

# Roadmap

DAB is the long-term direction. The product roadmap follows DAD first: prove reliable single-task development, then use that evidence to decide whether a DAB goal loop is justified.

## v0.1 DAD Config Governance

- Authored source: `AGENTS.md` and `.agents/`.
- Generated output: `.claude/`.
- Commands: `dab init`, `dab detect`, `dab normalize`, `dab policy explain`.
- Bilingual documentation gates.
- Status: released as `v0.1.1` on 2026-11-23.
- Release: [npm](https://www.npmjs.com/package/@saydone/dab) · [GitHub Release](https://github.com/pzsoftchen/drive-agent-build/releases/tag/v0.1.1)

## v0.1.x DAD Foundation

- Scope roots, v2 manifests, target adapters, ownership and failure semantics are released in `v0.1.1`.
- Symlink-first Claude Code instructions, per-entry projections and project settings are released in `v0.1.1`.
- Project and global scopes remain independent; DAB provides no `dab global` command and never merges scopes.
- Codex and DSH adapters are deferred until the DAD task loop is measured.

## v0.2 DAD Task Evidence

This is the next milestone. It validates one development task at a time and does not prove DAB.

- Add `dab run --record` for a single development task.
- Add `dab eval --suite <id> --compare baseline`.
- Use three existing-repository feature tasks with deterministic tests.
- Record time, attempts, cost, interventions and scope violations.
- Require stable harness events for attempts, tool activity, evidence, permissions and budgets before implementing this phase.
- Status: planned; next.

## v0.3 DAD Hardening and Memory

- Add `dab memory promote`.
- Review shared-memory expiry and supersession.
- Complete Agent Note archive workflow.
- Harden the failure modes observed during v0.2: hooks, policy explanation, recovery and handoff.
- Status: planned.

## v0.4 DAD Cross-harness Adapters

- Add the Codex adapter after the DAD task evidence contract is stable.
- Add the DSH adapter after Codex validates the common capabilities.
- Add explicit global-settings adoption and merge with backups.
- Keep `$HOME/.gitignore` read-only.
- Status: planned after v0.2 evidence.

## DAB Research Gate

DAB is not a scheduled implementation phase yet. Research starts only when DAD practice shows recurring failures at the goal level.

- Run DAD on enough real projects and tasks to establish its failure profile.
- Identify failures caused by multi-task decomposition, integration or overall acceptance rather than a single task loop.
- Prototype only the smallest goal-level loop needed to address observed failures.
- Do not commit to a task graph, `GoalRun`, `TaskRun`, or cross-task learning model before that evidence exists.
- Status: unscheduled research.

## Non-goals

- A DAB implementation before the research gate.
- GUI, independent agent runtime, plugin marketplace or team permissions.
- Automatic DAD migration or Windows junction support.
- Cross-scope inheritance or merge.
