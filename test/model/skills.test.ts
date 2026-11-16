import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { discoverSkills } from '../../src/model/skills.ts';
import { makeProject, writeProjectFile, type ProjectFixture } from '../helpers/project.ts';

const projects: ProjectFixture[] = [];

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
});
