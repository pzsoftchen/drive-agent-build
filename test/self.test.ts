import { beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runDetect } from '../src/commands/detect.ts';
import { normalizeProject } from '../src/commands/normalize.ts';
import { renderClaudeMdShim, discoverProjections } from '../src/adapter/claude-code/projection.ts';
import type { CommandRunner } from '../src/core/command.ts';
import { runCommand } from '../src/core/command.ts';
import { lstatOrNull } from '../src/core/fs-atomic.ts';
import { runDocSync } from '../src/docs/doc-sync.ts';
import { loadProjectManifest, resolveProjectPaths } from '../src/model/project-manifest.ts';

const root = process.cwd();
const fakeRunner: CommandRunner = async () => ({
  stdout: '2.1.325 (Claude Code)\n',
  stderr: '',
  exitCode: 0,
});

beforeAll(async () => {
  if (
    (await lstatOrNull(join(root, '.claude/settings.json'))) === null
    || (await lstatOrNull(join(root, '.claude/CLAUDE.md'))) === null
  ) {
    const result = await normalizeProject({ cwd: root });
    if (!result.ok) {
      throw new Error(
        `self-test normalize failed: ${result.diagnostics.map((item) => item.code).join(', ')}`,
      );
    }
  }
});

describe('DAB dogfood', () => {
  it('declares the feature profile', async () => {
    const loaded = await loadProjectManifest(root);
    expect(loaded.manifest.profile).toBe('feature');
    expect(loaded.manifest.target.provider).toBe('claude-code');
  });

  it('keeps AGENTS.md English-only and within budget', async () => {
    const path = join(root, 'AGENTS.md');
    expect(await lstatOrNull(path)).not.toBeNull();
    const text = await readFile(path, 'utf8');
    expect(text).not.toMatch(/[一-鿿]/);
    const lines = text.replace(/\n$/, '').split('\n').length;
    expect(lines).toBeLessThanOrEqual(200);
    expect(await lstatOrNull(join(root, 'CLAUDE.md'))).toBeNull();
  });

  it('generates the compatibility shim and ignores generated outputs', async () => {
    const shim = await readFile(join(root, '.claude/CLAUDE.md'), 'utf8');
    expect(shim).toBe(renderClaudeMdShim());
    const settingsIgnored = await runCommand(
      'git',
      ['check-ignore', '-q', '.claude/settings.json'],
      { cwd: root },
    );
    const shimIgnored = await runCommand(
      'git',
      ['check-ignore', '-q', '.claude/CLAUDE.md'],
      { cwd: root },
    );
    expect(settingsIgnored.exitCode).toBe(0);
    expect(shimIgnored.exitCode).toBe(0);
  });

  it('has valid agents, skills and rules', async () => {
    const loaded = await loadProjectManifest(root);
    const paths = resolveProjectPaths(root, loaded.manifest);
    const discovered = await discoverProjections(root, paths);
    expect(discovered.diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
    expect(discovered.projections.some((item) => item.kind === 'agent')).toBe(true);
    expect(discovered.projections.some((item) => item.kind === 'skill')).toBe(true);
    expect(discovered.projections.some((item) => item.kind === 'rule')).toBe(true);
  });

  it('passes the documentation gates', async () => {
    const result = await runDocSync(root);
    expect(result.diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('passes detect with no errors', async () => {
    const result = await runDetect(
      { cwd: root, json: true, runner: fakeRunner, home: dirname(root) },
      { stdout: () => undefined, stderr: () => undefined },
    );
    expect(result).toBe(0);
  });
});
