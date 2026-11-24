---
name: dab-doc-writing
description: Use when writing, restructuring or reviewing project documentation; covers placement, fact-check, slop audit and verification.
---
<!-- dab-skill: dab-doc-writing@0.1.2 sha256=32117ddec3cfad1126abd7f1e5596ce8bea44cd908716b3af092c34ebc323802 -->
# Documentation writing

## When to use

Use this skill to write a new project document, restructure existing documentation, or review and fact-check a documentation change.

This skill owns the general workflow only. Project-specific placement and writing rules stay in the project's authority files; do not fork them here.

## Workflow

1. Read the authority files from Inputs and identify the owner document for every fact you plan to touch.
2. Placement: every fact has exactly one home. Keep detail in its owner document and link to it from summaries instead of copying it.
3. Fact-check: open the code, test or configuration that proves each claim before writing it.
4. Write current-state prose in the project's single language. Describe what exists now; do not narrate history, planned work or implementation progress.
5. Slop audit: apply the project's checklist and remove repeated rules, reasoning traces, hand-copied directory trees, emphasis inflation and paragraph walls.
6. Check that every relative link points to a file that exists and that headings, lists, tables and fenced code stay stable unless the change is about structure.
7. Do not generate translations or pairing records unless project rules require them; the project documentation uses one language.
8. Verify with the project commands below and record what you checked.

## Inputs

- When `docs/AGENTS.md` exists, it is the documentation authority; follow its placement, writing and verification rules before this skill.
- When `docs/AGENTS.md` does not exist, read the root `AGENTS.md` and the project rules under `.agents/rules/`. Project rules always win over this skill.
- The code, tests, configuration and executed commands that can evidence each claim.
- The owner documents and the links that the change touches.
- The project documentation language. Write in that one language; create translations or pairing records only when project rules require them.

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
