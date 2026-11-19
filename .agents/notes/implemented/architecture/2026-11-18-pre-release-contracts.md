# Agent Note: Pre-release public contracts

Status: implemented

English | [中文](2026-11-18-pre-release-contracts.zh.md)

## Problem

The first npm release would freeze three public contracts that were still implicit: CLI JSON output had no schema version, agent/skill/rule frontmatter rejected unknown top-level fields that Claude Code may add, and the approved adapter contract plan had gaps that would surface when a second adapter arrives. Publishing without deciding these would either break user scripts later or turn every Claude Code field addition into a DAB failure.

## Decision

- Every command that supports `--json` now includes `schemaVersion: 1`; releases may add fields, but removing or changing a field requires a new version.
- Agent, skill and rule frontmatter tolerate unknown top-level fields: DAB keeps the fields, projects the file, and reports `agent.unknown-frontmatter`, `skill.unknown-frontmatter` or `rule.unknown-frontmatter` as a warning. The warning names the closest known field when the unknown name looks like a typo.
- DAB-owned structures (hooks, policies, manifests, memory entries) stay strict; unknown fields there remain errors.
- JSON paths in normalize results and the nested init result are relative to `root`/`scopeRoot`, which are included in the payload. All commands share one Windows guard, normalize performs one runtime version check, and `dab detect --strict` turns warnings into exit code 3 for CI.
- The adapter contract spec and plan record the remaining gaps: adapter-owned gitignore entries, provider-owned init scanning and provider path placement. The full refactor stays deferred until the Codex adapter plan.

## Alternatives considered

**Keep strict frontmatter.** Rejected because Claude Code adds fields over time; every addition would reject otherwise valid agents and force an urgent DAB release.

**Allow unknown fields silently.** Rejected because typos would become invisible. Warnings preserve both compatibility and a fail-loud signal.

**Escalate near-miss typos to errors.** Rejected for v0.1 because a future Claude Code field can be close to a DAB field. A warning with a suggestion keeps compatibility while making the risk visible; CI should treat these warnings as errors.

**Expose absolute JSON paths.** Rejected because the public JSON contract should not depend on the machine that produced it.

**Add a strictness option to every command.** Deferred: `dab detect --strict` covers the CI use case without changing normalize defaults or expanding the rest of the surface.

**Run the full adapter contract refactor before publishing.** Rejected because the release is Claude-only, internals are not public, and DAD evidence is the next milestone. The plan gaps are recorded instead.

**Skip JSON schema versioning.** Rejected because the CLI JSON is documented and users will script it; the adapter refactor would otherwise be a silent breaking change.

## Consequences

- Existing agent, skill and rule files with future Claude Code fields keep working, with a visible warning.
- Typo fields are no longer fatal for these three fact kinds; DAB-owned YAML remains strict. A typo in a scope or permission key can still change effective behavior, so the did-you-mean hint and `dab detect --strict` in CI are the mitigation.
- JSON consumers can branch on `schemaVersion`, resolve relative paths from `root`/`scopeRoot`, and use `--strict` to enforce warning-free detection.
- The adapter plan is larger when Codex work starts, but release work is not blocked.

## Verification

- Focused tests cover unknown-field warnings with did-you-mean suggestions (including transpositions) for agents, skills and rules, projection of a fact with an unknown field, and strict hook YAML.
- Command and CLI tests assert `schemaVersion: 1` for init, detect, normalize, policy explain, every command error envelope and the internal-error envelope.
- Regression tests cover one runtime version check (including synchronous failures), `root`/`scopeRoot` JSON bases, `detect --strict`, the shared Windows guard and locale-independent ordering.
- `pnpm test`, `pnpm typecheck` and `pnpm doc-sync` pass.

## Related

- [Architecture](../../../../docs/architecture.md)
- [CLI](../../../../docs/user/cli.md)
- [Adapter contract spec](../../../../docs/superpowers/specs/2026-11-17-adapter-contract.md)
