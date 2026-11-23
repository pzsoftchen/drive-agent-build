import { afterEach, describe, expect, it } from 'vitest';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
