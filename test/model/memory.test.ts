import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { discoverMemory } from '../../src/model/memory.ts';
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

function entry(title: string, reviewBy = '2027-01-01'): string {
  return `---
title: ${title}
source: https://github.com/example/repo/pull/1
review_by: ${reviewBy}
updated: 2026-11-16
status: active
---
## Fact

${title} is true.
`;
}

describe('memory discovery', () => {
  it('loads a valid entry listed in INDEX.md', async () => {
    const fixture = await project();
    await writeProjectFile(fixture.root, '.agents/memory/INDEX.md', '- [Example](example.md)\n');
    await writeProjectFile(fixture.root, '.agents/memory/example.md', entry('Example'));

    const result = await discoverMemory(fixture.root, fixture.agents, new Date('2026-11-16'));

    expect(result.diagnostics).toEqual([]);
    expect(result.items[0]).toMatchObject({ title: 'Example', reviewBy: '2027-01-01' });
  });

  it('rejects an entry without source or review_by', async () => {
    const fixture = await project();
    await writeProjectFile(fixture.root, '.agents/memory/INDEX.md', '- [Bad](bad.md)\n');
    await writeProjectFile(
      fixture.root,
      '.agents/memory/bad.md',
      '---\ntitle: Bad\n---\nBody.\n',
    );

    const result = await discoverMemory(fixture.root, fixture.agents, new Date('2026-11-16'));

    expect(result.diagnostics.map((item) => item.code)).toContain('memory.invalid-entry');
  });

  it('warns about expired review dates', async () => {
    const fixture = await project();
    await writeProjectFile(fixture.root, '.agents/memory/INDEX.md', '- [Old](old.md)\n');
    await writeProjectFile(
      fixture.root,
      '.agents/memory/old.md',
      entry('Old', '2025-01-01'),
    );

    const result = await discoverMemory(fixture.root, fixture.agents, new Date('2026-11-16'));

    expect(result.diagnostics.map((item) => item.code)).toContain('memory.expired');
  });

  it('rejects a broken index link', async () => {
    const fixture = await project();
    await writeProjectFile(fixture.root, '.agents/memory/INDEX.md', '- [Missing](missing.md)\n');

    const result = await discoverMemory(fixture.root, fixture.agents, new Date('2026-11-16'));

    expect(result.diagnostics.map((item) => item.code)).toContain('memory.index-broken');
  });

  it('warns about a memory file that is not listed in INDEX.md', async () => {
    const fixture = await project();
    await writeProjectFile(fixture.root, '.agents/memory/INDEX.md', '# Memory\n');
    await writeProjectFile(fixture.root, '.agents/memory/unlisted.md', entry('Unlisted'));

    const result = await discoverMemory(fixture.root, fixture.agents, new Date('2026-11-16'));

    expect(result.diagnostics.map((item) => item.code)).toContain('memory.unlisted');
  });
});
