import { afterEach, describe, expect, it } from 'vitest';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { lstatOrNull } from '../../src/core/fs-atomic.ts';
import {
  minimalSourcePlan,
  planSourceWrites,
  resolveAdoptionRoot,
  writeSourceFiles,
} from '../../src/init/adoption.ts';
import { scanProject } from '../../src/init/scanner.ts';
import { populateProject } from '../helpers/initialized.ts';
import { makeProject, writeProjectFile } from '../helpers/project.ts';
import { makeTempDir } from '../helpers/tmp.ts';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await makeTempDir('dab-adopt-');
  dirs.push(dir);
  return dir;
}

async function projectFixture(): Promise<{ root: string; agents: string; claude: string }> {
  const project = await makeProject();
  dirs.push(project.root);
  return project;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('resolveAdoptionRoot', () => {
  it('classifies a project with manifest and .agents as initialized', async () => {
    const project = await projectFixture();
    await populateProject(project);
    const result = await resolveAdoptionRoot({ cwd: project.root, home: dirname(project.root) });
    expect(result).toMatchObject({
      scope: 'project',
      root: project.root,
      sourceRoot: join(project.root, '.agents'),
      manifestPath: join(project.root, 'dab.yaml'),
      instructionsPath: join(project.root, 'AGENTS.md'),
      phase: 'initialized',
      manifestValid: true,
    });
  });

  it('classifies a project with only .agents as partial', async () => {
    const project = await projectFixture();
    const result = await resolveAdoptionRoot({ cwd: project.root, home: dirname(project.root) });
    expect(result.phase).toBe('partial');
    expect(result.manifestValid).toBe(false);
  });

  it('uses the nearest git root for an uninitialized project', async () => {
    const root = await tempDir();
    await mkdir(join(root, '.git'));
    await mkdir(join(root, 'nested'), { recursive: true });
    const result = await resolveAdoptionRoot({ cwd: join(root, 'nested'), home: dirname(root) });
    expect(result).toMatchObject({ scope: 'project', root, phase: 'uninitialized' });
  });

  it('classifies global scope from ~/.agents', async () => {
    const home = await tempDir();
    await mkdir(join(home, '.agents'), { recursive: true });
    const result = await resolveAdoptionRoot({ cwd: join(home, '.agents'), home });
    expect(result).toMatchObject({
      scope: 'global',
      root: home,
      sourceRoot: join(home, '.agents'),
      phase: 'partial',
    });
  });

  it('falls back to cwd when an uninitialized project has no git root', async () => {
    const root = await tempDir();
    const result = await resolveAdoptionRoot({
      cwd: root,
      home: join(root, 'home'),
    });
    expect(result).toMatchObject({ scope: 'project', root, phase: 'uninitialized' });
  });

  it('classifies a manifest-only project as partial with a valid manifest', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'dab.yaml'), `version: 2
scope: project
project:
  id: demo
  name: Demo
profile: feature
targets:
  - provider: claude-code
    enabled: true
`);
    const result = await resolveAdoptionRoot({ cwd: root, home: dirname(root) });
    expect(result).toMatchObject({ scope: 'project', root, phase: 'partial', manifestValid: true });
  });

  it('keeps an invalid authored manifest as partial without throwing', async () => {
    const project = await projectFixture();
    const invalid = 'version: 2\nscope: project\n';
    await writeFile(join(project.root, 'dab.yaml'), invalid);
    const result = await resolveAdoptionRoot({ cwd: project.root, home: dirname(project.root) });
    expect(result).toMatchObject({ phase: 'partial', manifestValid: false });
    expect(await readFile(join(project.root, 'dab.yaml'), 'utf8')).toBe(invalid);
  });

  it('classifies a global source with a valid manifest as initialized', async () => {
    const home = await tempDir();
    await mkdir(join(home, '.agents'), { recursive: true });
    await writeFile(join(home, '.agents/dab.yaml'), `version: 2
scope: global
project:
  id: global
  name: Global
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
`);
    const result = await resolveAdoptionRoot({ cwd: join(home, '.agents'), home });
    expect(result).toMatchObject({ scope: 'global', phase: 'initialized', manifestValid: true });
  });
});

