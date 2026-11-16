import { runCommand, type CommandRunner } from './command.ts';
import { isVersionAtLeast, parseSemVer } from './semver.ts';

export const MIN_CLAUDE_CODE_VERSION = '2.1.277';

export interface ClaudeVersionInfo {
  installed: boolean;
  raw?: string;
  version?: string;
  minimum: string;
  compatible: boolean;
}

export async function readClaudeVersion(
  runner: CommandRunner = runCommand,
  minimum = MIN_CLAUDE_CODE_VERSION,
): Promise<ClaudeVersionInfo> {
  try {
    const result = await runner('claude', ['--version'], { timeoutMs: 5_000 });
    const raw = `${result.stdout}${result.stderr}`.trim();
    const parsed = parseSemVer(raw);
    const installed = result.exitCode === 0 && parsed !== null;
    return {
      installed,
      raw,
      ...(parsed === null
        ? {}
        : { version: `${parsed.major}.${parsed.minor}.${parsed.patch}` }),
      minimum,
      compatible: installed && parsed !== null && isVersionAtLeast(raw, minimum),
    };
  } catch {
    return {
      installed: false,
      minimum,
      compatible: false,
    };
  }
}
