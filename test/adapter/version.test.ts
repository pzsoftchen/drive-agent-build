import { describe, expect, it } from 'vitest';
import type { CommandRunner } from '../../src/core/command.ts';
import { checkClaudeCode } from '../../src/adapter/claude-code/version.ts';

function runnerReturning(stdout: string): CommandRunner {
  return async () => ({ stdout, stderr: '', exitCode: 0 });
}

describe('checkClaudeCode', () => {
  it('accepts a compatible version', async () => {
    const result = await checkClaudeCode('2.1.277', runnerReturning('2.1.325 (Claude Code)\n'));
    expect(result.info.compatible).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it('warns when Claude Code is not installed', async () => {
    const runner: CommandRunner = async () => {
      throw new Error('ENOENT');
    };
    const result = await checkClaudeCode('2.1.277', runner);
    expect(result.info.installed).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain('backend.missing');
    expect(result.diagnostics[0]?.severity).toBe('warning');
  });

  it('errors when the installed version is too old', async () => {
    const result = await checkClaudeCode('2.1.277', runnerReturning('2.1.100 (Claude Code)\n'));
    expect(result.info.compatible).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain('backend.version');
    expect(result.diagnostics[0]?.severity).toBe('error');
  });
});
