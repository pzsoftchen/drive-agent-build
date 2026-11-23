import { afterEach, describe, expect, it } from 'vitest';
import { lstat, mkdir, readdir, readFile, readlink, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  applyClaudeAdoption,
  planClaudeAdoption,
} from '../../src/adapter/claude-code/adoption.ts';
import { lstatOrNull } from '../../src/core/fs-atomic.ts';
import { makeProject, writeProjectFile, type ProjectFixture } from '../helpers/project.ts';
import { makeTempDir } from '../helpers/tmp.ts';

const projects: ProjectFixture[] = [];
const tempDirs: string[] = [];

async function project(): Promise<ProjectFixture> {
  const fixture = await makeProject('dab-claude-adoption-');
  projects.push(fixture);
  return fixture;
}

async function tempDir(): Promise<string> {
  const dir = await makeTempDir('dab-claude-adoption-');
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all([
    ...projects.splice(0).map((item) => rm(item.root, { recursive: true, force: true })),
    ...tempDirs.splice(0).map((item) => rm(item, { recursive: true, force: true })),
  ]);
});

function agent(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
}

function skill(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
}

function plan(fixture: ProjectFixture) {
  return planClaudeAdoption({
    root: fixture.root,
    scope: 'project',
    agentsRoot: fixture.agents,
    claudeRoot: fixture.claude,
  });
}

