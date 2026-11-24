# Documentation guide

`docs/AGENTS.md` is the documentation authority for DAB. Read it before writing, restructuring or reviewing documentation in this repository.

This file is an AGENTS file: it is written in English only and is exempt from translation pairing. Human-facing documents remain paired English and Simplified Chinese under [.agents/rules/docs-bilingual.md](../.agents/rules/docs-bilingual.md).

## Document tiers

- Root [AGENTS.md](../AGENTS.md) — agent entry rules, the short command list and this documentation index. It carries no project documentation detail.
- [docs/AGENTS.md](AGENTS.md) — this standard: tiers, placement, writing, slop and verification rules. English only and pairing-exempt.
- [docs/architecture.md](architecture.md) — architecture facts: layout, composition, runtime flows, module boundaries, extension points and invariants. Paired with `architecture.zh.md` and `docs/architecture.i18n.yaml`.
- [docs/concepts/why-dab.md](concepts/why-dab.md) — why DAB exists and the problem it solves. Paired.
- [docs/roadmap.md](roadmap.md) — direction and planned milestones. Paired.
- [docs/development.md](development.md) — setup, checks, development loop and release procedure. Paired.
- [docs/user/cli.md](user/cli.md) — CLI commands, flags, output contracts and exit codes. Paired.
- [docs/user/claude-code.md](user/claude-code.md) — Claude Code integration behavior. Paired.
- `docs/i18n/` — terminology and style rules, maintained directly in both languages and excluded from the pairing gate.
- [docs/superpowers/README.md](superpowers/README.md) — Chinese-only specs and plans for the superpowers workflow; [.agents/rules/docs-bilingual.md](../.agents/rules/docs-bilingual.md) exempts them from pairing while link and wrap checks still apply.
- `.agents/notes/` — decision records; write them with the [notes guide](../.agents/notes/AGENTS.md).
- `.agents/skills/` — agent skills, including the managed `dab-doc-writing`, `dab-architecture-writing` and `dab-decision-notes` authoring copies.

## Placement

- Every fact has exactly one home. The owner document holds the detail; other documents link to it instead of repeating it.
- Architecture facts belong in [docs/architecture.md](architecture.md), not in this guide or in root `AGENTS.md`.
- Durable decisions belong in `.agents/notes/` with context, alternatives, consequences and verification, following the [notes guide](../.agents/notes/AGENTS.md).
- Durable team knowledge belongs in `.agents/notes/` and project docs; `.agents/memory/` is an optional advanced capability and is not scaffolded by default.
- Authoring skill content lives in the canonical `skills/<name>/SKILL.md` templates shipped with the package. `.agents/skills/dab-*` are managed copies with a version/hash marker; edit the template and run `dab normalize`, not the installed copy.
- Setup, checks, development workflow and release steps belong in [docs/development.md](development.md).
- CLI syntax, flags, outputs and exit codes belong in [docs/user/cli.md](user/cli.md).
- User-facing Claude Code behavior belongs in [docs/user/claude-code.md](user/claude-code.md).
- Direction and milestones belong in [docs/roadmap.md](roadmap.md); other documents link to it instead of announcing planned work.
- Root `AGENTS.md` holds agent rules and a documentation index only.
- Link a new document from its owner document and from the root `AGENTS.md` Documentation index.
- Do not create `.zh.md` or `.i18n.yaml` pairs for AGENTS files.

## Writing rules

- Describe the current state. Do not narrate history, planned work or implementation progress.
- Write one physical line per paragraph so diffs stay reviewable. Use continuation lines only inside fenced code, tables and list items that need them.
- Human-facing documents in this repository remain paired English and Simplified Chinese; [.agents/rules/docs-bilingual.md](../.agents/rules/docs-bilingual.md) owns the pair structure, update rule and translation prohibitions.
- Use relative links to files that exist. Never use absolute links or link to an example that is not in the repository.
- State each rule and fact once; link to the owner instead of copying it.
- Prefer concrete identifiers, paths and commands over adjectives.
- Agent instructions, skills and roles are English single-source and covered by link, wrap and configured budget gates.

## Slop checklist

Remove these before finishing:

- Rules and facts repeated from the owner document instead of linked.
- History narration and changelog prose.
- Implementation-status notes such as "currently in progress" or "recently added".
- Hand-copied directory trees, file inventories and generated output.
- Reasoning traces, speculation and self-review commentary.
- Paragraph walls, repeated conclusions and duplicated summaries.
- Emphasis inflation: bold text, exclamation marks and callouts that add no meaning.
- Placeholder content, including `TODO(owner): question` markers that this change can answer; keep a marker only for an open owner question.

## Verification

- Run `node dist/cli.js detect --strict`. It checks the documentation pack files for broken links, line-start TODO markers and empty architecture sections.
- Run `pnpm doc-sync`. It runs translation pairing, link, wrap, budget and Agent Note checks.
- Run `pnpm run verify-translation-pairing --write` after confirming both sides of a pair.
- Use [dab-doc-writing](../.agents/skills/dab-doc-writing/SKILL.md) for writing and review, [dab-architecture-writing](../.agents/skills/dab-architecture-writing/SKILL.md) for architecture evidence and [dab-decision-notes](../.agents/skills/dab-decision-notes/SKILL.md) for decision records.
- Confirm every changed claim has evidence in code, tests, configuration or an executed command.
- Ask a person to confirm semantic correctness; the gates check structure, links and format only.
