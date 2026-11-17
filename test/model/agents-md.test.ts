import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { checkAgentsMd } from '../../src/model/agents-md.ts';
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

describe('AGENTS.md checks', () => {
  it('accepts a document at the 200-line budget', async () => {
    const fixture = await project();
    await writeProjectFile(fixture.root, 'AGENTS.md', `${'line\n'.repeat(200)}`);

    const result = await checkAgentsMd(fixture.root, join(fixture.root, 'AGENTS.md'));

    expect(result.lineCount).toBe(200);
    expect(result.diagnostics).toEqual([]);
  });

  it('warns when the document exceeds 200 lines', async () => {
    const fixture = await project();
    await writeProjectFile(fixture.root, 'AGENTS.md', `${'line\n'.repeat(201)}`);

    const result = await checkAgentsMd(fixture.root, join(fixture.root, 'AGENTS.md'));

    expect(result.lineCount).toBe(201);
    expect(result.diagnostics.map((item) => item.code)).toContain('agents-md.too-large');
  });

  it('warns when AGENTS.md is missing', async () => {
    const fixture = await project();
    const result = await checkAgentsMd(fixture.root, join(fixture.root, 'AGENTS.md'));
    expect(result.diagnostics.map((item) => item.code)).toContain('agents-md.missing');
  });
});