describe('planClaudeAdoption', () => {
  it('plans an import for an unmanaged physical agent', async () => {
    const fixture = await project();
    await writeProjectFile(
      fixture.root,
      '.claude/agents/reviewer.md',
      agent('reviewer', 'Reviews.', 'Review.'),
    );

    const result = await plan(fixture);

    expect(result.entries).toContainEqual(expect.objectContaining({
      kind: 'agent',
      name: 'reviewer',
      source: '.claude/agents/reviewer.md',
      target: '.agents/agents/reviewer.md',
      writeSource: true,
      replaceTarget: true,
    }));
    expect(result.diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
    expect(await lstatOrNull(join(fixture.root, '.agents/agents/reviewer.md'))).toBeNull();
    expect((await lstat(join(fixture.root, '.claude/agents/reviewer.md'))).isFile()).toBe(true);
  });

  it('keeps an existing .agents source and still replaces the target', async () => {
    const fixture = await project();
    await writeProjectFile(
      fixture.root,
      '.agents/agents/reviewer.md',
      agent('reviewer', 'Source.', 'Source.'),
    );
    await writeProjectFile(
      fixture.root,
      '.claude/agents/reviewer.md',
      agent('reviewer', 'Old.', 'Old.'),
    );

    const result = await plan(fixture);

    expect(result.entries).toContainEqual(expect.objectContaining({
      target: '.agents/agents/reviewer.md',
      writeSource: false,
      replaceTarget: true,
    }));
    const differs = result.diagnostics.find((item) => item.code === 'adoption.content-differs');
    expect(differs).toMatchObject({ severity: 'warning' });
  });

  it('plans a skill directory import and warns about extra files', async () => {
    const fixture = await project();
    await writeProjectFile(
      fixture.root,
      '.claude/skills/pdf-tools/SKILL.md',
      skill('pdf-tools', 'PDF.', 'PDF.'),
    );
    await writeProjectFile(fixture.root, '.claude/skills/pdf-tools/helpers.md', 'extra\n');
    await writeProjectFile(
      fixture.root,
      '.agents/skills/pdf-tools/SKILL.md',
      skill('pdf-tools', 'PDF.', 'PDF.'),
    );

    const result = await plan(fixture);

    expect(result.entries).toContainEqual(expect.objectContaining({
      kind: 'skill',
      name: 'pdf-tools',
      source: '.claude/skills/pdf-tools',
      target: '.agents/skills/pdf-tools',
      writeSource: false,
      replaceTarget: true,
    }));
    const extra = result.diagnostics.find((item) => item.code === 'adoption.skill-extra-files');
    expect(extra).toMatchObject({ severity: 'warning' });
  });

  it('rejects an invalid agent candidate', async () => {
    const fixture = await project();
    await writeProjectFile(fixture.root, '.claude/agents/bad.md', '---\nname: bad\n---\n');

    const result = await plan(fixture);

    expect(result.entries).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toContain('agent.invalid-frontmatter');
    expect(result.diagnostics.find((item) => item.code === 'agent.invalid-frontmatter'))
      .toMatchObject({ severity: 'error' });
  });

  it('rejects an invalid skill candidate', async () => {
    const fixture = await project();
    await writeProjectFile(fixture.root, '.claude/skills/bad/SKILL.md', '---\nname: bad\n---\n');

    const result = await plan(fixture);

    expect(result.entries).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toContain('skill.invalid-frontmatter');
  });

  it('skips agents and skills already linked to their .agents source', async () => {
    const fixture = await project();
    await writeProjectFile(
      fixture.root,
      '.agents/agents/reviewer.md',
      agent('reviewer', 'Reviews.', 'Review.'),
    );
    await mkdir(join(fixture.root, '.claude/agents'), { recursive: true });
    await symlink(
      '../../.agents/agents/reviewer.md',
      join(fixture.root, '.claude/agents/reviewer.md'),
    );
    await writeProjectFile(
      fixture.root,
      '.agents/skills/pdf-tools/SKILL.md',
      skill('pdf-tools', 'PDF.', 'PDF.'),
    );
    await mkdir(join(fixture.root, '.claude/skills'), { recursive: true });
    await symlink(
      '../../.agents/skills/pdf-tools',
      join(fixture.root, '.claude/skills/pdf-tools'),
    );

    const result = await plan(fixture);

    expect(result.entries).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it('reports an unmanaged symlink as a conflict', async () => {
    const fixture = await project();
    await mkdir(join(fixture.root, '.claude/agents'), { recursive: true });
    await symlink('../elsewhere.md', join(fixture.root, '.claude/agents/reviewer.md'));

    const result = await plan(fixture);

    expect(result.entries).toEqual([]);
    const conflict = result.diagnostics.find((item) => item.code === 'adoption.unmanaged-symlink');
    expect(conflict).toMatchObject({
      severity: 'error',
      file: '.claude/agents/reviewer.md',
    });
  });

  it('rejects a directory-level .claude/agents symlink', async () => {
    const fixture = await project();
    await writeProjectFile(
      fixture.root,
      '.agents/agents/reviewer.md',
      agent('reviewer', 'Reviews.', 'Review.'),
    );
    await symlink('../.agents/agents', join(fixture.root, '.claude/agents'));

    const result = await plan(fixture);

    expect(result.entries).toEqual([]);
    expect(result.diagnostics.find((item) => item.code === 'adoption.unmanaged-symlink'))
      .toMatchObject({ severity: 'error', file: '.claude/agents' });
  });

  it('imports a fresh skill directory with all of its files', async () => {
    const fixture = await project();
    await writeProjectFile(
      fixture.root,
      '.claude/skills/pdf-tools/SKILL.md',
      skill('pdf-tools', 'PDF.', 'PDF.'),
    );
    await writeProjectFile(fixture.root, '.claude/skills/pdf-tools/helpers.md', 'extra\n');

    const result = await plan(fixture);

    expect(result.entries).toContainEqual(expect.objectContaining({
      kind: 'skill',
      target: '.agents/skills/pdf-tools',
      writeSource: true,
      replaceTarget: true,
    }));
    expect(result.diagnostics.map((item) => item.code))
      .not.toContain('adoption.skill-extra-files');
  });

  it('keeps source basenames and warns when frontmatter names differ', async () => {
    const fixture = await project();
    await writeProjectFile(
      fixture.root,
      '.claude/agents/reviewer-file.md',
      agent('reviewer', 'Reviews.', 'Review.'),
    );
    await writeProjectFile(
      fixture.root,
      '.claude/skills/pdf-dir/SKILL.md',
      skill('pdf-tools', 'PDF.', 'PDF.'),
    );

    const result = await plan(fixture);

    expect(result.entries).toContainEqual(expect.objectContaining({
      kind: 'agent',
      name: 'reviewer',
      target: '.agents/agents/reviewer-file.md',
    }));
    expect(result.entries).toContainEqual(expect.objectContaining({
      kind: 'skill',
      name: 'pdf-tools',
      target: '.agents/skills/pdf-dir',
    }));
    expect(result.diagnostics.filter((item) => item.code === 'adoption.name-mismatch'))
      .toHaveLength(2);
    expect(result.diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
  });

  it('rejects duplicate frontmatter names across candidates', async () => {
    const fixture = await project();
    await writeProjectFile(
      fixture.root,
      '.claude/agents/a.md',
      agent('reviewer', 'First.', 'First.'),
    );
    await writeProjectFile(
      fixture.root,
      '.claude/agents/b.md',
      agent('reviewer', 'Second.', 'Second.'),
    );

    const result = await plan(fixture);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ source: '.claude/agents/a.md' });
    expect(result.diagnostics.find((item) => item.code === 'agent.duplicate-name'))
      .toMatchObject({ severity: 'error', file: '.claude/agents/b.md' });
  });

  it('reports a non-file target as a conflict instead of planning a copy', async () => {
    const fixture = await project();
    await writeProjectFile(
      fixture.root,
      '.claude/agents/reviewer.md',
      agent('reviewer', 'Reviews.', 'Review.'),
    );
    await mkdir(join(fixture.root, '.agents/agents/reviewer.md'), { recursive: true });

    const result = await plan(fixture);

    expect(result.entries).toEqual([]);
    expect(result.diagnostics.find((item) => item.code === 'adoption.target-conflict'))
      .toMatchObject({ severity: 'error', file: '.agents/agents/reviewer.md' });
  });

  it('does not write the .claude source when planning a skill', async () => {
    const fixture = await project();
    await writeProjectFile(
      fixture.root,
      '.claude/skills/pdf-tools/SKILL.md',
      skill('pdf-tools', 'PDF.', 'PDF.'),
    );

    await plan(fixture);

    expect((await lstat(join(fixture.root, '.claude/skills/pdf-tools'))).isDirectory()).toBe(true);
    expect((await readFile(join(fixture.root, '.claude/skills/pdf-tools/SKILL.md'), 'utf8')))
      .toContain('name: pdf-tools');
    expect(await lstatOrNull(join(fixture.root, '.agents/skills/pdf-tools'))).toBeNull();
  });
});

function apply(fixture: ProjectFixture, claudePlan: Awaited<ReturnType<typeof plan>>) {
  return applyClaudeAdoption({
    root: fixture.root,
    plan: claudePlan,
    backupRoot: join(fixture.root, '.dab/backups/test'),
  });
}

describe('applyClaudeAdoption', () => {
  it('copies an agent, backs up the original and creates a symlink', async () => {
    const fixture = await project();
    await writeProjectFile(
      fixture.root,
      '.claude/agents/reviewer.md',
      agent('reviewer', 'Reviews.', 'Review.'),
    );
    const claudePlan = await plan(fixture);

    const applied = await apply(fixture, claudePlan);

    expect(await readFile(join(fixture.root, '.agents/agents/reviewer.md'), 'utf8'))
      .toContain('name: reviewer');
    expect(await readlink(join(fixture.root, '.claude/agents/reviewer.md')))
      .toBe('../../.agents/agents/reviewer.md');
    expect(applied.backups).toHaveLength(1);
    expect(await readFile(applied.backups[0]!, 'utf8')).toContain('Review.');
    expect(applied.diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
    expect(applied.actions).toEqual([
      'import .claude/agents/reviewer.md -> .agents/agents/reviewer.md',
      'backup .claude/agents/reviewer.md -> .dab/backups/test/.claude/agents/reviewer.md',
      'symlink .claude/agents/reviewer.md -> ../../.agents/agents/reviewer.md',
    ]);
  });

  it('copies a skill directory and backs up the whole original', async () => {
    const fixture = await project();
    await writeProjectFile(
      fixture.root,
      '.claude/skills/pdf-tools/SKILL.md',
      skill('pdf-tools', 'PDF.', 'PDF.'),
    );
    await writeProjectFile(fixture.root, '.claude/skills/pdf-tools/helper.txt', 'extra\n');
    const claudePlan = await plan(fixture);

    const applied = await apply(fixture, claudePlan);

    expect(await readFile(join(fixture.root, '.agents/skills/pdf-tools/helper.txt'), 'utf8'))
      .toBe('extra\n');
    expect(await readlink(join(fixture.root, '.claude/skills/pdf-tools')))
      .toBe('../../.agents/skills/pdf-tools');
    expect(applied.backups).toHaveLength(1);
    expect((await lstat(applied.backups[0]!)).isDirectory()).toBe(true);
    expect(await readFile(join(applied.backups[0]!, 'helper.txt'), 'utf8')).toBe('extra\n');
  });

  it('keeps an existing .agents source and still backs up and links the target', async () => {
    const fixture = await project();
    await writeProjectFile(
      fixture.root,
      '.agents/agents/reviewer.md',
      agent('reviewer', 'Source.', 'Source.'),
    );
    await writeProjectFile(
      fixture.root,
      '.claude/agents/reviewer.md',
      agent('reviewer', 'Old.', 'Old.'),
    );
    const claudePlan = await plan(fixture);

    const applied = await apply(fixture, claudePlan);

    expect(await readFile(join(fixture.root, '.agents/agents/reviewer.md'), 'utf8'))
      .toContain('Source.');
    expect(await readFile(applied.backups[0]!, 'utf8')).toContain('Old.');
    expect(await readlink(join(fixture.root, '.claude/agents/reviewer.md')))
      .toBe('../../.agents/agents/reviewer.md');
  });

  it('does not merge extra skill files into an existing .agents skill', async () => {
    const fixture = await project();
    await writeProjectFile(
      fixture.root,
      '.agents/skills/pdf-tools/SKILL.md',
      skill('pdf-tools', 'PDF.', 'PDF.'),
    );
    await writeProjectFile(
      fixture.root,
      '.claude/skills/pdf-tools/SKILL.md',
      skill('pdf-tools', 'PDF.', 'PDF.'),
    );
    await writeProjectFile(fixture.root, '.claude/skills/pdf-tools/extra.txt', 'extra\n');
    const claudePlan = await plan(fixture);

    const applied = await apply(fixture, claudePlan);

    expect(await lstatOrNull(join(fixture.root, '.agents/skills/pdf-tools/extra.txt'))).toBeNull();
    expect(await readFile(join(applied.backups[0]!, 'extra.txt'), 'utf8')).toBe('extra\n');
    expect(await readlink(join(fixture.root, '.claude/skills/pdf-tools')))
      .toBe('../../.agents/skills/pdf-tools');
  });

  it('refuses to overwrite an .agents source that appeared after planning', async () => {
    const fixture = await project();
    await writeProjectFile(
      fixture.root,
      '.claude/agents/reviewer.md',
      agent('reviewer', 'Reviews.', 'Review.'),
    );
    const claudePlan = await plan(fixture);
    await writeProjectFile(
      fixture.root,
      '.agents/agents/reviewer.md',
      agent('reviewer', 'Late.', 'Late.'),
    );

    const applied = await apply(fixture, claudePlan);

    expect(await readFile(join(fixture.root, '.agents/agents/reviewer.md'), 'utf8'))
      .toContain('Late.');
    expect((await lstat(join(fixture.root, '.claude/agents/reviewer.md'))).isFile()).toBe(true);
    expect(applied.actions).toEqual([]);
    expect(applied.backups).toEqual([]);
    expect(applied.diagnostics.find((item) => item.code === 'adoption.target-exists'))
      .toMatchObject({ severity: 'error', file: '.agents/agents/reviewer.md' });
  });

  it('rejects a skill symlink that escapes the root without copying', async () => {
    const fixture = await project();
    const outside = await tempDir();
    await writeProjectFile(outside, 'secret.txt', 'secret\n');
    await writeProjectFile(
      fixture.root,
      '.claude/skills/pdf-tools/SKILL.md',
      skill('pdf-tools', 'PDF.', 'PDF.'),
    );
    await writeProjectFile(fixture.root, '.claude/skills/pdf-tools/nested/keep.txt', 'keep\n');
    await symlink(outside, join(fixture.root, '.claude/skills/pdf-tools/nested/leak'));
    const claudePlan = await plan(fixture);

    const applied = await apply(fixture, claudePlan);

    expect(await lstatOrNull(join(fixture.root, '.agents/skills/pdf-tools'))).toBeNull();
    expect(await readdir(join(fixture.root, '.agents/skills'))).toEqual([]);
    expect((await lstat(join(fixture.root, '.claude/skills/pdf-tools'))).isDirectory()).toBe(true);
    expect(applied.actions).toEqual([]);
    expect(applied.backups).toEqual([]);
    expect(applied.diagnostics.find((item) => item.code === 'adoption.source-symlink-escape'))
      .toMatchObject({ severity: 'error', file: '.claude/skills/pdf-tools/nested/leak' });
  });

  it('rejects a chained symlink that escapes through a symlink and dot-dot', async () => {
    const fixture = await project();
    await writeProjectFile(
      fixture.root,
      '.claude/skills/pdf-tools/SKILL.md',
      skill('pdf-tools', 'PDF.', 'PDF.'),
    );
    await mkdir(join(fixture.root, '.claude/agents'), { recursive: true });
    await symlink(
      join(fixture.root, '.claude/agents'),
      join(fixture.root, '.claude/skills/pdf-tools/s'),
    );
    await symlink('s/../../../etc/passwd', join(fixture.root, '.claude/skills/pdf-tools/t'));
    const claudePlan = await plan(fixture);

    const applied = await apply(fixture, claudePlan);

    expect(await lstatOrNull(join(fixture.root, '.agents/skills/pdf-tools'))).toBeNull();
    expect(await readdir(join(fixture.root, '.agents/skills'))).toEqual([]);
    expect(applied.actions).toEqual([]);
    expect(applied.backups).toEqual([]);
    expect(applied.diagnostics.find((item) => item.code === 'adoption.source-symlink-escape'))
      .toMatchObject({ severity: 'error', file: '.claude/skills/pdf-tools/t' });
  });

  it('copies an internal skill symlink verbatim', async () => {
    const fixture = await project();
    await writeProjectFile(
      fixture.root,
      '.claude/skills/pdf-tools/SKILL.md',
      skill('pdf-tools', 'PDF.', 'PDF.'),
    );
    await writeProjectFile(fixture.root, '.claude/skills/pdf-tools/data.txt', 'data\n');
    await symlink('data.txt', join(fixture.root, '.claude/skills/pdf-tools/helper.txt'));
    const claudePlan = await plan(fixture);

    await apply(fixture, claudePlan);

    const copied = join(fixture.root, '.agents/skills/pdf-tools/helper.txt');
    expect((await lstat(copied)).isSymbolicLink()).toBe(true);
    expect(await readlink(copied)).toBe('data.txt');
    expect(await readFile(copied, 'utf8')).toBe('data\n');
  });

  it('aborts before replacing when the backup fails', async () => {
    const fixture = await project();
    const outside = await tempDir();
    await writeProjectFile(
      fixture.root,
      '.claude/agents/reviewer.md',
      agent('reviewer', 'Reviews.', 'Review.'),
    );
    const claudePlan = await plan(fixture);

    const applied = await applyClaudeAdoption({
      root: fixture.root,
      plan: claudePlan,
      backupRoot: join(outside, 'backups'),
    });

    expect(applied.backups).toEqual([]);
    expect(applied.diagnostics.find((item) => item.code === 'adoption.apply-failed'))
      .toMatchObject({ severity: 'error', file: '.claude/agents/reviewer.md' });
    expect((await lstat(join(fixture.root, '.claude/agents/reviewer.md'))).isFile()).toBe(true);
    expect(await readFile(join(fixture.root, '.claude/agents/reviewer.md'), 'utf8'))
      .toContain('Review.');
    // The source copy happened before the failed backup and is not rolled back.
    expect(await readFile(join(fixture.root, '.agents/agents/reviewer.md'), 'utf8'))
      .toContain('name: reviewer');
  });

  it('is idempotent when the plan is rebuilt after applying', async () => {
    const fixture = await project();
    await writeProjectFile(
      fixture.root,
      '.claude/agents/reviewer.md',
      agent('reviewer', 'Reviews.', 'Review.'),
    );
    await apply(fixture, await plan(fixture));

    const rebuilt = await plan(fixture);
    const applied = await apply(fixture, rebuilt);

    expect(rebuilt.entries).toEqual([]);
    expect(applied.actions).toEqual([]);
    expect(applied.backups).toEqual([]);
    expect(applied.diagnostics).toEqual([]);
  });
});
