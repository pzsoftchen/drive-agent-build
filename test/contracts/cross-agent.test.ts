import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeCodeAdapter } from '../../src/adapter/claude-code/adapter.ts';
import { compilePolicy } from '../../src/adapter/claude-code/policy-compile.ts';
import { discoverCommonFacts } from '../../src/model/facts.ts';
import { loadClaudeCodePolicy } from '../../src/model/policy.ts';
import type {
  ProjectManifest,
  TargetConfig,
} from '../../src/model/types.ts';
import { makeProject, writeProjectFile, type ProjectFixture } from '../helpers/project.ts';
import { neutralView } from './neutral-consumer.ts';

const projects: ProjectFixture[] = [];

afterEach(async () => {
  await Promise.all(projects.splice(0).map((item) => rm(item.root, { recursive: true, force: true })));
});

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

function agentSource(providerFields: boolean): string {
  return [
    '---',
    'name: reviewer',
    'description: Reviews changes.',
    ...(providerFields
      ? ['tools: Read, Grep, Glob', 'model: sonnet', 'permissionMode: plan']
      : []),
    '---',
    'Review.',
    '',
  ].join('\n');
}

function skillSource(providerFields: boolean): string {
  return [
    '---',
    'name: doc-sync',
    'description: Keeps docs paired.',
    ...(providerFields
      ? ['allowed-tools: Read, Edit', 'model: sonnet', 'context: inline']
      : []),
    '---',
    'Sync docs.',
    '',
  ].join('\n');
}

async function makeCommonOnlyProject(options: {
  providerFields?: boolean;
  adapterPolicy?: string;
} = {}): Promise<ProjectFixture> {
  const project = await makeProject('dab-cross-agent-');
  projects.push(project);
  await writeProjectFile(project.root, 'AGENTS.md', '# Project\n\nRead this first.\n');
  await writeProjectFile(
    project.root,
    '.agents/policies/project.yaml',
    'version: 1\ndefaultMode: default\n',
  );
  await writeProjectFile(
    project.root,
    '.agents/agents/reviewer.md',
    agentSource(options.providerFields === true),
  );
  await writeProjectFile(
    project.root,
    '.agents/skills/doc-sync/SKILL.md',
    skillSource(options.providerFields === true),
  );
  await writeProjectFile(project.root, '.agents/rules/testing.md', 'Run tests.\n');
  await writeProjectFile(
    project.root,
    '.agents/hooks/protect-generated/hook.yaml',
    'id: protect-generated\nevent: pre_tool\nmatcher: Edit|Write\nentry: run.mjs\nrunner: node\ntimeout: 10\norder: 10\n',
  );
  await writeProjectFile(
    project.root,
    '.agents/hooks/protect-generated/run.mjs',
    'process.exit(0);\n',
  );
  if (options.adapterPolicy !== undefined) {
    await writeProjectFile(
      project.root,
      '.agents/adapters/claude-code.yaml',
      options.adapterPolicy,
    );
  }
  return project;
}

function manifestFor(target: TargetConfig): ProjectManifest {
  return {
    version: 2,
    scope: 'project',
    project: { id: 'demo', name: 'Demo' },
    profile: 'generic',
    docs: { language: 'en' },
    targets: [target],
    paths: { agents: '.agents', claude: '.claude' },
  };
}

describe('cross-agent contract', () => {
  it('discovers common facts without a provider overlay', async () => {
    const project = await makeCommonOnlyProject();

    const facts = await discoverCommonFacts(project.root, pathsOf(project));

    expect(facts.agents.items.map((item) => item.name)).toContain('reviewer');
    expect(facts.skills.items.map((item) => item.name)).toContain('doc-sync');
    expect(facts.rules.items.map((item) => item.name)).toContain('testing');
    expect(facts.hooks.items.map((item) => item.spec.id)).toContain('protect-generated');
    expect(facts.policy.version).toBe(1);
    expect(facts.policyPath).toBe('.agents/policies/project.yaml');
  });

  it('projects a neutral view without provider-specific fields or target paths', async () => {
    const project = await makeCommonOnlyProject({ providerFields: true });
    const paths = pathsOf(project);
    const facts = await discoverCommonFacts(project.root, paths);

    const view = await neutralView(project.root, paths, facts);

    expect(view.instructions).toMatchObject({
      path: 'AGENTS.md',
      text: '# Project\n\nRead this first.\n',
    });
    expect(view.agents).toEqual([
      {
        name: 'reviewer',
        description: 'Reviews changes.',
        body: expect.stringContaining('Review.'),
      },
    ]);
    expect(view.skills).toEqual([
      {
        name: 'doc-sync',
        description: 'Keeps docs paired.',
        body: expect.stringContaining('Sync docs.'),
      },
    ]);
    expect(view.rules).toEqual([
      { name: 'testing', paths: [], body: 'Run tests.\n' },
    ]);
    expect(view.hooks.map((hook) => hook.id)).toEqual(['protect-generated']);
    expect(view.policy.version).toBe(1);

    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('tools');
    expect(serialized).not.toContain('model');
    expect(serialized).not.toContain('permissionMode');
    expect(serialized).not.toContain('allowed-tools');
    expect(serialized).not.toContain('.claude');
    expect(serialized).not.toContain('claude-code.yaml');
  });

  it('keeps the neutral view unchanged when provider fields change', async () => {
    const plain = await makeCommonOnlyProject();
    const withProviderFields = await makeCommonOnlyProject({ providerFields: true });

    const plainPaths = pathsOf(plain);
    const fieldsPaths = pathsOf(withProviderFields);
    const plainView = await neutralView(
      plain.root,
      plainPaths,
      await discoverCommonFacts(plain.root, plainPaths),
    );
    const fieldsView = await neutralView(
      withProviderFields.root,
      fieldsPaths,
      await discoverCommonFacts(withProviderFields.root, fieldsPaths),
    );

    expect(fieldsView).toEqual(plainView);
  });

  it('keeps adapter policy out of the neutral view but inside the Claude target', async () => {
    const adapterPolicy = 'version: 1\nprovider: claude-code\npermissions:\n  deny:\n    - Bash(sudo:*)\n';
    const project = await makeCommonOnlyProject({ adapterPolicy });
    const paths = pathsOf(project);
    const facts = await discoverCommonFacts(project.root, paths);

    const view = await neutralView(project.root, paths, facts);
    expect(JSON.stringify(view)).not.toContain('Bash(sudo:*)');
    expect(JSON.stringify(view)).not.toContain('claude-code.yaml');

    const claudePolicy = await loadClaudeCodePolicy(paths);
    expect(claudePolicy.policy.permissions.deny).toContain('Bash(sudo:*)');
    const compiled = compilePolicy(facts.policy, claudePolicy.policy, facts.hooks.items);
    expect(compiled.effective.permissions.deny).toContain('Bash(sudo:*)');
  });

  it('keeps common facts available when the Claude adapter policy is missing', async () => {
    const project = await makeCommonOnlyProject();
    const paths = pathsOf(project);
    const facts = await discoverCommonFacts(project.root, paths);
    const target: TargetConfig = {
      provider: 'claude-code',
      enabled: true,
      options: {},
    };

    await expect(claudeCodeAdapter.normalize({
      paths,
      manifest: manifestFor(target),
      target,
      facts,
      fix: false,
      dryRun: true,
    })).rejects.toMatchObject({
      code: 'policy.missing',
      exitCode: 2,
    });
  });
});
