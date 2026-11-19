import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runInit } from '../../src/commands/init.ts';
import { normalizeProject } from '../../src/commands/normalize.ts';
import type { CommandRunner } from '../../src/core/command.ts';
import { lstatOrNull } from '../../src/core/fs-atomic.ts';
import {
  getGeneratedTarget,
  loadProjectManifest,
} from '../../src/model/project-manifest.ts';
import { makeTempDir } from '../helpers/tmp.ts';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await makeTempDir('dab-init-');
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

async function packageJson(root: string, name = 'demo-app'): Promise<void> {
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name, scripts: { test: 'vitest run', build: 'tsc' } }),
  );
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('runInit', () => {
  it('creates a full skeleton and normalized Claude Code outputs', async () => {
    const root = await tempDir();
    await packageJson(root);
    const captureResult = capture();

    const code = await runInit(
      { cwd: root, json: true },
      captureResult.io,
    );

    expect(code).toBe(0);
    const payload = JSON.parse(captureResult.stdout.join('')) as {
      schemaVersion: number;
      ok: boolean;
      scope: string;
      root: string;
      created: string[];
      normalize: { ok: boolean };
    };
    expect(payload.schemaVersion).toBe(1);
    expect(payload.ok).toBe(true);
    expect(payload.scope).toBe('project');
    expect(payload.root).toBe(root);
    expect(payload.created).toEqual(expect.arrayContaining(['AGENTS.md', 'dab.yaml']));
    expect(payload.normalize.ok).toBe(true);

    expect(await lstatOrNull(join(root, 'AGENTS.md'))).not.toBeNull();
    expect(await lstatOrNull(join(root, 'dab.yaml'))).not.toBeNull();
    expect((await lstatOrNull(join(root, '.claude/CLAUDE.md')))?.isSymbolicLink()).toBe(true);
    expect(await readlink(join(root, '.claude/CLAUDE.md'))).toBe('../AGENTS.md');
    expect(await lstatOrNull(join(root, '.claude/settings.json'))).not.toBeNull();
    expect(await readlink(join(root, '.claude/agents/implementer.md'))).toContain(
      '.agents/agents/implementer.md',
    );
    expect(await readlink(join(root, '.claude/skills/doc-sync'))).toContain(
      '.agents/skills/doc-sync',
    );
    expect(await lstatOrNull(join(root, '.claude/rules/testing.md'))).not.toBeNull();
    expect(await lstatOrNull(join(root, '.claude/settings.local.json'))).toBeNull();

    const manifest = await loadProjectManifest(root);
    expect(manifest.manifest.profile).toBe('feature');
    expect(manifest.manifest.scope).toBe('project');
    const generated = getGeneratedTarget(manifest.manifest, 'claude-code');
    expect(generated?.instructions?.mode).toBe('symlink');
    expect(generated?.projections.length ?? 0).toBeGreaterThan(0);
  });

  it('preserves an existing AGENTS.md', async () => {
    const root = await tempDir();
    await packageJson(root);
    await writeFile(join(root, 'AGENTS.md'), '# Custom project instructions\n');
    const captureResult = capture();

    const code = await runInit({ cwd: root, json: true }, captureResult.io);

    expect(code).toBe(0);
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe(
      '# Custom project instructions\n',
    );
    const payload = JSON.parse(captureResult.stdout.join('')) as { skipped: string[] };
    expect(payload.skipped).toContain('AGENTS.md');
  });

  it('writes authored files and leaves unmanaged settings pending', async () => {
    const root = await tempDir();
    await mkdir(join(root, '.claude'));
    await writeFile(join(root, '.claude/settings.json'), '{"permissions":{}}\n');
    const captureResult = capture();

    const code = await runInit({ cwd: root, json: true }, captureResult.io);

    expect(code).toBe(0);
    const payload = JSON.parse(captureResult.stdout.join('')) as {
      ok: boolean;
      dryRun: boolean;
      pending: Array<{ code: string }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.dryRun).toBe(false);
    expect(payload.pending.map((item) => item.code)).toContain('claude-settings.unmanaged');
    expect(await lstatOrNull(join(root, 'AGENTS.md'))).not.toBeNull();
    expect(await lstatOrNull(join(root, 'dab.yaml'))).not.toBeNull();
    expect(await lstatOrNull(join(root, '.agents'))).not.toBeNull();
    expect(await readFile(join(root, '.claude/settings.json'), 'utf8')).toBe(
      '{"permissions":{}}\n',
    );
    expect(await lstatOrNull(join(root, '.claude/CLAUDE.md'))).toBeNull();
  });

  it('aborts without writes on an unmanaged root CLAUDE.md', async () => {
    const root = await tempDir();
    await packageJson(root);
    await writeFile(join(root, 'CLAUDE.md'), '# user instructions\n');
    const captureResult = capture();

    const code = await runInit({ cwd: root, json: true }, captureResult.io);

    expect(code).toBe(3);
    expect(await lstatOrNull(join(root, 'AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(root, 'dab.yaml'))).toBeNull();
    expect(await readFile(join(root, 'CLAUDE.md'), 'utf8')).toBe('# user instructions\n');
  });

  it('writes authored files and leaves an unmanaged .claude/CLAUDE.md pending', async () => {
    const root = await tempDir();
    await packageJson(root);
    await mkdir(join(root, '.claude'));
    await writeFile(join(root, '.claude/CLAUDE.md'), 'user memory\n');
    const captureResult = capture();

    const code = await runInit({ cwd: root, json: true }, captureResult.io);

    expect(code).toBe(0);
    const payload = JSON.parse(captureResult.stdout.join('')) as {
      ok: boolean;
      pending: Array<{ code: string }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.pending.map((item) => item.code)).toContain('claude-md.unmanaged');
    expect(await lstatOrNull(join(root, 'AGENTS.md'))).not.toBeNull();
    expect(await lstatOrNull(join(root, 'dab.yaml'))).not.toBeNull();
    expect(await readFile(join(root, '.claude/CLAUDE.md'), 'utf8')).toBe('user memory\n');
  });

  it('previews without writing when --dry-run is used', async () => {
    const parent = await tempDir();
    const target = join(parent, 'new-project');
    const captureResult = capture();

    const code = await runInit(
      { cwd: parent, path: 'new-project', dryRun: true, json: true },
      captureResult.io,
    );

    expect(code).toBe(0);
    const payload = JSON.parse(captureResult.stdout.join('')) as {
      ok: boolean;
      dryRun: boolean;
      created: string[];
      pending: unknown[];
    };
    expect(payload.ok).toBe(true);
    expect(payload.dryRun).toBe(true);
    expect(payload.created).toEqual(expect.arrayContaining(['AGENTS.md', 'dab.yaml']));
    expect(payload.pending).toEqual([]);
    expect(await lstatOrNull(target)).toBeNull();
  });

  it('reports pending conflicts in --dry-run without writing', async () => {
    const root = await tempDir();
    await packageJson(root);
    await mkdir(join(root, '.claude'));
    await writeFile(join(root, '.claude/settings.json'), '{"permissions":{}}\n');
    const captureResult = capture();

    const code = await runInit({ cwd: root, dryRun: true, json: true }, captureResult.io);

    expect(code).toBe(0);
    const payload = JSON.parse(captureResult.stdout.join('')) as {
      dryRun: boolean;
      pending: Array<{ code: string }>;
    };
    expect(payload.dryRun).toBe(true);
    expect(payload.pending.map((item) => item.code)).toContain('claude-settings.unmanaged');
    expect(await lstatOrNull(join(root, 'AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(root, 'dab.yaml'))).toBeNull();
    expect(await readFile(join(root, '.claude/settings.json'), 'utf8')).toBe(
      '{"permissions":{}}\n',
    );
  });

  it('can be completed by normalize --fix after pending conflicts', async () => {
    const root = await tempDir();
    await packageJson(root);
    await mkdir(join(root, '.claude'));
    await writeFile(join(root, '.claude/settings.json'), '{"permissions":{}}\n');
    await runInit({ cwd: root }, capture().io);

    const normalized = await normalizeProject({
      cwd: root,
      fix: true,
      now: new Date('2026-11-16T12:00:00Z'),
    });

    expect(normalized.ok).toBe(true);
    expect(await readFile(join(root, '.claude/settings.json'), 'utf8')).not.toBe(
      '{"permissions":{}}\n',
    );
    expect(await lstatOrNull(join(root, '.claude/CLAUDE.md'))).not.toBeNull();
    expect(normalized.backups.some((item) => item.endsWith('.claude/settings.json'))).toBe(true);
    expect(normalized.backups.every((item) => item.startsWith('.dab/backups/'))).toBe(true);
    expect(normalized.gitignore.path).toBe('.gitignore');
  });

  it('rejects --ai with --dry-run', async () => {
    const root = await tempDir();
    const captureResult = capture();

    const code = await runInit(
      { cwd: root, ai: true, dryRun: true, json: true },
      captureResult.io,
    );

    expect(code).toBe(2);
    const payload = JSON.parse(captureResult.stdout.join('')) as {
      error: { code: string };
    };
    expect(payload.error.code).toBe('usage.ai-dry-run');
  });

  it('rejects an unsupported profile without writing', async () => {
    const root = await tempDir();
    const captureResult = capture();

    const code = await runInit(
      { cwd: root, profile: 'generic' as 'feature' },
      captureResult.io,
    );

    expect(code).toBe(2);
    expect(await lstatOrNull(join(root, 'AGENTS.md'))).toBeNull();
  });

  it('is idempotent', async () => {
    const root = await tempDir();
    await packageJson(root);
    await runInit({ cwd: root }, capture().io);
    const agents = await readFile(join(root, 'AGENTS.md'), 'utf8');
    const settings = await readFile(join(root, '.claude/settings.json'), 'utf8');
    const captureResult = capture();

    const code = await runInit({ cwd: root, json: true }, captureResult.io);

    expect(code).toBe(0);
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe(agents);
    expect(await readFile(join(root, '.claude/settings.json'), 'utf8')).toBe(settings);
    const payload = JSON.parse(captureResult.stdout.join('')) as { created: string[] };
    expect(payload.created).toEqual([]);
  });

  it('applies a confirmed AI proposal', async () => {
    const root = await tempDir();
    await packageJson(root);
    const proposal = {
      agentsMdAddition: '## AI rules\n\n- Prefer small diffs.\n',
      agents: [
        {
          name: 'ai-helper',
          description: 'Helps with scoped implementation work.',
          body: 'You help with scoped implementation work.',
        },
      ],
    };
    const runner: CommandRunner = async () => ({
      stdout: JSON.stringify({ result: JSON.stringify(proposal) }),
      stderr: '',
      exitCode: 0,
    });
    const captureResult = capture();

    const code = await runInit(
      {
        cwd: root,
        ai: true,
        json: true,
        runner,
        confirm: async () => true,
      },
      captureResult.io,
    );

    expect(code).toBe(0);
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toContain('## AI rules');
    expect(await lstatOrNull(join(root, '.agents/agents/ai-helper.md'))).not.toBeNull();
    const payload = JSON.parse(captureResult.stdout.join('')) as {
      ai: { applied: boolean };
    };
    expect(payload.ai.applied).toBe(true);
  });

  it('writes nothing when the AI proposal is declined', async () => {
    const root = await tempDir();
    await packageJson(root);
    const runner: CommandRunner = async () => ({
      stdout: JSON.stringify({
        result: JSON.stringify({ agentsMdAddition: 'note\n', agents: [] }),
      }),
      stderr: '',
      exitCode: 0,
    });
    const captureResult = capture();

    const code = await runInit(
      {
        cwd: root,
        ai: true,
        json: true,
        runner,
        confirm: async () => false,
      },
      captureResult.io,
    );

    expect(code).toBe(0);
    expect(await lstatOrNull(join(root, 'AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(root, 'dab.yaml'))).toBeNull();
    expect(await lstatOrNull(join(root, '.agents'))).toBeNull();
    const payload = JSON.parse(captureResult.stdout.join('')) as {
      ai: { applied: boolean };
    };
    expect(payload.ai.applied).toBe(false);
  });

  it('rejects invalid AI JSON without writing', async () => {
    const root = await tempDir();
    await packageJson(root);
    const runner: CommandRunner = async () => ({
      stdout: JSON.stringify({ result: 'not json' }),
      stderr: '',
      exitCode: 0,
    });
    const captureResult = capture();

    const code = await runInit(
      {
        cwd: root,
        ai: true,
        json: true,
        runner,
        confirm: async () => true,
      },
      captureResult.io,
    );

    expect(code).toBe(2);
    expect(await lstatOrNull(join(root, 'AGENTS.md'))).toBeNull();
    const payload = JSON.parse(captureResult.stdout.join('')) as {
      schemaVersion: number;
      error: { code: string };
    };
    expect(payload.schemaVersion).toBe(1);
    expect(payload.error.code).toBe('ai.invalid-proposal');
  });

  it('requires confirmation for AI init', async () => {
    const root = await tempDir();
    const captureResult = capture();
    const code = await runInit({ cwd: root, ai: true, json: true }, captureResult.io);
    expect(code).toBe(2);
    expect(await lstatOrNull(join(root, 'AGENTS.md'))).toBeNull();
    const payload = JSON.parse(captureResult.stdout.join('')) as {
      schemaVersion: number;
      error: { code: string };
    };
    expect(payload.schemaVersion).toBe(1);
    expect(payload.error.code).toBe('init.ai-confirmation-required');
  });

  it('aborts before writing when existing authored sources are invalid', async () => {
    const root = await tempDir();
    await packageJson(root);
    await mkdir(join(root, '.agents/agents'), { recursive: true });
    await writeFile(join(root, '.agents/agents/bad.md'), '---\nname: bad\n---\nBody.\n');
    const captureResult = capture();

    const code = await runInit({ cwd: root, json: true }, captureResult.io);

    expect(code).toBe(3);
    expect(await lstatOrNull(join(root, 'AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(root, 'dab.yaml'))).toBeNull();
  });

  it('supports an init path argument', async () => {
    const parent = await tempDir();
    const captureResult = capture();

    const code = await runInit(
      { cwd: parent, path: 'project', json: true },
      captureResult.io,
    );

    expect(code).toBe(0);
    expect(await lstatOrNull(join(parent, 'project/AGENTS.md'))).not.toBeNull();
    expect(await lstatOrNull(join(parent, 'project/dab.yaml'))).not.toBeNull();
  });
});
