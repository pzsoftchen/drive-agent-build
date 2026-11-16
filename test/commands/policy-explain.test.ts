import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { runPolicyExplain } from '../../src/commands/policy-explain.ts';
import type { CommandRunner } from '../../src/core/command.ts';
import { makeInitializedProject } from '../helpers/initialized.ts';
import { writeProjectFile, type ProjectFixture } from '../helpers/project.ts';

const projects: ProjectFixture[] = [];

async function initialized(): Promise<ProjectFixture> {
  const project = await makeInitializedProject();
  projects.push(project);
  return project;
}

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    },
  };
}

const goodRunner: CommandRunner = async () => ({
  stdout: '2.1.325 (Claude Code)\n',
  stderr: '',
  exitCode: 0,
});

const missingRunner: CommandRunner = async () => {
  throw new Error('ENOENT');
};

const oldRunner: CommandRunner = async () => ({
  stdout: '2.1.100 (Claude Code)\n',
  stderr: '',
  exitCode: 0,
});

async function addHookedAgent(project: ProjectFixture): Promise<void> {
  await writeProjectFile(
    project.root,
    '.agents/agents/hooked.md',
    `---
name: hooked
description: Runs an appended agent hook.
tools: Read, Grep
hooks:
  PreToolUse:
    - matcher: Bash
      hooks:
        - type: command
          command: 'node "\${CLAUDE_PROJECT_DIR}/.agents/hooks/protect-generated/run.mjs"'
          timeout: 10
          id: agent-check
---
You are hooked.
`,
  );
}

afterEach(async () => {
  await Promise.all(projects.splice(0).map((item) => rm(item.root, { recursive: true, force: true })));
});

