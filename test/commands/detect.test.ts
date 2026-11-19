import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { detectProject, runDetect } from '../../src/commands/detect.ts';
import { normalizeProject } from '../../src/commands/normalize.ts';
import type { CommandRunner } from '../../src/core/command.ts';
import { makeGlobalFixture } from '../helpers/global.ts';
import { populateProject } from '../helpers/initialized.ts';
import { makeInitializedProject } from '../helpers/initialized.ts';
import { makeProject, writeProjectFile, type ProjectFixture } from '../helpers/project.ts';
import { makeTempDir } from '../helpers/tmp.ts';

const projects: ProjectFixture[] = [];
const homes: string[] = [];

async function initialized(): Promise<ProjectFixture> {
  const project = await makeInitializedProject();
  projects.push(project);
  return project;
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

function detectOptions(project: ProjectFixture, runner: CommandRunner = goodRunner) {
  return {
    cwd: project.root,
    runner,
    home: dirname(project.root),
  };
}

afterEach(async () => {
  await Promise.all(projects.splice(0).map((item) => rm(item.root, { recursive: true, force: true })));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe('detectProject', () => {
  it('passes a clean initialized project', async () => {
    const project = await initialized();
    const result = await detectProject(detectOptions(project));

    expect(result.exitCode).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
    expect(result.targets.map((item) => item.provider)).toEqual(['claude-code']);
  });

  it('warns but does not fail when Claude Code is missing', async () => {
    const project = await initialized();
    const result = await detectProject(detectOptions(project, missingRunner));

    expect(result.exitCode).toBe(0);
    expect(
      result.diagnostics.some(
        (item) => item.code === 'backend.missing' && item.severity === 'warning',
      ),
    ).toBe(true);
  });

  it('returns backend exit code 4 when Claude Code is too old', async () => {
    const project = await initialized();
    const result = await detectProject(detectOptions(project, oldRunner));

    expect(result.exitCode).toBe(4);
    expect(result.diagnostics.map((item) => item.code)).toContain('backend.version');
  });

  it('flags an unmanaged root CLAUDE.md', async () => {
    const project = await initialized();
    await writeProjectFile(project.root, 'CLAUDE.md', '# user instructions\n');

    const result = await detectProject(detectOptions(project));

    expect(result.exitCode).toBe(3);
    expect(result.diagnostics.map((item) => item.code)).toContain('claude-md.unmanaged');
  });

  it('flags missing or drifted instructions', async () => {
    const project = await initialized();
    await rm(join(project.root, '.claude/CLAUDE.md'));
    const missing = await detectProject(detectOptions(project));
    expect(missing.diagnostics.map((item) => item.code)).toContain(
      'claude-md.instructions-missing',
    );

    await symlink('missing.md', join(project.root, '.claude/CLAUDE.md'));
    const drifted = await detectProject(detectOptions(project));
    expect(drifted.diagnostics.map((item) => item.code)).toContain(
      'claude-md.instructions-drift',
    );
  });

  it('warns about an ancestor CLAUDE.md', async () => {
    const project = await initialized();
    const parent = await makeTempDir('dab-ancestor-');
    const moved = join(parent, 'project');
    await rename(project.root, moved);
    try {
      await writeFile(join(parent, 'CLAUDE.md'), '# ancestor\n');
      const result = await detectProject({
        cwd: moved,
        runner: goodRunner,
        home: parent,
      });
      expect(result.exitCode).toBe(0);
      expect(
        result.diagnostics.some(
          (item) => item.code === 'claude-md.ancestor' && item.severity === 'warning',
        ),
      ).toBe(true);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('flags a broken projection symlink and a physical copy', async () => {
    const project = await initialized();
    const target = join(project.root, '.claude/agents/reviewer.md');
    await rm(target);
    await symlink('missing.md', target);
    const broken = await detectProject(detectOptions(project));
    expect(broken.diagnostics.map((item) => item.code)).toContain('projection.broken');

    await rm(target);
    await writeFile(target, 'physical copy\n');
    const physical = await detectProject(detectOptions(project));
    expect(physical.diagnostics.map((item) => item.code)).toContain('projection.physical-copy');
  });

  it('flags duplicate agent names and memory: project', async () => {
    const project = await initialized();
    await writeProjectFile(
      project.root,
      '.agents/agents/other.md',
      '---\nname: reviewer\ndescription: Other.\n---\nBody.\n',
    );
    await writeProjectFile(
      project.root,
      '.agents/agents/mem.md',
      '---\nname: mem\ndescription: Mem.\nmemory: project\n---\nBody.\n',
    );

    const result = await detectProject(detectOptions(project));

    expect(result.diagnostics.map((item) => item.code)).toContain('agent.duplicate-name');
    expect(result.diagnostics.map((item) => item.code)).toContain('agent.memory-project');
  });

  it('flags hand-edited settings as generated drift', async () => {
    const project = await initialized();
    await writeFile(join(project.root, '.claude/settings.json'), '{"permissions":{}}\n');

    const result = await detectProject(detectOptions(project));

    expect(result.exitCode).toBe(3);
    expect(result.diagnostics.map((item) => item.code)).toContain('generated.drift');
  });

  it('treats a stale manifest hash as a warning when generated bytes are correct', async () => {
    const project = await initialized();
    const path = join(project.root, 'dab.yaml');
    const text = await readFile(path, 'utf8');
    const updated = text.replace(
      /(settings:\n\s+path: \.claude\/settings\.json\n\s+sha256: )[a-f0-9]{64}/,
      `$1"${'0'.repeat(64)}"`,
    );
    expect(updated).not.toBe(text);
    await writeFile(path, updated);

    const result = await detectProject(detectOptions(project));

    expect(result.exitCode).toBe(0);
    expect(
      result.diagnostics.some(
        (item) => item.code === 'generated.manifest-stale' && item.severity === 'warning',
      ),
    ).toBe(true);
  });

  it('flags secrets in authored files', async () => {
    const project = await initialized();
    await writeProjectFile(
      project.root,
      '.agents/rules/leak.md',
      'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789\n',
    );

    const result = await detectProject(detectOptions(project));

    expect(result.diagnostics.map((item) => item.code)).toContain('secret.detected');
  });

  it('warns about an oversized AGENTS.md and flags a broken link', async () => {
    const project = await initialized();
    await writeFile(join(project.root, 'AGENTS.md'), `${'line\n'.repeat(201)}`);
    const oversized = await detectProject(detectOptions(project));
    expect(oversized.exitCode).toBe(0);
    expect(
      oversized.diagnostics.some(
        (item) => item.code === 'agents-md.too-large' && item.severity === 'warning',
      ),
    ).toBe(true);

    await writeFile(join(project.root, 'AGENTS.md'), '# Project\n[missing](docs/nope.md)\n');
    const broken = await detectProject(detectOptions(project));
    expect(broken.diagnostics.map((item) => item.code)).toContain('agents-md.broken-link');
  });

  it('flags agent memory artifacts in the repository', async () => {
    const project = await initialized();
    await mkdir(join(project.root, '.claude/agent-memory'), { recursive: true });
    const result = await detectProject(detectOptions(project));
    expect(result.diagnostics.map((item) => item.code)).toContain('memory.project-artifact');
  });

  it('flags unsafe hook scripts', async () => {
    const project = await initialized();
    await writeProjectFile(
      project.root,
      '.agents/hooks/protect-generated/hook.yaml',
      `id: protect-generated
event: pre_tool
matcher: Edit|Write
entry: run.sh
runner: exec
timeout: 10
order: 10
`,
    );
    await writeProjectFile(
      project.root,
      '.agents/hooks/protect-generated/run.sh',
      'echo hi\n',
    );

    const result = await detectProject(detectOptions(project));

    expect(result.diagnostics.map((item) => item.code)).toContain('hook.unsafe');
  });

  it('flags agent hooks that do not reference a managed project hook', async () => {
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

    const result = await detectProject(detectOptions(project));

    expect(result.exitCode).toBe(3);
    expect(result.diagnostics.map((item) => item.code)).toContain('hook.agent-unmanaged');
  });

  it('flags duplicate memory paragraphs', async () => {
    const project = await initialized();
    const body = 'The same durable fact appears in two shared memory entries.\n';
    await writeProjectFile(
      project.root,
      '.agents/memory/INDEX.md',
      '- [A](a.md)\n- [B](b.md)\n',
    );
    for (const [name, title] of [['a.md', 'A'], ['b.md', 'B']] as const) {
      await writeProjectFile(
        project.root,
        `.agents/memory/${name}`,
        `---\ntitle: ${title}\nsource: https://example.com/${title}\nreview_by: 2027-01-01\n---\n${body}`,
      );
    }

    const result = await detectProject(detectOptions(project));

    expect(result.diagnostics.map((item) => item.code)).toContain('memory.duplicate-paragraph');
  });

  it('flags an unmanaged .claude/CLAUDE.md without a generated manifest', async () => {
    const project = await makeProject();
    projects.push(project);
    await populateProject(project);
    await writeProjectFile(project.root, '.claude/CLAUDE.md', 'user memory\n');

    const result = await detectProject(detectOptions(project));

    expect(result.diagnostics.map((item) => item.code)).toContain('claude-md.unmanaged');
  });

  it('warns instead of failing for read-only global settings', async () => {
    const home = await makeGlobalFixture();
    homes.push(home.home);
    await normalizeProject({ cwd: home.agents, home: home.home, runner: goodRunner });
    const settings = join(home.home, '.claude/settings.json');
    const content = '{"permissions":{"allow":["Bash(echo)"]}}\n';
    await writeFile(settings, content);

    const result = await detectProject({
      cwd: home.agents,
      home: home.home,
      runner: goodRunner,
    });

    expect(result.exitCode).toBe(0);
    expect(
      result.diagnostics.some(
        (item) => item.code === 'claude-settings.global-not-adopted'
          && item.severity === 'warning',
      ),
    ).toBe(true);
    expect(result.diagnostics.map((item) => item.code)).not.toContain('generated.missing');
    expect(await readFile(settings, 'utf8')).toBe(content);
  });
});

describe('runDetect', () => {
  it('emits stable JSON and uses the configured exit codes', async () => {
    const project = await initialized();
    const first: string[] = [];
    const second: string[] = [];
    const code = await runDetect(
      { ...detectOptions(project), json: true },
      {
        stdout: (value) => first.push(value),
        stderr: () => undefined,
      },
    );
    await runDetect(
      { ...detectOptions(project), json: true },
      {
        stdout: (value) => second.push(value),
        stderr: () => undefined,
      },
    );

    expect(code).toBe(0);
    expect(first.join('')).toBe(second.join(''));
    const payload = JSON.parse(first.join('')) as {
      schemaVersion: number;
      ok: boolean;
      exitCode: number;
      diagnostics: unknown[];
      targets: Array<{ provider: string; statuses: unknown[] }>;
      summary: { errors: number; warnings: number };
    };
    expect(payload.schemaVersion).toBe(1);
    expect(payload.ok).toBe(true);
    expect(payload.exitCode).toBe(0);
    expect(Array.isArray(payload.diagnostics)).toBe(true);
    expect(payload.targets.map((item) => item.provider)).toEqual(['claude-code']);
    expect(payload.targets[0]?.statuses.length).toBeGreaterThan(0);
    expect(payload.summary.errors).toBe(0);

    await writeProjectFile(project.root, 'CLAUDE.md', '# user\n');
    const failing: string[] = [];
    const failingCode = await runDetect(
      { ...detectOptions(project), json: true },
      { stdout: (value) => failing.push(value), stderr: () => undefined },
    );
    expect(failingCode).toBe(3);
    expect((JSON.parse(failing.join('')) as { ok: boolean }).ok).toBe(false);
  });

  it('returns config exit code 2 for a missing manifest', async () => {
    const project = await makeProject();
    projects.push(project);
    const stdout: string[] = [];
    const code = await runDetect(
      { cwd: project.root, json: true, runner: goodRunner },
      { stdout: (value) => stdout.push(value), stderr: () => undefined },
    );

    expect(code).toBe(2);
    const payload = JSON.parse(stdout.join('')) as {
      schemaVersion: number;
      error: { code: string };
    };
    expect(payload.schemaVersion).toBe(1);
    expect(payload.error.code).toBe('config.missing');
  });

  it('rejects Windows with a versioned JSON error', async () => {
    const project = await makeProject();
    projects.push(project);
    const stdout: string[] = [];
    const code = await runDetect(
      { cwd: project.root, json: true, platform: 'win32', runner: goodRunner },
      { stdout: (value) => stdout.push(value), stderr: () => undefined },
    );

    expect(code).toBe(3);
    const payload = JSON.parse(stdout.join('')) as {
      schemaVersion: number;
      error: { code: string };
    };
    expect(payload.schemaVersion).toBe(1);
    expect(payload.error.code).toBe('platform.unsupported');
  });
});
