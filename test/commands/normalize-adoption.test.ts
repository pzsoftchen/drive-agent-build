import { afterEach, describe, expect, it } from 'vitest';
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { normalizeProject } from '../../src/commands/normalize.ts';
import type { CommandRunner } from '../../src/core/command.ts';
import { lstatOrNull } from '../../src/core/fs-atomic.ts';
import { prepareNormalizeAdoption } from '../../src/init/adoption.ts';
import { ProjectManifestSchema } from '../../src/model/schemas.ts';
import { makeGlobalFixture } from '../helpers/global.ts';
import { makeInitializedProject } from '../helpers/initialized.ts';
import { makeProject, writeProjectFile, type ProjectFixture } from '../helpers/project.ts';
import { makeTempDir } from '../helpers/tmp.ts';

const goodRunner: CommandRunner = async () => ({
  stdout: '2.1.325 (Claude Code)\n',
  stderr: '',
  exitCode: 0,
});

const projects: ProjectFixture[] = [];
const dirs: string[] = [];
const homes: string[] = [];

async function projectFixture(): Promise<ProjectFixture> {
  const project = await makeProject();
  projects.push(project);
  return project;
}

async function initializedProject(): Promise<ProjectFixture> {
  const project = await makeInitializedProject();
  projects.push(project);
  return project;
}

async function globalFixture() {
  const fixture = await makeGlobalFixture();
  homes.push(fixture.home);
  return fixture;
}

async function tempDir(prefix = 'dab-adopt-'): Promise<string> {
  const dir = await makeTempDir(prefix);
  dirs.push(dir);
  return dir;
}

