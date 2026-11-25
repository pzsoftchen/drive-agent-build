import { afterEach, describe, expect, it } from 'vitest';
import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { detectProject } from '../../src/commands/detect.ts';
import { normalizeProject } from '../../src/commands/normalize.ts';
import type { CommandRunner } from '../../src/core/command.ts';
import { DAB_VERSION } from '../../src/core/version.ts';
import { PRACTICE_NON_STRICT_WARNING_CODES } from '../../src/detect/practice.ts';
import { VERIFICATION_NON_STRICT_WARNING_CODES } from '../../src/detect/verification.ts';
import {
  AUTHORING_SKILL_NAMES,
  renderAuthoringSkill,
} from '../../src/init/practice-authoring.ts';
import {
  loadAuthoringSkillTemplate,
  type AuthoringSkillName,
} from '../../src/init/skill-templates.ts';
import { makeGlobalFixture } from '../helpers/global.ts';
import {
  populateProject,
  syncGeneratedProjections,
} from '../helpers/initialized.ts';
import { makeProject, writeProjectFile, type ProjectFixture } from '../helpers/project.ts';
import { makeTempDir } from '../helpers/tmp.ts';

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
const dirs: string[] = [];
const canDenyRead = process.platform !== 'win32'
  && typeof process.getuid === 'function'
  && process.getuid() !== 0;

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

const DOC_SKILL: AuthoringSkillName = 'dab-doc-writing';
const DOC_SKILL_FILE = '.agents/skills/dab-doc-writing/SKILL.md';

async function writeSkill(
  project: ProjectFixture,
  name: AuthoringSkillName,
  text: string,
): Promise<void> {
  await writeProjectFile(project.root, `.agents/skills/${name}/SKILL.md`, text);
}

/**
 * Refresh the recorded hash for the rewritten skill without running normalize,
 * so only the managed-skill state can drive warnings and strict failures.
 */
async function syncSkillHash(project: ProjectFixture): Promise<void> {
  await syncGeneratedProjections(project.root);
}

function skillCodes(result: { diagnostics: Array<{ code: string }> }): string[] {
  return codes(result).filter((code) => code.startsWith('practice.skill-'));
}

/** Warning codes that `--strict` turns into a validation failure. */
function strictWarningCodes(result: {
  diagnostics: Array<{ code: string; severity: string }>;
}): string[] {
  return result.diagnostics
    .filter(
      (item) => item.severity === 'warning'
        && !PRACTICE_NON_STRICT_WARNING_CODES.has(item.code)
        && !VERIFICATION_NON_STRICT_WARNING_CODES.has(item.code),
    )
    .map((item) => item.code);
}

function skillRows(
  result: Awaited<ReturnType<typeof detect>>,
  label: string,
) {
  return result.checklist.filter(
    (entry) => entry.group === 'Skills' && entry.label === label,
  );
}

