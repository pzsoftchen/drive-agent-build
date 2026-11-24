import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { discoverSkills, validateSkillSource } from '../../src/model/skills.ts';
import { makeProject, writeProjectFile, type ProjectFixture } from '../helpers/project.ts';

const projects: ProjectFixture[] = [];
const canDenyRead = process.platform !== 'win32'
  && typeof process.getuid === 'function'
  && process.getuid() !== 0;

async function project(): Promise<ProjectFixture> {
  const fixture = await makeProject();
  projects.push(fixture);
  return fixture;
}

afterEach(async () => {
  await Promise.all(projects.splice(0).map((item) => rm(item.root, { recursive: true, force: true })));
});

describe('skill discovery', () => {
  it('parses a valid skill', async () => {
    const fixture = await project();
    await writeProjectFile(
      fixture.root,
      '.agents/skills/doc-sync/SKILL.md',
      '---\nname: doc-sync\ndescription: Keeps docs paired.\n---\nRun the docs gate.\n',
    );

    const result = await discoverSkills(fixture.root, fixture.agents);

    expect(result.diagnostics).toEqual([]);
    expect(result.items[0]).toMatchObject({ name: 'doc-sync', description: 'Keeps docs paired.' });
  });

  it('warns about a skill directory without SKILL.md', async () => {
    const fixture = await project();
    await mkdir(join(fixture.agents, 'skills', 'empty'), { recursive: true });

    const result = await discoverSkills(fixture.root, fixture.agents);

    expect(result.diagnostics.map((item) => item.code)).toContain('skill.missing');
  });

  it('rejects a skill without a description', async () => {
    const fixture = await project();
    await writeProjectFile(
      fixture.root,
      '.agents/skills/no-desc/SKILL.md',
      '---\nname: no-desc\n---\nBody.\n',
    );

    const result = await discoverSkills(fixture.root, fixture.agents);

    expect(result.diagnostics.map((item) => item.code)).toContain('skill.invalid-frontmatter');
  });

  it('warns about unknown frontmatter fields and keeps the skill', async () => {
    const fixture = await project();
    await writeProjectFile(
      fixture.root,
      '.agents/skills/future-skill/SKILL.md',
      '---\nname: future-skill\ndescription: Uses a future field.\nfutureField: true\n---\nBody.\n',
    );

    const result = await discoverSkills(fixture.root, fixture.agents);

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'skill.unknown-frontmatter',
      severity: 'warning',
    }));
    expect(result.items[0]).toMatchObject({ name: 'future-skill' });
    expect(result.items[0]?.frontmatter.futureField).toBe(true);
  });

  it('rejects duplicate skill names', async () => {
    const fixture = await project();
    await writeProjectFile(
      fixture.root,
      '.agents/skills/one/SKILL.md',
      '---\nname: shared\ndescription: One.\n---\nBody.\n',
    );
    await writeProjectFile(
      fixture.root,
      '.agents/skills/two/SKILL.md',
      '---\nname: shared\ndescription: Two.\n---\nBody.\n',
    );

    const result = await discoverSkills(fixture.root, fixture.agents);

    expect(result.diagnostics.map((item) => item.code)).toContain('skill.duplicate-name');
  });

  it('validates a single skill directory for adoption', async () => {
    const fixture = await project();
    await writeProjectFile(fixture.root, '.agents/skills/doc-sync/SKILL.md', '---\nname: doc-sync\ndescription: Sync.\n---\nBody.\n');
    const result = await validateSkillSource(fixture.root, join(fixture.root, '.agents/skills/doc-sync'));
    expect(result.item?.name).toBe('doc-sync');
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('reports a missing SKILL.md from a single skill directory', async () => {
    const fixture = await project();
    const dir = join(fixture.root, '.agents/skills/empty');
    await mkdir(dir, { recursive: true });
    const result = await validateSkillSource(fixture.root, dir);
    expect(result.item).toBeUndefined();
    expect(result.diagnostics.map((d) => d.code)).toContain('skill.missing');
  });

  it('isolates an unreadable skill directory and keeps valid siblings', async () => {
    if (!canDenyRead) {
      return;
    }
    const fixture = await project();
    await writeProjectFile(
      fixture.root,
      '.agents/skills/good/SKILL.md',
      '---\nname: good\ndescription: Good.\n---\nBody.\n',
    );
    const broken = join(fixture.agents, 'skills', 'broken');
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, 'SKILL.md'), '---\nname: broken\ndescription: Broken.\n---\nBody.\n');
    await chmod(broken, 0o000);
    try {
      const result = await discoverSkills(fixture.root, fixture.agents);

      expect(result.items.map((item) => item.name)).toEqual(['good']);
      expect(result.diagnostics).toEqual([expect.objectContaining({
        code: 'skill.unreadable',
        severity: 'error',
        file: '.agents/skills/broken',
      })]);
    } finally {
      await chmod(broken, 0o755);
    }
  });

  it('reports an unreadable skill directory from a single-skill validation', async () => {
    if (!canDenyRead) {
      return;
    }
    const fixture = await project();
    const broken = join(fixture.agents, 'skills', 'broken');
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, 'SKILL.md'), '---\nname: broken\ndescription: Broken.\n---\nBody.\n');
    await chmod(broken, 0o000);
    try {
      const result = await validateSkillSource(fixture.root, broken);

      expect(result.item).toBeUndefined();
      expect(result.diagnostics).toEqual([expect.objectContaining({
        code: 'skill.unreadable',
        severity: 'error',
        file: '.agents/skills/broken',
      })]);
    } finally {
      await chmod(broken, 0o755);
    }
  });
});
