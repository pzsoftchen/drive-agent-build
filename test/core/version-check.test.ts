import { describe, expect, it } from 'vitest';
import type { CommandRunner } from '../../src/core/command.ts';
import { MIN_CLAUDE_CODE_VERSION, readClaudeVersion } from '../../src/core/version-check.ts';

function runnerReturning(stdout: string): CommandRunner {
  return async () => ({ stdout, stderr: '', exitCode: 0 });
}

describe('readClaudeVersion', () => {
  it('uses 2.1.277 as the v0.1 minimum', () => {
    expect(MIN_CLAUDE_CODE_VERSION).toBe('2.1.277');
  });

  it('parses a compatible installed version', async () => {
    const info = await readClaudeVersion(runnerReturning('2.1.325 (Claude Code)\n'));
    expect(info.installed).toBe(true);
    expect(info.compatible).toBe(true);
    expect(info.version).toBe('2.1.325');
    expect(info.minimum).toBe('2.1.277');
  });

  it('reports an old version as incompatible', async () => {
    const info = await readClaudeVersion(runnerReturning('2.1.100 (Claude Code)\n'));
    expect(info.installed).toBe(true);
    expect(info.compatible).toBe(false);
  });

  it('reports a missing CLI without throwing', async () => {
    const runner: CommandRunner = async () => {
      throw new Error('ENOENT');
    };
    const info = await readClaudeVersion(runner);
    expect(info.installed).toBe(false);
    expect(info.compatible).toBe(false);
  });
});
