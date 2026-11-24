import { relative } from 'node:path';
import type { Diagnostic } from '../core/diagnostics.ts';
import { lstatOrNull, readTextFile } from '../core/fs-atomic.ts';
import { toPosix } from '../core/paths.ts';
import { DiagnosticCodes } from './diagnostics-codes.ts';

export interface AgentsMdCheck {
  lineCount: number;
  diagnostics: Diagnostic[];
}

function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return text.replace(/\n$/, '').split('\n').length;
}

export async function checkAgentsMd(
  scopeRoot: string,
  instructions: string,
  maxLines = 200,
): Promise<AgentsMdCheck> {
  const file = toPosix(relative(scopeRoot, instructions));
  if ((await lstatOrNull(instructions)) === null) {
    return {
      lineCount: 0,
      diagnostics: [
        {
          code: DiagnosticCodes.agentsMdMissing,
          severity: 'warning',
          message: 'AGENTS.md is missing',
          file,
          hint: 'Run "dab init" or author AGENTS.md as the project instruction source.',
        },
      ],
    };
  }

  const text = await readTextFile(instructions);
  const lineCount = countLines(text);
  const diagnostics: Diagnostic[] = [];
  if (lineCount > maxLines) {
    diagnostics.push({
      code: DiagnosticCodes.agentsMdTooLarge,
      severity: 'warning',
      message: `AGENTS.md has ${lineCount} lines; the budget is ${maxLines}`,
      file,
      hint: 'Move long procedures into skills, architecture into docs, and durable facts into .agents/notes/ (optional advanced: .agents/memory/).',
    });
  }
  return { lineCount, diagnostics };
}
