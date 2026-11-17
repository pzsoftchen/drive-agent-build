import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertInitRoot, resolveSourceRoot } from '../../src/model/scope.ts';
import { makeTempDir } from '../helpers/tmp.ts';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await makeTempDir('dab-scope-home-');
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('scope resolution', () => {
  it('finds the nearest project root from a nested directory', async () => {
    const home = await tempDir();
    const root = join(home, 'repo');
    await mkdir(join(root, '.agents/skills/doc-sync'), { recursive: true });
    await writeFile(join(root, 'dab.yaml'), 'version: 2\n');

    const resolved = await resolveSourceRoot({
      cwd: join(root, '.agents/skills/doc-sync'),
      home,
    });

    expect(resolved).toEqual({
      scope: 'project',
      root,
      sourceRoot: join(root, '.agents'),
      manifest: join(root, 'dab.yaml'),
      instructions: join(root, 'AGENTS.md'),
    });
  });

  it('uses the global root only at or below $HOME/.agents', async () => {
    const home = await tempDir();
    await mkdir(join(home, '.agents/skills'), { recursive: true });

    const exact = await resolveSourceRoot({ cwd: join(home, '.agents'), home });
    const nested = await resolveSourceRoot({ cwd: join(home, '.agents/skills'), home });
    const other = await resolveSourceRoot({ cwd: home, home }).catch((error) => error);

    expect(exact.scope).toBe('global');
    expect(nested).toMatchObject({
      scope: 'global',
      root: home,
      sourceRoot: join(home, '.agents'),
      manifest: join(home, '.agents/dab.yaml'),
      instructions: join(home, '.agents/AGENTS.md'),
    });
    expect(other).toMatchObject({ code: 'config.source-root-missing' });
  });

  it('recognizes a symlinked global source root', async () => {
    const home = await tempDir();
    const real = join(home, 'dot-agents-real');
    await mkdir(join(real, 'skills'), { recursive: true });
    await symlink(real, join(home, '.agents'), 'dir');

    const resolved = await resolveSourceRoot({ cwd: join(real, 'skills'), home });

    expect(resolved.scope).toBe('global');
    expect(resolved.sourceRoot).toBe(join(home, '.agents'));
  });

  it('rejects init inside an existing project or global source root', async () => {
    const home = await tempDir();
    const project = join(home, 'repo');
    await mkdir(join(project, '.agents/skills/new'), { recursive: true });
    await writeFile(join(project, 'dab.yaml'), 'version: 2\n');
    await mkdir(join(home, '.agents/skills/new'), { recursive: true });

    await expect(assertInitRoot({ root: join(project, '.agents/skills/new'), home }))
      .rejects.toMatchObject({ code: 'config.source-root-nested' });
    await expect(assertInitRoot({ root: join(home, '.agents/skills/new'), home }))
      .rejects.toMatchObject({ code: 'config.source-root-nested' });
    await expect(assertInitRoot({ root: home, home }))
      .rejects.toMatchObject({ code: 'config.source-root-nested' });
    await expect(assertInitRoot({ root: project, home })).resolves.toBe('project');
    await expect(assertInitRoot({ root: join(home, '.agents'), home })).resolves.toBe('global');
  });

  it('treats an exact ~/.agents init target as global before the source exists', async () => {
    const home = await tempDir();

    await expect(assertInitRoot({ root: join(home, '.agents'), home })).resolves.toBe('global');
  });

  it('rejects non-existent init targets nested under a symlinked global source', async () => {
    const home = await tempDir();
    const real = join(home, 'dot-agents-real');
    await mkdir(join(real, 'skills'), { recursive: true });
    await symlink(real, join(home, '.agents'), 'dir');

    await expect(assertInitRoot({ root: join(home, '.agents/new-project'), home }))
      .rejects.toMatchObject({ code: 'config.source-root-nested' });
    await expect(assertInitRoot({ root: join(home, '.agents/skills/deeper-new'), home }))
      .rejects.toMatchObject({ code: 'config.source-root-nested' });
  });

  it('does not treat $HOME with only .agents as a project root', async () => {
    const home = await tempDir();
    await mkdir(join(home, '.agents'), { recursive: true });

    await expect(resolveSourceRoot({ cwd: home, home }))
      .rejects.toMatchObject({ code: 'config.source-root-missing' });
  });

  it('rejects init through a symlinked parent into an existing project source root', async () => {
    const home = await tempDir();
    const project = await tempDir();
    await mkdir(join(project, '.agents/skills'), { recursive: true });
    await writeFile(join(project, 'dab.yaml'), 'version: 2\n');
    const alias = join(home, 'alias');
    await symlink(join(project, '.agents/skills'), alias, 'dir');

    await expect(assertInitRoot({ root: join(alias, 'missing'), home }))
      .rejects.toMatchObject({ code: 'config.source-root-nested' });

    await mkdir(join(project, '.agents/skills/existing'), { recursive: true });
    await expect(assertInitRoot({ root: join(alias, 'existing'), home }))
      .rejects.toMatchObject({ code: 'config.source-root-nested' });
  });

  it('rejects global init when $HOME is already a project root', async () => {
    const home = await tempDir();
    await mkdir(join(home, '.agents'), { recursive: true });
    await writeFile(join(home, 'dab.yaml'), 'version: 2\n');

    await expect(assertInitRoot({ root: join(home, '.agents'), home }))
      .rejects.toMatchObject({ code: 'config.source-root-nested' });
  });

  it('accepts a global source root that only contains its own manifest', async () => {
    const home = await tempDir();
    await mkdir(join(home, '.agents'), { recursive: true });
    await writeFile(join(home, '.agents/dab.yaml'), 'version: 2\n');

    await expect(assertInitRoot({ root: join(home, '.agents'), home }))
      .resolves.toBe('global');
  });

  it('still accepts a symlinked global source root under $HOME', async () => {
    const home = await tempDir();
    const real = join(home, 'dot-agents-real');
    await mkdir(real, { recursive: true });
    await symlink(real, join(home, '.agents'), 'dir');

    await expect(assertInitRoot({ root: join(home, '.agents'), home }))
      .resolves.toBe('global');
  });
});
