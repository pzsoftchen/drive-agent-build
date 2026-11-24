# Agent Note: Route and discipline documentation

Status: implemented

English | [中文](2026-11-24-route-and-discipline-docs.zh.md)

## Problem

DAB's documentation described a release sequence, not a capability route. The philosophy and the route were split across `README.md`, `Why DAB exists` and `Roadmap`; the engineering discipline had no owner document, and the cross-agent isolation claim had no evidence gate. README and Why DAB also repeated the same conceptual diagram and status material, so no document was the single source for the route.

## Decision

- The route is four capability layers: L1 configuration governance and target isolation, L2 engineering discipline, L3 single-task delivery and L4 goal-level delivery.
- L1's evidence gate is `detect --strict` on a clean project, idempotent `normalize`, detection of foreign edits, target-neutral shared instructions and a cross-agent contract test. The contract test is a configuration-level check; full Codex and DSH adapters remain v0.4.
- `docs/concepts/engineering-discipline.md` owns the discipline set, enforcement levels, portability and provenance. README owns the entry summary and the system-position diagram; Why DAB owns the problem and conceptual model; Roadmap owns the route, gates and status; Architecture owns implementation facts.
- DAB is the long-term direction and product name; DAD is the current development-specific path; `dab` is the CLI.
- The public discipline is a synthesis of recognizable engineering practice. The deepseek-harness sample is one reference, not a canon.

## Alternatives considered

**Keep the route as a release list.** Rejected: release versions do not show dependencies, evidence gates or what "done" means for each capability.

**Narrow L1 to single-target governance.** Rejected: it would leave the cross-agent isolation claim unproven while the documentation presented it as the foundation.

**Move a full second adapter before v0.2.** Rejected for now: a full adapter expands the surface. A cross-agent contract test is the minimal configuration-level gate; full adapters remain v0.4.

**Put the discipline into Why DAB or Roadmap.** Rejected: the discipline would have no owner and would drift between the problem statement and the release plan.

**Treat deepseek-harness as the canonical discipline.** Rejected: it is a sample. Its docs and authoring skills informed the practice layer, but its domain content does not generalize.

## Consequences

- Capability status and planned work live in Roadmap; concept documents describe the current model and link to the route.
- L1 is not fully validated until the cross-agent contract test exists. The status in Roadmap records this gap.
- README owns the system-position diagram and the at-a-glance route; Why DAB links to that diagram instead of duplicating it. The detailed status table and planned work stay in Roadmap.
- The discipline document must stay current with the rules and enforcement levels. A behavioral rule must not be described as a gate.

## Verification

- `pnpm test`: 62 files, 795 tests pass.
- `pnpm typecheck`: no errors.
- `pnpm doc-sync`: no issues.
- `node dist/cli.js detect --strict`: `19/19 (100%)`, exit `0`.
- `node dist/cli.js normalize --dry-run`: manifest unchanged.
- `git diff --check`: clean.
- The English and Chinese documents are structurally paired and the links resolve.

## Related

- [Roadmap](../../../../docs/roadmap.md)
- [Engineering discipline](../../../../docs/concepts/engineering-discipline.md)
- [Why DAB exists](../../../../docs/concepts/why-dab.md)
