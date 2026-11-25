import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeCodeAdapter } from '../../src/adapter/claude-code/adapter.ts';
import type { CommandRunner } from '../../src/core/command.ts';
import { discoverCommonFacts } from '../../src/model/facts.ts';
import {
  getTarget,
  loadProjectManifest,
  resolveProjectPaths,
} from '../../src/model/project-manifest.ts';
import { makeInitializedProject } from '../helpers/initialized.ts';
import type { ProjectFixture } from '../helpers/project.ts';

const projects: ProjectFixture[] = [];

const goodRunner: CommandRunner = async () => ({
  stdout: '2.1.325 (Claude Code)\n',
  stderr: '',
  exitCode: 0,
});

const missingRunner: CommandRunner = async () => {
  throw new Error('ENOENT');
};

afterEach(async () => {
  await Promise.all(projects.splice(0).map((item) => rm(item.root, { recursive: true, force: true })));
});

async function manifestAndFacts(project: ProjectFixture) {
  const manifest = (await loadProjectManifest(project.root)).manifest;
  const paths = resolveProjectPaths(project.root, manifest);
  const target = getTarget(manifest, 'claude-code');
  if (target === undefined) {
    throw new Error('missing target');
  }
  const facts = await discoverCommonFacts(project.root, paths);
  return { manifest, paths, target, facts };
}

describe('claudeCodeAdapter', () => {
  it('plans Claude settings, symlinked instructions and symlink projections', async () => {
    const project = await makeInitializedProject();
    projects.push(project);
    const { manifest, paths, target, facts } = await manifestAndFacts(project);

    const plan = await claudeCodeAdapter.normalize({
      paths,
      manifest,
      target,
      facts,
      fix: false,
      dryRun: true,
      runner: goodRunner,
    });

    expect(plan.diagnostics).toEqual([]);
    expect(plan.generated.provider).toBe('claude-code');
    expect(plan.generated.settings?.path).toBe('.claude/settings.json');
    expect(plan.generated.instructions?.mode).toBe('symlink');
    expect(plan.generated.projections.map((item) => item.target)).toEqual([
      '.claude/agents/reviewer.md',
      '.claude/skills/doc-sync',
      '.claude/rules/testing.md',
    ]);
  });

  it('plans with a warning when Claude Code is missing', async () => {
    const project = await makeInitializedProject();
    projects.push(project);
    const { manifest, paths, target, facts } = await manifestAndFacts(project);

    const plan = await claudeCodeAdapter.normalize({
      paths,
      manifest,
      target,
      facts,
      fix: false,
      dryRun: true,
      runner: missingRunner,
    });

    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'backend.missing', severity: 'warning' }),
    );
    expect(plan.generated.projections).toHaveLength(3);
  });

  it('does not plan a backup for a target the import step owns', async () => {
    const project = await makeInitializedProject();
    projects.push(project);
    const { manifest, paths, target, facts } = await manifestAndFacts(project);
    const agentTarget = join(project.root, '.claude/agents/reviewer.md');
    await rm(agentTarget);
    await writeFile(
      agentTarget,
      '---\nname: reviewer\ndescription: Physical.\n---\nPhysical.\n',
    );

    const plan = await claudeCodeAdapter.normalize({
      paths,
      manifest,
      target,
      facts,
      fix: true,
      dryRun: true,
      runner: goodRunner,
      importedTargets: ['.claude/agents/reviewer.md'],
    });

    expect(plan.diagnostics.map((item) => item.code)).not.toContain('projection.physical-copy');
    expect(plan.actions.some((item) => item.includes('.claude/agents/reviewer.md'))).toBe(false);
  });

  it('returns per-fact statuses for detect', async () => {
    const project = await makeInitializedProject();
    projects.push(project);
    const { manifest, paths, target, facts } = await manifestAndFacts(project);

    const outcome = await claudeCodeAdapter.detect({
      paths,
      manifest,
      target,
      facts,
      runner: goodRunner,
    });

    expect(outcome.statuses).toEqual(expect.arrayContaining([
      { kind: 'instructions', name: 'CLAUDE.md', status: 'generated' },
      { kind: 'agent', name: 'reviewer', status: 'native' },
      { kind: 'skill', name: 'doc-sync', status: 'native' },
      { kind: 'rule', name: 'testing', status: 'native' },
      { kind: 'policy', name: 'project', status: 'mapped' },
    ]));
  });
});