describe('minimalSourcePlan', () => {
  it('builds a project minimal source without default agents or skills', async () => {
    const project = await projectFixture();
    const scan = await scanProject(project.root);
    const plan = minimalSourcePlan(scan, 'project');
    expect(Object.keys(plan.files)).toEqual(expect.arrayContaining([
      'AGENTS.md',
      'dab.yaml',
      '.agents/policies/project.yaml',
      '.agents/adapters/claude-code.yaml',
    ]));
    expect(Object.keys(plan.files).some((file) => file.startsWith('.agents/agents/'))).toBe(false);
    expect(Object.keys(plan.files).some((file) => file.startsWith('.agents/skills/'))).toBe(false);
    expect(Object.keys(plan.files).some((file) => file.startsWith('.agents/hooks/'))).toBe(false);
    expect(Object.keys(plan.files).some((file) => file.startsWith('.agents/memory/'))).toBe(false);
    expect(plan.directories).toEqual([
      '.agents/agents',
      '.agents/skills',
      '.agents/notes',
      '.agents/rules',
    ]);
    expect(plan.manifest.scope).toBe('project');
    expect(plan.manifest.profile).toBe('generic');
    expect(plan.manifest.paths).toEqual({ agents: '.agents', claude: '.claude' });
  });

  it('minimal source uses generic and docs.language auto', async () => {
    const project = await projectFixture();
    const scan = await scanProject(project.root);
    const plan = minimalSourcePlan(scan, 'project');
    expect(plan.manifest.profile).toBe('generic');
    expect(plan.manifest.docs.language).toBe('auto');
    expect(plan.files['dab.yaml']).toContain('profile: generic');
    expect(plan.files['dab.yaml']).toContain('docs:\n  language: auto');
  });

  it('builds global minimal paths under .agents', async () => {
    const home = await tempDir();
    const scan = await scanProject(home);
    const plan = minimalSourcePlan(scan, 'global');
    expect(plan.files['.agents/AGENTS.md']).toBeDefined();
    expect(plan.files['.agents/dab.yaml']).toBeDefined();
    expect(plan.files['AGENTS.md']).toBeUndefined();
    expect(plan.manifest.scope).toBe('global');
  });
});

describe('writeSourceFiles', () => {
  it('does not overwrite existing authored files', async () => {
    const project = await projectFixture();
    await writeProjectFile(project.root, 'AGENTS.md', 'keep me\n');
    const scan = await scanProject(project.root);
    const plan = minimalSourcePlan(scan, 'project');
    const result = await writeSourceFiles(project.root, plan);
    expect(result.skipped).toContain('AGENTS.md');
    expect(result.created).toContain('dab.yaml');
    expect(await readFile(join(project.root, 'AGENTS.md'), 'utf8')).toBe('keep me\n');
    for (const directory of plan.directories) {
      expect((await lstat(join(project.root, directory))).isDirectory()).toBe(true);
    }
  });

  it('plans writes without touching the filesystem', async () => {
    const project = await projectFixture();
    const scan = await scanProject(project.root);
    const plan = minimalSourcePlan(scan, 'project');
    const planned = await planSourceWrites(project.root, plan);
    expect(planned.create).toEqual(Object.keys(plan.files));
    expect(planned.skip).toEqual([]);
    expect(await lstatOrNull(join(project.root, 'dab.yaml'))).toBeNull();
  });

  it('skips every file when the minimal source already exists', async () => {
    const project = await projectFixture();
    const scan = await scanProject(project.root);
    const plan = minimalSourcePlan(scan, 'project');
    await writeSourceFiles(project.root, plan);
    const result = await writeSourceFiles(project.root, plan);
    expect(result.created).toEqual([]);
    expect(result.skipped).toEqual(Object.keys(plan.files));
  });
});
