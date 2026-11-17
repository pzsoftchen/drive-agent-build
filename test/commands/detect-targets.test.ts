import { afterEach, describe, expect, it } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { detectProject } from '../../src/commands/detect.ts';
import type { CommandRunner } from '../../src/core/command.ts';
import { makeInitializedProject } from '../helpers/initialized.ts';
import type { ProjectFixture } from '../helpers/project.ts';

const projects: ProjectFixture[] = [];

const goodRunner: CommandRunner = async () => ({
  stdout: '2.1.325 (Claude Code)\n',
  stderr: '',
  exitCode: 0,
});

async function initialized(): Promise<ProjectFixture> {
  const project = await makeInitializedProject();
  projects.push(project);
  return project;
}

afterEach(async () => {
  await Promise.all(projects.splice(0).map((item) => rm(item.root, { recursive: true, force: true })));
});

describe('detectProject targets', () => {
  it('reports per-fact target status for a clean Claude project', async () => {
    const project = await initialized();
    const result = await detectProject({
      cwd: project.root,
      runner: goodRunner,
      home: dirname(project.root),
    });

    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]?.provider).toBe('claude-code');
    expect(result.targets[0]?.statuses).toEqual(expect.arrayContaining([
      { kind: 'agent', name: 'reviewer', status: 'native' },
      { kind: 'skill', name: 'doc-sync', status: 'native' },
      { kind: 'rule', name: 'testing', status: 'native' },
      { kind: 'policy', name: 'project', status: 'mapped' },
    ]));
  });

  it('fails detect when a configured target has no adapter', async () => {
    const project = await initialized();
    const text = await readFile(join(project.root, 'dab.yaml'), 'utf8');
    await writeFile(
      join(project.root, 'dab.yaml'),
      text.replace(
        '  - provider: claude-code\n    enabled: true\n',
        '  - provider: claude-code\n    enabled: true\n  - provider: codex\n    enabled: true\n',
      ),
    );

    const result = await detectProject({
      cwd: project.root,
      runner: goodRunner,
      home: dirname(project.root),
    });

    expect(result.exitCode).toBe(3);
    expect(result.diagnostics.map((item) => item.code)).toContain('target.unsupported');
  });

  it('fails detect when no target is enabled', async () => {
    const project = await initialized();
    const path = join(project.root, 'dab.yaml');
    const text = await readFile(path, 'utf8');
    await writeFile(path, text.replace('enabled: true', 'enabled: false'));

    const result = await detectProject({
      cwd: project.root,
      runner: goodRunner,
      home: dirname(project.root),
    });

    expect(result.exitCode).toBe(3);
    expect(result.diagnostics.map((item) => item.code)).toContain('target.none');
  });
});