function agentSource(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${name}.\n`;
}

afterEach(async () => {
  await Promise.all(projects.splice(0).map((item) => rm(item.root, { recursive: true, force: true })));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
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

describe('normalize import adoption', () => {
  it('imports a Claude agent into .agents and replaces the target with a symlink', async () => {
    const project = await initializedProject();
    await writeFile(
      join(project.root, '.claude/agents/extra.md'),
      agentSource('extra', 'Extra.'),
    );

    const result = await normalizeProject({
      cwd: project.root,
      home: dirname(project.root),
      runner: goodRunner,
    });

    expect(result.ok).toBe(true);
    expect(await readFile(join(project.root, '.agents/agents/extra.md'), 'utf8'))
      .toContain('name: extra');
    expect(await readlink(join(project.root, '.claude/agents/extra.md')))
      .toBe('../../.agents/agents/extra.md');
    expect(result.adoption?.backups.length).toBe(1);
    expect(result.adoption?.backups[0]).toMatch(/^\.dab\/backups\//);
    expect(result.adoption?.imports?.map((entry) => entry.target))
      .toEqual(['.agents/agents/extra.md']);
  });

  it('writes nothing when an import candidate is invalid', async () => {
    const project = await initializedProject();
    await writeFile(join(project.root, '.claude/agents/bad.md'), '---\nname: bad\n---\n');
    const settingsBefore = await readFile(join(project.root, '.claude/settings.json'), 'utf8');
    const manifestBefore = await readFile(join(project.root, 'dab.yaml'), 'utf8');

    const result = await normalizeProject({
      cwd: project.root,
      home: dirname(project.root),
      runner: goodRunner,
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain('agent.invalid-frontmatter');
    expect(await lstatOrNull(join(project.root, '.agents/agents/bad.md'))).toBeNull();
    expect(await readFile(join(project.root, '.claude/settings.json'), 'utf8'))
      .toBe(settingsBefore);
    expect(await readFile(join(project.root, 'dab.yaml'), 'utf8')).toBe(manifestBefore);
    expect((await lstat(join(project.root, '.claude/agents/bad.md'))).isFile()).toBe(true);
    expect(result.adoption?.imports).toEqual([]);
    expect(result.adoption?.backups).toEqual([]);
  });

  it('writes no source when an uninitialized project has an invalid import', async () => {
    const root = await tempDir('dab-adopt-import-invalid-');
    await writeProjectFile(root, '.claude/agents/bad.md', '---\nname: bad\n---\n');

    const result = await normalizeProject({
      cwd: root,
      home: dirname(root),
      runner: goodRunner,
    });

    expect(result.ok).toBe(false);
    expect(result.adoption?.phase).toBe('uninitialized');
    expect(result.adoption?.sourceActions).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toContain('agent.invalid-frontmatter');
    expect(await lstatOrNull(join(root, 'AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(root, 'dab.yaml'))).toBeNull();
    expect(await lstatOrNull(join(root, '.agents/AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(root, '.agents/agents/bad.md'))).toBeNull();
    expect(await lstatOrNull(join(root, '.claude/settings.json'))).toBeNull();
  });

  it('does not report an ok dry run when import candidates are invalid', async () => {
    const root = await tempDir('dab-adopt-import-dry-');
    await writeProjectFile(root, '.claude/agents/bad.md', '---\nname: bad\n---\n');

    const result = await normalizeProject({
      cwd: root,
      home: dirname(root),
      runner: goodRunner,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain('agent.invalid-frontmatter');
    expect(await lstatOrNull(join(root, 'AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(root, '.agents/AGENTS.md'))).toBeNull();
  });

  it('previews uninitialized source and imports without writing', async () => {
    const root = await tempDir('dab-adopt-import-dry-ok-');
    await writeProjectFile(root, '.claude/agents/extra.md', agentSource('extra', 'Extra.'));

    const result = await normalizeProject({
      cwd: root,
      home: dirname(root),
      runner: goodRunner,
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    expect(result.adoption?.phase).toBe('uninitialized');
    expect(result.adoption?.sourceActions.length).toBeGreaterThan(0);
    expect(result.adoption?.imports?.map((entry) => entry.target))
      .toEqual(['.agents/agents/extra.md']);
    expect(result.adoption?.backups).toEqual([]);
    expect(await lstatOrNull(join(root, 'AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(root, '.agents/agents/extra.md'))).toBeNull();
    expect((await lstat(join(root, '.claude/agents/extra.md'))).isFile()).toBe(true);
  });

  it('imports global agents and skills into a temp HOME', async () => {
    const fixture = await globalFixture();
    const home = fixture.home;
    const settings = '{"permissions":{}}\n';
    await writeProjectFile(home, '.claude/settings.json', settings);
    await writeProjectFile(home, '.claude/agents/reviewer.md', agentSource('reviewer', 'Reviews.'));
    await writeProjectFile(
      home,
      '.claude/skills/pdf-tools/SKILL.md',
      agentSource('pdf-tools', 'PDF.'),
    );

    const result = await normalizeProject({
      cwd: join(home, '.agents'),
      home,
      runner: goodRunner,
    });

    expect(result.ok).toBe(true);
    // The authored .agents source wins; the .claude copy is imported as a link.
    expect(await readFile(join(home, '.agents/agents/reviewer.md'), 'utf8'))
      .toContain('description: Reviews changes.');
    expect(await readFile(join(home, '.agents/skills/pdf-tools/SKILL.md'), 'utf8'))
      .toContain('name: pdf-tools');
    expect(await readlink(join(home, '.claude/agents/reviewer.md')))
      .toBe('../../.agents/agents/reviewer.md');
    expect(await readlink(join(home, '.claude/skills/pdf-tools')))
      .toBe('../../.agents/skills/pdf-tools');
    expect(await readFile(join(home, '.claude/settings.json'), 'utf8')).toBe(settings);
    expect(await lstatOrNull(join(home, '.gitignore'))).toBeNull();
    expect(result.adoption?.backups.length).toBe(2);
  });

  it('keeps .claude untouched when a later target preflight fails', async () => {
    const project = await projectFixture();
    const extra = join(project.root, '.claude/agents/extra.md');
    await writeProjectFile(project.root, '.claude/agents/extra.md', agentSource('extra', 'Extra.'));
    await writeProjectFile(project.root, 'CLAUDE.md', '# user instructions\n');

    const result = await normalizeProject({
      cwd: project.root,
      home: dirname(project.root),
      runner: goodRunner,
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain('claude-md.unmanaged');
    // Source adoption is idempotent and may run before the target preflight.
    expect(await lstatOrNull(join(project.root, 'AGENTS.md'))).not.toBeNull();
    expect(await lstatOrNull(join(project.root, 'dab.yaml'))).not.toBeNull();
    // No import and no backup happened: .claude stays a physical file.
    expect((await lstat(extra)).isFile()).toBe(true);
    expect(await lstatOrNull(join(project.root, '.agents/agents/extra.md'))).toBeNull();
    expect(result.adoption?.imports).toEqual([]);
    expect(result.adoption?.backups).toEqual([]);
    expect(await lstatOrNull(join(project.root, '.claude/settings.json'))).toBeNull();
  });

  it('does not re-import managed entries on the next normalize', async () => {
    const project = await initializedProject();
    await writeFile(
      join(project.root, '.claude/agents/extra.md'),
      agentSource('extra', 'Extra.'),
    );
    const options = {
      cwd: project.root,
      home: dirname(project.root),
      runner: goodRunner,
    };

    const first = await normalizeProject(options);
    expect(first.ok).toBe(true);
    expect(first.adoption?.backups.length).toBe(1);

    const second = await normalizeProject(options);
    expect(second.ok).toBe(true);
    expect(second.adoption?.imports).toEqual([]);
    expect(second.adoption?.backups).toEqual([]);
    expect(await readlink(join(project.root, '.claude/agents/extra.md')))
      .toBe('../../.agents/agents/extra.md');
  });

  it('previews imports in a dry run without writing', async () => {
    const project = await initializedProject();
    await writeFile(
      join(project.root, '.claude/agents/extra.md'),
      agentSource('extra', 'Extra.'),
    );

    const result = await normalizeProject({
      cwd: project.root,
      home: dirname(project.root),
      runner: goodRunner,
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    expect(result.adoption?.imports?.map((entry) => entry.target))
      .toEqual(['.agents/agents/extra.md']);
    expect(result.adoption?.backups).toEqual([]);
    expect(await lstatOrNull(join(project.root, '.agents/agents/extra.md'))).toBeNull();
    expect((await lstat(join(project.root, '.claude/agents/extra.md'))).isFile()).toBe(true);
  });
});
