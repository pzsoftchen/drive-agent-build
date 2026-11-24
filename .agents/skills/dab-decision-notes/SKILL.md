---
name: dab-decision-notes
description: Use when recording a durable project decision, its alternatives, consequences, verification or supersession.
---
<!-- dab-skill: dab-decision-notes@0.1.2 sha256=8fe97fb4bea69e2b9923c370ff4d0f20daa7e522b31b181473e2951a44cabb9f -->
# Decision notes

## When to use

Use this skill to write or maintain an Agent Note for a durable, non-obvious decision.

When to write: the choice affects future code, architecture, process or tooling, and the reasoning will not be obvious from the result. Do not write a note for routine edits, reversible local choices or facts that already have an owner document.

## Workflow

1. Place one note per decision under the project's notes directory, following the note format the repository already uses.
2. Choose a status: proposed for a decision under consideration, implemented for a decision in effect, rejected for an option that was considered and not adopted.
3. Record Context, Decision, Alternatives, Consequences and Verification. Name each alternative that was seriously considered and explain why it lost.
4. Consequences and Verification must be concrete. Verification names the tests, commands or manual checks that confirm the decision still holds.
5. Supersession: when a new note replaces an older one, link the new note to the old and mark the old note as superseded by the new one. Do not rewrite the older decision's history.
6. Do not archive, move or delete notes; supersession links preserve the history that later readers need.
7. Verify the note against the code and the project commands below before handing it to review.

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
