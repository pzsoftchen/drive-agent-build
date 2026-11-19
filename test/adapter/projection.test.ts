import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, readlink, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  applyProjectionActions,
  discoverProjections,
  planProjectionActions,
} from '../../src/adapter/claude-code/projection.ts';
import { replaceSymlink } from '../../src/core/fs-atomic.ts';
import { sha256 } from '../../src/core/hash.ts';
import { relativeLink } from '../../src/core/paths.ts';
import type {
  GeneratedTarget,
  ProjectPaths,
  Projection,
} from '../../src/model/types.ts';
import { makeProject, writeProjectFile, type ProjectFixture } from '../helpers/project.ts';

const projects: ProjectFixture[] = [];

async function fixture(): Promise<ProjectFixture> {
  const project = await makeProject();
  projects.push(project);
  await writeProjectFile(
    project.root,
    '.agents/agents/reviewer.md',
    '---\nname: reviewer\ndescription: Reviews changes.\n---\nReview.\n',
  );
  await writeProjectFile(
    project.root,
    '.agents/skills/doc-sync/SKILL.md',
    '---\nname: doc-sync\ndescription: Keeps docs paired.\n---\nSync docs.\n',
  );
  await writeProjectFile(project.root, '.agents/rules/testing.md', 'Run tests.\n');
  return project;
}

afterEach(async () => {
  await Promise.all(projects.splice(0).map((item) => rm(item.root, { recursive: true, force: true })));
});

function paths(root: string): ProjectPaths {
  return {
    root,
    scope: 'project',
    agents: join(root, '.agents'),
    claude: join(root, '.claude'),
    manifest: join(root, 'dab.yaml'),
    instructions: join(root, 'AGENTS.md'),
  };
}

function generated(projections: Projection[]): GeneratedTarget {
  return {
    provider: 'claude-code',
    settings: { path: '.claude/settings.json', sha256: 'a'.repeat(64) },
    instructions: null,
    projections,
  };
}

async function linkProjection(
  root: string,
  projection: Projection,
): Promise<void> {
  const target = join(root, projection.target);
  const source = join(root, projection.source);
  await mkdir(join(root, '.claude', projection.kind === 'agent'
    ? 'agents'
    : projection.kind === 'skill'
      ? 'skills'
      : 'rules'), { recursive: true });
  await replaceSymlink(target, relativeLink(target, source));
}

describe('projection discovery', () => {
  it('discovers agents, skills and rules deterministically', async () => {
    const project = await fixture();

    const first = await discoverProjections(project.root, paths(project.root));
    const second = await discoverProjections(project.root, paths(project.root));

    expect(first.diagnostics).toEqual([]);
    expect(first.projections).toHaveLength(3);
    expect(second.projections).toEqual(first.projections);
    expect(first.projections.find((item) => item.kind === 'agent')).toMatchObject({
      name: 'reviewer',
      source: '.agents/agents/reviewer.md',
      target: '.claude/agents/reviewer.md',
      link: 'symlink',
    });
    expect(first.projections.find((item) => item.kind === 'skill')?.target).toBe(
      '.claude/skills/doc-sync',
    );
    expect(first.projections.find((item) => item.kind === 'rule')?.target).toBe(
      '.claude/rules/testing.md',
    );
    expect(first.projections.every((item) => /^[a-f0-9]{64}$/.test(item.sourceSha256))).toBe(true);
  });

  it('hashes skill directories in code-unit order', async () => {
    const project = await fixture();
    const skill = [
      '---',
      'name: mixed',
      'description: Mixed files.',
      '---',
      'Body.',
      '',
    ].join('\n');
    await writeProjectFile(project.root, '.agents/skills/mixed/SKILL.md', skill);
    await writeProjectFile(project.root, '.agents/skills/mixed/B.md', 'b');
    await writeProjectFile(project.root, '.agents/skills/mixed/a.md', 'a');

    const discovered = await discoverProjections(project.root, paths(project.root));
    const projection = discovered.projections.find(
      (item) => item.kind === 'skill' && item.name === 'mixed',
    );
    const expected = sha256([
      `B.md\0${sha256('b')}`,
      `SKILL.md\0${sha256(skill)}`,
      `a.md\0${sha256('a')}`,
    ].join('\n'));

    expect(projection?.sourceSha256).toBe(expected);
  });
});

