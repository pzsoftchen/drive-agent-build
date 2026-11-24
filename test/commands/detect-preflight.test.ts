import { afterEach, describe, expect, it } from 'vitest';
import { chmod, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { detectProject, runDetect } from '../../src/commands/detect.ts';
import { preflightProject } from '../../src/detect/preflight.ts';
import type { CommandRunner } from '../../src/core/command.ts';
import { lstatOrNull } from '../../src/core/fs-atomic.ts';
import { makeProject, writeProjectFile, type ProjectFixture } from '../helpers/project.ts';
import { makeTempDir } from '../helpers/tmp.ts';

const goodRunner: CommandRunner = async () => ({
  stdout: '2.1.325 (Claude Code)\n',
  stderr: '',
  exitCode: 0,
});

const canDenyRead = process.platform !== 'win32'
  && typeof process.getuid === 'function'
  && process.getuid() !== 0;

interface ChecklistItem {
  group: string;
  label: string;
  status: string;
  detail?: string;
  file?: string;
  next?: string;
}

interface DetectPayload {
  schemaVersion: number;
  ok: boolean;
  exitCode: number;
  scope: string;
  root: string;
  phase: string;
  checklist: ChecklistItem[];
  score: { ok: number; total: number; percent: number };
  nextActions: string[];
  diagnostics: Array<{ code: string; severity: string }>;
  targets: unknown[];
  summary: { errors: number; warnings: number; info: number };
  error?: { code: string };
}

interface DetectCapture {
  stdout: string[];
  stderr: string[];
  io: {
    stdout: (value: string) => void;
    stderr: (value: string) => void;
  };
}

function capture(): DetectCapture {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    },
  };
}

async function detectJson(input: {
  cwd: string;
  home: string;
  strict?: boolean;
}): Promise<{ code: number; payload: DetectPayload; captured: DetectCapture }> {
  const captured = capture();
  const code = await runDetect(
    {
      cwd: input.cwd,
      home: input.home,
      json: true,
      runner: goodRunner,
      ...(input.strict === undefined ? {} : { strict: input.strict }),
    },
    captured.io,
  );
  return {
    code,
    payload: JSON.parse(captured.stdout.join('')) as DetectPayload,
    captured,
  };
}

const projects: ProjectFixture[] = [];
const dirs: string[] = [];

async function projectFixture(): Promise<ProjectFixture> {
  const project = await makeProject();
  projects.push(project);
  return project;
}

