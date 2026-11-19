import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { discoverAgents } from '../../src/model/agents.ts';
import { makeProject, writeProjectFile, type ProjectFixture } from '../helpers/project.ts';

const projects: ProjectFixture[] = [];

async function project(): Promise<ProjectFixture> {
  const fixture = await makeProject();
  projects.push(fixture);
  return fixture;
}

afterEach(async () => {
  await Promise.all(projects.splice(0).map((item) => rm(item.root, { recursive: true, force: true })));
});

function agent(name: string, extra = ''): string {
  return `---
name: ${name}
description: Does ${name} things.
${extra}---
Prompt for ${name}.
`;
}

describe('agent discovery', () => {
  it('parses a valid agent and normalizes tool lists', async () => {
    const fixture = await project();
    await writeProjectFile(
      fixture.root,
      '.agents/agents/reviewer.md',
      agent('reviewer', 'tools: Read, Grep, Glob\ndisallowedTools: [Write, Edit]\nmemory: user\n'),
    );

    const result = await discoverAgents(fixture.root, fixture.agents);

    expect(result.diagnostics).toEqual([]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      name: 'reviewer',
      tools: ['Read', 'Grep', 'Glob'],
      disallowedTools: ['Write', 'Edit'],
      memory: 'user',
    });
  });

  it('distinguishes omitted, wildcard, empty and explicit tool specs', async () => {
    const fixture = await project();
    await writeProjectFile(
      fixture.root,
      '.agents/agents/inherit.md',
      agent('inherit', 'disallowedTools: Bash\n'),
    );
    await writeProjectFile(
      fixture.root,
      '.agents/agents/wild.md',
      agent('wild', 'tools: "*"\ndisallowedTools: Bash\n'),
    );
    await writeProjectFile(
      fixture.root,
      '.agents/agents/empty.md',
      agent('empty', 'tools: ""\n'),
    );
    await writeProjectFile(
      fixture.root,
      '.agents/agents/listed.md',
      agent('listed', 'tools: Read, Grep\ndisallowedTools: Bash\n'),
    );

    const result = await discoverAgents(fixture.root, fixture.agents);

    expect(result.items.find((item) => item.name === 'inherit')?.toolsSpec).toEqual({
      mode: 'all',
      explicit: false,
    });
    expect(result.items.find((item) => item.name === 'wild')?.toolsSpec).toEqual({
      mode: 'all',
      explicit: true,
    });
    expect(result.items.find((item) => item.name === 'empty')?.toolsSpec).toEqual({
      mode: 'none',
    });
    expect(result.items.find((item) => item.name === 'listed')?.toolsSpec).toEqual({
      mode: 'list',
      tools: ['Read', 'Grep'],
    });
    expect(
      result.diagnostics.filter((item) => item.code === 'agent.tools-empty'),
    ).toHaveLength(1);
  });

  it('rejects whitespace-separated tool tokens and mixed wildcards', async () => {
    const fixture = await project();
    await writeProjectFile(
      fixture.root,
      '.agents/agents/space.md',
      agent('space', 'tools: Read Grep\n'),
    );
    await writeProjectFile(
      fixture.root,
      '.agents/agents/mixed.md',
      agent('mixed', 'tools: ["*", Read]\n'),
    );
    await writeProjectFile(
      fixture.root,
      '.agents/agents/bad-deny.md',
      agent('bad-deny', 'disallowedTools: Bash Read\n'),
    );
    await writeProjectFile(
      fixture.root,
      '.agents/agents/two-specifiers.md',
      agent('two-specifiers', 'tools: "Read(./src/**) Bash(rm -rf:*)"\n'),
    );

    const result = await discoverAgents(fixture.root, fixture.agents);

    const invalid = result.diagnostics.filter((item) => item.code === 'agent.tools-invalid');
    expect(invalid).toHaveLength(4);
    expect(result.items.find((item) => item.name === 'space')?.toolsSpec).toEqual({
      mode: 'none',
    });
    expect(result.items.find((item) => item.name === 'two-specifiers')?.toolsSpec).toEqual({
      mode: 'none',
    });
  });

  it('rejects memory: project with a specific diagnostic', async () => {
    const fixture = await project();
    await writeProjectFile(
      fixture.root,
      '.agents/agents/reviewer.md',
      agent('reviewer', 'memory: project\n'),
    );

    const result = await discoverAgents(fixture.root, fixture.agents);

    expect(result.items).toHaveLength(1);
    expect(result.diagnostics.map((item) => item.code)).toContain('agent.memory-project');
  });

  it('rejects auto and bypass permission modes', async () => {
    const fixture = await project();
    await writeProjectFile(
      fixture.root,
      '.agents/agents/auto.md',
      agent('auto', 'permissionMode: auto\n'),
    );
    await writeProjectFile(
      fixture.root,
      '.agents/agents/bypass.md',
      agent('bypass', 'permissionMode: bypassPermissions\n'),
    );

    const result = await discoverAgents(fixture.root, fixture.agents);

    expect(result.diagnostics.filter((item) => item.code === 'agent.permission-mode')).toHaveLength(2);
  });

  it('rejects duplicate agent names', async () => {
    const fixture = await project();
    await writeProjectFile(fixture.root, '.agents/agents/one.md', agent('reviewer'));
    await writeProjectFile(fixture.root, '.agents/agents/two.md', agent('reviewer'));

    const result = await discoverAgents(fixture.root, fixture.agents);

    expect(result.diagnostics.map((item) => item.code)).toContain('agent.duplicate-name');
  });

  it('warns about unknown frontmatter fields while keeping malformed agents invalid', async () => {
    const fixture = await project();
    await writeProjectFile(
      fixture.root,
      '.agents/agents/bad.md',
      '---\nname: bad\n---\nNo description.\n',
    );
    await writeProjectFile(
      fixture.root,
      '.agents/agents/typo.md',
      agent('typo', 'toolz: Read\n'),
    );

    const result = await discoverAgents(fixture.root, fixture.agents);

    expect(result.diagnostics.filter((item) => item.code === 'agent.invalid-frontmatter')).toHaveLength(1);
    expect(result.diagnostics.filter((item) => item.code === 'agent.unknown-frontmatter')).toHaveLength(1);
    expect(result.diagnostics.find((item) => item.code === 'agent.unknown-frontmatter')?.message)
      .toContain('toolz');
    expect(result.diagnostics.find((item) => item.code === 'agent.unknown-frontmatter')?.message)
      .toContain('did you mean tools?');
    expect(result.items.map((item) => item.name)).toContain('typo');
    expect(result.items.find((item) => item.name === 'typo')?.frontmatter.toolz).toBe('Read');
  });

  it('rejects an agent hook with a non-command handler', async () => {
    const fixture = await project();
    await writeProjectFile(
      fixture.root,
      '.agents/agents/hooked.md',
      agent(
        'hooked',
        [
          'hooks:',
          '  PreToolUse:',
          '    - matcher: Bash',
          '      hooks:',
          '        - type: http',
          '          url: https://example.com',
          '',
        ].join('\n'),
      ),
    );

    const result = await discoverAgents(fixture.root, fixture.agents);

    expect(result.diagnostics.map((item) => item.code)).toContain('agent.hook-handler');
  });
});
