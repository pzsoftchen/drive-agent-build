import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { detectProject } from '../../src/commands/detect.ts';
import { initializeProject, runInit } from '../../src/commands/init.ts';
import { normalizeProject } from '../../src/commands/normalize.ts';
import type { CommandRunner } from '../../src/core/command.ts';
import { lstatOrNull } from '../../src/core/fs-atomic.ts';
import { scanProject } from '../../src/init/scanner.ts';
import { templateFiles } from '../../src/init/templates.ts';
import { loadProjectManifest } from '../../src/model/project-manifest.ts';
import { makeGlobalFixture } from '../helpers/global.ts';
import { makeTempDir } from '../helpers/tmp.ts';

const dirs: string[] = [];

const goodRunner: CommandRunner = async () => ({
  stdout: '2.1.325 (Claude Code)\n',
  stderr: '',
  exitCode: 0,
});

const legacyManifest = `version: 1
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
`;

async function tempDir(prefix: string): Promise<string> {
  const dir = await makeTempDir(prefix);
  dirs.push(dir);
  return dir;
}

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    },
  };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('scope-aware init', () => {
  it('bootstraps global source and projections without writing home AGENTS.md or settings', async () => {
    const home = await makeTempDir('dab-home-init-');
    dirs.push(home);
    const captureResult = capture();

    const code = await runInit(
      { cwd: home, path: '.agents', home, runner: goodRunner, json: true },
      captureResult.io,
    );

    expect(code).toBe(0);
    expect(await lstatOrNull(join(home, 'AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(home, 'dab.yaml'))).toBeNull();
    expect(await lstatOrNull(join(home, '.gitignore'))).toBeNull();
    expect(await lstatOrNull(join(home, '.agents/AGENTS.md'))).not.toBeNull();
    expect(await lstatOrNull(join(home, '.agents/dab.yaml'))).not.toBeNull();
    expect(await readlink(join(home, '.claude/CLAUDE.md'))).toBe('../.agents/AGENTS.md');
    expect(await lstatOrNull(join(home, '.claude/settings.json'))).toBeNull();

    const manifest = await loadProjectManifest(home, { scope: 'global' });
    expect(manifest.manifest.scope).toBe('global');
    expect(manifest.manifest.targets[0]?.provider).toBe('claude-code');

    const payload = JSON.parse(captureResult.stdout.join('')) as {
      ok: boolean;
      scope: string;
      root: string;
      scopeRoot: string;
      created: string[];
    };
    expect(payload.ok).toBe(true);
    expect(payload.scope).toBe('global');
    expect(payload.root).toBe(join(home, '.agents'));
    expect(payload.scopeRoot).toBe(home);
    expect(await lstatOrNull(join(payload.scopeRoot, payload.created[0] ?? ''))).not.toBeNull();
  });

  it('bootstraps a symlinked global source root under HOME', async () => {
    const home = await tempDir('dab-home-init-');
    const real = join(home, 'dot-agents-real');
    await mkdir(join(real, 'skills'), { recursive: true });
    await symlink(real, join(home, '.agents'), 'dir');
    const captureResult = capture();

    const code = await runInit(
      { cwd: home, path: '.agents', home, runner: goodRunner, json: true },
      captureResult.io,
    );

    expect(code).toBe(0);
    const payload = JSON.parse(captureResult.stdout.join('')) as {
      ok: boolean;
      scope: string;
      root: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.scope).toBe('global');
    expect(payload.root).toBe(join(home, '.agents'));
    expect(await lstatOrNull(join(real, 'AGENTS.md'))).not.toBeNull();
    expect(await lstatOrNull(join(real, 'dab.yaml'))).not.toBeNull();
    expect(await lstatOrNull(join(home, 'AGENTS.md'))).toBeNull();
    expect(await readlink(join(home, '.claude/CLAUDE.md'))).toBe('../.agents/AGENTS.md');

    const manifest = await loadProjectManifest(home, { scope: 'global' });
    expect(manifest.manifest.scope).toBe('global');
  });

  it('refuses a project symlink that targets an existing source root', async () => {
    const project = await tempDir('dab-init-symlink-project-');
    await mkdir(join(project, '.agents/skills/new'), { recursive: true });
    await writeFile(join(project, 'dab.yaml'), 'version: 2\n');
    const linkParent = await tempDir('dab-init-symlink-');
    const link = join(linkParent, 'innocent-link');
    await symlink(join(project, '.agents/skills/new'), link, 'dir');
    const captureResult = capture();

    const code = await runInit(
      { cwd: linkParent, path: 'innocent-link', home: linkParent, json: true },
      captureResult.io,
    );

    expect(code).toBe(3);
    const payload = JSON.parse(captureResult.stdout.join('')) as {
      error: { code: string };
    };
    expect(payload.error.code).toBe('config.source-root-nested');
    expect(await lstatOrNull(join(link, 'AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(link, 'dab.yaml'))).toBeNull();
    expect(await lstatOrNull(join(link, '.agents'))).toBeNull();
    expect(await lstatOrNull(join(link, '.claude'))).toBeNull();
  });

  it('writes the authored template under .agents for global scope', async () => {
    const home = await tempDir('dab-home-init-');

    const code = await runInit(
      { cwd: home, path: '.agents', home, runner: goodRunner, json: true },
      capture().io,
    );

    expect(code).toBe(0);
    for (const relative of [
      '.agents/agents/implementer.md',
      '.agents/agents/reviewer.md',
      '.agents/skills/feature-delivery/SKILL.md',
      '.agents/rules/testing.md',
      '.agents/policies/project.yaml',
      '.agents/adapters/claude-code.yaml',
      '.agents/memory/INDEX.md',
    ]) {
      expect(await lstatOrNull(join(home, relative)), relative).not.toBeNull();
    }
    expect((await lstatOrNull(join(home, '.agents/notes')))?.isDirectory()).toBe(true);
    expect((await lstatOrNull(join(home, '.claude/agents/implementer.md')))?.isSymbolicLink())
      .toBe(true);
    expect(await readFile(join(home, '.agents/dab.yaml'), 'utf8')).toContain('scope: global');
  });

  it('does not scaffold docs or authoring skills in global scope', async () => {
    const home = await tempDir('dab-home-init-');

    const result = await initializeProject({
      cwd: home,
      path: '.agents',
      home,
      runner: goodRunner,
    });

    expect(result.ok).toBe(true);
    expect(result.created.some((path) => path.startsWith('docs/'))).toBe(false);
    expect(result.created.some((path) => path.startsWith('.agents/skills/dab-'))).toBe(false);
    expect(result.language.value).toMatch(/^(en|zh)$/);
    expect(await lstatOrNull(join(home, 'docs'))).toBeNull();
    expect(await lstatOrNull(join(home, '.agents/skills/dab-doc-writing'))).toBeNull();
    const agentsMd = await readFile(join(home, '.agents/AGENTS.md'), 'utf8');
    expect(agentsMd).not.toContain('## Documentation');
  });

  it('leaves user-level settings and gitignore byte-identical in global scope', async () => {
    const home = await tempDir('dab-home-init-');
    const settings = '{"permissions":{"allow":["Bash(ls)"]}}\n';
    const gitignore = 'node_modules\n';
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(join(home, '.claude/settings.json'), settings);
    await writeFile(join(home, '.gitignore'), gitignore);
    const captureResult = capture();

    const code = await runInit(
      { cwd: home, path: '.agents', home, runner: goodRunner, json: true },
      captureResult.io,
    );

    expect(code).toBe(0);
    expect(await readFile(join(home, '.claude/settings.json'), 'utf8')).toBe(settings);
    expect(await readFile(join(home, '.gitignore'), 'utf8')).toBe(gitignore);
    const payload = JSON.parse(captureResult.stdout.join('')) as {
      ok: boolean;
      pending: Array<{ code: string }>;
      normalize: { ok: boolean };
    };
    expect(payload.ok).toBe(true);
    expect(payload.normalize.ok).toBe(true);
    expect(payload.pending.map((item) => item.code)).not.toContain(
      'claude-settings.unmanaged',
    );
  });

  it('renders scope-specific template layouts', async () => {
    const scan = await scanProject(await tempDir('dab-init-template-'));

    const project = templateFiles(scan, 'project');
    expect(Object.keys(project)).toContain('AGENTS.md');
    expect(Object.keys(project)).toContain('dab.yaml');
    expect(Object.keys(project)).not.toContain('.agents/AGENTS.md');
    expect(Object.keys(project)).not.toContain('.agents/dab.yaml');
    expect(project['dab.yaml']).toContain('scope: project');

    const global = templateFiles(scan, 'global');
    expect(Object.keys(global)).toContain('.agents/AGENTS.md');
    expect(Object.keys(global)).toContain('.agents/dab.yaml');
    expect(Object.keys(global)).not.toContain('AGENTS.md');
    expect(Object.keys(global)).not.toContain('dab.yaml');
    expect(global['.agents/dab.yaml']).toContain('scope: global');
    expect(global['.agents/agents/implementer.md']).toBe(
      project['.agents/agents/implementer.md'],
    );
  });

  it('reports scope=global in human output', async () => {
    const home = await tempDir('dab-home-init-');
    const captureResult = capture();

    const code = await runInit(
      { cwd: home, path: '.agents', home, runner: goodRunner },
      captureResult.io,
    );

    expect(code).toBe(0);
    expect(captureResult.stdout.join('')).toContain(`dab init ${join(home, '.agents')} scope=global`);
  });

  it('refuses to init inside an existing project source root', async () => {
    const root = await makeTempDir('dab-init-nested-');
    dirs.push(root);
    await mkdir(join(root, '.agents/skills/new'), { recursive: true });
    await writeFile(join(root, 'dab.yaml'), 'version: 2\n');

    const code = await runInit(
      { cwd: join(root, '.agents/skills/new'), json: true },
      capture().io,
    );

    expect(code).toBe(3);
    expect(await lstatOrNull(join(root, '.agents/skills/new/AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(root, '.agents/skills/new/dab.yaml'))).toBeNull();
  });

  it('refuses to init inside an existing project .agents tree without a manifest', async () => {
    const root = await makeTempDir('dab-init-nested-');
    dirs.push(root);
    await mkdir(join(root, '.agents/skills/new'), { recursive: true });

    const code = await runInit(
      { cwd: join(root, '.agents/skills/new'), json: true },
      capture().io,
    );

    expect(code).toBe(3);
    expect(await lstatOrNull(join(root, '.agents/skills/new/AGENTS.md'))).toBeNull();
  });

  it('refuses init through a symlinked parent into an existing project source root', async () => {
    const project = await tempDir('dab-init-symlink-parent-');
    await mkdir(join(project, '.agents/skills'), { recursive: true });
    await writeFile(join(project, 'dab.yaml'), 'version: 2\n');
    const home = await tempDir('dab-init-symlink-alias-');
    const alias = join(home, 'alias');
    await symlink(join(project, '.agents/skills'), alias, 'dir');

    const pinned = ['AGENTS.md', 'dab.yaml', '.agents', '.claude', '.gitignore'];
    const missing = capture();
    const missingCode = await runInit(
      { cwd: home, path: 'alias/missing', home, json: true },
      missing.io,
    );

    expect(missingCode).toBe(3);
    const missingPayload = JSON.parse(missing.stdout.join('')) as {
      error: { code: string };
    };
    expect(missingPayload.error.code).toBe('config.source-root-nested');
    for (const relative of pinned) {
      expect(await lstatOrNull(join(project, '.agents/skills/missing', relative)), relative)
        .toBeNull();
    }

    await mkdir(join(project, '.agents/skills/existing'), { recursive: true });
    const existing = capture();
    const existingCode = await runInit(
      { cwd: home, path: 'alias/existing', home, json: true },
      existing.io,
    );

    expect(existingCode).toBe(3);
    const existingPayload = JSON.parse(existing.stdout.join('')) as {
      error: { code: string };
    };
    expect(existingPayload.error.code).toBe('config.source-root-nested');
    for (const relative of pinned) {
      expect(await lstatOrNull(join(project, '.agents/skills/existing', relative)), relative)
        .toBeNull();
    }
  });

  it('refuses global init at $HOME when $HOME is already a project root', async () => {
    const home = await tempDir('dab-home-overlap-');
    const projectCode = await runInit(
      { cwd: home, home, runner: goodRunner, json: true },
      capture().io,
    );
    expect(projectCode).toBe(0);
    expect(await lstatOrNull(join(home, 'dab.yaml'))).not.toBeNull();

    const captureResult = capture();
    const code = await runInit(
      { cwd: home, path: '.agents', home, runner: goodRunner, json: true },
      captureResult.io,
    );

    expect(code).toBe(3);
    const payload = JSON.parse(captureResult.stdout.join('')) as {
      error: { code: string };
    };
    expect(payload.error.code).toBe('config.source-root-nested');
    expect(await lstatOrNull(join(home, '.agents/dab.yaml'))).toBeNull();
    expect(await lstatOrNull(join(home, '.agents/AGENTS.md'))).toBeNull();
  });

  it('rejects a legacy v1 global manifest before writing anything', async () => {
    const home = await tempDir('dab-home-init-');
    await mkdir(join(home, '.agents'), { recursive: true });
    await writeFile(join(home, '.agents/dab.yaml'), legacyManifest);
    const captureResult = capture();

    const code = await runInit(
      { cwd: home, path: '.agents', home, json: true },
      captureResult.io,
    );

    expect(code).toBe(2);
    const payload = JSON.parse(captureResult.stdout.join('')) as {
      error: { code: string };
    };
    expect(payload.error.code).toBe('config.manifest-legacy-global');
    expect(await readFile(join(home, '.agents/dab.yaml'), 'utf8')).toBe(legacyManifest);
    expect(await lstatOrNull(join(home, '.agents/AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(home, '.agents/agents'))).toBeNull();
    expect(await lstatOrNull(join(home, '.claude'))).toBeNull();
  });

  it('migrates an existing v1 project manifest through normalize', async () => {
    const root = await tempDir('dab-init-legacy-');
    await writeFile(join(root, 'dab.yaml'), legacyManifest);
    const captureResult = capture();

    const code = await runInit(
      { cwd: root, runner: goodRunner, json: true },
      captureResult.io,
    );

    expect(code).toBe(0);
    const payload = JSON.parse(captureResult.stdout.join('')) as {
      ok: boolean;
      scope: string;
      normalize: { ok: boolean; manifestUpdated: boolean };
    };
    expect(payload.ok).toBe(true);
    expect(payload.scope).toBe('project');
    expect(payload.normalize.ok).toBe(true);
    expect(payload.normalize.manifestUpdated).toBe(true);

    const loaded = await loadProjectManifest(root);
    expect(loaded.manifest.version).toBe(2);
    expect(loaded.manifest.scope).toBe('project');
    expect(loaded.manifest.targets[0]?.options.instructions).toBe('generated');
    expect(await readFile(join(root, 'dab.yaml'), 'utf8')).toContain('version: 2');
    expect((await lstatOrNull(join(root, '.claude/CLAUDE.md')))?.isFile()).toBe(true);
  });
});

describe('global detect safety', () => {
  it('does not flag user-level Claude data as a project artifact in global scope', async () => {
    const fixture = await makeGlobalFixture();
    dirs.push(fixture.home);
    await normalizeProject({
      cwd: fixture.agents,
      home: fixture.home,
      runner: goodRunner,
    });
    await mkdir(join(fixture.home, '.claude/projects'), { recursive: true });
    await writeFile(join(fixture.home, '.claude/projects/index.json'), '{}\n');

    const result = await detectProject({
      cwd: fixture.agents,
      home: fixture.home,
      runner: goodRunner,
    });

    expect(result.diagnostics.map((item) => item.code)).not.toContain(
      'memory.project-artifact',
    );
    expect(await lstatOrNull(join(fixture.home, '.claude/projects'))).not.toBeNull();
    expect(result.exitCode).toBe(0);
  });

  it('does not scan instruction files above HOME for global scope', async () => {
    const parent = await tempDir('dab-global-parent-');
    const fixture = await makeGlobalFixture();
    const home = join(parent, 'home');
    await rename(fixture.home, home);
    await writeFile(join(parent, 'CLAUDE.md'), '# ancestor\n');

    await normalizeProject({
      cwd: join(home, '.agents'),
      home,
      runner: goodRunner,
    });
    const result = await detectProject({
      cwd: join(home, '.agents'),
      home,
      runner: goodRunner,
    });

    expect(result.diagnostics.map((item) => item.code)).not.toContain('claude-md.ancestor');
    expect(result.exitCode).toBe(0);
  });
});