async function tempDir(prefix = 'dab-detect-preflight-'): Promise<string> {
  const dir = await makeTempDir(prefix);
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(projects.splice(0).map((item) => rm(item.root, { recursive: true, force: true })));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('detect preflight', () => {
  it('prints a checklist for an uninitialized project instead of a source-root error', async () => {
    const project = await tempDir();

    const { code, payload } = await detectJson({ cwd: project, home: dirname(project) });

    expect(code).toBe(2);
    expect(payload.schemaVersion).toBe(1);
    expect(payload.ok).toBe(false);
    expect(payload.phase).toBe('uninitialized');
    expect(payload.scope).toBe('project');
    expect(payload.root).toBe(project);
    expect(payload.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'AGENTS.md', status: 'missing' }),
      expect.objectContaining({ label: 'dab.yaml', status: 'missing' }),
    ]));
    expect(payload.score.total).toBeGreaterThan(0);
    expect(payload.nextActions).toContain('dab normalize');
    expect(payload.targets).toEqual([]);
    expect(payload.error).toBeUndefined();

    expect(await lstatOrNull(join(project, '.agents'))).toBeNull();
    expect(await lstatOrNull(join(project, 'AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(project, 'dab.yaml'))).toBeNull();
  });

  it('pins the uninitialized JSON result shape instead of the error envelope', async () => {
    const project = await tempDir();

    const { code, payload } = await detectJson({ cwd: project, home: dirname(project) });

    expect(code).toBe(2);
    expect(payload.exitCode).toBe(2);
    expect(payload.ok).toBe(false);
    expect(payload.error).toBeUndefined();
    expect(Object.keys(payload).sort()).toEqual([
      'checklist',
      'diagnostics',
      'exitCode',
      'nextActions',
      'ok',
      'phase',
      'profile',
      'root',
      'schemaVersion',
      'scope',
      'score',
      'summary',
      'targets',
    ]);
  });

  it('keeps preflight exit 2 even with --strict', async () => {
    const project = await tempDir();

    const { code, payload } = await detectJson({
      cwd: project,
      home: dirname(project),
      strict: true,
    });

    expect(code).toBe(2);
    expect(payload.phase).toBe('uninitialized');
  });

  it('marks importable Claude agents and skills', async () => {
    const project = await projectFixture();
    await writeProjectFile(
      project.root,
      '.claude/agents/reviewer.md',
      '---\nname: reviewer\ndescription: Reviews.\n---\nReview.\n',
    );
    await writeProjectFile(
      project.root,
      '.claude/skills/pdf-tools/SKILL.md',
      '---\nname: pdf-tools\ndescription: PDF.\n---\nPDF.\n',
    );

    const { code, payload } = await detectJson({
      cwd: project.root,
      home: dirname(project.root),
    });

    expect(code).toBe(2);
    expect(payload.phase).toBe('partial');
    expect(payload.exitCode).toBe(2);
    expect(payload.error).toBeUndefined();
    expect(payload.checklist.map((item) => item.status)).toContain('importable');
    expect(payload.nextActions).toContain('dab normalize --dry-run');
    expect(payload.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({
        group: 'Agents',
        label: '.claude/agents/reviewer.md',
        status: 'importable',
      }),
      expect.objectContaining({
        group: 'Skills',
        label: '.claude/skills/pdf-tools',
        status: 'importable',
      }),
    ]));

    // Preflight is strictly read-only.
    expect(await lstatOrNull(join(project.root, '.agents/agents/reviewer.md'))).toBeNull();
    expect((await lstat(join(project.root, '.claude/agents/reviewer.md'))).isFile()).toBe(true);
  });

  it('returns a read-only checklist directly from preflightProject', async () => {
    const project = await tempDir();

    const result = await preflightProject({ cwd: project, home: dirname(project) });

    expect(result.sourceRoot).toMatchObject({ scope: 'project', root: project });
    expect(result.phase).toBe('uninitialized');
    expect(result.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: 'Instructions', label: 'AGENTS.md', status: 'missing' }),
      expect.objectContaining({ group: 'Generated target', label: 'dab.yaml', status: 'missing' }),
      expect.objectContaining({ group: 'Notes', label: '.agents/notes/', status: 'missing' }),
    ]));
    expect(result.diagnostics).toEqual([]);
    expect(await lstatOrNull(join(project, '.agents'))).toBeNull();
    expect(await lstatOrNull(join(project, 'dab.yaml'))).toBeNull();
  });

  it('reports an invalid authored manifest as an error entry without throwing', async () => {
    const project = await projectFixture();
    const manifest = 'version: 2\nscope: project\n';
    await writeProjectFile(project.root, 'dab.yaml', manifest);

    const { code, payload } = await detectJson({
      cwd: project.root,
      home: dirname(project.root),
    });

    expect(code).toBe(2);
    expect(payload.phase).toBe('partial');
    expect(payload.diagnostics.map((item) => item.code)).toContain('config.invalid');
    expect(payload.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: 'Generated target', label: 'dab.yaml', status: 'error' }),
    ]));
    expect(payload.nextActions).not.toContain('dab normalize');
    const documentation = payload.checklist.find((item) => item.group === 'Documentation');
    expect(documentation).toBeDefined();
    expect(documentation?.next).toBeUndefined();

    expect(await readFile(join(project.root, 'dab.yaml'), 'utf8')).toBe(manifest);
    expect(await lstatOrNull(join(project.root, '.agents/policies/project.yaml'))).toBeNull();
  });

  it('governs a regular file at the rules path during preflight', async () => {
    const root = await tempDir();
    await writeProjectFile(root, '.agents/rules', 'not a directory\n');

    const result = await detectProject({ cwd: root, home: dirname(root) });

    expect(result.phase).toBe('partial');
    expect(result.exitCode).toBe(2);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'practice.docs-path',
        severity: 'error',
        file: '.agents/rules',
      }),
    ]));
    expect(result.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({
        group: 'Documentation',
        status: 'error',
        next: 'resolve the path conflict manually',
      }),
    ]));
    expect(result.checklist.some(
      (item) => item.group === 'Documentation' && item.status === 'missing',
    )).toBe(false);
  });

  it('governs a regular file at the skills path during preflight', async () => {
    const root = await tempDir();
    await writeProjectFile(root, '.agents/skills', 'not a directory\n');

    const result = await detectProject({ cwd: root, home: dirname(root) });

    expect(result.phase).toBe('partial');
    expect(result.exitCode).toBe(2);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'practice.skill-path',
        severity: 'error',
        file: '.agents/skills',
      }),
    ]));
    expect(result.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({
        group: 'Skills',
        status: 'error',
        next: 'resolve the path conflict manually',
      }),
    ]));
    expect(result.checklist.some(
      (item) => item.group === 'Skills' && item.status === 'missing',
    )).toBe(false);
  });

  it('does not claim an invalid existing authoring skill is ok', async () => {
    const root = await tempDir();
    await writeProjectFile(root, '.agents/skills/dab-doc-writing/SKILL.md', '# not a skill\n');

    const result = await detectProject({ cwd: root, home: dirname(root) });

    expect(result.diagnostics.map((item) => item.code)).toContain('skill.invalid-frontmatter');
    expect(result.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({
        group: 'Skills',
        label: '.agents/skills/dab-doc-writing/SKILL.md',
        status: 'error',
      }),
    ]));
    expect(result.checklist.some(
      (item) => item.group === 'Skills'
        && item.label === 'dab-doc-writing'
        && item.status === 'ok',
    )).toBe(false);
  });

  it('governs a regular file at the hooks path during preflight', async () => {
    const root = await tempDir();
    await writeProjectFile(root, '.agents/hooks', 'not a directory\n');

    const result = await detectProject({ cwd: root, home: dirname(root) });

    expect(result.phase).toBe('partial');
    expect(result.exitCode).toBe(2);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'path.conflict',
        severity: 'error',
        file: expect.stringMatching(/^\.agents\/hooks\/?$/),
      }),
    ]));
    expect(result.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: 'Hooks', status: 'error' }),
    ]));
  });

  it('governs a regular file at the agents path during preflight', async () => {
    const root = await tempDir();
    await writeProjectFile(root, '.agents/agents', 'not a directory\n');

    const result = await detectProject({ cwd: root, home: dirname(root) });

    expect(result.phase).toBe('partial');
    expect(result.exitCode).toBe(2);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'path.conflict',
        severity: 'error',
        file: expect.stringMatching(/^\.agents\/agents\/?$/),
      }),
    ]));
    expect(result.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: 'Agents', status: 'error' }),
    ]));
  });

  it('governs a regular file at the notes path during preflight', async () => {
    const root = await tempDir();
    await writeProjectFile(root, '.agents/notes', 'not a directory\n');

    const result = await detectProject({ cwd: root, home: dirname(root) });

    expect(result.phase).toBe('partial');
    expect(result.exitCode).toBe(2);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'path.conflict',
        severity: 'error',
        file: expect.stringMatching(/^\.agents\/notes\/?$/),
      }),
    ]));
    expect(result.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: 'Notes', status: 'error' }),
    ]));
  });

  it.each(['hooks', 'rules', 'notes'])(
    'governs an unreadable .agents/%s directory during preflight',
    async (parent) => {
      if (!canDenyRead) {
        return;
      }
      const root = await tempDir();
      const directory = join(root, '.agents', parent);
      await mkdir(directory, { recursive: true });
      await chmod(directory, 0o000);
      try {
        const result = await detectProject({ cwd: root, home: dirname(root) });

        expect(result.phase).toBe('partial');
        expect(result.diagnostics.some(
          (item) => item.severity === 'error'
            && item.file?.replace(/\/$/, '') === `.agents/${parent}`,
        )).toBe(true);
      } finally {
        await chmod(directory, 0o755);
      }
    },
  );

  it.each(['hooks', 'rules', 'notes'])(
    'governs an unreadable global .agents/%s directory during preflight',
    async (parent) => {
      if (!canDenyRead) {
        return;
      }
      const home = await tempDir('dab-global-preflight-');
      const directory = join(home, '.agents', parent);
      await mkdir(directory, { recursive: true });
      await chmod(directory, 0o000);
      try {
        const result = await detectProject({ cwd: join(home, '.agents'), home });

        expect(result.scope).toBe('global');
        expect(result.phase).toBe('partial');
        expect(result.diagnostics.some(
          (item) => item.severity === 'error'
            && item.file?.replace(/\/$/, '') === `.agents/${parent}`,
        )).toBe(true);
      } finally {
        await chmod(directory, 0o755);
      }
    },
  );

  it('emits a governed diagnostic for a non-practice path with a file parent', async () => {
    const root = await tempDir();
    await writeProjectFile(root, '.agents/policies', 'not a directory\n');

    const result = await detectProject({ cwd: root, home: dirname(root) });

    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'path.conflict',
        severity: 'error',
        file: '.agents/policies/project.yaml',
      }),
    ]));
  });

  it('shows Documentation and authoring skill entries before initialization', async () => {
    const root = await tempDir();

    const result = await detectProject({ cwd: root, home: dirname(root) });

    expect(result.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: 'Documentation', status: 'missing', next: 'dab normalize' }),
      expect.objectContaining({
        group: 'Skills',
        label: 'dab-architecture-writing',
        status: 'missing',
        next: 'dab normalize',
      }),
    ]));
    expect(
      result.checklist.find((entry) => entry.group === 'Documentation')?.detail,
    ).toContain('Language:');
  });

  it('uses the manifest profile and docs language for partial practice entries', async () => {
    const root = await tempDir();
    await writeProjectFile(
      root,
      'dab.yaml',
      `version: 2
scope: project
project:
  id: demo
  name: Demo
profile: generic
docs:
  language: zh
targets:
  - provider: claude-code
    enabled: true
paths:
  agents: .agents
  claude: .claude
`,
    );

    const result = await detectProject({ cwd: root, home: dirname(root) });

    expect(result.phase).toBe('partial');
    const documentation = result.checklist.filter((entry) => entry.group === 'Documentation');
    expect(documentation.length).toBeGreaterThan(0);
    expect(documentation.every(
      (entry) => entry.detail?.includes('Language: zh (source: config)'),
    )).toBe(true);
    expect(documentation.every((entry) => entry.next === 'dab normalize')).toBe(true);
  });

  it('refuses to suggest project writes at $HOME when ~/.agents is the global source', async () => {
    const home = await tempDir('dab-detect-home-');
    await mkdir(join(home, '.agents'), { recursive: true });
    await mkdir(join(home, '.git'), { recursive: true });
    await mkdir(join(home, 'work'), { recursive: true });
    await writeFile(join(home, '.agents/AGENTS.md'), '# global instructions\n');

    // A dotfiles-style git repository at $HOME: the project fallback root is
    // $HOME, whose .agents tree is the global source root.
    const { code, payload } = await detectJson({ cwd: join(home, 'work'), home });

    expect(code).toBe(2);
    expect(payload.scope).toBe('project');
    expect(payload.root).toBe(home);
    expect(payload.phase).toBe('uninitialized');
    expect(payload.diagnostics.map((item) => item.code)).toContain('config.source-root-nested');
    expect(payload.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: 'Safety', status: 'error' }),
    ]));
    expect(payload.checklist.every((item) => item.next !== 'dab normalize')).toBe(true);
    expect(payload.nextActions).not.toContain('dab normalize');

    expect(await lstatOrNull(join(home, '.agents/dab.yaml'))).toBeNull();
    expect(await lstatOrNull(join(home, 'AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(home, 'dab.yaml'))).toBeNull();
  });

  it('renders a global partial checklist with a temp HOME and leaves user files alone', async () => {
    const home = await tempDir('dab-detect-global-');
    const agents = join(home, '.agents');
    await mkdir(agents, { recursive: true });
    await mkdir(join(home, '.claude'), { recursive: true });
    const settings = join(home, '.claude/settings.json');
    const settingsContent = '{"permissions":{"allow":["Bash(ls)"]}}\n';
    await writeFile(settings, settingsContent);
    const gitignore = join(home, '.gitignore');
    const gitignoreContent = 'node_modules\n';
    await writeFile(gitignore, gitignoreContent);

    const { code, payload } = await detectJson({ cwd: agents, home });

    expect(code).toBe(2);
    expect(payload.scope).toBe('global');
    expect(payload.root).toBe(home);
    expect(payload.phase).toBe('partial');
    expect(payload.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({
        group: 'Instructions',
        label: '.agents/AGENTS.md',
        status: 'missing',
      }),
      expect.objectContaining({
        group: 'Generated target',
        label: '.agents/dab.yaml',
        status: 'missing',
      }),
    ]));
    // Global scope never suggests writing the user-owned settings or gitignore.
    expect(payload.checklist.some((item) => item.label === '.claude/settings.json')).toBe(false);
    expect(payload.checklist.some((item) => item.label === '.gitignore')).toBe(false);
    // Global scope owns neither project docs nor authoring skills.
    expect(payload.checklist.some((item) => item.group === 'Documentation')).toBe(false);
    expect(payload.checklist.some((item) => item.label === 'dab-architecture-writing')).toBe(false);

    expect(await readFile(settings, 'utf8')).toBe(settingsContent);
    expect(await readFile(gitignore, 'utf8')).toBe(gitignoreContent);
    expect(await lstatOrNull(join(home, '.agents/dab.yaml'))).toBeNull();
    expect(await lstatOrNull(join(home, 'AGENTS.md'))).toBeNull();
  });
});
