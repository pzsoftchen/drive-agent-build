import { describe, expect, it } from 'vitest';
import {
  ClaudeCodePolicySchema,
  HookSpecSchema,
  PolicySpecSchema,
} from '../../src/model/schemas.ts';

describe('policy schemas', () => {
  it('applies neutral policy defaults', () => {
    const parsed = PolicySpecSchema.parse({ version: 1 });
    expect(parsed.defaultMode).toBe('default');
    expect(parsed.read.deny).toEqual([]);
    expect(parsed.execute.ask).toEqual([]);
    expect(parsed.capabilities.deny).toEqual([]);
  });

  it('rejects unsafe project default modes at schema level', () => {
    expect(() => PolicySpecSchema.parse({ version: 1, defaultMode: 'auto' })).toThrow();
    expect(() =>
      PolicySpecSchema.parse({ version: 1, defaultMode: 'bypassPermissions' }),
    ).toThrow();
  });

  it('applies Claude Code adapter defaults', () => {
    const parsed = ClaudeCodePolicySchema.parse({ version: 1, provider: 'claude-code' });
    expect(parsed.permissions.disableBypassPermissionsMode).toBe('disable');
    expect(parsed.permissions.deny).toEqual([]);
  });

  it('validates hook metadata and defaults', () => {
    const parsed = HookSpecSchema.parse({
      id: 'protect-generated',
      event: 'pre_tool',
      entry: 'run.mjs',
    });
    expect(parsed.runner).toBe('node');
    expect(parsed.timeout).toBe(30);
    expect(parsed.order).toBe(100);
  });

  it('rejects duplicate-looking invalid hook ids', () => {
    expect(() =>
      HookSpecSchema.parse({ id: 'Bad_ID', event: 'pre_tool', entry: 'run.mjs' }),
    ).toThrow();
  });
});
