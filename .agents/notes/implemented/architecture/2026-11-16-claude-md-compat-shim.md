# Agent Note: A generated CLAUDE.md import shim

Status: implemented

English | [中文](2026-11-16-claude-md-compat-shim.zh.md)

## Problem

Claude Code 2.1.277 added native `AGENTS.md` loading. On the development machine, a cached feature flag disables it: with only `AGENTS.md` present, project instructions were not loaded. A root `CLAUDE.md` or `.claude/CLAUDE.md` still loads reliably.

## Decision

When `target.claudeMdShim` is true, DAB generates `.claude/CLAUDE.md` containing a generated header and `@../AGENTS.md`. `AGENTS.md` remains the only authored instruction source. The shim is a projection, gitignored, and checked by `dab detect`.

## Alternatives considered

**Do nothing.** Rejected because native loading is gated on some machines.

**Symlink root `CLAUDE.md` to `AGENTS.md`.** Rejected because it puts a generated symlink at the repository root and conflicts with user files.

**Require a user-level Claude Code setting.** Rejected because it is not project-local and is easy to miss.

## Consequences

- Project instructions load on both gated and ungated Claude Code builds.
- A root `CLAUDE.md` remains an unmanaged conflict; users must merge it into `AGENTS.md`.
- The shim adds one generated file and one manifest entry.
- Users who rely on native loading can set `claudeMdShim: false`.

## Verification

A local probe confirmed that `.claude/CLAUDE.md` with `@../AGENTS.md` loads a unique marker while `AGENTS.md` alone does not on the gated build. `dab detect` checks shim presence and drift; `pnpm test` covers shim ownership and repair.

## Update 2026-11-17

Manifest v2 uses `targets[].options.instructions` and no longer uses `target.claudeMdShim`. The default instruction artifact is a symlink from `.claude/CLAUDE.md` to the scope's `AGENTS.md`. The generated import shim remains an explicit fallback: `@../AGENTS.md` for project scope and `@../.agents/AGENTS.md` for global scope. The facts above describe the pre-v2 shim era and remain historical context.

## Related

- [Architecture](../../../../docs/architecture.md)
- [Claude Code integration](../../../../docs/user/claude-code.md)
