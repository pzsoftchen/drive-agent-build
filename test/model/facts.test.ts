import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverProjections } from '../../src/adapter/claude-code/projection.ts';
import { discoverSourceFacts } from '../../src/model/facts.ts';
import { makeInitializedProject } from '../helpers/initialized.ts';
import type { ProjectFixture } from '../helpers/project.ts';

const projects: ProjectFixture[] = [];
const canDenyRead = process.platform !== 'win32'
  && typeof process.getuid === 'function'
  && process.getuid() !== 0;

function pathsOf(project: ProjectFixture) {
  return {
    root: project.root,
    scope: 'project' as const,
    agents: join(project.root, '.agents'),
    claude: join(project.root, '.claude'),
    manifest: join(project.root, 'dab.yaml'),
    instructions: join(project.root, 'AGENTS.md'),
  };
}

afterEach(async () => {
  await Promise.all(projects.splice(0).map((item) => rm(item.root, { recursive: true, force: true })));
});

describe('discoverSourceFacts', () => {
  it('discovers agents, skills, rules, hooks and policies once', async () => {
    const project = await makeInitializedProject();
    projects.push(project);

    const facts = await discoverSourceFacts(project.root, pathsOf(project));

    expect(facts.agents.items.map((item) => item.name)).toContain('reviewer');
    expect(facts.skills.items.map((item) => item.name)).toContain('doc-sync');
    expect(facts.rules.items.map((item) => item.name)).toContain('testing');
    expect(facts.hooks.items.map((item) => item.spec.id)).toContain('protect-generated');
    expect(facts.policies.project.version).toBe(1);
    expect(facts.policies.adapter.provider).toBe('claude-code');
  });

  it('keeps sibling skills and reports one unreadable skill directory', async () => {
    if (!canDenyRead) {
      return;
    }
    const project = await makeInitializedProject();
    projects.push(project);
    const good = join(project.agents, 'skills', 'good');
    await mkdir(good, { recursive: true });
    await writeFile(
      join(good, 'SKILL.md'),
      '---\nname: good\ndescription: Good.\n---\nBody.\n',
    );
    const broken = join(project.agents, 'skills', 'doc-sync');
    await chmod(broken, 0o000);
    try {
      const facts = await discoverSourceFacts(project.root, pathsOf(project));

      expect(facts.skills.items.map((item) => item.name)).toContain('good');
      expect(facts.skills.items.map((item) => item.name)).not.toContain('doc-sync');
      expect(facts.skills.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'skill.unreadable',
          severity: 'error',
          file: '.agents/skills/doc-sync',
        }),
      ]));

      const projections = await discoverProjections(project.root, pathsOf(project), {
        agents: facts.agents.items,
        skills: facts.skills.items,
        rules: facts.rules.items,
      });
      expect(projections.projections.map((item) => item.target)).toContain(
        '.claude/skills/good',
      );
    } finally {
      await chmod(broken, 0o755);
    }
  });

  it('treats only the exact practice parent failure as empty facts', async () => {
    const project = await makeInitializedProject();
    projects.push(project);
    await rm(join(project.root, '.agents/skills'), { recursive: true, force: true });
    await writeFile(join(project.root, '.agents/skills'), 'not a directory\n');

    const facts = await discoverSourceFacts(project.root, pathsOf(project));

    expect(facts.skills.items).toEqual([]);
    expect(facts.skills.diagnostics).toEqual([]);
    expect(facts.agents.items.map((item) => item.name)).toContain('reviewer');
    expect(facts.rules.items.map((item) => item.name)).toContain('testing');
  });
});
