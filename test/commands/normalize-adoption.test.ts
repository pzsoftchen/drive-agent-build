import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { normalizeProject } from '../../src/commands/normalize.ts';
import type { CommandRunner } from '../../src/core/command.ts';
import { lstatOrNull } from '../../src/core/fs-atomic.ts';
import { prepareNormalizeAdoption } from '../../src/init/adoption.ts';
import { ProjectManifestSchema } from '../../src/model/schemas.ts';
import { makeProject, writeProjectFile, type ProjectFixture } from '../helpers/project.ts';
import { makeTempDir } from '../helpers/tmp.ts';

const goodRunner: CommandRunner = async () => ({
  stdout: '2.1.325 (Claude Code)\n',
  stderr: '',
  exitCode: 0,
});

const projects: ProjectFixture[] = [];
const dirs: string[] = [];

async function projectFixture(): Promise<ProjectFixture> {
  const project = await makeProject();
  projects.push(project);
  return project;
}

async function tempDir(prefix = 'dab-adopt-'): Promise<string> {
  const dir = await makeTempDir(prefix);
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(projects.splice(0).map((item) => rm(item.root, { recursive: true, force: true })));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('normalize adoption', () => {
  it('adopts a project with a missing manifest', async () => {
    const project = await projectFixture();
    const result = await normalizeProject({
      cwd: project.root,
      home: dirname(project.root),
      runner: goodRunner,
    });

    expect(result.ok).toBe(true);
    expect(result.scope).toBe('project');
    expect(await lstatOrNull(join(project.root, 'AGENTS.md'))).not.toBeNull();
    expect(await lstatOrNull(join(project.root, 'dab.yaml'))).not.toBeNull();
    expect(await lstatOrNull(join(project.root, '.agents/agents'))).not.toBeNull();
    expect(result.adoption?.phase).toBe('partial');
    expect(result.adoption?.sourceActions.length).toBeGreaterThan(0);
  });

  it('adopts a completely uninitialized project', async () => {
    const root = await tempDir('dab-adopt-empty-');
    const result = await normalizeProject({
      cwd: root,
      home: dirname(root),
      runner: goodRunner,
    });

    expect(result.ok).toBe(true);
    expect(result.scope).toBe('project');
    expect(result.adoption?.phase).toBe('uninitialized');
    expect(await lstatOrNull(join(root, 'AGENTS.md'))).not.toBeNull();
    expect(await lstatOrNull(join(root, 'dab.yaml'))).not.toBeNull();
    expect(await lstatOrNull(join(root, '.agents/policies/project.yaml'))).not.toBeNull();
  });

  it('does not write during adoption dry-run', async () => {
    const project = await projectFixture();
    const result = await normalizeProject({
      cwd: project.root,
      home: dirname(project.root),
      runner: goodRunner,
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    expect(await lstatOrNull(join(project.root, 'AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(project.root, 'dab.yaml'))).toBeNull();
    expect(await lstatOrNull(join(project.root, '.agents/policies/project.yaml'))).toBeNull();
    expect(result.adoption?.sourcePlan?.files['AGENTS.md']).toBeDefined();
    expect(result.adoption?.sourceActions.length).toBeGreaterThan(0);
  });

  it('does not overwrite an existing invalid manifest', async () => {
    const project = await projectFixture();
    await writeProjectFile(project.root, 'dab.yaml', 'version: nope\n');

    await expect(
      normalizeProject({ cwd: project.root, home: dirname(project.root), runner: goodRunner }),
    ).rejects.toMatchObject({ code: 'config.invalid' });

    expect(await readFile(join(project.root, 'dab.yaml'), 'utf8')).toBe('version: nope\n');
    expect(await lstatOrNull(join(project.root, 'AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(project.root, '.agents/policies/project.yaml'))).toBeNull();
  });

  it('keeps the prepared manifest equal to the rendered dab.yaml', async () => {
    const project = await projectFixture();
    const preparation = await prepareNormalizeAdoption({
      cwd: project.root,
      home: dirname(project.root),
    });

    const rendered = preparation.sourcePlan?.files['dab.yaml'];
    expect(rendered).toBeDefined();
    const parsed = ProjectManifestSchema.parse(parse(rendered ?? ''));
    expect(parsed).toEqual(preparation.manifest);
    expect(parsed.scope).toBe('project');

    const home = await tempDir('dab-adopt-global-manifest-');
    await mkdir(join(home, '.agents'), { recursive: true });
    const globalPrep = await prepareNormalizeAdoption({
      cwd: join(home, '.agents'),
      home,
    });
    const globalRendered = globalPrep.sourcePlan?.files['.agents/dab.yaml'];
    expect(globalRendered).toBeDefined();
    const globalParsed = ProjectManifestSchema.parse(parse(globalRendered ?? ''));
    expect(globalParsed).toEqual(globalPrep.manifest);
    expect(globalParsed.scope).toBe('global');
  });

  it('does not overwrite a valid authored manifest', async () => {
    const root = await tempDir('dab-adopt-manifest-');
    const manifest = `# authored manifest
version: 2
scope: project
project:
  id: custom
  name: Custom
profile: feature
targets:
  - provider: claude-code
    enabled: true
    options:
      minVersion: 2.1.277
      instructions: symlink
paths:
  agents: .agents
  claude: .claude
`;
    await writeFile(join(root, 'dab.yaml'), manifest);

    const result = await normalizeProject({
      cwd: root,
      home: dirname(root),
      runner: goodRunner,
    });

    expect(result.ok).toBe(true);
    expect(result.adoption?.phase).toBe('partial');
    const text = await readFile(join(root, 'dab.yaml'), 'utf8');
    expect(text).toContain('# authored manifest');
    expect(text).toContain('id: custom');
    expect(text).not.toContain('id: dab-');
    expect(await lstatOrNull(join(root, '.agents/policies/project.yaml'))).not.toBeNull();
    expect(result.adoption?.sourcePlan?.files['dab.yaml']).toBeUndefined();
    expect(result.adoption?.sourcePlan?.manifest.project.id).toBe('custom');
  });

  it('refuses project adoption at $HOME when ~/.agents is the global source', async () => {
    const home = await tempDir('dab-adopt-home-');
    await mkdir(join(home, '.agents'), { recursive: true });

    await expect(
      normalizeProject({ cwd: home, home, runner: goodRunner }),
    ).rejects.toMatchObject({ code: 'config.source-root-nested' });

    expect(await lstatOrNull(join(home, 'AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(home, 'dab.yaml'))).toBeNull();
    expect(await lstatOrNull(join(home, '.agents/AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(home, '.agents/dab.yaml'))).toBeNull();
  });

  it('refuses source writes through an escaping .agents symlink', async () => {
    const root = await tempDir('dab-adopt-escape-');
    const outside = await tempDir('dab-adopt-outside-');
    await symlink(outside, join(root, '.agents'), 'dir');

    const result = await normalizeProject({
      cwd: root,
      home: dirname(root),
      runner: goodRunner,
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.diagnostics.map((item) => item.code)).toContain('path.symlink-escape');
    expect(await readdir(outside)).toEqual([]);
    expect(await lstatOrNull(join(root, 'AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(root, 'dab.yaml'))).toBeNull();
  });

  it('adopts a global source without writing $HOME root files', async () => {
    const home = await tempDir('dab-adopt-global-');
    await mkdir(join(home, '.agents'), { recursive: true });

    const result = await normalizeProject({
      cwd: join(home, '.agents'),
      home,
      runner: goodRunner,
    });

    expect(result.ok).toBe(true);
    expect(result.scope).toBe('global');
    expect(result.adoption?.phase).toBe('partial');
    expect(await lstatOrNull(join(home, '.agents/AGENTS.md'))).not.toBeNull();
    expect(await lstatOrNull(join(home, '.agents/dab.yaml'))).not.toBeNull();
    expect(await lstatOrNull(join(home, 'AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(home, 'dab.yaml'))).toBeNull();
  });
});
