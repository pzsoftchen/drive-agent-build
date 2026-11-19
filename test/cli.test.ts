import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCli } from '../src/cli.ts';

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    ctx: {
      cwd: process.cwd(),
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
      env: {},
    },
  };
}

describe('cli contract', () => {
  it('prints the package version from package.json', async () => {
    const { ctx, stdout } = capture();
    const pkg = JSON.parse(
      await readFile(join(process.cwd(), 'package.json'), 'utf8'),
    ) as { version: string };

    await expect(runCli(['--version'], ctx)).resolves.toBe(0);
    expect(stdout.join('').trim()).toBe(pkg.version);
  });

  it('rejects --json for help, version and commandless invocations', async () => {
    for (const argv of [['--help', '--json'], ['--version', '--json'], ['help', '--json'], ['--json']]) {
      const { ctx, stdout } = capture();

      await expect(runCli(argv, ctx)).resolves.toBe(2);
      const payload = JSON.parse(stdout.join('')) as {
        schemaVersion: number;
        error: { code: string };
      };
      expect(payload.schemaVersion).toBe(1);
      expect(payload.error.code).toMatch(/^usage\.json-/);
    }
  });

  it('emits a versioned internal error envelope', async () => {
    const { ctx, stdout } = capture();

    await expect(
      runCli(['detect', '--json'], { ...ctx, cwd: 42 as unknown as string }),
    ).resolves.toBe(1);
    const payload = JSON.parse(stdout.join('')) as {
      schemaVersion: number;
      error: { code: string };
    };
    expect(payload.schemaVersion).toBe(1);
    expect(payload.error.code).toBe('internal.error');
  });

  it('lists the v0.1 commands in help', async () => {
    const { ctx, stdout } = capture();

    await expect(runCli(['--help'], ctx)).resolves.toBe(0);
    const help = stdout.join('');
    expect(help).toContain('init');
    expect(help).toContain('detect');
    expect(help).toContain('normalize');
    expect(help).toContain('policy explain');
    expect(help).toContain('--target <provider>');
  });

  it('rejects an unknown command with a usage error', async () => {
    const { ctx, stderr } = capture();

    await expect(runCli(['wat'], ctx)).resolves.toBe(2);
    expect(stderr.join('')).toContain('unknown command');
  });

  it('emits a machine-readable error for unknown commands', async () => {
    const { ctx, stdout } = capture();

    await expect(runCli(['wat', '--json'], ctx)).resolves.toBe(2);
    const payload = JSON.parse(stdout.join('')) as {
      schemaVersion: number;
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(payload.schemaVersion).toBe(1);
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe('usage.unknown-command');
    expect(payload.error.message).toContain('wat');
  });

  it('rejects unsupported init profiles before writing anything', async () => {
    const { ctx, stderr } = capture();

    await expect(runCli(['init', '--profile', 'nope'], ctx)).resolves.toBe(2);
    expect(stderr.join('')).toContain('feature');
  });

  it('rejects an unknown policy target before reading the project', async () => {
    const { ctx, stderr } = capture();

    await expect(runCli(['policy', 'explain', '--target', 'wat'], ctx)).resolves.toBe(2);
    expect(stderr.join('')).toContain('unknown target');
  });
});
