import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Diagnostic } from '../../src/core/diagnostics.ts';
import { minimalSourcePlan } from '../../src/init/adoption.ts';
import {
  planAuthoredScaffold,
  type AuthoredScaffoldInput,
  type AuthoredScaffoldPlan,
  type PracticePack,
} from '../../src/init/practice.ts';
import { scanProject } from '../../src/init/scanner.ts';
import { renderAgentFromProposal, templateFiles } from '../../src/init/templates.ts';
import type { ProjectManifest } from '../../src/model/types.ts';
import { makeTempDir } from '../helpers/tmp.ts';

const dirs: string[] = [];
let root: string;

beforeEach(async () => {
  root = await makeTempDir('dab-practice-');
  dirs.push(root);
});

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await makeTempDir(prefix);
  dirs.push(dir);
  return dir;
}

async function baseInput(
  overrides: Partial<AuthoredScaffoldInput> = {},
): Promise<AuthoredScaffoldInput> {
  return {
    root,
    scope: 'project',
    scan: await scanProject(root),
    profile: 'generic',
    mode: 'converge',
    version: '0.0.0',
    env: {},
    ...overrides,
  };
}

async function planWith(
  pack: PracticePack,
  overrides: Partial<AuthoredScaffoldInput> = {},
): Promise<AuthoredScaffoldPlan> {
  return planAuthoredScaffold(await baseInput(overrides), [pack]);
}

async function planCore(
  overrides: Partial<AuthoredScaffoldInput> = {},
): Promise<AuthoredScaffoldPlan> {
  return planAuthoredScaffold(await baseInput(overrides));
}

function errorFor(plan: AuthoredScaffoldPlan, file: string): Diagnostic | undefined {
  return plan.diagnostics.find((item) => item.severity === 'error' && item.file === file);
}

