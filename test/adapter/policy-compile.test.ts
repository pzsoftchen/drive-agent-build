import { describe, expect, it } from 'vitest';
import { compilePolicy } from '../../src/adapter/claude-code/policy-compile.ts';
import { buildHookCommand, mapHookEvent } from '../../src/adapter/claude-code/hooks.ts';
import { renderSettings, renderSettingsObject } from '../../src/adapter/claude-code/settings.ts';
import {
  ClaudeCodePolicySchema,
  HookSpecSchema,
  PolicySpecSchema,
} from '../../src/model/schemas.ts';
import type {
  AgentDefinition,
  ClaudeCodePolicy,
  HookSpec,
  LoadedHook,
  PolicySpec,
} from '../../src/model/types.ts';

function projectPolicy(overrides: Record<string, unknown> = {}): PolicySpec {
  return PolicySpecSchema.parse({ version: 1, ...overrides });
}

function adapterPolicy(overrides: Record<string, unknown> = {}): ClaudeCodePolicy {
  return ClaudeCodePolicySchema.parse({
    version: 1,
    provider: 'claude-code',
    ...overrides,
  });
}

function loadedHook(
  id = 'protect-generated',
  entry = 'run.mjs',
  event: HookSpec['event'] = 'pre_tool',
): LoadedHook {
  return {
    spec: HookSpecSchema.parse({ id, event, entry, timeout: 10, order: 10 }),
    dir: `.agents/hooks/${id}`,
    entryPath: `/project/.agents/hooks/${id}/${entry}`,
    metadataPath: `.agents/hooks/${id}/hook.yaml`,
  };
}

function agentDefinition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    file: '.agents/agents/reviewer.md',
    name: 'reviewer',
    description: 'Reviews changes.',
    tools: [],
    disallowedTools: [],
    hooks: [],
    body: 'You review.',
    frontmatter: { name: 'reviewer', description: 'Reviews changes.' },
    ...overrides,
  };
}

