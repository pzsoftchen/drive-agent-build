import { afterEach, describe, expect, it } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeProject } from '../../src/commands/normalize.ts';
import type { CommandRunner } from '../../src/core/command.ts';
import { lstatOrNull } from '../../src/core/fs-atomic.ts';
import { populateProject } from '../helpers/initialized.ts';
import { makeProject, type ProjectFixture } from '../helpers/project.ts';

const projects: ProjectFixture[] = [];

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

async function projectFixture(): Promise<ProjectFixture> {
  const project = await makeProject();
  projects.push(project);
  await populateProject(project);
  return project;
}

async function addCodexTarget(project: ProjectFixture): Promise<void> {
  const path = join(project.root, 'dab.yaml');
  const text = await readFile(path, 'utf8');
  await writeFile(
    path,
    text.replace(
      '  - provider: claude-code\n    enabled: true\n',
      '  - provider: claude-code\n    enabled: true\n  - provider: codex\n    enabled: true\n',
    ),
  );
}

afterEach(async () => {
  await Promise.all(projects.splice(0).map((item) => rm(item.root, { recursive: true, force: true })));
});

describe('normalizeProject targets', () => {
  it('blocks every target when a configured target has no adapter', async () => {
    const project = await projectFixture();
    await addCodexTarget(project);

    const result = await normalizeProject({ cwd: project.root, runner: goodRunner });

    expect(result.ok).toBe(false);
    expect(result.targets).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toContain('target.unsupported');
    expect(await lstatOrNull(join(project.root, '.claude/settings.json'))).toBeNull();
    expect(await lstatOrNull(join(project.root, '.claude/agents/reviewer.md'))).toBeNull();
  });

  it('applies all configured Claude targets only after every plan is clean', async () => {
    const project = await projectFixture();
    const result = await normalizeProject({
      cwd: project.root,
      dryRun: true,
      runner: goodRunner,
    });

    expect(result.targets.map((item) => item.provider)).toEqual(['claude-code']);
    expect(result.targets[0]?.settings?.path).toBe('.claude/settings.json');
    expect(result.actions).toEqual([
      ...['.agents/gates.yaml', 'scripts/dab-check.mjs', 'scripts/dab-gates.json']
        .map((path) => `create gate ${path}`),
      ...result.targets.flatMap((item) => item.actions),
    ]);
    expect(await lstatOrNull(join(project.root, '.claude/settings.json'))).toBeNull();
  });

  it('rejects a manifest with no enabled target', async () => {
    const project = await projectFixture();
    const path = join(project.root, 'dab.yaml');
    const text = await readFile(path, 'utf8');
    await writeFile(path, text.replace('enabled: true', 'enabled: false'));

    const result = await normalizeProject({ cwd: project.root, runner: goodRunner });

    expect(result.ok).toBe(false);
    expect(result.targets).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toContain('target.none');
    expect(await lstatOrNull(join(project.root, '.claude/settings.json'))).toBeNull();
  });

  it('keeps backend exit 4 ahead of an unsupported target', async () => {
    const project = await projectFixture();
    await addCodexTarget(project);

    const result = await normalizeProject({ cwd: project.root, runner: oldRunner });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(4);
    expect(result.targets).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toContain('backend.version');
    expect(await lstatOrNull(join(project.root, '.claude/settings.json'))).toBeNull();
    expect(await lstatOrNull(join(project.root, '.claude/agents/reviewer.md'))).toBeNull();
  });
});
