import type { PracticeContext, PracticePack, PracticeTargetSet } from './practice.ts';

export const AUTHORING_SKILL_NAMES = [
  'dab-doc-writing',
  'dab-architecture-writing',
  'dab-decision-notes',
] as const;

type AuthoringSkillName = (typeof AUTHORING_SKILL_NAMES)[number];

interface SkillContent {
  title: string;
  description: string;
  whenToUse: string;
  workflow: string;
}

const SHARED_INPUTS = `## Inputs

- When \`docs/AGENTS.md\` exists, it is the documentation authority; follow its placement, writing and verification rules before this skill.
- When \`docs/AGENTS.md\` does not exist, read the root \`AGENTS.md\` and the project rules under \`.agents/rules/\`. Project rules always win over this skill.
- The code, tests, configuration and executed commands that can evidence each claim.
- The owner documents and the links that the change touches.
- The project documentation language. Write in that one language and do not create translations or pairing records.`;

const SHARED_EVIDENCE = `## Evidence and fact-check

- Every command, behavior, default, path or flow claim needs evidence: a source file, a test, a configuration value or an executed command.
- Read the evidence before writing the claim. A file name alone is not proof that the described behavior exists.
- This skill does not invent components, flows, boundaries, commands or history; if the repository does not show it, do not write it.
- Unverifiable content stays as \`TODO(owner): question\`. Never fill a TODO from memory, another project or this skill.`;

const SHARED_TODO = `## TODO rules

- Use \`TODO(owner): question\` when a statement cannot be verified from code, tests, configuration or an executed command. Write the open question, not a guessed answer.
- Name the question so the owner can answer it without re-reading this skill.
- Replace the TODO with current-state prose and its evidence once the evidence exists.
- Keep each TODO marker at the start of its line so the project's documentation checks can find it.
- Do not delete a TODO just to make a check pass; answer it or leave it with the question.`;

const SHARED_COMMANDS = `## Project commands

- Read commands from \`AGENTS.md\`, \`docs/AGENTS.md\`, or the \`scripts\` field in \`package.json\`; use the commands the project documents.
- Use the package manager the repository already uses. Do not hardcode a package manager, test runner or documentation gate.
- Run only commands that exist. When a command is missing, write \`TODO(owner): question\` instead of inventing one.`;

const SHARED_VERIFICATION = `## Verification

- Run the project commands discovered above, including the documentation gate or \`dab detect\` when the project defines them.
- Confirm that every changed claim has evidence and that remaining TODOs are owner questions rather than missing guesses.
- Confirm that links point to files that exist and that headings, lists, tables and fenced code stay structurally stable.
- Semantic correctness still needs a review by a person or a review pass; this skill cannot prove meaning.`;