describe('runPolicyExplain', () => {
  it('explains an agent policy in human-readable form', async () => {
    const project = await initialized();
    const captureResult = capture();

    const code = await runPolicyExplain(
      {
        cwd: project.root,
        agent: 'reviewer',
        json: false,
        runner: goodRunner,
      },
      captureResult.io,
    );

    expect(code).toBe(0);
    const text = captureResult.stdout.join('');
    expect(text).toContain('reviewer');
    expect(text).toContain('Read');
    expect(text).toContain('WebFetch');
    expect(text).toContain('protect-generated');
    expect(text).toContain('Bash can read and write files');
  });

  it('emits machine-readable effective policy and runtime', async () => {
    const project = await initialized();
    const captureResult = capture();

    const code = await runPolicyExplain(
      {
        cwd: project.root,
        agent: 'reviewer',
        json: true,
        runner: goodRunner,
      },
      captureResult.io,
    );

    expect(code).toBe(0);
    const payload = JSON.parse(captureResult.stdout.join('')) as {
      ok: boolean;
      effective: {
        permissions: { deny: string[]; ask: string[] };
        hooks: Array<{ id: string; scope: string }>;
        limitations: string[];
      };
      agent: { name: string; tools: string[]; disallowedTools: string[] };
      runtime: { installed: boolean; version: string; compatible: boolean; minimum: string };
    };
    expect(payload.ok).toBe(true);
    expect(payload.effective.permissions.deny).toContain('Read(./.env)');
    expect(payload.effective.permissions.ask).toContain('Bash(git push:*)');
    expect(payload.effective.hooks.map((hook) => hook.id)).toContain('protect-generated');
    expect(payload.agent).toMatchObject({
      name: 'reviewer',
      tools: ['Read', 'Grep', 'Glob'],
    });
    expect(payload.runtime).toMatchObject({
      installed: true,
      version: '2.1.325',
      compatible: true,
      minimum: '2.1.277',
    });
    expect(payload.effective.limitations.join(' ')).toContain('Bash can read');
  });

  it('orders project hooks before appended agent hooks', async () => {
    const project = await initialized();
    await addHookedAgent(project);
    const captureResult = capture();

    const code = await runPolicyExplain(
      {
        cwd: project.root,
        agent: 'hooked',
        json: true,
        runner: goodRunner,
      },
      captureResult.io,
    );

    expect(code).toBe(0);
    const payload = JSON.parse(captureResult.stdout.join('')) as {
      effective: { hooks: Array<{ id: string; scope: string }> };
    };
    expect(payload.effective.hooks.map((hook) => hook.scope)).toEqual(['project', 'agent']);
    expect(payload.effective.hooks[1]?.id).toBe('agent-check');
  });

  it('fails with validation 3 on duplicate hook ids', async () => {
    const project = await initialized();
    await writeProjectFile(
      project.root,
      '.agents/agents/duplicate.md',
      `---
name: duplicate
description: Duplicates a project hook id.
hooks:
  PreToolUse:
    - matcher: Bash
      hooks:
        - type: command
          command: 'node "\${CLAUDE_PROJECT_DIR}/.agents/hooks/protect-generated/run.mjs"'
          id: protect-generated
---
Duplicate.
`,
    );
    const captureResult = capture();

    const code = await runPolicyExplain(
      {
        cwd: project.root,
        agent: 'duplicate',
        json: true,
        runner: goodRunner,
      },
      captureResult.io,
    );

    expect(code).toBe(3);
    const payload = JSON.parse(captureResult.stdout.join('')) as {
      ok: boolean;
      diagnostics: Array<{ code: string }>;
    };
    expect(payload.ok).toBe(false);
    expect(payload.diagnostics.map((item) => item.code)).toContain('hook.duplicate-id');
  });

  it('fails with usage 2 for an unknown agent', async () => {
    const project = await initialized();
    const captureResult = capture();

    const code = await runPolicyExplain(
      {
        cwd: project.root,
        agent: 'missing',
        json: true,
        runner: goodRunner,
      },
      captureResult.io,
    );

    expect(code).toBe(2);
    const payload = JSON.parse(captureResult.stdout.join('')) as {
      error: { code: string };
    };
    expect(payload.error.code).toBe('usage.unknown-agent');
  });

  it('explains policies when Claude Code is missing', async () => {
    const project = await initialized();
    const captureResult = capture();

    const code = await runPolicyExplain(
      {
        cwd: project.root,
        json: true,
        runner: missingRunner,
      },
      captureResult.io,
    );

    expect(code).toBe(0);
    const payload = JSON.parse(captureResult.stdout.join('')) as {
      runtime: { installed: boolean; compatible: boolean };
      effective: { permissions: { deny: string[] } };
      agent?: unknown;
    };
    expect(payload.runtime.installed).toBe(false);
    expect(payload.runtime.compatible).toBe(false);
    expect(payload.agent).toBeUndefined();
    expect(payload.effective.permissions.deny.length).toBeGreaterThan(0);
  });

  it('returns backend 4 when the installed version is too old', async () => {
    const project = await initialized();
    const captureResult = capture();

    const code = await runPolicyExplain(
      {
        cwd: project.root,
        json: true,
        runner: oldRunner,
      },
      captureResult.io,
    );

    expect(code).toBe(4);
    const payload = JSON.parse(captureResult.stdout.join('')) as {
      diagnostics: Array<{ code: string }>;
    };
    expect(payload.diagnostics.map((item) => item.code)).toContain('backend.version');
  });

  it('fails with validation 3 for memory: project', async () => {
    const project = await initialized();
    await writeProjectFile(
      project.root,
      '.agents/agents/mem.md',
      '---\nname: mem\ndescription: Mem.\nmemory: project\n---\nBody.\n',
    );
    const captureResult = capture();

    const code = await runPolicyExplain(
      {
        cwd: project.root,
        agent: 'mem',
        json: true,
        runner: goodRunner,
      },
      captureResult.io,
    );

    expect(code).toBe(3);
    const payload = JSON.parse(captureResult.stdout.join('')) as {
      diagnostics: Array<{ code: string }>;
    };
    expect(payload.diagnostics.map((item) => item.code)).toContain('agent.memory-project');
  });
});