describe('planAuthoredScaffold anchors', () => {
  it('resolves anchors in two passes: existing + targets, before files', async () => {
    const seen: Array<ReadonlySet<string>> = [];
    const pack: PracticePack = {
      id: 'fake',
      targets: (context) => {
        seen.push(context.anchors);
        return { paths: ['one.md', 'two.md'] };
      },
      files: (context) => ({
        'one.md': context.anchors.has('two.md') ? 'links two' : 'missing two',
        'two.md': 'two',
      }),
    };
    const plan = await planWith(pack, { mode: 'converge' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.size).toBe(0);
    expect(plan.files['one.md']).toBe('links two');
    expect(plan.files).toEqual({ 'one.md': 'links two', 'two.md': 'two' });
    expect(plan.skipped).toEqual([]);
  });

  it('anchors existing targets but not policy-skipped targets', async () => {
    await writeFile(join(root, 'exists.md'), 'authored');
    const pack: PracticePack = {
      id: 'fake',
      targets: () => ({
        paths: ['exists.md', 'new.md', 'skip.md'],
        policySkipped: ['skip.md'],
      }),
      files: (context) => ({
        'exists.md': 'template',
        'skip.md': 'template',
        'new.md': [
          context.anchors.has('exists.md') ? 'has existing' : 'missing existing',
          context.anchors.has('skip.md') ? 'has skip' : 'no skip',
        ].join(','),
      }),
    };
    const plan = await planWith(pack);
    expect(plan.files).toEqual({ 'new.md': 'has existing,no skip' });
    expect(plan.skipped).toEqual(['exists.md']);
    expect(plan.policySkipped).toEqual(['skip.md']);
  });

  it('skips existing paths and reports policy-skipped paths separately', async () => {
    await writeFile(join(root, 'one.md'), 'authored');
    const pack: PracticePack = {
      id: 'fake',
      targets: () => ({ paths: ['one.md', 'two.md', 'three.md'], policySkipped: ['three.md'] }),
      files: () => ({ 'one.md': 'template', 'two.md': 'two', 'three.md': 'three' }),
    };
    const plan = await planWith(pack, { mode: 'converge' });
    expect(plan.skipped).toEqual(['one.md']);
    expect(plan.policySkipped).toEqual(['three.md']);
    expect(plan.files).toEqual({ 'two.md': 'two' });
    expect(plan.directories).toEqual([]);
  });
});

describe('planAuthoredScaffold path safety', () => {
  it('rejects a target path whose type conflicts', async () => {
    await mkdir(join(root, 'one.md'), { recursive: true });
    let filesCalled = false;
    const pack: PracticePack = {
      id: 'fake',
      targets: () => ({ paths: ['one.md', 'two.md'] }),
      files: () => {
        filesCalled = true;
        return { 'one.md': 'one', 'two.md': 'two' };
      },
    };
    const plan = await planWith(pack);
    expect(errorFor(plan, 'one.md')).toBeDefined();
    expect(plan.files).toEqual({});
    expect(plan.directories).toEqual([]);
    expect(filesCalled).toBe(false);
  });

  it('rejects a declared directory that is a file', async () => {
    await writeFile(join(root, 'skills'), 'not a directory');
    const pack: PracticePack = {
      id: 'fake',
      targets: () => ({ paths: [], directories: ['skills'] }),
      files: () => ({}),
    };
    const plan = await planWith(pack);
    expect(errorFor(plan, 'skills')).toBeDefined();
    expect(plan.directories).toEqual([]);
  });

  it('rejects a target whose parent is a symlink escaping the root', async () => {
    const outside = await tempDir('dab-practice-outside-');
    await symlink(outside, join(root, 'docs'), 'dir');
    const pack: PracticePack = {
      id: 'fake',
      targets: () => ({ paths: ['docs/AGENTS.md'] }),
      files: () => ({ 'docs/AGENTS.md': 'docs' }),
    };
    const plan = await planWith(pack);
    expect(errorFor(plan, 'docs/AGENTS.md')?.code).toBe('path.symlink-escape');
    expect(plan.files).toEqual({});
    expect(plan.directories).toEqual([]);
  });

  it('rejects paths that escape the root', async () => {
    const pack: PracticePack = {
      id: 'fake',
      targets: () => ({ paths: ['../outside.md'] }),
      files: () => ({ '../outside.md': 'outside' }),
    };
    const plan = await planWith(pack);
    expect(errorFor(plan, '../outside.md')?.code).toBe('path.escape');
    expect(plan.files).toEqual({});
    expect(plan.directories).toEqual([]);
  });

  it('rejects a .claude file target without needing an escape', async () => {
    const pack: PracticePack = {
      id: 'fake',
      targets: () => ({ paths: ['.claude/agents/one.md'] }),
      files: () => ({ '.claude/agents/one.md': 'generated' }),
    };
    const plan = await planWith(pack);
    expect(errorFor(plan, '.claude/agents/one.md')?.code).toBe('path.conflict');
    expect(plan.files).toEqual({});
    expect(plan.directories).toEqual([]);
  });

  it('rejects .claude directory and policy-skip declarations', async () => {
    const pack: PracticePack = {
      id: 'fake',
      targets: () => ({
        paths: [],
        directories: ['.claude/rules'],
        policySkipped: ['.claude/settings.local.json'],
      }),
      files: () => ({}),
    };
    const plan = await planWith(pack);
    expect(errorFor(plan, '.claude/rules')?.code).toBe('path.conflict');
    expect(errorFor(plan, '.claude/settings.local.json')?.code).toBe('path.conflict');
    expect(plan.files).toEqual({});
    expect(plan.directories).toEqual([]);
    expect(plan.policySkipped).toEqual([]);
  });
});

describe('planAuthoredScaffold blocked reporting', () => {
  it('preserves skipped, policySkipped and directories when a diagnostic blocks', async () => {
    await writeFile(join(root, 'existing.md'), 'authored');
    await mkdir(join(root, 'conflict.md'), { recursive: true });
    const pack: PracticePack = {
      id: 'fake',
      targets: () => ({
        paths: ['existing.md', 'conflict.md', 'skip.md'],
        directories: ['planned-dir'],
        policySkipped: ['skip.md'],
      }),
      files: () => ({ 'existing.md': 'one', 'conflict.md': 'two', 'skip.md': 'three' }),
    };
    const plan = await planWith(pack);
    expect(errorFor(plan, 'conflict.md')?.severity).toBe('error');
    expect(plan.files).toEqual({});
    expect(plan.skipped).toEqual(['existing.md']);
    expect(plan.policySkipped).toEqual(['skip.md']);
    expect(plan.directories).toEqual(['planned-dir']);
  });

  it('preserves planned directories when directories() blocks the plan', async () => {
    await writeFile(join(root, 'not-a-dir'), 'file');
    const pack: PracticePack = {
      id: 'fake',
      targets: () => ({ paths: [], directories: ['planned-dir'] }),
      files: () => ({}),
      directories: () => ['not-a-dir'],
    };
    const plan = await planWith(pack);
    expect(errorFor(plan, 'not-a-dir')?.code).toBe('path.conflict');
    expect(plan.files).toEqual({});
    expect(plan.directories).toEqual(['planned-dir']);
  });
});

describe('planAuthoredScaffold core pack', () => {
  it('plans full core files in parity with templateFiles', async () => {
    const input = await baseInput({ mode: 'full' });
    const plan = await planAuthoredScaffold(input);
    expect(plan.files).toEqual(
      templateFiles(input.scan, 'project', undefined, { profile: 'generic' }),
    );
    expect(plan.directories).toEqual(['.agents/notes']);
    expect(plan.skipped).toEqual([]);
    expect(plan.policySkipped).toEqual([]);
    expect(plan.diagnostics).toEqual([]);
    expect(plan.manifest?.profile).toBe('generic');
    expect(plan.docsLanguage).toEqual({ value: 'en', source: 'default' });
  });

  it('renders the resolved feature profile in full core files and manifest', async () => {
    const input = await baseInput({ mode: 'full', profile: 'feature' });
    const plan = await planAuthoredScaffold(input);
    expect(plan.files).toEqual(
      templateFiles(input.scan, 'project', undefined, { profile: 'feature' }),
    );
    expect(plan.files['dab.yaml']).toContain('profile: feature');
    expect(plan.manifest?.profile).toBe('feature');
  });

  it('adds proposed agents and the AGENTS.md addition in full mode', async () => {
    const agent = {
      name: 'domain-expert',
      description: 'Knows the domain rules.',
      body: 'Use the domain rules.',
    };
    const addition = '- Run the domain check before shipping.';
    const input = await baseInput({
      mode: 'full',
      proposals: { agentsMdAddition: addition, agents: [agent] },
    });
    const plan = await planAuthoredScaffold(input);
    expect(plan.files['.agents/agents/domain-expert.md']).toBe(renderAgentFromProposal(agent));
    expect(plan.files['AGENTS.md']).toBe(
      templateFiles(input.scan, 'project', addition, { profile: 'generic' })['AGENTS.md'],
    );
  });

  it('plans adoption core files and directories in parity with minimalSourcePlan', async () => {
    const input = await baseInput({ mode: 'adoption' });
    const plan = await planAuthoredScaffold(input);
    const minimal = minimalSourcePlan(input.scan, 'project');
    expect(plan.files).toEqual(minimal.files);
    expect(plan.directories).toEqual(minimal.directories);
    expect(plan.manifest).toEqual(minimal.manifest);
  });

  it('plans global adoption core files in parity with minimalSourcePlan', async () => {
    const input = await baseInput({ mode: 'adoption', scope: 'global' });
    const plan = await planAuthoredScaffold(input);
    const minimal = minimalSourcePlan(input.scan, 'global');
    expect(plan.files).toEqual(minimal.files);
    expect(plan.files).toHaveProperty('.agents/dab.yaml');
    expect(plan.directories).toEqual(minimal.directories);
  });

  it('omits the manifest target when an authored manifest wins', async () => {
    const input = await baseInput({ mode: 'adoption' });
    const manifest: ProjectManifest = {
      ...minimalSourcePlan(input.scan, 'project').manifest,
      docs: { language: 'en' },
    };
    const plan = await planAuthoredScaffold({ ...input, manifest });
    expect(plan.files).not.toHaveProperty('dab.yaml');
    expect(plan.files).toHaveProperty('.agents/policies/project.yaml');
    expect(plan.manifest).toBe(manifest);
    expect(plan.docsLanguage).toEqual({ value: 'en', source: 'config' });
  });

  it('plans no core files or directories in converge mode', async () => {
    const plan = await planCore();
    expect(plan.files).toEqual({});
    expect(plan.directories).toEqual([]);
    expect(plan.skipped).toEqual([]);
    expect(plan.policySkipped).toEqual([]);
    expect(plan.manifest).toBeUndefined();
    expect(plan.profile).toBe('generic');
    expect(plan.mode).toBe('converge');
  });
});

describe('planAuthoredScaffold declared directories', () => {
  it('keeps planning full core skill templates when .agents/skills already exists', async () => {
    await mkdir(join(root, '.agents/skills'), { recursive: true });
    const plan = await planCore({ mode: 'full' });
    expect(plan.files).toHaveProperty('.agents/skills/feature-delivery/SKILL.md');
    expect(plan.files).toHaveProperty('.agents/skills/doc-sync/SKILL.md');
    expect(plan.skipped).toEqual([]);
  });

  it('skips an existing adoption directory without hiding its files', async () => {
    await mkdir(join(root, '.agents/skills'), { recursive: true });
    const plan = await planCore({ mode: 'adoption' });
    expect(plan.skipped).toEqual(['.agents/skills']);
    expect(plan.directories).toEqual([
      '.agents/agents',
      '.agents/notes',
      '.agents/rules',
      '.agents/hooks',
    ]);
    expect(plan.files).toHaveProperty('.agents/policies/project.yaml');
  });

  it('plans children of an existing declared directory unless it opts into skipping', async () => {
    await mkdir(join(root, 'x'), { recursive: true });
    const pack: PracticePack = {
      id: 'fake',
      targets: () => ({ paths: ['x/SKILL.md'], directories: ['x'] }),
      files: () => ({ 'x/SKILL.md': 'skill' }),
    };
    const plan = await planWith(pack);
    expect(plan.files).toEqual({ 'x/SKILL.md': 'skill' });
    expect(plan.skipped).toEqual(['x']);
    expect(plan.directories).toEqual([]);
  });

  it('skips a skipChildrenWhenExists directory and suppresses its declared files', async () => {
    await mkdir(join(root, 'x'), { recursive: true });
    const pack: PracticePack = {
      id: 'skills',
      targets: () => ({
        paths: ['x/SKILL.md'],
        directories: ['x'],
        skipChildrenWhenExists: ['x'],
      }),
      files: () => ({ 'x/SKILL.md': 'skill' }),
    };
    const plan = await planWith(pack);
    expect(plan.files).toEqual({});
    expect(plan.skipped).toEqual(['x']);
    expect(plan.directories).toEqual([]);
  });

  it('plans a missing skipChildrenWhenExists directory and its files', async () => {
    const pack: PracticePack = {
      id: 'skills',
      targets: () => ({
        paths: ['x/SKILL.md'],
        directories: ['x'],
        skipChildrenWhenExists: ['x'],
      }),
      files: () => ({ 'x/SKILL.md': 'skill' }),
    };
    const plan = await planWith(pack);
    expect(plan.files).toEqual({ 'x/SKILL.md': 'skill' });
    expect(plan.skipped).toEqual([]);
    expect(plan.directories).toEqual(['x']);
  });

  it('collects directories() and keeps only missing, non-policy-skipped ones', async () => {
    await mkdir(join(root, 'exists'));
    const pack: PracticePack = {
      id: 'fake',
      targets: () => ({ paths: [], directories: ['declared'], policySkipped: ['declared', 'skip'] }),
      files: () => ({}),
      directories: () => ['exists', 'skip', 'missing'],
    };
    const plan = await planWith(pack);
    expect(plan.directories).toEqual(['missing']);
    expect(plan.policySkipped).toEqual(['declared', 'skip']);
  });
});

describe('planAuthoredScaffold docs language', () => {
  it('resolves docsLanguage from existing docs and attaches it', async () => {
    await writeFile(join(root, 'README.md'), '# README\n\n这是中文文档，用于测试。');
    const plan = await planCore();
    expect(plan.docsLanguage).toEqual({ value: 'zh', source: 'README.md' });
  });

  it('uses the supplied env for locale detection', async () => {
    const plan = await planCore({ env: { LANG: 'zh_CN.UTF-8' } });
    expect(plan.docsLanguage).toEqual({ value: 'zh', source: 'locale' });
  });

  it('prefers the configured manifest language over detection', async () => {
    await writeFile(join(root, 'README.md'), '# README\n\n这是中文文档，用于测试。');
    const input = await baseInput();
    const manifest: ProjectManifest = {
      ...minimalSourcePlan(input.scan, 'project').manifest,
      docs: { language: 'en' },
    };
    const plan = await planAuthoredScaffold({ ...input, manifest });
    expect(plan.docsLanguage).toEqual({ value: 'en', source: 'config' });
  });
});
