import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverSourceFacts } from '../../src/model/facts.ts';
import { makeInitializedProject } from '../helpers/initialized.ts';
import type { ProjectFixture } from '../helpers/project.ts';

const projects: ProjectFixture[] = [];

afterEach(async () => {
  await Promise.all(projects.splice(0).map((item) => rm(item.root, { recursive: true, force: true })));
});

describe('discoverSourceFacts', () => {
  it('discovers agents, skills, rules, hooks and policies once', async () => {
    const project = await makeInitializedProject();
    projects.push(project);

    const facts = await discoverSourceFacts(project.root, {
      root: project.root,
      scope: 'project',
      agents: join(project.root, '.agents'),
      claude: join(project.root, '.claude'),
      manifest: join(project.root, 'dab.yaml'),
      instructions: join(project.root, 'AGENTS.md'),
    });

    expect(facts.agents.items.map((item) => item.name)).toContain('reviewer');
    expect(facts.skills.items.map((item) => item.name)).toContain('doc-sync');
    expect(facts.rules.items.map((item) => item.name)).toContain('testing');
    expect(facts.hooks.items.map((item) => item.spec.id)).toContain('protect-generated');
    expect(facts.policies.project.version).toBe(1);
    expect(facts.policies.adapter.provider).toBe('claude-code');
  });
});
