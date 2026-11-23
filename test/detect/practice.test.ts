import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { detectProject } from '../../src/commands/detect.ts';
import { normalizeProject } from '../../src/commands/normalize.ts';
import type { CommandRunner } from '../../src/core/command.ts';
import { DAB_VERSION } from '../../src/core/version.ts';
import {
  AUTHORING_SKILL_NAMES,
  renderAuthoringSkill,
} from '../../src/init/practice-authoring.ts';
import { makeGlobalFixture } from '../helpers/global.ts';
import { populateProject } from '../helpers/initialized.ts';
import { makeProject, writeProjectFile, type ProjectFixture } from '../helpers/project.ts';

const goodRunner: CommandRunner = async () => ({
  stdout: '2.1.325 (Claude Code)\n',
  stderr: '',
  exitCode: 0,
});

const CLEAN_DOCS_AGENTS = `# Documentation guide

One place per fact. Write in English only.
`;

const CLEAN_ARCHITECTURE = `# Architecture

## Project facts

- Project: Demo

## System purpose

DAB verifies the practice layer.

## Composition

One module.

## Runtime flow

Detect reads authored files.

## Module boundaries

Single module.

## Extension points

None.

## Invariants

Tests pass.

## Verification

Run pnpm test.
`;

const projects: ProjectFixture[] = [];
const homes: string[] = [];

async function initializedProject(): Promise<ProjectFixture> {
  const project = await makeProject();
  projects.push(project);
  await populateProject(project);
  await normalizeProject({ cwd: project.root, runner: goodRunner });
  return project;
}

async function completePractice(project: ProjectFixture): Promise<void> {
  await writeProjectFile(project.root, 'docs/AGENTS.md', CLEAN_DOCS_AGENTS);
  await writeProjectFile(project.root, 'docs/architecture.md', CLEAN_ARCHITECTURE);
}

function detect(project: ProjectFixture, strict = false) {
  return detectProject({
    cwd: project.root,
    home: dirname(project.root),
    runner: goodRunner,
    ...(strict ? { strict: true } : {}),
  });
}

function codes(result: { diagnostics: Array<{ code: string }> }): string[] {
  return result.diagnostics.map((item) => item.code);
}

