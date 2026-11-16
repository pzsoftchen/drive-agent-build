import { afterEach, describe, expect, it } from 'vitest';
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { renderClaudeMdShim } from '../src/adapter/claude-code/projection.ts';
import { detectProject } from '../src/commands/detect.ts';
import { runInit } from '../src/commands/init.ts';
import { normalizeProject, runNormalize } from '../src/commands/normalize.ts';
import type { CommandRunner } from '../src/core/command.ts';
import { lstatOrNull } from '../src/core/fs-atomic.ts';
import { parseFrontmatter } from '../src/model/frontmatter.ts';
import { discoverHooks } from '../src/model/hooks.ts';
import { loadProjectManifest } from '../src/model/project-manifest.ts';
import { AgentFrontmatterSchema } from '../src/model/schemas.ts';
import { makeInitializedProject, populateProject } from './helpers/initialized.ts';
import { makeProject, writeProjectFile, type ProjectFixture } from './helpers/project.ts';
import { makeTempDir } from './helpers/tmp.ts';

const projects: ProjectFixture[] = [];
const extraDirs: string[] = [];

async function initialized(): Promise<ProjectFixture> {
  const project = await makeInitializedProject();
  projects.push(project);
  return project;
}

async function freshPopulated(): Promise<ProjectFixture> {
  const project = await makeProject();
  projects.push(project);
  await populateProject(project);
  return project;
}

async function tempDir(prefix = 'dab-hardening-'): Promise<string> {
  const dir = await makeTempDir(prefix);
  extraDirs.push(dir);
  return dir;
}

const goodRunner: CommandRunner = async () => ({
  stdout: '2.1.325 (Claude Code)\n',
  stderr: '',
  exitCode: 0,
});

const oldRunner: CommandRunner = async () => ({
  stdout: '2.1.100 (Claude Code)\n',
  stderr: '',
  exitCode: 0,
});

const missingRunner: CommandRunner = async () => {
  throw new Error('ENOENT');
};

function detect(project: ProjectFixture, runner: CommandRunner = goodRunner) {
  return detectProject({
    cwd: project.root,
    runner,
    home: dirname(project.root),
  });
}

