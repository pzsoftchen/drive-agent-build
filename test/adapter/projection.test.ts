import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, readlink, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  applyProjectionActions,
  discoverProjections,
  planClaudeMdShim,
  planProjectionActions,
  renderClaudeMdShim,
} from '../../src/adapter/claude-code/projection.ts';
import { replaceSymlink } from '../../src/core/fs-atomic.ts';
import { relativeLink } from '../../src/core/paths.ts';
import type {
  GeneratedTarget,
  ProjectManifest,
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

function generated(
  projections: Projection[],
  instructions: GeneratedTarget['instructions'] = null,
): GeneratedTarget {
  return {
    provider: 'claude-code',
    settings: { path: '.claude/settings.json', sha256: 'a'.repeat(64) },
    instructions,
    projections,
  };
}

function manifest(
  instructions: 'generated' | 'disabled' = 'generated',
  generatedTarget?: GeneratedTarget,
): ProjectManifest {
  return {
    version: 2,
    scope: 'project',
    project: { id: 'demo', name: 'Demo' },
    profile: 'feature',
    targets: [{
      provider: 'claude-code',
      enabled: true,
      options: { minVersion: '2.1.277', instructions },
    }],
    paths: { agents: '.agents', claude: '.claude' },
    ...(generatedTarget === undefined ? {} : { generated: { targets: [generatedTarget] } }),
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

describe('generated CLAUDE.md shim', () => {
  it('renders a single AGENTS.md import with a generated header', () => {
    expect(renderClaudeMdShim()).toBe(
      '<!-- Generated by DAB from AGENTS.md. Do not edit. Run `dab normalize` to regenerate. -->\n@../AGENTS.md\n',
    );
  });

  it('creates, accepts, repairs, and removes the shim according to ownership', async () => {
    const project = await fixture();
    const absent = await planClaudeMdShim(project.root, manifest());
    expect(absent).toMatchObject({ action: 'create' });
    expect(absent.conflict).toBeUndefined();

    await writeProjectFile(project.root, '.claude/CLAUDE.md', renderClaudeMdShim());
    expect((await planClaudeMdShim(project.root, manifest())).action).toBe('none');

    await writeProjectFile(project.root, '.claude/CLAUDE.md', 'drifted\n');
    const managed = manifest('generated', generated([], {
      path: '.claude/CLAUDE.md',
      mode: 'generated',
      sha256: 'b'.repeat(64),
    }));
    expect(await planClaudeMdShim(project.root, managed)).toMatchObject({ action: 'repair' });

    const removed = await planClaudeMdShim(project.root, manifest('disabled', generated([], {
      path: '.claude/CLAUDE.md',
      mode: 'generated',
      sha256: 'b'.repeat(64),
    })));
    expect(removed).toMatchObject({ action: 'remove' });
  });

  it('reports unmanaged root or .claude CLAUDE.md files as conflicts', async () => {
    const project = await fixture();
    await writeProjectFile(project.root, 'CLAUDE.md', '# user instructions\n');
    expect((await planClaudeMdShim(project.root, manifest())).conflict?.code).toBe(
      'claude-md.unmanaged',
    );

    await unlink(join(project.root, 'CLAUDE.md'));
    await writeProjectFile(project.root, '.claude/CLAUDE.md', 'user memory\n');
    expect((await planClaudeMdShim(project.root, manifest())).conflict?.code).toBe(
      'claude-md.unmanaged',
    );
  });
});