afterEach(async () => {
  await Promise.all(
    projects.splice(0).map((item) => rm(item.root, { recursive: true, force: true })),
  );
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe('detect practice layer', () => {
  it('warns on TODO and empty architecture sections', async () => {
    const project = await initializedProject();
    await completePractice(project);
    await writeProjectFile(
      project.root,
      'docs/architecture.md',
      `# Architecture

## Project facts

- Project: Demo

## System purpose

TODO(owner): Explain why this system exists.

## Composition

## Runtime flow

Detect reads authored files.

## Module boundaries

Single module.

## Extension points

None.

## Invariants

Tests pass.

## Verification

Run pnpm test.
`,
    );

    const result = await detect(project);

    expect(result.exitCode).toBe(0);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'practice.docs-todo',
        severity: 'warning',
        file: 'docs/architecture.md',
      }),
      expect.objectContaining({
        code: 'practice.docs-empty',
        severity: 'warning',
        file: 'docs/architecture.md',
      }),
    ]));
    expect(result.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({
        group: 'Documentation',
        label: 'docs/architecture.md',
        status: 'warn',
        next: 'use dab-architecture-writing',
      }),
    ]));
    expect(result.nextActions).toContain('use dab-architecture-writing');
    expect((await detect(project, true)).exitCode).toBe(3);

    await writeProjectFile(
      project.root,
      'docs/architecture.md',
      `${CLEAN_ARCHITECTURE}
\`TODO:\` is documentation about the marker.

\`\`\`text
TODO: this line is code, not a marker.
\`\`\`
`,
    );

    const fixed = await detect(project);
    expect(codes(fixed)).not.toContain('practice.docs-todo');
    expect(codes(fixed)).not.toContain('practice.docs-empty');
    expect((await detect(project, true)).exitCode).toBe(0);
  });

  it('reports broken links as errors and policy skips as non-strict warnings', async () => {
    const broken = await initializedProject();
    await completePractice(broken);
    await writeProjectFile(
      broken.root,
      'docs/AGENTS.md',
      `${CLEAN_DOCS_AGENTS}
See [missing](nope.md).
`,
    );

    const result = await detect(broken);

    expect(result.exitCode).toBe(3);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'practice.docs-link',
        severity: 'error',
        file: 'docs/AGENTS.md',
      }),
    ]));
    expect(result.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({
        group: 'Documentation',
        label: 'docs/AGENTS.md',
        status: 'error',
      }),
    ]));

    const policyProject = await makeProject();
    projects.push(policyProject);
    await populateProject(policyProject);
    await writeProjectFile(
      policyProject.root,
      '.agents/rules/docs-bilingual.md',
      'Human-facing documentation is paired.\n',
    );
    const normalized = await normalizeProject({
      cwd: policyProject.root,
      runner: goodRunner,
    });
    expect(normalized.ok).toBe(true);

    const policy = await detect(policyProject);
    const policyDiagnostics = policy.diagnostics.filter(
      (item) => item.code === 'practice.docs-bilingual-policy',
    );
    expect(policyDiagnostics.length).toBeGreaterThan(0);
    expect(policyDiagnostics.every((item) => item.severity === 'warning')).toBe(true);
    expect(codes(policy)).not.toContain('practice.docs-missing');
    const policyEntries = policy.checklist.filter((entry) => entry.group === 'Documentation');
    expect(policyEntries.length).toBeGreaterThan(0);
    expect(policyEntries.every((entry) => entry.status === 'warn')).toBe(true);
    expect(policyEntries.every((entry) => entry.next !== 'dab normalize')).toBe(true);
    expect(policy.nextActions).not.toContain('dab normalize');
    expect((await detect(policyProject, true)).exitCode).toBe(0);
  });

  it('reports stale markers as strict but unversioned markers as non-strict/no-next', async () => {
    const project = await initializedProject();
    await completePractice(project);
    const skillFile = '.agents/skills/dab-doc-writing/SKILL.md';
    await writeProjectFile(
      project.root,
      skillFile,
      '---\nname: dab-doc-writing\ndescription: Writes docs.\n---\nBody without a marker.\n',
    );
    await normalizeProject({ cwd: project.root, runner: goodRunner });

    const unversioned = await detect(project);
    expect(unversioned.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'practice.skill-unversioned',
        severity: 'warning',
        file: skillFile,
      }),
    ]));
    const unversionedEntry = unversioned.checklist.find(
      (entry) => entry.group === 'Skills' && entry.label === 'dab-doc-writing',
    );
    expect(unversionedEntry).toMatchObject({ status: 'warn' });
    expect(unversionedEntry?.next).toBeUndefined();
    expect((await detect(project, true)).exitCode).toBe(0);

    await writeProjectFile(
      project.root,
      skillFile,
      '---\nname: dab-doc-writing\ndescription: Writes docs.\n---\n'
        + '<!-- dab-skill: dab-doc-writing@0.0.0 -->\nBody.\n',
    );
    await normalizeProject({ cwd: project.root, runner: goodRunner });

    const stale = await detect(project);
    expect(stale.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'practice.skill-stale',
        severity: 'warning',
        file: skillFile,
      }),
    ]));
    const staleEntry = stale.checklist.find(
      (entry) => entry.group === 'Skills' && entry.label === 'dab-doc-writing',
    );
    expect(staleEntry).toMatchObject({ status: 'warn' });
    expect(staleEntry?.next).toBeDefined();
    expect((await detect(project, true)).exitCode).toBe(3);
  });

  it('governs a broken link whose parent component is a file', async () => {
    const project = await initializedProject();
    await completePractice(project);
    await writeProjectFile(
      project.root,
      'docs/AGENTS.md',
      `${CLEAN_DOCS_AGENTS}
See [nested](architecture.md/child.md).
`,
    );

    const result = await detect(project);

    expect(result.exitCode).toBe(3);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'practice.docs-link',
        severity: 'error',
        file: 'docs/AGENTS.md',
      }),
    ]));
    expect(result.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({
        group: 'Documentation',
        label: 'docs/AGENTS.md',
        status: 'error',
      }),
    ]));
  });

  it('reports practice path conflicts as blocking errors', async () => {
    const project = await initializedProject();
    await completePractice(project);
    await rm(join(project.root, 'docs/AGENTS.md'), { recursive: true, force: true });
    await mkdir(join(project.root, 'docs/AGENTS.md'), { recursive: true });

    const docs = await detect(project);
    expect(docs.exitCode).toBe(3);
    expect(docs.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'practice.docs-path',
        severity: 'error',
        file: 'docs/AGENTS.md',
      }),
    ]));
    expect(codes(docs)).not.toContain('practice.docs-missing');

    await rm(join(project.root, 'docs/AGENTS.md'), { recursive: true, force: true });
    await writeProjectFile(project.root, 'docs/AGENTS.md', CLEAN_DOCS_AGENTS);
    await rm(join(project.root, '.agents/skills/dab-doc-writing'), {
      recursive: true,
      force: true,
    });
    await writeProjectFile(
      project.root,
      '.agents/skills/dab-doc-writing',
      'not a directory\n',
    );

    const skills = await detect(project);
    expect(skills.exitCode).toBe(3);
    expect(skills.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'practice.skill-path',
        severity: 'error',
        file: '.agents/skills/dab-doc-writing',
      }),
    ]));
  });

  it('reports versioned authoring skills as OK with the resolved language detail', async () => {
    const project = await initializedProject();
    await completePractice(project);
    for (const name of AUTHORING_SKILL_NAMES) {
      await writeProjectFile(
        project.root,
        `.agents/skills/${name}/SKILL.md`,
        renderAuthoringSkill(name, DAB_VERSION),
      );
    }
    await normalizeProject({ cwd: project.root, runner: goodRunner });

    const result = await detect(project);
    const docs = result.checklist.filter((entry) => entry.group === 'Documentation');
    expect(docs).toHaveLength(2);
    expect(docs.every((entry) => entry.status === 'ok')).toBe(true);
    expect(docs.every((entry) => entry.detail?.includes('Language: en'))).toBe(true);
    for (const name of AUTHORING_SKILL_NAMES) {
      expect(result.checklist).toEqual(expect.arrayContaining([
        expect.objectContaining({ group: 'Skills', label: name, status: 'ok' }),
      ]));
    }
    expect((await detect(project, true)).exitCode).toBe(0);
  });

  it('never reports practice entries in global scope', async () => {
    const fixture = await makeGlobalFixture();
    homes.push(fixture.home);
    await normalizeProject({ cwd: fixture.agents, home: fixture.home, runner: goodRunner });

    const result = await detectProject({
      cwd: fixture.agents,
      home: fixture.home,
      runner: goodRunner,
    });

    expect(result.scope).toBe('global');
    expect(result.checklist.some((entry) => entry.group === 'Documentation')).toBe(false);
    expect(result.checklist.some(
      (entry) => (AUTHORING_SKILL_NAMES as readonly string[]).includes(entry.label),
    )).toBe(false);
    expect(result.diagnostics.some((item) => item.code.startsWith('practice.'))).toBe(false);
  });
});
