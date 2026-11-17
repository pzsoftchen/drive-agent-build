import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { normalizeProject, runNormalize } from '../../src/commands/normalize.ts';
import type { CommandRunner } from '../../src/core/command.ts';
import { ConfigError } from '../../src/core/errors.ts';
import { lstatOrNull } from '../../src/core/fs-atomic.ts';
import {
  getGeneratedTarget,
  loadProjectManifest,
} from '../../src/model/project-manifest.ts';
import { makeGlobalFixture } from '../helpers/global.ts';
import { makeProject, writeProjectFile, type ProjectFixture } from '../helpers/project.ts';
import { makeTempDir } from '../helpers/tmp.ts';

const goodRunner: CommandRunner = async () => ({
  stdout: '2.1.325 (Claude Code)\n',
  stderr: '',
  exitCode: 0,
});

const projects: ProjectFixture[] = [];
const homes: string[] = [];

async function globalFixture() {
  const fixture = await makeGlobalFixture();
  homes.push(fixture.home);
  return fixture;
}

const projectPolicy = `version: 1
defaultMode: default
read:
  deny:
    - .env
write:
  deny:
    - .claude/settings.json
execute:
  ask:
    - git push
capabilities:
  deny:
    - web
`;

const adapterPolicy = `version: 1
provider: claude-code
permissions:
  deny:
    - Bash(sudo:*)
`;

const hookMetadata = `id: protect-generated
event: pre_tool
matcher: Edit|Write|MultiEdit
entry: run.mjs
runner: node
timeout: 10
order: 10
`;

async function projectFixture(
  options: { instructions?: 'generated' | 'disabled'; legacy?: boolean } = {},
): Promise<ProjectFixture> {
  const project = await makeProject();
  projects.push(project);
  await writeProjectFile(project.root, 'AGENTS.md', '# Project\n\nRead this first.\n');
  const manifest = options.legacy === true
    ? `# project manifest
version: 1
project:
  id: demo
  name: Demo
profile: feature
target:
  provider: claude-code
  minVersion: 2.1.277
  claudeMdShim: true
paths:
  agents: .agents
  claude: .claude
`
    : `# project manifest
version: 2
scope: project
project:
  id: demo
  name: Demo
profile: feature
targets:
  - provider: claude-code
    enabled: true
    options:
      minVersion: 2.1.277
      instructions: ${options.instructions ?? 'symlink'}
paths:
  agents: .agents
  claude: .claude
`;
  await writeProjectFile(project.root, 'dab.yaml', manifest);
  await writeProjectFile(project.root, '.agents/policies/project.yaml', projectPolicy);
  await writeProjectFile(project.root, '.agents/adapters/claude-code.yaml', adapterPolicy);
  await writeProjectFile(
    project.root,
    '.agents/agents/reviewer.md',
    '---\nname: reviewer\ndescription: Reviews changes.\ntools: Read, Grep, Glob\n---\nReview.\n',
  );
  await writeProjectFile(
    project.root,
    '.agents/skills/doc-sync/SKILL.md',
    '---\nname: doc-sync\ndescription: Keeps docs paired.\n---\nSync docs.\n',
  );
  await writeProjectFile(project.root, '.agents/rules/testing.md', 'Run tests.\n');
  await writeProjectFile(
    project.root,
    '.agents/hooks/protect-generated/hook.yaml',
    hookMetadata,
  );
  await writeProjectFile(
    project.root,
    '.agents/hooks/protect-generated/run.mjs',
    'process.exit(0);\n',
  );
  return project;
}

