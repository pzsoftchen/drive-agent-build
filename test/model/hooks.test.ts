import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { discoverHooks } from '../../src/model/hooks.ts';
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

function hook(id: string, entry = 'run.mjs', event = 'pre_tool'): string {
  return `id: ${id}
event: ${event}
matcher: Edit|Write
entry: ${entry}
runner: node
timeout: 10
order: 10
`;
}

describe('hook discovery', () => {
  it('loads a valid hook whose id matches its directory', async () => {
    const fixture = await project();
    await writeProjectFile(
      fixture.root,
      '.agents/hooks/protect-generated/hook.yaml',
      hook('protect-generated'),
    );
    await writeProjectFile(
      fixture.root,
      '.agents/hooks/protect-generated/run.mjs',
      'process.exit(0);\n',
    );

    const result = await discoverHooks(fixture.root, fixture.agents);

    expect(result.diagnostics).toEqual([]);
    expect(result.items[0]).toMatchObject({
      spec: { id: 'protect-generated', event: 'pre_tool', timeout: 10 },
    });
    expect(result.items[0]?.entryPath.endsWith('run.mjs')).toBe(true);
  });

  it('rejects an id that does not match the directory', async () => {
    const fixture = await project();
    await writeProjectFile(
      fixture.root,
      '.agents/hooks/protect-generated/hook.yaml',
      hook('other-id'),
    );
    await writeProjectFile(fixture.root, '.agents/hooks/protect-generated/run.mjs', 'x\n');

    const result = await discoverHooks(fixture.root, fixture.agents);

    expect(result.diagnostics.map((item) => item.code)).toContain('hook.invalid');
  });

  it('rejects an entry that escapes the hook directory', async () => {
    const fixture = await project();
    await writeProjectFile(
      fixture.root,
      '.agents/hooks/protect-generated/hook.yaml',
      hook('protect-generated', '../outside.mjs'),
    );
    await writeProjectFile(fixture.root, '.agents/hooks/protect-generated/run.mjs', 'x\n');

    const result = await discoverHooks(fixture.root, fixture.agents);

    expect(result.diagnostics.map((item) => item.code)).toContain('hook.entry');
  });

  it('rejects a missing entry file', async () => {
    const fixture = await project();
    await writeProjectFile(
      fixture.root,
      '.agents/hooks/protect-generated/hook.yaml',
      hook('protect-generated'),
    );

    const result = await discoverHooks(fixture.root, fixture.agents);

    expect(result.diagnostics.map((item) => item.code)).toContain('hook.missing-entry');
  });

  it('rejects an unknown hook field even when the rest is valid', async () => {
    const fixture = await project();
    await writeProjectFile(
      fixture.root,
      '.agents/hooks/protect-generated/hook.yaml',
      `${hook('protect-generated')}futureField: true\n`,
    );
    await writeProjectFile(fixture.root, '.agents/hooks/protect-generated/run.mjs', 'x\n');

    const result = await discoverHooks(fixture.root, fixture.agents);

    expect(result.items).toHaveLength(0);
    expect(result.diagnostics.map((item) => item.code)).toContain('hook.invalid');
  });

  it('rejects an invalid event and unknown field', async () => {
    const fixture = await project();
    await writeProjectFile(
      fixture.root,
      '.agents/hooks/protect-generated/hook.yaml',
      `${hook('protect-generated', 'run.mjs', 'not_an_event')}extra: true\n`,
    );
    await writeProjectFile(fixture.root, '.agents/hooks/protect-generated/run.mjs', 'x\n');

    const result = await discoverHooks(fixture.root, fixture.agents);

    expect(result.diagnostics.map((item) => item.code)).toContain('hook.invalid');
  });
});
