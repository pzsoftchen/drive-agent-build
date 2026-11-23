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
import { normalizeProject, runNormalize } from '../../src/commands/normalize.ts';
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

function skillSource(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${name}.\n`;
}

function capture(): {
  stdout: string[];
  stderr: string[];
  io: { stdout: (value: string) => void; stderr: (value: string) => void };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    },
  };
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
    // Dry runs report the planned backup path without creating it.
    expect(result.adoption?.backups).toHaveLength(1);
    expect(result.adoption?.backups[0])
      .toMatch(/^\.dab\/backups\/.*\/\.claude\/agents\/extra\.md$/);
    expect(await lstatOrNull(join(root, '.dab'))).toBeNull();
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
    // Dry runs report the planned backup path without creating it.
    expect(result.adoption?.backups).toHaveLength(1);
    expect(result.adoption?.backups[0])
      .toMatch(/^\.dab\/backups\/.*\/\.claude\/agents\/extra\.md$/);
    expect(await lstatOrNull(join(project.root, '.dab'))).toBeNull();
    expect(await lstatOrNull(join(project.root, '.agents/agents/extra.md'))).toBeNull();
    expect((await lstat(join(project.root, '.claude/agents/extra.md'))).isFile()).toBe(true);
  });

  it('writes nothing when a fresh skill symlink escapes the root', async () => {
    const root = await tempDir('dab-adopt-import-escape-');
    const outside = await tempDir('dab-adopt-escape-outside-');
    await writeProjectFile(outside, 'secret.txt', 'secret\n');
    await writeProjectFile(root, '.claude/agents/extra.md', agentSource('extra', 'Extra.'));
    await writeProjectFile(root, '.claude/skills/bad/SKILL.md', skillSource('bad', 'Bad.'));
    await symlink(outside, join(root, '.claude/skills/bad/leak'));

    const result = await normalizeProject({
      cwd: root,
      home: dirname(root),
      runner: goodRunner,
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code))
      .toContain('adoption.source-symlink-escape');
    expect(result.adoption?.imports).toEqual([]);
    expect(result.adoption?.backups).toEqual([]);
    expect(await lstatOrNull(join(root, 'AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(root, 'dab.yaml'))).toBeNull();
    expect(await lstatOrNull(join(root, '.agents/AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(root, '.agents/agents/extra.md'))).toBeNull();
    expect(await lstatOrNull(join(root, '.agents/skills/bad'))).toBeNull();
    expect((await lstat(join(root, '.claude/agents/extra.md'))).isFile()).toBe(true);
    expect((await lstat(join(root, '.claude/skills/bad'))).isDirectory()).toBe(true);
    expect(await lstatOrNull(join(root, '.dab'))).toBeNull();
  });

  it('keeps .claude untouched when an initialized skill symlink escapes', async () => {
    const project = await initializedProject();
    const outside = await tempDir('dab-adopt-escape-outside-');
    await writeProjectFile(outside, 'secret.txt', 'secret\n');
    await writeFile(join(project.root, '.claude/agents/extra.md'), agentSource('extra', 'Extra.'));
    await writeProjectFile(project.root, '.claude/skills/bad/SKILL.md', skillSource('bad', 'Bad.'));
    await symlink(outside, join(project.root, '.claude/skills/bad/leak'));
    const settingsBefore = await readFile(join(project.root, '.claude/settings.json'), 'utf8');

    const result = await normalizeProject({
      cwd: project.root,
      home: dirname(project.root),
      runner: goodRunner,
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code))
      .toContain('adoption.source-symlink-escape');
    expect(result.adoption?.imports).toEqual([]);
    expect(result.adoption?.backups).toEqual([]);
    expect(await readFile(join(project.root, '.claude/settings.json'), 'utf8'))
      .toBe(settingsBefore);
    expect(await lstatOrNull(join(project.root, '.agents/agents/extra.md'))).toBeNull();
    expect(await lstatOrNull(join(project.root, '.agents/skills/bad'))).toBeNull();
    expect((await lstat(join(project.root, '.claude/agents/extra.md'))).isFile()).toBe(true);
  });

  it('replaces a physical agent over an existing source with --fix', async () => {
    const project = await initializedProject();
    const target = join(project.root, '.claude/agents/reviewer.md');
    const physical = agentSource('reviewer', 'Physical.');
    await rm(target);
    await writeFile(target, physical);

    const result = await normalizeProject({
      cwd: project.root,
      home: dirname(project.root),
      runner: goodRunner,
      fix: true,
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(await readlink(target)).toBe('../../.agents/agents/reviewer.md');
    expect(await readFile(join(project.root, '.agents/agents/reviewer.md'), 'utf8'))
      .toContain('description: Reviews changes.');
    const backup = result.adoption?.backups.find(
      (item) => item.endsWith('.claude/agents/reviewer.md'),
    );
    expect(backup).toMatch(/^\.dab\/backups\//);
    expect(await readFile(join(project.root, backup ?? ''), 'utf8')).toBe(physical);
    expect(result.backups.some((item) => item.endsWith('.claude/agents/reviewer.md')))
      .toBe(false);
  });

  it('replaces a physical skill over an existing source with --fix', async () => {
    const project = await initializedProject();
    const target = join(project.root, '.claude/skills/doc-sync');
    const physical = skillSource('doc-sync', 'Physical.');
    await rm(target, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'SKILL.md'), physical);

    const result = await normalizeProject({
      cwd: project.root,
      home: dirname(project.root),
      runner: goodRunner,
      fix: true,
    });

    expect(result.ok).toBe(true);
    expect(await readlink(target)).toBe('../../.agents/skills/doc-sync');
    expect(await readFile(join(project.root, '.agents/skills/doc-sync/SKILL.md'), 'utf8'))
      .toContain('description: Keeps docs paired.');
    const backup = result.adoption?.backups.find(
      (item) => item.endsWith('.claude/skills/doc-sync'),
    );
    expect(backup).toMatch(/^\.dab\/backups\//);
    expect(await readFile(join(project.root, backup ?? '', 'SKILL.md'), 'utf8'))
      .toBe(physical);
    expect(result.backups.some((item) => item.endsWith('.claude/skills/doc-sync')))
      .toBe(false);
  });

  it('imports physical global entries with --fix into a temp HOME', async () => {
    const fixture = await globalFixture();
    const home = fixture.home;
    const settings = '{"permissions":{}}\n';
    await writeProjectFile(home, '.claude/settings.json', settings);
    await writeProjectFile(home, '.claude/agents/reviewer.md', agentSource('reviewer', 'Physical.'));
    await writeProjectFile(
      home,
      '.claude/skills/doc-sync/SKILL.md',
      skillSource('doc-sync', 'Physical.'),
    );

    const result = await normalizeProject({
      cwd: join(home, '.agents'),
      home,
      runner: goodRunner,
      fix: true,
    });

    expect(result.ok).toBe(true);
    expect(await readlink(join(home, '.claude/agents/reviewer.md')))
      .toBe('../../.agents/agents/reviewer.md');
    expect(await readlink(join(home, '.claude/skills/doc-sync')))
      .toBe('../../.agents/skills/doc-sync');
    expect(await readFile(join(home, '.agents/agents/reviewer.md'), 'utf8'))
      .toContain('description: Reviews changes.');
    expect(await readFile(join(home, '.agents/skills/doc-sync/SKILL.md'), 'utf8'))
      .toContain('description: Keeps docs paired.');
    expect(await readFile(join(home, '.claude/settings.json'), 'utf8')).toBe(settings);
    expect(await lstatOrNull(join(home, '.gitignore'))).toBeNull();
  });

  it('blocks an import that duplicates an authored agent name', async () => {
    const project = await initializedProject();
    await writeFile(
      join(project.root, '.claude/agents/other-reviewer.md'),
      agentSource('reviewer', 'Duplicate.'),
    );

    const result = await normalizeProject({
      cwd: project.root,
      home: dirname(project.root),
      runner: goodRunner,
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain('agent.duplicate-name');
    expect(await lstatOrNull(join(project.root, '.agents/agents/other-reviewer.md'))).toBeNull();
    expect((await lstat(join(project.root, '.claude/agents/other-reviewer.md'))).isFile())
      .toBe(true);
    expect(result.adoption?.imports).toEqual([]);
    expect(result.adoption?.backups).toEqual([]);
  });

  it('blocks an import that duplicates an authored skill name', async () => {
    const project = await initializedProject();
    await writeProjectFile(
      project.root,
      '.claude/skills/other-sync/SKILL.md',
      skillSource('doc-sync', 'Duplicate.'),
    );

    const result = await normalizeProject({
      cwd: project.root,
      home: dirname(project.root),
      runner: goodRunner,
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain('skill.duplicate-name');
    expect(await lstatOrNull(join(project.root, '.agents/skills/other-sync'))).toBeNull();
    expect(result.adoption?.imports).toEqual([]);
  });

  it('writes no source when a partial project imports a duplicate name', async () => {
    const project = await projectFixture();
    await writeProjectFile(
      project.root,
      '.agents/agents/reviewer.md',
      agentSource('reviewer', 'Authored.'),
    );
    await writeProjectFile(
      project.root,
      '.claude/agents/other-reviewer.md',
      agentSource('reviewer', 'Duplicate.'),
    );

    const result = await normalizeProject({
      cwd: project.root,
      home: dirname(project.root),
      runner: goodRunner,
    });

    expect(result.ok).toBe(false);
    expect(result.adoption?.phase).toBe('partial');
    expect(result.diagnostics.map((item) => item.code)).toContain('agent.duplicate-name');
    expect(await lstatOrNull(join(project.root, 'AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(project.root, 'dab.yaml'))).toBeNull();
    expect(await lstatOrNull(join(project.root, '.agents/agents/other-reviewer.md'))).toBeNull();
  });
});

describe('normalize source tree safety', () => {
  it('writes nothing when .agents aliases .claude', async () => {
    const root = await tempDir('dab-adopt-alias-');
    await mkdir(join(root, '.claude'), { recursive: true });
    await symlink('.claude', join(root, '.agents'), 'dir');

    const result = await normalizeProject({
      cwd: root,
      home: dirname(root),
      runner: goodRunner,
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.diagnostics.map((item) => item.code)).toContain('path.overlap');
    expect(await readdir(join(root, '.claude'))).toEqual([]);
    expect(await lstatOrNull(join(root, 'AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(root, 'dab.yaml'))).toBeNull();
  });

  it('writes nothing when .agents is a dangling alias of .claude', async () => {
    const root = await tempDir('dab-adopt-alias-dangling-');
    await symlink('.claude', join(root, '.agents'), 'dir');

    const result = await normalizeProject({
      cwd: root,
      home: dirname(root),
      runner: goodRunner,
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.diagnostics.map((item) => item.code)).toContain('path.overlap');
    // The minimal source write must not create the missing .claude target.
    expect(await lstatOrNull(join(root, '.claude'))).toBeNull();
    expect(await lstatOrNull(join(root, 'AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(root, 'dab.yaml'))).toBeNull();
  });
});

describe('normalize managed projection drift', () => {
  it('repairs a drifted managed agent symlink without --fix', async () => {
    const project = await initializedProject();
    const target = join(project.root, '.claude/agents/reviewer.md');
    await rm(target);
    await symlink('../../elsewhere.md', target);

    const result = await normalizeProject({
      cwd: project.root,
      home: dirname(project.root),
      runner: goodRunner,
    });

    expect(result.ok).toBe(true);
    expect(await readlink(target)).toBe('../../.agents/agents/reviewer.md');
    expect(result.adoption?.imports).toEqual([]);
    expect(result.adoption?.backups).toEqual([]);
  });

  it('repairs a drifted managed skill symlink without --fix', async () => {
    const project = await initializedProject();
    const target = join(project.root, '.claude/skills/doc-sync');
    await rm(target, { recursive: true });
    await symlink('../../elsewhere', target);

    const result = await normalizeProject({
      cwd: project.root,
      home: dirname(project.root),
      runner: goodRunner,
    });

    expect(result.ok).toBe(true);
    expect(await readlink(target)).toBe('../../.agents/skills/doc-sync');
    expect(result.adoption?.imports).toEqual([]);
    expect(result.adoption?.backups).toEqual([]);
  });

  it('repairs drifted managed links with --fix without importing or backing them up', async () => {
    const project = await initializedProject();
    const target = join(project.root, '.claude/agents/reviewer.md');
    await rm(target);
    await symlink('../../elsewhere.md', target);

    const result = await normalizeProject({
      cwd: project.root,
      home: dirname(project.root),
      runner: goodRunner,
      fix: true,
    });

    expect(result.ok).toBe(true);
    expect(await readlink(target)).toBe('../../.agents/agents/reviewer.md');
    expect(result.adoption?.imports).toEqual([]);
    expect(result.adoption?.backups).toEqual([]);
    expect(result.backups.some((item) => item.endsWith('.claude/agents/reviewer.md')))
      .toBe(false);
  });

  it('repairs an unmanaged agent symlink with --fix when an authored source exists', async () => {
    const project = await initializedProject();
    await writeProjectFile(
      project.root,
      '.agents/agents/extra.md',
      agentSource('extra', 'Authored.'),
    );
    const target = join(project.root, '.claude/agents/extra.md');
    await symlink('../../elsewhere.md', target);

    const blocked = await normalizeProject({
      cwd: project.root,
      home: dirname(project.root),
      runner: goodRunner,
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.diagnostics.map((item) => item.code)).toContain('projection.unmanaged');
    expect((await lstat(target)).isSymbolicLink()).toBe(true);

    const fixed = await normalizeProject({
      cwd: project.root,
      home: dirname(project.root),
      runner: goodRunner,
      fix: true,
    });

    expect(fixed.ok).toBe(true);
    expect(await readlink(target)).toBe('../../.agents/agents/extra.md');
    const backup = fixed.backups.find((item) => item.endsWith('.claude/agents/extra.md'));
    expect(backup).toMatch(/^\.dab\/backups\//);
  });

  it('repairs an unmanaged skill symlink with --fix when an authored source exists', async () => {
    const project = await initializedProject();
    await writeProjectFile(
      project.root,
      '.agents/skills/extra-skill/SKILL.md',
      skillSource('extra-skill', 'Authored.'),
    );
    const target = join(project.root, '.claude/skills/extra-skill');
    await symlink('../../elsewhere', target);

    const fixed = await normalizeProject({
      cwd: project.root,
      home: dirname(project.root),
      runner: goodRunner,
      fix: true,
    });

    expect(fixed.ok).toBe(true);
    expect(await readlink(target)).toBe('../../.agents/skills/extra-skill');
    const backup = fixed.backups.find((item) => item.endsWith('.claude/skills/extra-skill'));
    expect(backup).toMatch(/^\.dab\/backups\//);
  });
});

describe('normalize adoption dry-run plans', () => {
  it('previews import, backup and symlink actions for an initialized project', async () => {
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
    expect(result.actions).toEqual(expect.arrayContaining([
      'import .claude/agents/extra.md -> .agents/agents/extra.md',
      'symlink .claude/agents/extra.md -> ../../.agents/agents/extra.md',
    ]));
    expect(
      result.actions.some((action) =>
        action.startsWith('backup .claude/agents/extra.md -> .dab/backups/')),
    ).toBe(true);
    expect(result.adoption?.backups).toHaveLength(1);
    expect(result.adoption?.backups[0])
      .toMatch(/^\.dab\/backups\/.*\/\.claude\/agents\/extra\.md$/);
    expect(await lstatOrNull(join(project.root, '.agents/agents/extra.md'))).toBeNull();
    expect((await lstat(join(project.root, '.claude/agents/extra.md'))).isFile()).toBe(true);
  });

  it('previews global skill imports with backup paths', async () => {
    const fixture = await globalFixture();
    const home = fixture.home;
    await writeProjectFile(
      home,
      '.claude/skills/pdf-tools/SKILL.md',
      skillSource('pdf-tools', 'PDF.'),
    );

    const result = await normalizeProject({
      cwd: join(home, '.agents'),
      home,
      runner: goodRunner,
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    expect(result.actions).toEqual(expect.arrayContaining([
      'import .claude/skills/pdf-tools -> .agents/skills/pdf-tools',
      'symlink .claude/skills/pdf-tools -> ../../.agents/skills/pdf-tools',
    ]));
    expect(result.adoption?.backups).toHaveLength(1);
    expect(result.adoption?.backups[0])
      .toMatch(/^\.dab\/backups\/.*\/\.claude\/skills\/pdf-tools$/);
    expect((await lstat(join(home, '.claude/skills/pdf-tools'))).isDirectory()).toBe(true);
    expect(await lstatOrNull(join(home, '.agents/skills/pdf-tools'))).toBeNull();
  });

  it('prints adoption source, import and backup actions in human output', async () => {
    const project = await initializedProject();
    await writeFile(
      join(project.root, '.claude/agents/extra.md'),
      agentSource('extra', 'Extra.'),
    );
    const captured = capture();

    const code = await runNormalize(
      { cwd: project.root, home: dirname(project.root), runner: goodRunner },
      captured.io,
    );

    expect(code).toBe(0);
    const output = captured.stdout.join('');
    expect(output).toContain('import .claude/agents/extra.md -> .agents/agents/extra.md');
    expect(output).toContain('symlink .claude/agents/extra.md -> ../../.agents/agents/extra.md');
    expect(output).toContain('.dab/backups/');
    expect(output).toMatch(/backup \.claude\/agents\/extra\.md -> \.dab\/backups\//);
  });

  it('prints planned import actions and backup paths in a human dry run', async () => {
    const project = await initializedProject();
    await writeFile(
      join(project.root, '.claude/agents/extra.md'),
      agentSource('extra', 'Extra.'),
    );
    const captured = capture();

    const code = await runNormalize(
      {
        cwd: project.root,
        home: dirname(project.root),
        runner: goodRunner,
        dryRun: true,
      },
      captured.io,
    );

    expect(code).toBe(0);
    const output = captured.stdout.join('');
    expect(output).toContain('dab normalize (dry run)');
    expect(output).toContain('import .claude/agents/extra.md -> .agents/agents/extra.md');
    expect(output).toContain('symlink .claude/agents/extra.md -> ../../.agents/agents/extra.md');
    expect(output).toMatch(/backup \.claude\/agents\/extra\.md -> \.dab\/backups\//);
    expect((await lstat(join(project.root, '.claude/agents/extra.md'))).isFile()).toBe(true);
  });

  it('previews uninitialized import plans in actions and backup paths', async () => {
    const root = await tempDir('dab-adopt-dry-plan-');
    await writeProjectFile(root, '.claude/agents/extra.md', agentSource('extra', 'Extra.'));

    const result = await normalizeProject({
      cwd: root,
      home: dirname(root),
      runner: goodRunner,
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    expect(result.actions).toEqual(expect.arrayContaining([
      'create AGENTS.md',
      'import .claude/agents/extra.md -> .agents/agents/extra.md',
      'symlink .claude/agents/extra.md -> ../../.agents/agents/extra.md',
    ]));
    expect(result.adoption?.backups).toHaveLength(1);
    expect(result.adoption?.backups[0])
      .toMatch(/^\.dab\/backups\/.*\/\.claude\/agents\/extra\.md$/);
    expect(await lstatOrNull(join(root, 'AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(root, '.agents/agents/extra.md'))).toBeNull();
  });
});
