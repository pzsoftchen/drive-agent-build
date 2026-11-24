import { afterEach, describe, expect, it } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { explainPolicy, runPolicyExplain } from '../../src/commands/policy-explain.ts';
import type { CommandRunner } from '../../src/core/command.ts';
import { makeGlobalFixture } from '../helpers/global.ts';
import { makeInitializedProject } from '../helpers/initialized.ts';
import { writeProjectFile, type ProjectFixture } from '../helpers/project.ts';

const projects: ProjectFixture[] = [];
const homes: string[] = [];

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
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
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
    expect(text).toContain('Target: claude-code');
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
      schemaVersion: number;
      ok: boolean;
      effective: {
        permissions: { deny: string[]; ask: string[] };
        hooks: Array<{ id: string; scope: string }>;
        limitations: string[];
      };
      agent: { name: string; tools: string[]; disallowedTools: string[] };
      runtime: { installed: boolean; version: string; compatible: boolean; minimum: string };
    };
    expect(payload.schemaVersion).toBe(1);
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

  it('shows all tools except disallowedTools when tools is omitted', async () => {
    const project = await initialized();
    await writeProjectFile(
      project.root,
      '.agents/agents/inherit-tools.md',
      `---
name: inherit-tools
description: Inherits all tools except Bash.
disallowedTools: Bash
---
Inherits tools.
`,
    );
    const captureResult = capture();

    const code = await runPolicyExplain(
      {
        cwd: project.root,
        agent: 'inherit-tools',
        json: true,
        runner: goodRunner,
      },
      captureResult.io,
    );

    expect(code).toBe(0);
    const payload = JSON.parse(captureResult.stdout.join('')) as {
      agent: {
        tools: string[];
        toolsMode: string;
        effectiveTools: string[];
        effectiveToolsExcluded: string[];
      };
    };
    expect(payload.agent).toMatchObject({
      tools: [],
      toolsMode: 'all',
      effectiveTools: ['*'],
      effectiveToolsExcluded: ['Bash'],
    });

    const human = capture();
    await runPolicyExplain(
      {
        cwd: project.root,
        agent: 'inherit-tools',
        runner: goodRunner,
      },
      human.io,
    );
    expect(human.stdout.join('')).toContain('effectiveTools: * except Bash');
  });

  it('applies disallowedTools to an explicit tool allowlist', async () => {
    const project = await initialized();
    await writeProjectFile(
      project.root,
      '.agents/agents/listed-tools.md',
      `---
name: listed-tools
description: Has a filtered tool list.
tools: Read, Grep
disallowedTools: Grep
---
Listed tools.
`,
    );
    const captureResult = capture();

    const code = await runPolicyExplain(
      {
        cwd: project.root,
        agent: 'listed-tools',
        json: true,
        runner: goodRunner,
      },
      captureResult.io,
    );

    expect(code).toBe(0);
    const payload = JSON.parse(captureResult.stdout.join('')) as {
      agent: {
        toolsMode: string;
        toolsExplicit: boolean;
        effectiveTools: string[];
        effectiveToolsExcluded: string[];
      };
    };
    expect(payload.agent).toMatchObject({
      toolsMode: 'list',
      toolsExplicit: false,
      effectiveTools: ['Read'],
      effectiveToolsExcluded: ['Grep'],
    });
  });

  it('treats an explicitly empty tools list as no tools', async () => {
    const project = await initialized();
    await writeProjectFile(
      project.root,
      '.agents/agents/empty-tools.md',
      `---
name: empty-tools
description: Has no tools.
tools: ""
---
No tools.
`,
    );
    const captureResult = capture();

    const code = await runPolicyExplain(
      {
        cwd: project.root,
        agent: 'empty-tools',
        json: true,
        runner: goodRunner,
      },
      captureResult.io,
    );

    expect(code).toBe(0);
    const payload = JSON.parse(captureResult.stdout.join('')) as {
      agent: { toolsMode: string; effectiveTools: string[] };
      diagnostics: Array<{ code: string; severity: string }>;
    };
    expect(payload.agent).toMatchObject({
      toolsMode: 'none',
      effectiveTools: [],
    });
    expect(payload.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'agent.tools-empty', severity: 'warning' }),
    ]));
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

  it('fails with validation 3 for an unmanaged agent hook command', async () => {
    const project = await initialized();
    await writeProjectFile(
      project.root,
      '.agents/agents/unsafe.md',
      `---
name: unsafe
description: Uses an unmanaged inline command.
hooks:
  PreToolUse:
    - matcher: Bash
      hooks:
        - type: command
          command: sh -c 'touch /tmp/dab-agent-hook-pwned'
          id: unsafe-hook
---
Unsafe.
`,
    );
    const captureResult = capture();

    const code = await runPolicyExplain(
      {
        cwd: project.root,
        agent: 'unsafe',
        json: true,
        runner: goodRunner,
      },
      captureResult.io,
    );

    expect(code).toBe(3);
    const payload = JSON.parse(captureResult.stdout.join('')) as {
      ok: boolean;
      diagnostics: Array<{ code: string }>;
      effective: { hooks: Array<{ id: string }> };
    };
    expect(payload.ok).toBe(false);
    expect(payload.diagnostics.map((item) => item.code)).toContain('hook.agent-unmanaged');
    expect(payload.effective.hooks.map((hook) => hook.id)).not.toContain('unsafe-hook');
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
      schemaVersion: number;
      error: { code: string };
    };
    expect(payload.schemaVersion).toBe(1);
    expect(payload.error.code).toBe('usage.unknown-agent');
  });

  it('rejects Windows with a versioned JSON error', async () => {
    const project = await initialized();
    const captureResult = capture();

    const code = await runPolicyExplain(
      {
        cwd: project.root,
        platform: 'win32',
        json: true,
        runner: goodRunner,
      },
      captureResult.io,
    );

    expect(code).toBe(3);
    const payload = JSON.parse(captureResult.stdout.join('')) as {
      schemaVersion: number;
      error: { code: string };
    };
    expect(payload.schemaVersion).toBe(1);
    expect(payload.error.code).toBe('platform.unsupported');
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

  it('notes that global settings are not managed in this phase', async () => {
    const project = await initialized();
    const local = await explainPolicy({ cwd: project.root, runner: goodRunner });
    expect(local.effective.limitations).not.toContain(
      'global settings are not managed in this phase',
    );

    const home = await makeGlobalFixture();
    homes.push(home.home);
    const global = await explainPolicy({
      cwd: home.agents,
      home: home.home,
      runner: goodRunner,
    });
    expect(global.effective.limitations).toContain(
      'global settings are not managed in this phase',
    );
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

describe('explainPolicy target selection', () => {
  it('selects a configured target and rejects an unsupported one', async () => {
    const project = await initialized();
    const claude = await explainPolicy({
      cwd: project.root,
      target: 'claude-code',
      runner: goodRunner,
    });
    expect(claude.target).toBe('claude-code');

    await expect(explainPolicy({
      cwd: project.root,
      target: 'dsh',
      runner: goodRunner,
    })).rejects.toMatchObject({ code: 'target.not-configured' });

    const path = join(project.root, 'dab.yaml');
    const text = await readFile(path, 'utf8');
    await writeFile(
      path,
      text.replace(
        '  - provider: claude-code\n    enabled: true\n',
        '  - provider: claude-code\n    enabled: true\n  - provider: codex\n    enabled: true\n',
      ),
    );
    await expect(explainPolicy({
      cwd: project.root,
      target: 'codex',
      runner: goodRunner,
    })).rejects.toMatchObject({ code: 'target.unsupported' });
  });

  it('defaults to the first enabled target', async () => {
    const project = await initialized();
    const result = await explainPolicy({ cwd: project.root, runner: goodRunner });

    expect(result.target).toBe('claude-code');
  });

  it('rejects a manifest with no enabled target', async () => {
    const project = await initialized();
    const path = join(project.root, 'dab.yaml');
    const text = await readFile(path, 'utf8');
    await writeFile(path, text.replace('enabled: true', 'enabled: false'));

    await expect(explainPolicy({ cwd: project.root, runner: goodRunner }))
      .rejects.toMatchObject({ code: 'target.none' });
  });

  it('reports a broken source parent as a governed path conflict', async () => {
    const project = await initialized();
    await rm(join(project.root, '.agents/hooks'), { recursive: true, force: true });
    await writeFile(join(project.root, '.agents/hooks'), 'not a directory\n');
    const captureResult = capture();

    const code = await runPolicyExplain(
      {
        cwd: project.root,
        home: dirname(project.root),
        json: true,
        runner: goodRunner,
      },
      captureResult.io,
    );

    expect(code).toBe(3);
    const payload = JSON.parse(captureResult.stdout.join('')) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe('path.conflict');
    expect(payload.error.message).toContain('.agents/hooks');
  });
});
