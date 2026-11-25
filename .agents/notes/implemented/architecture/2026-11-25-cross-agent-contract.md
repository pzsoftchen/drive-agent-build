# Agent Note: Cross-agent contract

Status: implemented

English | [中文](2026-11-25-cross-agent-contract.zh.md)

## Problem

Common fact discovery was not provider-independent. `SourceFacts` loaded both `.agents/policies/project.yaml` and `.agents/adapters/claude-code.yaml`, so a project without the Claude adapter overlay could not discover its common facts. The cross-agent isolation claim in the L1 route had no configuration-level test.

## Decision

- Split the source model into `CommonFacts`: agents, skills, rules, hooks, the common policy and its path. `loadCommonPolicy` reads only `.agents/policies/project.yaml`.
- Each target adapter loads its own overlay. The Claude adapter calls `loadClaudeCodePolicy` and compiles the common and Claude policies together. A missing or invalid Claude overlay is a target diagnostic, not a common-fact failure.
- Add a test-only neutral consumer that reads `CommonFacts` and projects explicit common fields: instructions text, agent name/description/body, skill name/description/body, rule name/paths/body, neutral hooks and the common policy. It never includes provider fields, target options, adapter policy or `.claude` artifacts.
- The contract tests cover: common discovery without a provider overlay; provider fields do not change the neutral view; adapter policy stays target-local; common facts remain available when the Claude overlay is missing.
- L1's evidence gate now uses this contract; the cross-agent contract test is passing.

## Alternatives considered

**Test a neutral view without splitting `SourceFacts`.** Rejected: it would prove a separate test parser, not that the production common-fact path is independent of Claude.

**Register a fake Codex adapter.** Rejected: it would pretend a target is supported and would not test the common boundary.

**Lint `AGENTS.md` for Claude keywords.** Rejected: free-form prose makes a keyword blacklist brittle, and it does not prove the configuration boundary.

**Implement the full Codex adapter now.** Deferred: a full adapter belongs to v0.4; the contract test is the minimal configuration-level gate.

## Consequences

- Common fact discovery works without `.agents/adapters/claude-code.yaml`.
- A missing or invalid Claude overlay is reported by the Claude adapter and still blocks writes through the target plan.
- Provider-specific agent and skill frontmatter fields remain in the common source for now. The neutral contract treats them as provider-specific and excludes them; moving them into adapter overlays is a follow-up.
- The contract proves the configuration surface, not another agent's runtime behavior. Full Codex and DSH adapters remain v0.4.

## Verification

- `pnpm test`: 63 files, 800 tests pass.
- `pnpm typecheck`: no errors.
- `pnpm doc-sync`: no issues.
- `node dist/cli.js detect --strict`: `19/19 (100%)`, exit `0`.
- `node dist/cli.js normalize --dry-run`: manifest unchanged.
- `git diff --check`: clean.

## Related

- [Roadmap](../../../../docs/roadmap.md)
- [Architecture](../../../../docs/architecture.md)
- [Engineering discipline](../../../../docs/concepts/engineering-discipline.md)
