import type { CommandRunner } from '../../core/command.ts';
import type { Diagnostic } from '../../core/diagnostics.ts';
import { readClaudeVersion, type ClaudeVersionInfo } from '../../core/version-check.ts';

export interface ClaudeCodeCheck {
  info: ClaudeVersionInfo;
  diagnostics: Diagnostic[];
}

export async function checkClaudeCode(
  minVersion: string,
  runner?: CommandRunner,
): Promise<ClaudeCodeCheck> {
  const info = await readClaudeVersion(runner, minVersion);
  if (!info.installed) {
    return {
      info,
      diagnostics: [
        {
          code: 'backend.missing',
          severity: 'warning',
          message: 'Claude Code is not installed or is not on PATH',
          hint: `Install Claude Code >= ${minVersion} to run the projected configuration.`,
        },
      ],
    };
  }
  if (!info.compatible) {
    return {
      info,
      diagnostics: [
        {
          code: 'backend.version',
          severity: 'error',
          message: `Claude Code ${info.version ?? 'unknown'} is older than required ${minVersion}`,
          hint: 'Upgrade Claude Code. DAB will not modify your global installation.',
        },
      ],
    };
  }
  return { info, diagnostics: [] };
}