afterEach(async () => {
  await Promise.all(
    projects.splice(0).map((item) => rm(item.root, { recursive: true, force: true })),
  );
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('detect practice layer', () => {
  it('keeps stale and missing skill warnings strict, and preserved states non-strict', () => {
    expect(PRACTICE_NON_STRICT_WARNING_CODES.has('practice.skill-stale')).toBe(false);
    expect(PRACTICE_NON_STRICT_WARNING_CODES.has('practice.skill-missing')).toBe(false);
    for (const code of [
      'practice.skill-newer',
      'practice.skill-modified',
      'practice.skill-legacy',
      'practice.skill-unversioned',
      'practice.skill-marker-mismatch',
    ]) {
      expect(PRACTICE_NON_STRICT_WARNING_CODES.has(code)).toBe(true);
    }
  });

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
    await writeProjectFile(
      project.root,
      DOC_SKILL_FILE,
      '---\nname: dab-doc-writing\ndescription: Writes docs.\n---\nBody without a marker.\n',
    );
    await syncSkillHash(project);

    const unversioned = await detect(project);
    expect(unversioned.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'practice.skill-unversioned',
        severity: 'warning',
        file: DOC_SKILL_FILE,
      }),
    ]));
    expect(skillRows(unversioned, DOC_SKILL)).toEqual([
      expect.objectContaining({ status: 'warn' }),
    ]);
    expect(skillRows(unversioned, DOC_SKILL)[0]?.next).toBeUndefined();
    expect((await detect(project, true)).exitCode).toBe(0);

    const staleText = await renderAuthoringSkill(DOC_SKILL, '0.0.0');
    await writeSkill(project, DOC_SKILL, staleText);
    await syncSkillHash(project);

    const stale = await detect(project);
    expect(stale.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'practice.skill-stale',
        severity: 'warning',
        file: DOC_SKILL_FILE,
      }),
    ]));
    // The recorded projection hash is fresh, so the only strict-failing
    // warning is the stale state itself.
    expect(codes(stale)).not.toContain('generated.manifest-stale');
    expect(strictWarningCodes(stale)).toEqual(['practice.skill-stale']);
    const staleRows = skillRows(stale, DOC_SKILL);
    expect(staleRows).toHaveLength(1);
    expect(staleRows[0]).toMatchObject({ status: 'warn', next: 'dab normalize' });
    expect((await detect(project, true)).exitCode).toBe(3);
    // Detect is read-only: the stale install is still on disk.
    expect(await readFile(join(project.root, DOC_SKILL_FILE), 'utf8')).toBe(staleText);
  });

  it('reports a current managed skill as OK with its marker version', async () => {
    const project = await initializedProject();
    await completePractice(project);

    const result = await detect(project);

    expect(skillCodes(result)).toEqual([]);
    expect(skillRows(result, DOC_SKILL)).toEqual([
      expect.objectContaining({ status: 'ok', detail: `version ${DAB_VERSION}` }),
    ]);
    expect((await detect(project, true)).exitCode).toBe(0);
  });

  it.each(['9.9.9', 'future'])(
    'reports version %s with a matching hash as non-strict newer without a next',
    async (version) => {
      const project = await initializedProject();
      await completePractice(project);
      const text = await renderAuthoringSkill(DOC_SKILL, version);
      await writeSkill(project, DOC_SKILL, text);
      await syncSkillHash(project);

      const result = await detect(project);

      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'practice.skill-newer',
          severity: 'warning',
          file: DOC_SKILL_FILE,
        }),
      ]));
      const rows = skillRows(result, DOC_SKILL);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'warn' });
      expect(rows[0]?.next).toBeUndefined();
      expect((await detect(project, true)).exitCode).toBe(0);
      expect(await readFile(join(project.root, DOC_SKILL_FILE), 'utf8')).toBe(text);
    },
  );

  it('reports a modified managed skill as non-strict, preserved and without a next', async () => {
    const project = await initializedProject();
    await completePractice(project);
    const modified = `${await renderAuthoringSkill(DOC_SKILL, DAB_VERSION)}\nLocal note.\n`;
    await writeSkill(project, DOC_SKILL, modified);
    await syncSkillHash(project);

    const result = await detect(project);

    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'practice.skill-modified',
        severity: 'warning',
        file: DOC_SKILL_FILE,
      }),
    ]));
    const rows = skillRows(result, DOC_SKILL);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'warn' });
    expect(rows[0]?.next).toBeUndefined();
    expect(strictWarningCodes(result)).toEqual([]);
    expect(result.nextActions).not.toContain('dab normalize');
    expect((await detect(project, true)).exitCode).toBe(0);
    expect(await readFile(join(project.root, DOC_SKILL_FILE), 'utf8')).toBe(modified);
  });

  it('reports a preserved legacy managed skill as non-strict without a next', async () => {
    const project = await initializedProject();
    await completePractice(project);
    const legacy = `${(await renderAuthoringSkill(DOC_SKILL, '0.0.0'))
      .replace(/ sha256=[0-9a-f]{64}/, '')}\nLocal note.\n`;
    await writeSkill(project, DOC_SKILL, legacy);
    await syncSkillHash(project);

    const result = await detect(project);

    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'practice.skill-legacy',
        severity: 'warning',
        file: DOC_SKILL_FILE,
      }),
    ]));
    const rows = skillRows(result, DOC_SKILL);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'warn' });
    expect(rows[0]?.next).toBeUndefined();
    expect((await detect(project, true)).exitCode).toBe(0);
    expect(await readFile(join(project.root, DOC_SKILL_FILE), 'utf8')).toBe(legacy);
  });

  it('renders a migratable legacy skill as a warn row without a next', async () => {
    const project = await initializedProject();
    await completePractice(project);
    // A legacy marker whose stripped body equals the current template is
    // migrated by normalize, so detect keeps the warn row without auto-next.
    const migratable = (await renderAuthoringSkill(DOC_SKILL, '0.0.0'))
      .replace(/ sha256=[0-9a-f]{64}/, '');
    await writeSkill(project, DOC_SKILL, migratable);
    await syncSkillHash(project);

    const result = await detect(project);

    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'practice.skill-legacy',
        severity: 'info',
        file: DOC_SKILL_FILE,
      }),
    ]));
    expect(result.diagnostics.some(
      (item) => item.code === 'practice.skill-legacy' && item.severity === 'warning',
    )).toBe(false);
    const rows = skillRows(result, DOC_SKILL);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'warn' });
    expect(rows[0]?.detail).toContain('will be migrated by dab normalize');
    expect(rows[0]?.next).toBeUndefined();
    expect((await detect(project, true)).exitCode).toBe(0);
    expect(await readFile(join(project.root, DOC_SKILL_FILE), 'utf8')).toBe(migratable);
  });

  it('reports a managed skill plan path error as a blocking error row', async () => {
    const project = await initializedProject();
    await completePractice(project);
    const target = '.agents/skill-sources/dab-doc-writing.md';
    await writeProjectFile(
      project.root,
      target,
      await renderAuthoringSkill(DOC_SKILL, DAB_VERSION),
    );
    await rm(join(project.root, DOC_SKILL_FILE), { force: true });
    await symlink(join(project.root, target), join(project.root, DOC_SKILL_FILE));

    const result = await detect(project);

    expect(result.exitCode).toBe(3);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'practice.skill-path',
        severity: 'error',
        file: DOC_SKILL_FILE,
      }),
    ]));
    const rows = skillRows(result, DOC_SKILL);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'error',
      next: 'resolve the path conflict manually',
    });
    // The shared plan refuses symlinked SKILL.md files; detect only reports it.
    expect((await lstat(join(project.root, DOC_SKILL_FILE))).isSymbolicLink()).toBe(true);
  });

  it('reports an unversioned managed skill as non-strict without a next', async () => {
    const project = await initializedProject();
    await completePractice(project);
    const unversioned = await loadAuthoringSkillTemplate(DOC_SKILL);
    await writeSkill(project, DOC_SKILL, unversioned);
    await syncSkillHash(project);

    const result = await detect(project);

    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'practice.skill-unversioned',
        severity: 'warning',
        file: DOC_SKILL_FILE,
      }),
    ]));
    const rows = skillRows(result, DOC_SKILL);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'warn' });
    expect(rows[0]?.next).toBeUndefined();
    expect((await detect(project, true)).exitCode).toBe(0);
  });

  it('reports a marker naming another skill as a non-strict mismatch without duplicates', async () => {
    const project = await initializedProject();
    await completePractice(project);
    const mismatched = (await renderAuthoringSkill(DOC_SKILL, DAB_VERSION)).replace(
      'dab-skill: dab-doc-writing@',
      'dab-skill: dab-other-skill@',
    );
    await writeSkill(project, DOC_SKILL, mismatched);
    await syncSkillHash(project);

    const result = await detect(project);

    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'practice.skill-marker-mismatch',
        severity: 'warning',
        file: DOC_SKILL_FILE,
      }),
    ]));
    expect(result.diagnostics.filter(
      (item) => item.code === 'practice.skill-unversioned',
    )).toEqual([]);
    const rows = skillRows(result, DOC_SKILL);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'warn' });
    expect(rows[0]?.next).toBeUndefined();
    expect((await detect(project, true)).exitCode).toBe(0);
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
        await renderAuthoringSkill(name, DAB_VERSION),
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

  it('governs a regular file at .agents/rules on an initialized project', async () => {
    const project = await initializedProject();
    await completePractice(project);
    await rm(join(project.root, '.agents/rules'), { recursive: true, force: true });
    await writeProjectFile(project.root, '.agents/rules', 'not a directory\n');

    const result = await detect(project);

    expect(result.exitCode).toBe(3);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'practice.docs-path',
        severity: 'error',
        file: '.agents/rules',
      }),
    ]));
  });

  it('governs a regular file at .agents/skills on an initialized project', async () => {
    const project = await initializedProject();
    await completePractice(project);
    await rm(join(project.root, '.agents/skills'), { recursive: true, force: true });
    await writeProjectFile(project.root, '.agents/skills', 'not a directory\n');

    const result = await detect(project);

    expect(result.exitCode).toBe(3);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'practice.skill-path',
        severity: 'error',
        file: '.agents/skills',
      }),
    ]));
  });

  it('governs a regular file at .agents/hooks on an initialized project', async () => {
    const project = await initializedProject();
    await completePractice(project);
    await rm(join(project.root, '.agents/hooks'), { recursive: true, force: true });
    await writeProjectFile(project.root, '.agents/hooks', 'not a directory\n');

    const result = await detect(project);

    expect(result.exitCode).toBe(3);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'path.conflict',
        severity: 'error',
        file: '.agents/hooks',
      }),
    ]));
    expect(result.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: 'Hooks', label: '.agents/hooks', status: 'error' }),
    ]));
  });

  it('governs a dangling .agents/hooks symlink on an initialized project', async () => {
    const project = await initializedProject();
    await completePractice(project);
    await rm(join(project.root, '.agents/hooks'), { recursive: true, force: true });
    await symlink('missing-hooks', join(project.root, '.agents/hooks'), 'dir');

    const result = await detect(project);

    expect(result.exitCode).toBe(3);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'path.conflict',
        severity: 'error',
        file: '.agents/hooks',
      }),
    ]));
    expect(result.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: 'Hooks', label: '.agents/hooks', status: 'error' }),
    ]));
  });

  it('governs a regular file at .agents/notes on an initialized project', async () => {
    const project = await initializedProject();
    await completePractice(project);
    await rm(join(project.root, '.agents/notes'), { recursive: true, force: true });
    await writeProjectFile(project.root, '.agents/notes', 'not a directory\n');

    const result = await detect(project);

    expect(result.exitCode).toBe(3);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'path.conflict',
        severity: 'error',
        file: '.agents/notes',
      }),
    ]));
    expect(result.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: 'Notes', label: '.agents/notes', status: 'error' }),
    ]));
  });

  it('governs a dangling .agents/notes symlink on an initialized project', async () => {
    const project = await initializedProject();
    await completePractice(project);
    await rm(join(project.root, '.agents/notes'), { recursive: true, force: true });
    await symlink('missing-notes', join(project.root, '.agents/notes'), 'dir');

    const result = await detect(project);

    expect(result.exitCode).toBe(3);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'path.conflict',
        severity: 'error',
        file: '.agents/notes',
      }),
    ]));
    expect(result.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: 'Notes', label: '.agents/notes', status: 'error' }),
    ]));
  });

  it.each(['hooks', 'rules', 'notes'])(
    'governs an unreadable .agents/%s directory on an initialized project',
    async (parent) => {
      if (!canDenyRead) {
        return;
      }
      const project = await initializedProject();
      await completePractice(project);
      const directory = join(project.root, '.agents', parent);
      await mkdir(directory, { recursive: true });
      await chmod(directory, 0o000);
      try {
        const result = await detect(project);

        expect(result.exitCode).toBe(3);
        expect(result.diagnostics.some(
          (item) => item.severity === 'error'
            && item.file === `.agents/${parent}`
            && ['path.conflict', 'practice.docs-path', 'practice.skill-path']
              .includes(item.code),
        )).toBe(true);
        expect(result.checklist.some(
          (entry) => entry.status === 'ok'
            && entry.label === `.agents/${parent}`,
        )).toBe(false);
      } finally {
        await chmod(directory, 0o755);
      }
    },
  );

  it('governs a regular file at global .agents/notes', async () => {
    const fixture = await makeGlobalFixture();
    homes.push(fixture.home);
    await rm(join(fixture.agents, 'notes'), { recursive: true, force: true });
    await writeFile(join(fixture.agents, 'notes'), 'not a directory\n');

    const result = await detectProject({
      cwd: fixture.agents,
      home: fixture.home,
      runner: goodRunner,
    });

    expect(result.scope).toBe('global');
    expect(result.exitCode).toBe(3);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'path.conflict',
        severity: 'error',
        file: '.agents/notes',
      }),
    ]));
    expect(result.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: 'Notes', label: '.agents/notes', status: 'error' }),
    ]));
  });

  it.each(['hooks', 'rules', 'notes'])(
    'governs an unreadable global .agents/%s directory',
    async (parent) => {
      if (!canDenyRead) {
        return;
      }
      const fixture = await makeGlobalFixture();
      homes.push(fixture.home);
      const directory = join(fixture.agents, parent);
      await mkdir(directory, { recursive: true });
      await chmod(directory, 0o000);
      try {
        const result = await detectProject({
          cwd: fixture.agents,
          home: fixture.home,
          runner: goodRunner,
        });

        expect(result.scope).toBe('global');
        expect(result.exitCode).toBe(3);
        expect(result.diagnostics.some(
          (item) => item.severity === 'error' && item.file === `.agents/${parent}`,
        )).toBe(true);
      } finally {
        await chmod(directory, 0o755);
      }
    },
  );

  it('governs a regular file at .agents/agents on an initialized project', async () => {
    const project = await initializedProject();
    await completePractice(project);
    await rm(join(project.root, '.agents/agents'), { recursive: true, force: true });
    await writeProjectFile(project.root, '.agents/agents', 'not a directory\n');

    const result = await detect(project);

    expect(result.exitCode).toBe(3);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'path.conflict',
        severity: 'error',
        file: '.agents/agents',
      }),
    ]));
  });

  it('reports an unreadable authoring skill directory as a path error', async () => {
    if (!canDenyRead) {
      return;
    }
    const project = await initializedProject();
    await completePractice(project);
    const directory = join(project.root, '.agents/skills/dab-doc-writing');
    await chmod(directory, 0o000);
    try {
      const result = await detect(project);

      expect(result.exitCode).toBe(3);
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'practice.skill-path',
          severity: 'error',
          file: '.agents/skills/dab-doc-writing',
        }),
      ]));
    } finally {
      await chmod(directory, 0o755);
    }
  });

  it('reports an unreadable docs directory as a path error', async () => {
    if (!canDenyRead) {
      return;
    }
    const project = await initializedProject();
    await completePractice(project);
    const directory = join(project.root, 'docs');
    await chmod(directory, 0o000);
    try {
      const result = await detect(project);

      expect(result.exitCode).toBe(3);
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'practice.docs-path',
          severity: 'error',
          file: 'docs/AGENTS.md',
        }),
      ]));
    } finally {
      await chmod(directory, 0o755);
    }
  });

  it('reports an unreadable user skill directory instead of a healthy project', async () => {
    if (!canDenyRead) {
      return;
    }
    const project = await initializedProject();
    await completePractice(project);
    const directory = join(project.root, '.agents/skills/doc-sync');
    await chmod(directory, 0o000);
    try {
      const result = await detect(project);

      expect(result.exitCode).toBe(3);
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'skill.unreadable',
          severity: 'error',
          file: '.agents/skills/doc-sync',
        }),
      ]));
      expect(result.checklist).toEqual(expect.arrayContaining([
        expect.objectContaining({
          group: 'Skills',
          label: '.agents/skills/doc-sync',
          status: 'error',
        }),
        expect.objectContaining({
          group: 'Skills',
          label: 'dab-doc-writing',
          status: 'ok',
        }),
      ]));
      expect(result.checklist.filter(
        (entry) => entry.group === 'Skills' && entry.label === '.agents/skills/doc-sync',
      )).toHaveLength(1);
      expect(result.checklist.some(
        (entry) => entry.label === '.agents/skills/doc-sync' && entry.status === 'ok',
      )).toBe(false);
    } finally {
      await chmod(directory, 0o755);
    }
  });

  it('reports a skill directory symlinked to a file as a path error', async () => {
    const project = await initializedProject();
    await completePractice(project);
    await writeProjectFile(project.root, '.agents/skills/real-target.txt', 'not a skill\n');
    await rm(join(project.root, '.agents/skills/dab-doc-writing'), {
      recursive: true,
      force: true,
    });
    await symlink(
      join(project.root, '.agents/skills/real-target.txt'),
      join(project.root, '.agents/skills/dab-doc-writing'),
    );

    const result = await detect(project);

    expect(result.exitCode).toBe(3);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'practice.skill-path',
        severity: 'error',
        file: '.agents/skills/dab-doc-writing',
      }),
    ]));
  });

  it('accepts a skill directory symlinked to a directory inside the root', async () => {
    const project = await initializedProject();
    await completePractice(project);
    const real = '.agents/skill-sources/dab-doc-writing';
    await writeProjectFile(
      project.root,
      `${real}/SKILL.md`,
      await renderAuthoringSkill('dab-doc-writing', DAB_VERSION),
    );
    await rm(join(project.root, '.agents/skills/dab-doc-writing'), {
      recursive: true,
      force: true,
    });
    await symlink(join(project.root, real), join(project.root, '.agents/skills/dab-doc-writing'));

    const result = await detect(project);

    expect(codes(result)).not.toContain('practice.skill-path');
    expect(result.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({
        group: 'Skills',
        label: 'dab-doc-writing',
        status: 'ok',
        detail: `version ${DAB_VERSION}`,
      }),
    ]));
  });

  it('reports a docs file symlinked outside the root as a path error', async () => {
    const project = await initializedProject();
    await completePractice(project);
    const outside = await makeTempDir('dab-detect-outside-');
    dirs.push(outside);
    await writeFile(join(outside, 'AGENTS.md'), '# outside\n');
    await rm(join(project.root, 'docs/AGENTS.md'), { force: true });
    await symlink(join(outside, 'AGENTS.md'), join(project.root, 'docs/AGENTS.md'));

    const result = await detect(project);

    expect(result.exitCode).toBe(3);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'practice.docs-path',
        severity: 'error',
        file: 'docs/AGENTS.md',
      }),
    ]));
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

  it('governs a regular file at global .agents/hooks', async () => {
    const fixture = await makeGlobalFixture();
    homes.push(fixture.home);
    await rm(join(fixture.agents, 'hooks'), { recursive: true, force: true });
    await writeFile(join(fixture.agents, 'hooks'), 'not a directory\n');

    const result = await detectProject({
      cwd: fixture.agents,
      home: fixture.home,
      runner: goodRunner,
    });

    expect(result.scope).toBe('global');
    expect(result.exitCode).toBe(3);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'path.conflict',
        severity: 'error',
        file: '.agents/hooks',
      }),
    ]));
    expect(result.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: 'Hooks', label: '.agents/hooks', status: 'error' }),
    ]));
  });
});