describe('projection planning and application', () => {
  it('creates missing links and manifest entries', async () => {
    const project = await fixture();
    const { projections } = await discoverProjections(project.root, paths(project.root));

    const plan = await planProjectionActions(project.root, projections, undefined);

    expect(plan.conflicts).toEqual([]);
    expect(plan.actions.filter((item) => item.type === 'create-link')).toHaveLength(3);
    expect(plan.actions.filter((item) => item.type === 'add-manifest')).toHaveLength(3);
  });

  it('does nothing for correct managed links', async () => {
    const project = await fixture();
    const { projections } = await discoverProjections(project.root, paths(project.root));
    for (const projection of projections) {
      await linkProjection(project.root, projection);
    }

    const plan = await planProjectionActions(
      project.root,
      projections,
      generated(projections),
    );

    expect(plan.conflicts).toEqual([]);
    expect(plan.actions).toEqual([]);
  });

  it('repairs a wrong managed symlink', async () => {
    const project = await fixture();
    const { projections } = await discoverProjections(project.root, paths(project.root));
    const projection = projections.find((item) => item.kind === 'agent');
    if (projection === undefined) {
      throw new Error('missing projection');
    }
    const target = join(project.root, projection.target);
    await mkdir(join(project.root, '.claude/agents'), { recursive: true });
    await symlink('wrong.md', target);

    const plan = await planProjectionActions(project.root, projections, generated(projections));

    expect(plan.actions.map((item) => item.type)).toContain('repair-link');
    expect(plan.conflicts).toEqual([]);
  });

  it('treats a physical copy as a conflict and backs it up only with fix', async () => {
    const project = await fixture();
    const { projections } = await discoverProjections(project.root, paths(project.root));
    const projection = projections.find((item) => item.kind === 'agent');
    if (projection === undefined) {
      throw new Error('missing projection');
    }
    const target = join(project.root, projection.target);
    await mkdir(join(project.root, '.claude/agents'), { recursive: true });
    await writeFile(target, 'physical copy\n');

    const withoutFix = await planProjectionActions(
      project.root,
      projections,
      generated(projections),
    );
    const withFix = await planProjectionActions(project.root, projections, generated(projections), {
      fix: true,
    });

    expect(withoutFix.conflicts.map((item) => item.code)).toContain('projection.physical-copy');
    expect(withoutFix.actions.some((item) => item.type === 'backup-and-replace')).toBe(false);
    expect(withFix.actions.some((item) => item.type === 'backup-and-replace')).toBe(true);
  });

  it('removes a managed link whose source disappeared', async () => {
    const project = await fixture();
    const { projections } = await discoverProjections(project.root, paths(project.root));
    const projection = projections.find((item) => item.kind === 'agent');
    if (projection === undefined) {
      throw new Error('missing projection');
    }
    await linkProjection(project.root, projection);
    await unlink(join(project.root, projection.source));

    const plan = await planProjectionActions(project.root, [], generated(projections));

    expect(plan.actions.map((item) => item.type)).toEqual(
      expect.arrayContaining(['remove-link', 'remove-manifest']),
    );
    expect(plan.conflicts).toEqual([]);
  });

  it('creates links atomically and backs up physical conflicts', async () => {
    const project = await fixture();
    const { projections } = await discoverProjections(project.root, paths(project.root));
    const projection = projections.find((item) => item.kind === 'agent');
    if (projection === undefined) {
      throw new Error('missing projection');
    }
    const target = join(project.root, projection.target);
    await mkdir(join(project.root, '.claude/agents'), { recursive: true });
    await writeFile(target, 'physical copy\n');
    const plan = await planProjectionActions(project.root, projections, generated(projections), {
      fix: true,
    });
    const backupRoot = join(project.root, '.dab/backups/test');

    await applyProjectionActions(project.root, plan.actions, { backupRoot });

    expect((await readlink(target)).includes('.agents/agents/reviewer.md')).toBe(true);
    expect(await readFile(join(backupRoot, projection.target), 'utf8')).toBe('physical copy\n');
  });
});