afterEach(async () => {
  await Promise.all(projects.splice(0).map((item) => rm(item.root, { recursive: true, force: true })));
  await Promise.all(extraDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('path and projection safety', () => {
  it('rejects a .claude symlink that overlaps the authored tree without deleting sources', async () => {
    const project = await initialized();
    await rm(join(project.root, '.claude'), { recursive: true, force: true });
    await symlink('.agents', join(project.root, '.claude'), 'dir');

    const result = await normalizeProject({ cwd: project.root, fix: true });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain('path.overlap');
    expect(await readFile(join(project.root, '.agents/agents/reviewer.md'), 'utf8')).toContain(
      'name: reviewer',
    );
    expect(await lstatOrNull(join(project.root, '.agents/settings.json'))).toBeNull();
  });

  it('rejects .claude/agents symlinked into the authored agents tree', async () => {
    const project = await initialized();
    await rm(join(project.root, '.claude/agents'), { recursive: true, force: true });
    await symlink('../.agents/agents', join(project.root, '.claude/agents'), 'dir');
    const settingsBefore = await readFile(join(project.root, '.claude/settings.json'), 'utf8');

    const result = await normalizeProject({ cwd: project.root, fix: true });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain('path.overlap');
    expect(await readFile(join(project.root, '.agents/agents/reviewer.md'), 'utf8')).toContain(
      'name: reviewer',
    );
    expect(await readFile(join(project.root, '.claude/settings.json'), 'utf8')).toBe(
      settingsBefore,
    );
  });

  it('rejects custom manifest paths in v0.1', async () => {
    const project = await freshPopulated();
    const text = await readFile(join(project.root, 'dab.yaml'), 'utf8');
    await writeFile(
      join(project.root, 'dab.yaml'),
      text.replace('claude: .claude', 'claude: custom-claude'),
    );

    await expect(loadProjectManifest(project.root)).rejects.toMatchObject({
      code: 'config.paths-unsupported',
    });
  });

  it.each(['policies', 'hooks', 'memory'])(
    'rejects a symlinked .agents/%s root that escapes the project',
    async (directory) => {
      const project = await initialized();
      const outside = await tempDir();
      await writeFile(join(outside, 'placeholder'), 'x\n');
      await rm(join(project.root, '.agents', directory), { recursive: true, force: true });
      await symlink(outside, join(project.root, '.agents', directory), 'dir');

      const result = await normalizeProject({ cwd: project.root });

      expect(result.ok).toBe(false);
      expect(result.diagnostics.map((item) => item.code)).toContain('path.symlink-escape');
      expect(await readdir(outside)).toEqual(['placeholder']);
    },
  );

  it('rejects symlinked authored source directories that escape the project', async () => {
    const project = await initialized();
    const outside = await tempDir();
    await writeFile(
      join(outside, 'reviewer.md'),
      '---\nname: outsider\ndescription: Outside.\n---\nOutside.\n',
    );
    await rm(join(project.root, '.agents/agents'), { recursive: true, force: true });
    await symlink(outside, join(project.root, '.agents/agents'), 'dir');

    const normalized = await normalizeProject({ cwd: project.root, fix: true });
    expect(normalized.ok).toBe(false);
    expect(normalized.diagnostics.map((item) => item.code)).toContain('path.symlink-escape');

    const detected = await detect(project);
    expect(detected.diagnostics.map((item) => item.code)).toContain('path.symlink-escape');
    expect(await readdir(outside)).toEqual(['reviewer.md']);
  });
});

describe('hook safety during discovery and normalize', () => {
  it('rejects hook entry names that could inject shell syntax', async () => {
    const project = await initialized();
    const hookDir = join(project.root, '.agents/hooks/protect-generated');
    const badName = 'run.mjs"; touch PWNED; #.mjs';
    await writeFile(join(hookDir, badName), 'process.exit(0);\n');
    await writeProjectFile(
      project.root,
      '.agents/hooks/protect-generated/hook.yaml',
      `id: protect-generated
event: pre_tool
matcher: Edit|Write
entry: ${JSON.stringify(badName)}
runner: node
timeout: 10
order: 10
`,
    );

    const discovered = await discoverHooks(project.root, join(project.root, '.agents'));
    expect(discovered.diagnostics.map((item) => item.code)).toContain('hook.invalid');

    const result = await normalizeProject({ cwd: project.root });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain('hook.invalid');
  });

  it('rejects hook entry symlinks that escape the hook directory', async () => {
    const project = await initialized();
    const outside = await tempDir();
    await writeFile(join(outside, 'evil.mjs'), 'process.exit(0);\n');
    await symlink(
      join(outside, 'evil.mjs'),
      join(project.root, '.agents/hooks/protect-generated/link.mjs'),
    );
    await writeProjectFile(
      project.root,
      '.agents/hooks/protect-generated/hook.yaml',
      `id: protect-generated
event: pre_tool
matcher: Edit|Write
entry: link.mjs
runner: node
timeout: 10
order: 10
`,
    );

    const result = await normalizeProject({ cwd: project.root });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain('hook.entry');
  });

  it('rejects secrets in hook scripts before normalize writes settings', async () => {
    const project = await freshPopulated();
    await writeProjectFile(
      project.root,
      '.agents/hooks/protect-generated/run.mjs',
      'const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";\nprocess.exit(0);\n',
    );

    const result = await normalizeProject({ cwd: project.root });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain('secret.detected');
    expect(await lstatOrNull(join(project.root, '.claude/settings.json'))).toBeNull();
  });

  it('detects secrets in exec hook entries regardless of extension', async () => {
    const project = await freshPopulated();
    await writeProjectFile(
      project.root,
      '.agents/hooks/protect-generated/hook.yaml',
      `id: protect-generated
event: pre_tool
matcher: Edit|Write
entry: run.py
runner: exec
timeout: 10
order: 10
`,
    );
    const script = join(project.root, '.agents/hooks/protect-generated/run.py');
    await writeFile(
      script,
      '#!/usr/bin/env python3\n# ghp_abcdefghijklmnopqrstuvwxyz0123456789\n',
    );
    await chmod(script, 0o755);

    const result = await detect(project);

    expect(result.diagnostics.map((item) => item.code)).toContain('secret.detected');
  });

  it('rejects agent hook ids that collide with project hooks in normalize and detect', async () => {
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

    const normalized = await normalizeProject({ cwd: project.root });
    expect(normalized.ok).toBe(false);
    expect(normalized.diagnostics.map((item) => item.code)).toContain('hook.duplicate-id');

    const detected = await detect(project);
    expect(detected.diagnostics.map((item) => item.code)).toContain('hook.duplicate-id');
  });
});

describe('shim and backend safety', () => {
  it('backs up a drifted managed shim before repairing it', async () => {
    const project = await initialized();
    const shim = join(project.root, '.claude/CLAUDE.md');
    await writeFile(shim, 'user drift\n');

    const result = await normalizeProject({
      cwd: project.root,
      now: new Date('2026-11-16T12:00:00Z'),
    });

    expect(result.ok).toBe(true);
    const backup = result.backups.find((item) => item.endsWith('.claude/CLAUDE.md'));
    expect(backup).toBeDefined();
    expect(await readFile(backup ?? '', 'utf8')).toBe('user drift\n');
    expect(await readFile(shim, 'utf8')).toBe(renderClaudeMdShim());
  });

  it('repairs a directory at the shim path with --fix', async () => {
    const project = await initialized();
    const shim = join(project.root, '.claude/CLAUDE.md');
    await rm(shim, { recursive: true, force: true });
    await mkdir(join(shim, 'sub'), { recursive: true });
    await writeFile(join(shim, 'sub/file.txt'), 'inside\n');

    const result = await normalizeProject({
      cwd: project.root,
      fix: true,
      now: new Date('2026-11-16T12:00:00Z'),
    });

    expect(result.ok).toBe(true);
    expect(await readFile(shim, 'utf8')).toBe(renderClaudeMdShim());
    expect(result.backups.some((item) => item.endsWith('.claude/CLAUDE.md'))).toBe(true);
  });

  it('classifies malformed policy as validation 3', async () => {
    const project = await freshPopulated();
    await writeProjectFile(
      project.root,
      '.agents/policies/project.yaml',
      'version: 1\ndefaultMode: auto\n',
    );
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runNormalize(
      { cwd: project.root, json: true },
      { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) },
    );

    expect(code).toBe(3);
    const payload = JSON.parse(stdout.join('')) as { error: { code: string } };
    expect(payload.error.code).toBe('policy.invalid');
    expect(await lstatOrNull(join(project.root, '.claude/settings.json'))).toBeNull();
  });

  it('returns backend 4 on an old Claude Code and warns when it is missing', async () => {
    const oldProject = await freshPopulated();
    const old = await normalizeProject({ cwd: oldProject.root, runner: oldRunner });
    expect(old.ok).toBe(false);
    expect(old.exitCode).toBe(4);
    expect(old.diagnostics.map((item) => item.code)).toContain('backend.version');
    expect(await lstatOrNull(join(oldProject.root, '.claude/settings.json'))).toBeNull();

    const missingProject = await freshPopulated();
    const missing = await normalizeProject({ cwd: missingProject.root, runner: missingRunner });
    expect(missing.ok).toBe(true);
    expect(missing.diagnostics.map((item) => item.code)).toContain('backend.missing');
  });
});

describe('init preflight and AI proposal hardening', () => {
  it('rejects a symlinked .claude/agents directory before writing authored files', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'demo' }));
    const outside = await tempDir();
    await mkdir(join(root, '.claude'), { recursive: true });
    await symlink(outside, join(root, '.claude/agents'), 'dir');

    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runInit(
      { cwd: root, json: true },
      { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) },
    );

    expect(code).toBe(3);
    expect(await lstatOrNull(join(root, 'AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(root, 'dab.yaml'))).toBeNull();
    expect(await readdir(outside)).toEqual([]);
  });

  it('rejects an existing invalid policy before writing authored files', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'demo' }));
    await mkdir(join(root, '.agents/policies'), { recursive: true });
    await writeFile(join(root, '.agents/policies/project.yaml'), 'version: 1\ndefaultMode: auto\n');

    const stdout: string[] = [];
    const code = await runInit(
      { cwd: root, json: true },
      { stdout: (value) => stdout.push(value), stderr: () => undefined },
    );

    expect(code).toBe(3);
    expect(await lstatOrNull(join(root, 'AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(root, 'dab.yaml'))).toBeNull();
  });

  it('serializes AI agent frontmatter safely and shows the proposal in JSON mode', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'demo' }));
    const proposal = {
      agentsMdAddition: '',
      agents: [
        {
          name: 'ai-helper',
          description: 'Reviews code: correctness\nwith care',
          body: 'You help with reviews.',
        },
      ],
    };
    const runner: CommandRunner = async () => ({
      stdout: JSON.stringify({ result: JSON.stringify(proposal) }),
      stderr: '',
      exitCode: 0,
    });
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runInit(
      {
        cwd: root,
        ai: true,
        json: true,
        runner,
        confirm: async () => true,
      },
      { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) },
    );

    expect(code).toBe(0);
    expect(stderr.join('')).toContain('ai-helper');
    const text = await readFile(join(root, '.agents/agents/ai-helper.md'), 'utf8');
    const parsed = parseFrontmatter(text, 'ai-helper.md');
    const validated = AgentFrontmatterSchema.safeParse(parsed.data);
    expect(validated.success).toBe(true);
    expect(parsed.data.description).toContain('correctness');
    expect(parsed.data.hooks).toBeUndefined();
  });
});
