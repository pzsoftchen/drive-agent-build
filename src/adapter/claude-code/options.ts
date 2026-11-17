import { z } from 'zod';
import { ConfigError } from '../../core/errors.ts';
import type { TargetConfig } from '../../model/types.ts';

export const ClaudeCodeTargetOptionsSchema = z
  .object({
    minVersion: z.string().regex(/^\d+\.\d+\.\d+$/).default('2.1.277'),
    instructions: z.enum(['symlink', 'generated', 'disabled']).default('symlink'),
  })
  .strict();

export type ClaudeCodeTargetOptions = z.infer<typeof ClaudeCodeTargetOptionsSchema>;

function zodMessage(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path.length === 0 ? issue.message : `${path}: ${issue.message}`;
    })
    .join('; ');
}

export function parseClaudeTargetOptions(target: TargetConfig): ClaudeCodeTargetOptions {
  if (target.provider !== 'claude-code') {
    throw new ConfigError(
      `invalid claude-code target options: target provider is ${target.provider}`,
      'target.invalid-options',
    );
  }
  const parsed = ClaudeCodeTargetOptionsSchema.safeParse(target.options);
  if (!parsed.success) {
    throw new ConfigError(
      `invalid claude-code target options: ${zodMessage(parsed.error)}`,
      'target.invalid-options',
    );
  }
  return parsed.data;
}
