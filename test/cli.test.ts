import { describe, expect, it } from 'vitest';
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
  it('prints the package version', async () => {
    const { ctx, stdout } = capture();

    await expect(runCli(['--version'], ctx)).resolves.toBe(0);
    expect(stdout.join('')).toContain('0.1.0');
  });

  it('lists the v0.1 commands in help', async () => {
    const { ctx, stdout } = capture();

    await expect(runCli(['--help'], ctx)).resolves.toBe(0);
    const help = stdout.join('');
    expect(help).toContain('init');
    expect(help).toContain('detect');
    expect(help).toContain('normalize');
    expect(help).toContain('policy explain');
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
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe('usage.unknown-command');
    expect(payload.error.message).toContain('wat');
  });

  it('rejects unsupported init profiles before writing anything', async () => {
    const { ctx, stderr } = capture();

    await expect(runCli(['init', '--profile', 'nope'], ctx)).resolves.toBe(2);
    expect(stderr.join('')).toContain('feature');
  });
});
