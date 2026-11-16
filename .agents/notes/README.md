# Agent Notes

English | [中文](README.zh.md)

Agent Notes record durable decisions and proposals for this project.

## Layout and naming

Every note lives at `{lifecycle}/{class}/YYYY-MM-DD-topic.md`.

- Lifecycle is `proposed`, `implemented` or `rejected`.
- Class is one of the closed set below.
- The date is the first-proposed date.

## Lifecycle

- `proposed`: a proposal under review, not yet shipped.
- `implemented`: the decision shipped; keep facts current.
- `rejected`: considered and declined; keep only while useful.

## Classification

| Class | Covers |
|---|---|
| `feature` | A new user- or agent-facing capability. |
| `bug-fix` | A defect or gap fix. |
| `simplification` | Removes surface without adding capability. |
| `architecture` | Structure of the shipped source. |
| `process` | Tooling, policy or workflow around the code. |
| `testing` | Test infrastructure and strategy. |

## File format

Every active note starts with:

```markdown
# Agent Note: <title>

Status: implemented
```

Implemented notes require `## Problem`, `## Decision`, `## Alternatives considered` and `## Consequences`. Proposed notes require `## Problem`, `## Proposal`, `## Alternatives considered`, `## Acceptance criteria` and `## Risks`. Rejected notes require `## Problem`, `## Proposal`, `## Alternatives considered` and a reason on the status line.

## Chinese counterparts

Every note has a `.zh.md` counterpart and a `.i18n.yaml` record. Update all three in one change.

## Archiving

`archived/` is a frozen historical tree. Do not edit archived notes. See [archived/AGENTS.md](archived/AGENTS.md).
