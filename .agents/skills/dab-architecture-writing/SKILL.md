---
name: dab-architecture-writing
description: Use when filling docs/architecture.md with evidence about layout, components, runtime flow, seams and invariants.
---
<!-- dab-skill: dab-architecture-writing@0.1.1 -->
# Architecture writing

## When to use

Use this skill to fill, restructure or review `docs/architecture.md`, or when a component, entry point, runtime flow, seam or invariant changes.

Write only what the repository proves. Leave an owner question when the design intent is not verifiable.

## Workflow

1. Top-level inventory: list source directories, entry points and external boundaries from the repository. Each entry names its evidence.
2. Composition: describe the primary components and how they relate. Do not invent layers, call chains or responsibilities.
3. Runtime flow: trace each main entry point end to end and name the files, tests or commands that prove the flow.
4. Seams: record module boundaries, extension points and invariants where new behavior plugs in or must not break.
5. Write current-state prose. Describe what exists now, not history, plans or implementation progress.
6. Link owners: keep summaries in the architecture document and link detailed behavior to its owner document or source file instead of copying it.
7. Fill TODOs: replace every skeleton TODO with an evidence-backed statement or `TODO(owner): question`.
8. Verify each section against the code and the project commands below before handing the document to review.

## Inputs

- When `docs/AGENTS.md` exists, it is the documentation authority; follow its placement, writing and verification rules before this skill.
- When `docs/AGENTS.md` does not exist, read the root `AGENTS.md` and the project rules under `.agents/rules/`. Project rules always win over this skill.
- The code, tests, configuration and executed commands that can evidence each claim.
- The owner documents and the links that the change touches.
- The project documentation language. Write in that one language and do not create translations or pairing records.

## Evidence and fact-check

- Every command, behavior, default, path or flow claim needs evidence: a source file, a test, a configuration value or an executed command.
- Read the evidence before writing the claim. A file name alone is not proof that the described behavior exists.
- This skill does not invent components, flows, boundaries, commands or history; if the repository does not show it, do not write it.
- Unverifiable content stays as `TODO(owner): question`. Never fill a TODO from memory, another project or this skill.

## TODO rules

- Use `TODO(owner): question` when a statement cannot be verified from code, tests, configuration or an executed command. Write the open question, not a guessed answer.
- Name the question so the owner can answer it without re-reading this skill.
- Replace the TODO with current-state prose and its evidence once the evidence exists.
- Keep each TODO marker at the start of its line so the project's documentation checks can find it.
- Do not delete a TODO just to make a check pass; answer it or leave it with the question.

## Project commands

- Read commands from `AGENTS.md`, `docs/AGENTS.md`, or the `scripts` field in `package.json`; use the commands the project documents.
- Use the package manager the repository already uses. Do not hardcode a package manager, test runner or documentation gate.
- Run only commands that exist. When a command is missing, write `TODO(owner): question` instead of inventing one.

## Verification

- Run the project commands discovered above, including the documentation gate or `dab detect` when the project defines them.
- Confirm that every changed claim has evidence and that remaining TODOs are owner questions rather than missing guesses.
- Confirm that links point to files that exist and that headings, lists, tables and fenced code stay structurally stable.
- Semantic correctness still needs a review by a person or a review pass; this skill cannot prove meaning.
