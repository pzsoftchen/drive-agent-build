English | [中文](engineering-discipline.zh.md)

# Engineering discipline

DAB treats engineering discipline as a product surface, not as advice that lives in a prompt. Configuration governance without discipline is an empty shell: it projects facts into a harness, but it does not define how work should be done or what evidence makes it acceptable.

The discipline is part of the authored source. Some rules can be gated by the CLI or CI; others remain behavioral instructions. The distinction is part of the model, not an implementation detail.

## The discipline set

The following rules form the default discipline model. A project can customize them, but it must state the enforcement level and the target portability of each rule.

| Rule | Why it matters | Enforcement | Portability |
|---|---|---|---|
| Authored source is the only source; generated output is never edited. | Prevents drift and competing facts. | `gate` via `normalize` and `detect`. | Target-neutral. |
| Tests before production code. | Produces evidence before a claim. | `behavioral`; a project CI can add a gate. | Target-neutral. |
| Fail loud. | Silent fallback and permission widening hide failures. | `gate` via diagnostics and exit codes. | Target-neutral. |
| Least privilege; deny wins. | Generated configuration must not widen access. | `gate` via policy compilation. | Shared policy plus adapter overlay. |
| Documentation is part of the change. | Project knowledge must survive the session. | `gate` via `doc-sync` when the project requires it; otherwise `behavioral`. | Target-neutral. |
| Durable decisions are recorded. | Alternatives and consequences stay reviewable. | `gate` for note format; content is `behavioral`. | Target-neutral. |
| Managed updates preserve local changes. | Generated templates must not overwrite authored work. | `gate` via marker and hash checks. | Target-neutral. |
| Evidence over activity. | Acceptance needs reproducible evidence, not activity. | `behavioral` until task evaluation exists; the L3 evidence gate defines the requirement. | Target-neutral. |
| Project and global scopes are independent. | Silent scope merging changes effective configuration. | `gate` via scope resolution. | Target-neutral. |

## Enforcement levels

- `gate`: a CLI or CI check fails the change. Evidence is an exit code, a diagnostic or a failing test.
- `check`: `dab detect` reports a warning or error; `--strict` decides whether it blocks. A `pnpm doc-sync` failure is a `gate`.
- `behavioral`: an instruction in `AGENTS.md` or a skill. The agent is expected to follow it, but DAB cannot prove it.
- `optional`: hooks, shared memory or another opt-in capability. The project chooses whether to enable it.

A behavioral rule is not a gate. The documentation must not describe a behavioral rule as enforced.

## Portability

Common facts live in `.agents/` and are target-neutral. Provider-specific policy lives in `.agents/adapters/<provider>.yaml`; adapters map facts into a target and never own agent, skill or rule definitions.

If a target cannot express a rule, DAB fails with `target.unsupported` instead of silently dropping it. This is the same fail-loud principle that governs permissions and ownership.

The current implementation has one target, Claude Code. Cross-agent coverage is an L1 evidence gate in [Roadmap](../roadmap.md).

## Provenance

The discipline is a synthesis of recognizable engineering practice: tests before code, docs as part of the change, decision records, least privilege, fail-loud behavior and idempotent updates. The `deepseek-harness` sample informed the practice layer: it showed that docs and authoring skills matter, but its domain content does not generalize and was not copied. The practice-layer decision is recorded in [Agent Note 0003](../../.agents/notes/implemented/architecture/2026-11-23-practice-layer.md).

This is not an appeal to industry consensus. The authority is the project's own authored rules and the checks that enforce them. When the source changes, record the change with alternatives, consequences and verification.

## Adoption

- `dab init` scaffolds the discipline files.
- `dab normalize` fills missing practice files, updates unmodified older managed skills and preserves modified copies.
- `dab detect` reports documentation, note, skill and configuration state without writing.
- A project can add rules, choose a documentation language or keep user-defined skills; it must label the enforcement level and keep provider-specific rules in an adapter overlay.

The implementation details are in [Architecture](../architecture.md). The milestones are in [Roadmap](../roadmap.md).

## Boundaries

- DAB governs configuration and artifacts, not agent runtime behavior.
- Hooks are trusted executable code; DAB checks metadata and static safety, not runtime behavior.
- Path deny rules are tool-level guardrails, not a sandbox.
- DAB does not run an LLM to fill documentation.
