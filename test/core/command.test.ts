import { describe, expect, it } from 'vitest';
import { runCommand } from '../../src/core/command.ts';

describe('runCommand', () => {
  it('captures stdout and a zero exit code', async () => {
    const result = await runCommand(process.execPath, ['-e', 'console.log("hello")']);
    expect(result.stdout).toBe('hello\n');
    expect(result.exitCode).toBe(0);
  });

  it('captures a non-zero exit code', async () => {
    const result = await runCommand(process.execPath, ['-e', 'process.exit(3)']);
    expect(result.exitCode).toBe(3);
  });

  it('passes stdin input', async () => {
    const result = await runCommand(
      process.execPath,
      ['-e', 'process.stdout.write(require("fs").readFileSync(0, "utf8"))'],
      { input: 'from-stdin' },
    );
    expect(result.stdout).toBe('from-stdin');
  });

  it('rejects when the command cannot be spawned', async () => {
    await expect(runCommand('dab-command-that-does-not-exist', [])).rejects.toThrow();
  });

  it('times out a hanging command', async () => {
    const result = await runCommand(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 5000)'],
      { timeoutMs: 100 },
    );
    expect(result.exitCode).toBe(124);
  });

  it('does not crash when the child closes stdin before the parent writes', async () => {
    const result = await runCommand(
      process.execPath,
      ['-e', 'process.stdin.destroy(); process.exit(0)'],
      { input: 'x'.repeat(1024 * 1024) },
    );
    expect(result.exitCode).toBe(0);
  });
});
