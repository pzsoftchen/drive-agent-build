import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { discoverRules } from '../../src/model/rules.ts';
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

describe('rule discovery', () => {
  it('accepts a rule without frontmatter', async () => {
    const fixture = await project();
    await writeProjectFile(fixture.root, '.agents/rules/global.md', 'Global rule.\n');

    const result = await discoverRules(fixture.root, fixture.agents);

    expect(result.diagnostics).toEqual([]);
    expect(result.items[0]).toMatchObject({ name: 'global', paths: [] });
  });

  it('parses path scopes from a list or comma-separated string', async () => {
    const fixture = await project();
    await writeProjectFile(
      fixture.root,
      '.agents/rules/docs.md',
      '---\npaths: ["docs/**", "README.md"]\n---\nDocs rule.\n',
    );
    await writeProjectFile(
      fixture.root,
      '.agents/rules/src.md',
      '---\npaths: src/**, tests/**\n---\nSource rule.\n',
    );

    const result = await discoverRules(fixture.root, fixture.agents);

    expect(result.diagnostics).toEqual([]);
    expect(result.items.find((item) => item.name === 'docs')?.paths).toEqual([
      'docs/**',
      'README.md',
    ]);
    expect(result.items.find((item) => item.name === 'src')?.paths).toEqual([
      'src/**',
      'tests/**',
    ]);
  });

  it('rejects unknown frontmatter fields and unsafe paths', async () => {
    const fixture = await project();
    await writeProjectFile(
      fixture.root,
      '.agents/rules/typo.md',
      '---\npathz: docs/**\n---\nBody.\n',
    );
    await writeProjectFile(
      fixture.root,
      '.agents/rules/escape.md',
      '---\npaths: ../outside/**\n---\nBody.\n',
    );

    const result = await discoverRules(fixture.root, fixture.agents);

    expect(result.diagnostics.filter((item) => item.code === 'rule.invalid-frontmatter')).toHaveLength(2);
  });
});