describe('compilePolicy', () => {
  it('maps neutral restrictions to Claude Code permission rules', () => {
    const result = compilePolicy(
      projectPolicy({
        read: { deny: ['.env', 'secrets/**'] },
        write: { deny: ['.claude/settings.json'] },
        execute: { deny: ['sudo'], ask: ['git push'] },
        capabilities: { deny: ['web', 'notebook'] },
      }),
      adapterPolicy(),
      [],
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.effective.permissions.deny).toEqual(
      [
        'Bash(sudo:*)',
        'Edit(./.claude/settings.json)',
        'NotebookEdit',
        'Read(./.env)',
        'Read(./secrets/**)',
        'WebFetch',
        'Write(./.claude/settings.json)',
      ].sort(),
    );
    expect(result.effective.permissions.ask).toEqual(['Bash(git push:*)']);
    expect(result.effective.permissions.allow).toEqual([]);
    expect(result.effective.permissions.disableBypassPermissionsMode).toBe('disable');
  });

  it('appends adapter rules and sorts every list', () => {
    const result = compilePolicy(
      projectPolicy({ execute: { ask: ['git push'] } }),
      adapterPolicy({
        permissions: {
          allow: ['Bash(pnpm test:*)', 'Read(./src/**)'],
          ask: ['Bash(npm publish:*)'],
          deny: ['Bash(git reset --hard:*)'],
        },
      }),
      [],
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.effective.permissions.allow).toEqual([
      'Bash(pnpm test:*)',
      'Read(./src/**)',
    ]);
    expect(result.effective.permissions.ask).toEqual([
      'Bash(git push:*)',
      'Bash(npm publish:*)',
    ]);
    expect(result.effective.permissions.deny).toEqual(['Bash(git reset --hard:*)']);
  });

  it('reports an exact rule conflict between project deny and adapter allow', () => {
    const result = compilePolicy(
      projectPolicy({ execute: { deny: ['git push'] } }),
      adapterPolicy({ permissions: { allow: ['Bash(git push:*)'] } }),
      [],
    );

    const conflict = result.diagnostics.find((item) => item.code === 'policy.conflict');
    expect(conflict).toBeDefined();
    expect(conflict?.message).toContain('.agents/policies/project.yaml');
    expect(conflict?.message).toContain('.agents/adapters/claude-code.yaml');
  });

  it.each(['auto', 'bypassPermissions'])('rejects unsafe project mode %s', (mode) => {
    const policy = projectPolicy();
    (policy as { defaultMode: string }).defaultMode = mode;
    const result = compilePolicy(policy, adapterPolicy(), []);
    expect(result.diagnostics.map((item) => item.code)).toContain('policy.invalid-mode');
  });

  it('rejects memory: project and bypassPermissions on an agent', () => {
    const result = compilePolicy(
      projectPolicy(),
      adapterPolicy(),
      [],
      agentDefinition({ memory: 'project', permissionMode: 'bypassPermissions' }),
    );

    expect(result.diagnostics.map((item) => item.code)).toContain('agent.memory-project');
    expect(result.diagnostics.map((item) => item.code)).toContain('agent.permission-mode');
  });

  it('maps neutral hook events and defaults the post_edit matcher', () => {
    const result = compilePolicy(
      projectPolicy(),
      adapterPolicy(),
      [loadedHook('format', 'format.mjs', 'post_edit')],
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.effective.hooks[0]).toMatchObject({
      id: 'format',
      event: 'PostToolUse',
      matcher: 'Edit|Write|MultiEdit',
      command: 'node "${CLAUDE_PROJECT_DIR}/.agents/hooks/format/format.mjs"',
      timeout: 10,
      scope: 'project',
    });
  });

  it('rejects a hook entry that escapes its hook directory', () => {
    const hook = loadedHook();
    hook.spec.entry = '../outside.mjs';
    const result = compilePolicy(projectPolicy(), adapterPolicy(), [hook]);
    expect(result.diagnostics.map((item) => item.code)).toContain('hook.entry');
  });

  it('rejects duplicate hook ids between project and agent hooks', () => {
    const result = compilePolicy(
      projectPolicy(),
      adapterPolicy(),
      [loadedHook('protect-generated')],
      agentDefinition({
        hooks: [
          {
            id: 'protect-generated',
            event: 'PreToolUse',
            command: 'node "${CLAUDE_PROJECT_DIR}/.agents/hooks/protect-generated/run.mjs"',
            source: '.agents/agents/reviewer.md',
          },
        ],
      }),
    );

    expect(result.diagnostics.map((item) => item.code)).toContain('hook.duplicate-id');
  });

  it('includes agent hooks in the effective explanation but not in project settings', () => {
    const result = compilePolicy(
      projectPolicy(),
      adapterPolicy(),
      [loadedHook('protect-generated')],
      agentDefinition({
        hooks: [
          {
            id: 'agent-check',
            event: 'PreToolUse',
            command: 'node "${CLAUDE_PROJECT_DIR}/.agents/hooks/protect-generated/run.mjs"',
            source: '.agents/agents/reviewer.md',
          },
        ],
      }),
    );

    expect(result.effective.hooks.map((item) => item.scope)).toContain('agent');
    const settings = renderSettings(result.effective);
    expect(settings).toContain('protect-generated');
    expect(settings).not.toContain('agent-check');
  });

  it('rejects and omits agent hooks that are not managed project hook commands', () => {
    const result = compilePolicy(
      projectPolicy(),
      adapterPolicy(),
      [loadedHook('protect-generated')],
      agentDefinition({
        hooks: [
          {
            id: 'agent-check',
            event: 'PreToolUse',
            command: 'sh -c "touch /tmp/dab-agent-hook-pwned"',
            source: '.agents/agents/reviewer.md',
          },
        ],
      }),
    );

    expect(result.diagnostics.map((item) => item.code)).toContain('hook.agent-unmanaged');
    expect(result.effective.hooks.map((item) => item.id)).not.toContain('agent-check');
  });

  it('renders byte-identical settings with stable ordering', () => {
    const result = compilePolicy(
      projectPolicy({
        read: { deny: ['secrets/**', '.env'] },
        execute: { ask: ['npm publish', 'git push'] },
      }),
      adapterPolicy({ permissions: { allow: ['Read(./src/**)', 'Bash(pnpm test:*)'] } }),
      [loadedHook('z-hook', 'z.mjs', 'pre_tool'), loadedHook('a-hook', 'a.mjs', 'session_start')],
    );

    const first = renderSettings(result.effective);
    const second = renderSettings(result.effective);
    expect(first).toBe(second);
    expect(first.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(first) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(parsed.hooks.PreToolUse?.[0]?.hooks[0]?.command).toBe(
      'node "${CLAUDE_PROJECT_DIR}/.agents/hooks/z-hook/z.mjs"',
    );
    expect(renderSettingsObject(result.effective)).toMatchSnapshot();
  });
});

describe('adapter hook mapping', () => {
  it.each([
    ['session_start', 'SessionStart'],
    ['session_end', 'SessionEnd'],
    ['pre_tool', 'PreToolUse'],
    ['post_tool', 'PostToolUse'],
    ['post_edit', 'PostToolUse'],
    ['user_prompt', 'UserPromptSubmit'],
    ['agent_stop', 'Stop'],
    ['subagent_stop', 'SubagentStop'],
    ['pre_compact', 'PreCompact'],
    ['notification', 'Notification'],
  ] as const)('maps %s to %s', (neutral, claude) => {
    expect(mapHookEvent(neutral)).toBe(claude);
  });

  it('builds node and exec commands from stable hook paths', () => {
    const nodeHook = loadedHook('protect-generated', 'run.mjs');
    expect(buildHookCommand(nodeHook)).toBe(
      'node "${CLAUDE_PROJECT_DIR}/.agents/hooks/protect-generated/run.mjs"',
    );

    const execHook = loadedHook('shell-hook', 'run.sh');
    execHook.spec.runner = 'exec';
    expect(buildHookCommand(execHook)).toBe(
      '"${CLAUDE_PROJECT_DIR}/.agents/hooks/shell-hook/run.sh"',
    );
  });
});