const SKILL_CONTENT: Record<AuthoringSkillName, SkillContent> = {
  'dab-doc-writing': {
    title: 'Documentation writing',
    description:
      'Use when writing, restructuring or reviewing project documentation; covers placement, fact-check, slop audit and verification.',
    whenToUse: `Use this skill to write a new project document, restructure existing documentation, or review and fact-check a documentation change.

This skill owns the general workflow only. Project-specific placement and writing rules stay in the project's authority files; do not fork them here.`,
    workflow: `1. Read the authority files from Inputs and identify the owner document for every fact you plan to touch.
2. Placement: every fact has exactly one home. Keep detail in its owner document and link to it from summaries instead of copying it.
3. Fact-check: open the code, test or configuration that proves each claim before writing it.
4. Write current-state prose in the project's single language. Describe what exists now; do not narrate history, planned work or implementation progress.
5. Slop audit: apply the project's checklist and remove repeated rules, reasoning traces, hand-copied directory trees, emphasis inflation and paragraph walls.
6. Check that every relative link points to a file that exists and that headings, lists, tables and fenced code stay stable unless the change is about structure.
7. Do not generate translations or pairing records; the project documentation uses one language.
8. Verify with the project commands below and record what you checked.`,
  },
  'dab-architecture-writing': {
    title: 'Architecture writing',
    description:
      'Use when filling docs/architecture.md with evidence about layout, components, runtime flow, seams and invariants.',
    whenToUse: `Use this skill to fill, restructure or review \`docs/architecture.md\`, or when a component, entry point, runtime flow, seam or invariant changes.

Write only what the repository proves. Leave an owner question when the design intent is not verifiable.`,
    workflow: `1. Top-level inventory: list source directories, entry points and external boundaries from the repository. Each entry names its evidence.
2. Composition: describe the primary components and how they relate. Do not invent layers, call chains or responsibilities.
3. Runtime flow: trace each main entry point end to end and name the files, tests or commands that prove the flow.
4. Seams: record module boundaries, extension points and invariants where new behavior plugs in or must not break.
5. Write current-state prose. Describe what exists now, not history, plans or implementation progress.
6. Link owners: keep summaries in the architecture document and link detailed behavior to its owner document or source file instead of copying it.
7. Fill TODOs: replace every skeleton TODO with an evidence-backed statement or \`TODO(owner): question\`.
8. Verify each section against the code and the project commands below before handing the document to review.`,
  },
  'dab-decision-notes': {
    title: 'Decision notes',
    description:
      'Use when recording a durable project decision, its alternatives, consequences, verification or supersession.',
    whenToUse: `Use this skill to write or maintain an Agent Note for a durable, non-obvious decision.

When to write: the choice affects future code, architecture, process or tooling, and the reasoning will not be obvious from the result. Do not write a note for routine edits, reversible local choices or facts that already have an owner document.`,
    workflow: `1. Place one note per decision under the project's notes directory, following the note format the repository already uses.
2. Choose a status: proposed for a decision under consideration, implemented for a decision in effect, rejected for an option that was considered and not adopted.
3. Record Context, Decision, Alternatives, Consequences and Verification. Name each alternative that was seriously considered and explain why it lost.
4. Consequences and Verification must be concrete. Verification names the tests, commands or manual checks that confirm the decision still holds.
5. Supersession: when a new note replaces an older one, link the new note to the old and mark the old note as superseded by the new one. Do not rewrite the older decision's history.
6. Do not archive, move or delete notes; supersession links preserve the history that later readers need.
7. Verify the note against the code and the project commands below before handing it to review.`,
  },
};

function skillDirectory(name: AuthoringSkillName): string {
  return `.agents/skills/${name}`;
}

function skillFile(name: AuthoringSkillName): string {
  return `${skillDirectory(name)}/SKILL.md`;
}

export function renderAuthoringSkill(name: AuthoringSkillName, version: string): string {
  const skill = SKILL_CONTENT[name];
  return `---
name: ${name}
description: ${skill.description}
---
<!-- dab-skill: ${name}@${version} -->
# ${skill.title}

## When to use

${skill.whenToUse}

## Workflow

${skill.workflow}

${SHARED_INPUTS}

${SHARED_EVIDENCE}

${SHARED_TODO}

${SHARED_COMMANDS}

${SHARED_VERIFICATION}
`;
}

function authoringTargets(context: PracticeContext): PracticeTargetSet {
  if (context.scope !== 'project') {
    return { paths: [] };
  }
  const directories = AUTHORING_SKILL_NAMES.map(skillDirectory);
  return {
    paths: AUTHORING_SKILL_NAMES.map(skillFile),
    directories,
    // An existing skill directory belongs to the user: skip it and every
    // declared file under it instead of adding or merging a SKILL.md.
    skipChildrenWhenExists: directories,
  };
}

export const authoringPack: PracticePack = {
  id: 'authoring',
  targets: authoringTargets,
  files(context) {
    if (context.scope !== 'project') {
      return {};
    }
    const files: Record<string, string> = {};
    for (const name of AUTHORING_SKILL_NAMES) {
      files[skillFile(name)] = renderAuthoringSkill(name, context.version);
    }
    return files;
  },
};