afterEach(async () => {
  await Promise.all(projects.splice(0).map((item) => rm(item.root, { recursive: true, force: true })));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe('normalizeProject', () => {
  it('creates settings, the shim, projections, manifest and ignore block', async () => {
    const project = await projectFixture();
    const result = await normalizeProject({ cwd: project.root });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.targets.map((item) => item.provider)).toEqual(['claude-code']);
    expect(result.targets[0]?.settings?.path).toBe('.claude/settings.json');
    expect(result.targets[0]?.instructions).toMatchObject({
      path: '.claude/CLAUDE.md',
      mode: 'symlink',
      action: 'create',
    });
    expect(result.actions).toEqual(result.targets.flatMap((item) => item.actions));
    const settingsText = await readFile(join(project.root, '.claude/settings.json'), 'utf8');
    const settings = JSON.parse(settingsText) as {
      permissions: { deny: string[]; ask: string[] };
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining([
        'Read(./.env)',
        'Edit(./.claude/settings.json)',
        'Write(./.claude/settings.json)',
        'Bash(sudo:*)',
        'WebFetch',
      ]),
    );
    expect(settings.permissions.ask).toContain('Bash(git push:*)');
    expect(settings.hooks.PreToolUse?.[0]?.hooks[0]?.command).toContain(
      '.agents/hooks/protect-generated/run.mjs',
    );

    expect((await lstatOrNull(join(project.root, '.claude/CLAUDE.md')))?.isSymbolicLink())
      .toBe(true);
    expect(await readlink(join(project.root, '.claude/CLAUDE.md'))).toBe('../AGENTS.md');
    expect(await readlink(join(project.root, '.claude/agents/reviewer.md'))).toBe(
      '../../.agents/agents/reviewer.md',
    );
    expect(await readlink(join(project.root, '.claude/skills/doc-sync'))).toBe(
      '../../.agents/skills/doc-sync',
    );
    expect(await readlink(join(project.root, '.claude/rules/testing.md'))).toBe(
      '../../.agents/rules/testing.md',
    );

    const loaded = await loadProjectManifest(project.root);
    const generated = getGeneratedTarget(loaded.manifest, 'claude-code');
    expect(generated?.settings?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(generated?.instructions).toMatchObject({
      path: '.claude/CLAUDE.md',
      mode: 'symlink',
    });
    expect(generated?.projections).toHaveLength(3);

    const gitignore = await readFile(join(project.root, '.gitignore'), 'utf8');
    expect(gitignore).toContain('# >>> dab managed >>>');
    expect(gitignore).toContain('.claude/CLAUDE.md');
    expect(await lstatOrNull(join(project.root, '.claude/settings.local.json'))).toBeNull();
  });

  it('accepts a managed instruction symlink and repairs it after drift', async () => {
    const project = await projectFixture();
    await normalizeProject({ cwd: project.root });
    expect(await readlink(join(project.root, '.claude/CLAUDE.md'))).toBe('../AGENTS.md');

    await rm(join(project.root, '.claude/CLAUDE.md'));
    const repaired = await normalizeProject({ cwd: project.root });
    expect(repaired.ok).toBe(true);
    expect(await readlink(join(project.root, '.claude/CLAUDE.md'))).toBe('../AGENTS.md');
  });

  it('keeps global settings byte-identical', async () => {
    const home = await globalFixture();
    const settings = join(home.home, '.claude/settings.json');
    await writeProjectFile(
      home.home,
      '.claude/settings.json',
      '{"permissions":{"allow":["Bash(echo)"]}}\n',
    );

    const result = await normalizeProject({
      cwd: home.agents,
      home: home.home,
      runner: goodRunner,
    });

    expect(result.ok).toBe(true);
    expect(await readFile(settings, 'utf8')).toBe(
      '{"permissions":{"allow":["Bash(echo)"]}}\n',
    );
    expect(result.targets[0]?.settings).toBeUndefined();
    expect(
      result.diagnostics.some(
        (item) => item.code === 'claude-settings.global-not-adopted'
          && item.severity === 'warning',
      ),
    ).toBe(true);
  });

  it('does not create a global $HOME/.gitignore', async () => {
    const home = await globalFixture();

    const result = await normalizeProject({
      cwd: home.agents,
      home: home.home,
      runner: goodRunner,
    });

    expect(result.ok).toBe(true);
    expect(result.gitignore).toEqual({ changed: false, path: '' });
    expect(await lstatOrNull(join(home.home, '.gitignore'))).toBeNull();
  });

  it('leaves an existing global $HOME/.gitignore byte-identical', async () => {
    const home = await globalFixture();
    const ignore = join(home.home, '.gitignore');
    const content = 'node_modules/\n# user managed\ncustom/\n';
    await writeFile(ignore, content);

    const result = await normalizeProject({
      cwd: home.agents,
      home: home.home,
      runner: goodRunner,
    });

    expect(result.ok).toBe(true);
    expect(result.gitignore.changed).toBe(false);
    expect(await readFile(ignore, 'utf8')).toBe(content);
  });

  it('is byte-idempotent on a second run', async () => {
    const project = await projectFixture();
    await normalizeProject({ cwd: project.root });
    const settingsBefore = await readFile(join(project.root, '.claude/settings.json'), 'utf8');
    const manifestBefore = await readFile(join(project.root, 'dab.yaml'), 'utf8');
    const gitignoreBefore = await readFile(join(project.root, '.gitignore'), 'utf8');

    const result = await normalizeProject({ cwd: project.root });

    expect(result.ok).toBe(true);
    expect(result.settings.changed).toBe(false);
    expect(result.manifestUpdated).toBe(false);
    expect(result.gitignore.changed).toBe(false);
    expect(result.backups).toEqual([]);
    expect(await readFile(join(project.root, '.claude/settings.json'), 'utf8')).toBe(
      settingsBefore,
    );
    expect(await readFile(join(project.root, 'dab.yaml'), 'utf8')).toBe(manifestBefore);
    expect(await readFile(join(project.root, '.gitignore'), 'utf8')).toBe(gitignoreBefore);
  });

  it('repairs drifted settings and keeps a backup', async () => {
    const project = await projectFixture();
    await normalizeProject({ cwd: project.root });
    const settingsPath = join(project.root, '.claude/settings.json');
    await writeFile(settingsPath, '{"permissions":{}}\n');

    const result = await normalizeProject({
      cwd: project.root,
      now: new Date('2026-11-16T12:00:00Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.settings.changed).toBe(true);
    expect(result.backups).toHaveLength(1);
    expect(await readFile(result.backups[0] ?? '', 'utf8')).toBe('{"permissions":{}}\n');
    expect(await readFile(settingsPath, 'utf8')).not.toBe('{"permissions":{}}\n');
  });

  it('blocks a physical agent copy before any write, then fixes with backup', async () => {
    const project = await projectFixture();
    const target = join(project.root, '.claude/agents/reviewer.md');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, 'physical copy\n');

    const blocked = await normalizeProject({ cwd: project.root });

    expect(blocked.ok).toBe(false);
    expect(blocked.exitCode).toBe(3);
    expect(blocked.diagnostics.map((item) => item.code)).toContain('projection.physical-copy');
    expect(await readFile(target, 'utf8')).toBe('physical copy\n');
    expect(await lstatOrNull(join(project.root, '.claude/settings.json'))).toBeNull();
    expect(await lstatOrNull(join(project.root, '.claude/CLAUDE.md'))).toBeNull();
    expect(await lstatOrNull(join(project.root, '.gitignore'))).toBeNull();
    expect((await loadProjectManifest(project.root)).manifest.generated).toBeUndefined();

    const fixed = await normalizeProject({
      cwd: project.root,
      fix: true,
      now: new Date('2026-11-16T12:00:00Z'),
    });

    expect(fixed.ok).toBe(true);
    expect(await readlink(target)).toContain('.agents/agents/reviewer.md');
    expect(fixed.backups.some((item) => item.endsWith('.claude/agents/reviewer.md'))).toBe(true);
    expect(
      await readFile(
        fixed.backups.find((item) => item.endsWith('.claude/agents/reviewer.md')) ?? '',
        'utf8',
      ),
    ).toBe('physical copy\n');
  });

  it('keeps an unresolvable root CLAUDE.md conflict fatal with --fix', async () => {
    const project = await projectFixture();
    await writeProjectFile(project.root, 'CLAUDE.md', '# user instructions\n');

    const result = await normalizeProject({
      cwd: project.root,
      fix: true,
      now: new Date('2026-11-16T12:00:00Z'),
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'claude-md.unmanaged', severity: 'error' }),
    ]));
    expect(await lstatOrNull(join(project.root, '.claude/settings.json'))).toBeNull();
    expect(await lstatOrNull(join(project.root, '.claude/CLAUDE.md'))).toBeNull();
    expect(await lstatOrNull(join(project.root, '.claude/agents/reviewer.md'))).toBeNull();
    expect((await loadProjectManifest(project.root)).manifest.generated).toBeUndefined();
  });

  it('writes nothing during a dry run', async () => {
    const project = await projectFixture();
    const result = await normalizeProject({ cwd: project.root, dryRun: true });

    expect(result.ok).toBe(true);
    expect(result.actions.length).toBeGreaterThan(0);
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]?.provider).toBe('claude-code');
    expect(await lstatOrNull(join(project.root, '.claude/settings.json'))).toBeNull();
    expect(await lstatOrNull(join(project.root, '.claude/CLAUDE.md'))).toBeNull();
    expect(await lstatOrNull(join(project.root, '.claude/agents/reviewer.md'))).toBeNull();
    expect(await lstatOrNull(join(project.root, '.gitignore'))).toBeNull();
    expect((await loadProjectManifest(project.root)).manifest.generated).toBeUndefined();
  });

  it('preserves comments in dab.yaml', async () => {
    const project = await projectFixture();
    await normalizeProject({ cwd: project.root });
    const text = await readFile(join(project.root, 'dab.yaml'), 'utf8');
    expect(text).toContain('# project manifest');
    expect(text).toContain('generated:');
  });

  it('migrates a v1 manifest in place and preserves its comments', async () => {
    const project = await projectFixture({ legacy: true });

    const result = await normalizeProject({ cwd: project.root });

    expect(result.ok).toBe(true);
    expect(result.manifestUpdated).toBe(true);
    const text = await readFile(join(project.root, 'dab.yaml'), 'utf8');
    expect(text).toContain('# project manifest');
    expect(text).toContain('version: 2');
    expect(text).toContain('scope: project');
    expect(text).not.toMatch(/^target:/m);
    const loaded = await loadProjectManifest(project.root);
    expect(loaded.legacy).toBe(false);
    expect(getGeneratedTarget(loaded.manifest, 'claude-code')?.settings?.path).toBe(
      '.claude/settings.json',
    );
  });

  it('removes a managed shim when instructions are disabled', async () => {
    const project = await projectFixture();
    await normalizeProject({ cwd: project.root });
    const dabPath = join(project.root, 'dab.yaml');
    const manifestText = await readFile(dabPath, 'utf8');
    await writeFile(dabPath, manifestText.replace('instructions: symlink', 'instructions: disabled'));

    const result = await normalizeProject({ cwd: project.root });

    expect(result.ok).toBe(true);
    expect(result.shimAction).toBe('remove');
    expect(await lstatOrNull(join(project.root, '.claude/CLAUDE.md'))).toBeNull();
    const loaded = await loadProjectManifest(project.root);
    expect(getGeneratedTarget(loaded.manifest, 'claude-code')?.instructions).toBeNull();
  });

  it('blocks unmanaged settings and replaces them only with fix', async () => {
    const project = await projectFixture();
    const settingsPath = join(project.root, '.claude/settings.json');
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, '{"permissions":{"allow":["Bash(echo)"]}}\n');

    const blocked = await normalizeProject({ cwd: project.root });
    expect(blocked.ok).toBe(false);
    expect(blocked.diagnostics.map((item) => item.code)).toContain('claude-settings.unmanaged');
    expect(await readFile(settingsPath, 'utf8')).toBe('{"permissions":{"allow":["Bash(echo)"]}}\n');
    expect(await lstatOrNull(join(project.root, '.claude/CLAUDE.md'))).toBeNull();

    const fixed = await normalizeProject({
      cwd: project.root,
      fix: true,
      now: new Date('2026-11-16T12:00:00Z'),
    });
    expect(fixed.ok).toBe(true);
    expect(fixed.backups.some((item) => item.endsWith('.claude/settings.json'))).toBe(true);
    expect(await readFile(settingsPath, 'utf8')).not.toBe(
      '{"permissions":{"allow":["Bash(echo)"]}}\n',
    );
  });

  it('stops on invalid authored sources without writing', async () => {
    const project = await projectFixture();
    await writeProjectFile(project.root, '.agents/agents/bad.md', '---\nname: bad\n---\nBody.\n');

    const result = await normalizeProject({ cwd: project.root });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.diagnostics.map((item) => item.code)).toContain('agent.invalid-frontmatter');
    expect(await lstatOrNull(join(project.root, '.claude/settings.json'))).toBeNull();
  });

  it('rejects Windows and missing manifests', async () => {
    const project = await projectFixture();
    await expect(
      normalizeProject({ cwd: project.root, platform: 'win32' }),
    ).rejects.toMatchObject({ code: 'platform.unsupported' });

    const empty = await makeProject();
    projects.push(empty);
    await expect(normalizeProject({ cwd: empty.root })).rejects.toBeInstanceOf(ConfigError);
  });

  it('rejects a symlinked generated directory that escapes the project', async () => {
    const project = await projectFixture();
    const outside = await makeTempDir('dab-outside-');
    try {
      await rm(join(project.root, '.claude'), { recursive: true, force: true });
      await symlink(outside, join(project.root, '.claude'), 'dir');

      const result = await normalizeProject({ cwd: project.root });
      expect(result.ok).toBe(false);
      expect(result.diagnostics.map((item) => item.code)).toContain('path.symlink-escape');
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('emits machine-readable JSON from runNormalize', async () => {
    const project = await projectFixture();
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runNormalize(
      { cwd: project.root, json: true },
      {
        stdout: (value) => stdout.push(value),
        stderr: (value) => stderr.push(value),
      },
    );

    expect(code).toBe(0);
    expect(stderr.join('')).toBe('');
    const payload = JSON.parse(stdout.join('')) as {
      ok: boolean;
      settings: { path: string; sha256: string };
    };
    expect(payload.ok).toBe(true);
    expect(payload.settings.path).toBe('.claude/settings.json');
    expect(payload.settings.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
