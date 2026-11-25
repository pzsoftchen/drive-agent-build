import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { detectProject, runDetect } from '../../src/commands/detect.ts';
import { initializeProject } from '../../src/commands/init.ts';
import { normalizeProject } from '../../src/commands/normalize.ts';
import type { CommandRunner } from '../../src/core/command.ts';
import { DAB_VERSION } from '../../src/core/version.ts';
import {
  AUTHORING_SKILL_NAMES,
  renderAuthoringSkill,
} from '../../src/init/practice-authoring.ts';
import { makeGlobalFixture } from '../helpers/global.ts';
import {
  makeInitializedProject,
  populateProject,
  syncGeneratedProjections,
} from '../helpers/initialized.ts';
import { makeProject, writeProjectFile, type ProjectFixture } from '../helpers/project.ts';
import { makeTempDir } from '../helpers/tmp.ts';

const projects: ProjectFixture[] = [];
const homes: string[] = [];

async function initialized(): Promise<ProjectFixture> {
  const project = await makeInitializedProject();
  projects.push(project);
  return project;
}

const goodRunner: CommandRunner = async () => ({
  stdout: '2.1.325 (Claude Code)\n',
  stderr: '',
  exitCode: 0,
});

const missingRunner: CommandRunner = async () => {
  throw new Error('ENOENT');
};

const cleanDocumentation = {
  'docs/AGENTS.md': '# Documentation guide\n\nOne place per fact. Write in English only.\n',
  'docs/architecture.md': `# Architecture

## Project facts

- Project: Demo

## System purpose

DAB verifies the practice layer.

## Composition

One module.

## Runtime flow

Detect reads authored files.

## Module boundaries

Single module.

## Extension points

None.

## Invariants

Tests pass.

## Verification

Run pnpm test.
`,
} as const;

/**
 * A practice-complete project: clean docs and current authoring skills with
 * projection records. Tests that observe unrelated warnings need this state so
 * the practice warnings do not decide their exit code.
 */
async function completePractice(project: ProjectFixture): Promise<void> {
  for (const [path, content] of Object.entries(cleanDocumentation)) {
    await writeProjectFile(project.root, path, content);
  }
  for (const name of AUTHORING_SKILL_NAMES) {
    await writeProjectFile(
      project.root,
      `.agents/skills/${name}/SKILL.md`,
      await renderAuthoringSkill(name, DAB_VERSION),
    );
  }
  await normalizeProject({ cwd: project.root, runner: goodRunner });
}

const oldRunner: CommandRunner = async () => ({
  stdout: '2.1.100 (Claude Code)\n',
  stderr: '',
  exitCode: 0,
});

function detectOptions(project: ProjectFixture, runner: CommandRunner = goodRunner) {
  return {
    cwd: project.root,
    runner,
    home: dirname(project.root),
  };
}

afterEach(async () => {
  await Promise.all(projects.splice(0).map((item) => rm(item.root, { recursive: true, force: true })));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe('detectProject', () => {
  it('keeps a missing Claude overlay a configuration error', async () => {
    const project = await initialized();
    await rm(join(project.root, '.agents/adapters/claude-code.yaml'));

    await expect(detectProject(detectOptions(project))).rejects.toMatchObject({
      code: 'policy.missing',
      exitCode: 2,
    });
  });

  it('keeps a damaged Claude overlay a governed configuration error', async () => {
    const project = await initialized();
    const overlay = join(project.root, '.agents/adapters/claude-code.yaml');
    await rm(overlay);
    await symlink('/nonexistent-dab-overlay', overlay);

    await expect(detectProject(detectOptions(project))).rejects.toMatchObject({
      code: 'policy.missing',
      exitCode: 2,
    });
  });

  it('passes a clean initialized project', async () => {
    const project = await initialized();
    const result = await detectProject(detectOptions(project));

    expect(result.exitCode).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
    expect(result.targets.map((item) => item.provider)).toEqual(['claude-code']);
  });

  it('omits optional hooks and memory entries from a project that has none', async () => {
    const root = await makeTempDir('dab-detect-empty-');
    projects.push({
      root,
      agents: join(root, '.agents'),
      claude: join(root, '.claude'),
    });
    const init = await initializeProject({ cwd: root, runner: goodRunner });
    expect(init.ok).toBe(true);

    const result = await detectProject({
      cwd: root,
      home: dirname(root),
      runner: goodRunner,
    });

    expect(result.phase).toBe('initialized');
    expect(result.checklist.some((entry) => entry.group === 'Hooks')).toBe(false);
    expect(result.checklist.some((entry) => entry.group === 'Memory')).toBe(false);
  });

  it('keeps hook and memory entries for a project that has them', async () => {
    const project = await initialized();

    const result = await detectProject(detectOptions(project));

    expect(result.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: 'Hooks', label: 'protect-generated', status: 'ok' }),
      expect.objectContaining({
        group: 'Memory',
        label: '.agents/memory/INDEX.md',
        status: 'ok',
      }),
    ]));
  });

  it('fails on warnings only when strict mode is enabled', async () => {
    const project = await initialized();
    await writeProjectFile(
      project.root,
      '.agents/rules/typo.md',
      '---\npathz: src/**\n---\nBody.\n',
    );
    await normalizeProject({ cwd: project.root, runner: goodRunner });

    const normal = await detectProject(detectOptions(project));
    expect(normal.summary.warnings).toBeGreaterThan(0);
    expect(normal.exitCode).toBe(0);
    expect(normal.ok).toBe(true);

    const strict = await detectProject({ ...detectOptions(project), strict: true });
    expect(strict.exitCode).toBe(3);
    expect(strict.ok).toBe(false);
  });

  it('warns but does not fail when Claude Code is missing', async () => {
    const project = await initialized();
    await completePractice(project);
    const result = await detectProject(detectOptions(project, missingRunner));
    const strict = await detectProject({
      ...detectOptions(project, missingRunner),
      strict: true,
    });

    expect(result.exitCode).toBe(0);
    expect(strict.exitCode).toBe(0);
    expect(
      result.diagnostics.some(
        (item) => item.code === 'backend.missing' && item.severity === 'warning',
      ),
    ).toBe(true);
  });

  it('returns backend exit code 4 when Claude Code is too old', async () => {
    const project = await initialized();
    const result = await detectProject(detectOptions(project, oldRunner));

    expect(result.exitCode).toBe(4);
    expect(result.diagnostics.map((item) => item.code)).toContain('backend.version');
  });

  it('flags an unmanaged root CLAUDE.md', async () => {
    const project = await initialized();
    await writeProjectFile(project.root, 'CLAUDE.md', '# user instructions\n');

    const result = await detectProject(detectOptions(project));

    expect(result.exitCode).toBe(3);
    expect(result.diagnostics.map((item) => item.code)).toContain('claude-md.unmanaged');
  });

  it('flags missing or drifted instructions', async () => {
    const project = await initialized();
    await rm(join(project.root, '.claude/CLAUDE.md'));
    const missing = await detectProject(detectOptions(project));
    expect(missing.diagnostics.map((item) => item.code)).toContain(
      'claude-md.instructions-missing',
    );

    await symlink('missing.md', join(project.root, '.claude/CLAUDE.md'));
    const drifted = await detectProject(detectOptions(project));
    expect(drifted.diagnostics.map((item) => item.code)).toContain(
      'claude-md.instructions-drift',
    );
  });

  it('warns about an ancestor CLAUDE.md', async () => {
    const project = await initialized();
    const parent = await makeTempDir('dab-ancestor-');
    const moved = join(parent, 'project');
    await rename(project.root, moved);
    try {
      await writeFile(join(parent, 'CLAUDE.md'), '# ancestor\n');
      const result = await detectProject({
        cwd: moved,
        runner: goodRunner,
        home: parent,
      });
      expect(result.exitCode).toBe(0);
      expect(
        result.diagnostics.some(
          (item) => item.code === 'claude-md.ancestor' && item.severity === 'warning',
        ),
      ).toBe(true);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('flags a broken projection symlink and a physical copy', async () => {
    const project = await initialized();
    const target = join(project.root, '.claude/agents/reviewer.md');
    await rm(target);
    await symlink('missing.md', target);
    const broken = await detectProject(detectOptions(project));
    expect(broken.diagnostics.map((item) => item.code)).toContain('projection.broken');

    await rm(target);
    await writeFile(target, 'physical copy\n');
    const physical = await detectProject(detectOptions(project));
    expect(physical.diagnostics.map((item) => item.code)).toContain('projection.physical-copy');
  });

  it('flags duplicate agent names and memory: project', async () => {
    const project = await initialized();
    await writeProjectFile(
      project.root,
      '.agents/agents/other.md',
      '---\nname: reviewer\ndescription: Other.\n---\nBody.\n',
    );
    await writeProjectFile(
      project.root,
      '.agents/agents/mem.md',
      '---\nname: mem\ndescription: Mem.\nmemory: project\n---\nBody.\n',
    );

    const result = await detectProject(detectOptions(project));

    expect(result.diagnostics.map((item) => item.code)).toContain('agent.duplicate-name');
    expect(result.diagnostics.map((item) => item.code)).toContain('agent.memory-project');
  });

  it('flags hand-edited settings as generated drift', async () => {
    const project = await initialized();
    await writeFile(join(project.root, '.claude/settings.json'), '{"permissions":{}}\n');

    const result = await detectProject(detectOptions(project));

    expect(result.exitCode).toBe(3);
    expect(result.diagnostics.map((item) => item.code)).toContain('generated.drift');
  });

  it('treats a stale manifest hash as a warning when generated bytes are correct', async () => {
    const project = await initialized();
    const path = join(project.root, 'dab.yaml');
    const text = await readFile(path, 'utf8');
    const updated = text.replace(
      /(settings:\n\s+path: \.claude\/settings\.json\n\s+sha256: )[a-f0-9]{64}/,
      `$1"${'0'.repeat(64)}"`,
    );
    expect(updated).not.toBe(text);
    await writeFile(path, updated);

    const result = await detectProject(detectOptions(project));

    expect(result.exitCode).toBe(0);
    expect(
      result.diagnostics.some(
        (item) => item.code === 'generated.manifest-stale' && item.severity === 'warning',
      ),
    ).toBe(true);
  });

  it('flags secrets in authored files', async () => {
    const project = await initialized();
    await writeProjectFile(
      project.root,
      '.agents/rules/leak.md',
      'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789\n',
    );

    const result = await detectProject(detectOptions(project));

    expect(result.diagnostics.map((item) => item.code)).toContain('secret.detected');
  });

  it('warns about an oversized AGENTS.md and flags a broken link', async () => {
    const project = await initialized();
    await writeFile(join(project.root, 'AGENTS.md'), `${'line\n'.repeat(201)}`);
    const oversized = await detectProject(detectOptions(project));
    expect(oversized.exitCode).toBe(0);
    expect(
      oversized.diagnostics.some(
        (item) => item.code === 'agents-md.too-large' && item.severity === 'warning',
      ),
    ).toBe(true);

    await writeFile(join(project.root, 'AGENTS.md'), '# Project\n[missing](docs/nope.md)\n');
    const broken = await detectProject(detectOptions(project));
    expect(broken.diagnostics.map((item) => item.code)).toContain('agents-md.broken-link');
  });

  it('flags agent memory artifacts in the repository', async () => {
    const project = await initialized();
    await mkdir(join(project.root, '.claude/agent-memory'), { recursive: true });
    const result = await detectProject(detectOptions(project));
    expect(result.diagnostics.map((item) => item.code)).toContain('memory.project-artifact');
    const artifact = result.diagnostics.find((item) => item.code === 'memory.project-artifact');
    expect(artifact?.hint).toContain('.agents/notes/');
    expect(artifact?.hint).toContain('optional');
  });

  it('flags unsafe hook scripts', async () => {
    const project = await initialized();
    await writeProjectFile(
      project.root,
      '.agents/hooks/protect-generated/hook.yaml',
      `id: protect-generated
event: pre_tool
matcher: Edit|Write
entry: run.sh
runner: exec
timeout: 10
order: 10
`,
    );
    await writeProjectFile(
      project.root,
      '.agents/hooks/protect-generated/run.sh',
      'echo hi\n',
    );

    const result = await detectProject(detectOptions(project));

    expect(result.diagnostics.map((item) => item.code)).toContain('hook.unsafe');
  });

  it('flags agent hooks that do not reference a managed project hook', async () => {
    const project = await initialized();
    await writeProjectFile(
      project.root,
      '.agents/agents/unsafe.md',
      `---
name: unsafe
description: Uses an unmanaged inline command.
hooks:
  PreToolUse:
    - matcher: Bash
      hooks:
        - type: command
          command: sh -c 'touch /tmp/dab-agent-hook-pwned'
          id: unsafe-hook
---
Unsafe.
`,
    );

    const result = await detectProject(detectOptions(project));

    expect(result.exitCode).toBe(3);
    expect(result.diagnostics.map((item) => item.code)).toContain('hook.agent-unmanaged');
  });

  it('flags duplicate memory paragraphs', async () => {
    const project = await initialized();
    const body = 'The same durable fact appears in two shared memory entries.\n';
    await writeProjectFile(
      project.root,
      '.agents/memory/INDEX.md',
      '- [A](a.md)\n- [B](b.md)\n',
    );
    for (const [name, title] of [['a.md', 'A'], ['b.md', 'B']] as const) {
      await writeProjectFile(
        project.root,
        `.agents/memory/${name}`,
        `---\ntitle: ${title}\nsource: https://example.com/${title}\nreview_by: 2027-01-01\n---\n${body}`,
      );
    }

    const result = await detectProject(detectOptions(project));

    expect(result.diagnostics.map((item) => item.code)).toContain('memory.duplicate-paragraph');
  });

  it('flags an unmanaged .claude/CLAUDE.md without a generated manifest', async () => {
    const project = await makeProject();
    projects.push(project);
    await populateProject(project);
    await writeProjectFile(project.root, '.claude/CLAUDE.md', 'user memory\n');

    const result = await detectProject(detectOptions(project));

    expect(result.diagnostics.map((item) => item.code)).toContain('claude-md.unmanaged');
  });

  it('warns instead of failing for read-only global settings', async () => {
    const home = await makeGlobalFixture();
    homes.push(home.home);
    await normalizeProject({ cwd: home.agents, home: home.home, runner: goodRunner });
    const settings = join(home.home, '.claude/settings.json');
    const content = '{"permissions":{"allow":["Bash(echo)"]}}\n';
    await writeFile(settings, content);

    const result = await detectProject({
      cwd: home.agents,
      home: home.home,
      runner: goodRunner,
    });

    expect(result.exitCode).toBe(0);
    expect(
      result.diagnostics.some(
        (item) => item.code === 'claude-settings.global-not-adopted'
          && item.severity === 'warning',
      ),
    ).toBe(true);
    expect(result.diagnostics.map((item) => item.code)).not.toContain('generated.missing');
    expect(await readFile(settings, 'utf8')).toBe(content);
  });

  it('marks a physical .claude agent importable instead of unmanaged', async () => {
    const project = await initialized();
    await writeProjectFile(
      project.root,
      '.claude/agents/extra.md',
      '---\nname: extra\ndescription: Extra.\n---\nExtra.\n',
    );

    const result = await detectProject(detectOptions(project));

    expect(result.exitCode).toBe(0);
    expect(result.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({
        group: 'Agents',
        label: '.claude/agents/extra.md',
        status: 'importable',
        detail: '.agents/agents/extra.md',
      }),
    ]));
    expect(result.diagnostics.map((item) => item.code)).not.toContain('projection.unmanaged');
  });

  it('marks a physical copy of a managed projection importable instead of a conflict', async () => {
    const project = await initialized();
    const target = join(project.root, '.claude/agents/reviewer.md');
    await rm(target);
    await writeFile(
      target,
      '---\nname: reviewer\ndescription: Physical.\n---\nReview.\n',
    );

    const result = await detectProject(detectOptions(project));

    expect(result.exitCode).toBe(0);
    expect(result.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({
        group: 'Agents',
        label: '.claude/agents/reviewer.md',
        status: 'importable',
      }),
    ]));
    expect(result.diagnostics.map((item) => item.code)).not.toContain('projection.physical-copy');
  });

  it('marks a physical .claude skill importable instead of unmanaged', async () => {
    const project = await initialized();
    await writeProjectFile(
      project.root,
      '.claude/skills/pdf-tools/SKILL.md',
      '---\nname: pdf-tools\ndescription: PDF.\n---\nPDF.\n',
    );

    const result = await detectProject(detectOptions(project));

    expect(result.exitCode).toBe(0);
    expect(result.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({
        group: 'Skills',
        label: '.claude/skills/pdf-tools',
        status: 'importable',
        detail: '.agents/skills/pdf-tools',
      }),
    ]));
    expect(result.diagnostics.map((item) => item.code)).not.toContain('projection.unmanaged');
  });

  it('keeps an invalid physical entry as an unmanaged conflict, not importable', async () => {
    const project = await initialized();
    await writeProjectFile(project.root, '.claude/agents/bad.md', 'not frontmatter\n');

    const result = await detectProject(detectOptions(project));

    expect(result.exitCode).toBe(3);
    expect(result.diagnostics.map((item) => item.code)).toContain('agent.invalid-frontmatter');
    expect(result.checklist.some((item) => item.status === 'importable')).toBe(false);
  });

  it('reports one Skills error row for an invalid authored skill', async () => {
    const project = await initialized();
    await writeProjectFile(
      project.root,
      '.agents/skills/broken/SKILL.md',
      'not frontmatter\n',
    );

    const result = await detectProject(detectOptions(project));

    expect(result.exitCode).toBe(3);
    expect(
      result.diagnostics.filter((item) => item.code === 'skill.invalid-frontmatter'),
    ).toHaveLength(1);
    const rows = result.checklist.filter(
      (entry) => entry.group === 'Skills'
        && entry.label === '.agents/skills/broken/SKILL.md',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'error' });
  });
});

describe('detect verification group', () => {
  const EMPTY_COMMANDS_CONFIG = `version: 1
gates:
  source:
    mode: required
  code:
    commands: {}
  docs:
    mode: check
`;

  const NEEDS_CONFIG_CONFIG = `version: 1
gates:
  source:
    mode: required
  code:
    commands:
      test:
        command: null
        mode: required
        needs: Configure the Xcode scheme and destination in .agents/gates.yaml.
  docs:
    mode: check
`;

  it('reports the Verification group after Skills in JSON and human output', async () => {
    const project = await initialized();
    await completePractice(project);

    const result = await detectProject(detectOptions(project));
    const groups = [...new Set(result.checklist.map((entry) => entry.group))];

    expect(groups.indexOf('Verification')).toBe(groups.indexOf('Skills') + 1);
    expect(result.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({
        group: 'Verification',
        label: '.agents/gates.yaml',
        status: 'ok',
      }),
      expect.objectContaining({
        group: 'Verification',
        label: 'scripts/dab-check.mjs',
        status: 'ok',
      }),
      expect.objectContaining({
        group: 'Verification',
        label: 'scripts/dab-gates.json',
        status: 'ok',
      }),
    ]));

    const json: string[] = [];
    const jsonCode = await runDetect(
      { ...detectOptions(project), json: true },
      { stdout: (value) => json.push(value), stderr: () => undefined },
    );
    expect(jsonCode).toBe(0);
    const payload = JSON.parse(json.join('')) as {
      checklist: Array<{ group: string; label: string; status: string }>;
    };
    const jsonGroups = [...new Set(payload.checklist.map((entry) => entry.group))];
    expect(jsonGroups.indexOf('Verification')).toBe(jsonGroups.indexOf('Skills') + 1);
    expect(payload.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({
        group: 'Verification',
        label: 'scripts/dab-gates.json',
        status: 'ok',
      }),
    ]));

    const human: string[] = [];
    const humanCode = await runDetect(
      detectOptions(project),
      { stdout: (value) => human.push(value), stderr: () => undefined },
    );
    expect(humanCode).toBe(0);
    const text = human.join('');
    expect(text).toContain('\nVerification\n');
    expect(text).toContain('[OK] scripts/dab-check.mjs');
  });

  it('fails strict for missing artifacts but not for preserved artifacts', async () => {
    const missing = await initialized();
    await completePractice(missing);
    await rm(join(missing.root, '.agents/gates.yaml'));

    const missingNormal = await detectProject(detectOptions(missing));
    expect(missingNormal.exitCode).toBe(0);
    expect(missingNormal.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'verification.config-missing',
        severity: 'warning',
      }),
    ]));
    const missingStrict = await detectProject({
      ...detectOptions(missing),
      strict: true,
    });
    expect(missingStrict.exitCode).toBe(3);

    const modified = await initialized();
    await completePractice(modified);
    const runner = await readFile(join(modified.root, 'scripts/dab-check.mjs'), 'utf8');
    await writeFile(join(modified.root, 'scripts/dab-check.mjs'), `${runner}// local edit\n`);

    const modifiedNormal = await detectProject(detectOptions(modified));
    expect(modifiedNormal.exitCode).toBe(0);
    expect(modifiedNormal.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'verification.runner-modified',
        severity: 'warning',
      }),
    ]));
    const modifiedStrict = await detectProject({
      ...detectOptions(modified),
      strict: true,
    });
    expect(modifiedStrict.exitCode).toBe(0);
  });

  it('fails normal detect when detected commands are not wired', async () => {
    const project = await initialized();
    await completePractice(project);
    await writeProjectFile(
      project.root,
      'package.json',
      '{"name":"demo","scripts":{"test":"node -e \\"process.exit(0)\\""}}\n',
    );
    await writeProjectFile(project.root, '.agents/gates.yaml', EMPTY_COMMANDS_CONFIG);
    await normalizeProject({ cwd: project.root, runner: goodRunner });

    const result = await detectProject(detectOptions(project));

    expect(result.exitCode).toBe(3);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'verification.command-missing',
        severity: 'error',
      }),
    ]));
    expect(result.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({
        group: 'Verification',
        label: 'code',
        status: 'error',
      }),
    ]));
  });

  it('fails strict for needs-config commands but not normal detect', async () => {
    const project = await initialized();
    await completePractice(project);
    await writeProjectFile(project.root, '.agents/gates.yaml', NEEDS_CONFIG_CONFIG);
    await normalizeProject({ cwd: project.root, runner: goodRunner });

    const normal = await detectProject(detectOptions(project));

    expect(normal.exitCode).toBe(0);
    expect(normal.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'verification.command-needs-config',
        severity: 'warning',
      }),
    ]));
    expect(normal.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({
        group: 'Verification',
        label: 'code.test',
        status: 'warn',
        next: 'edit .agents/gates.yaml',
      }),
    ]));

    const strict = await detectProject({ ...detectOptions(project), strict: true });
    expect(strict.exitCode).toBe(3);
  });

  it('omits the Verification group from global scope', async () => {
    const home = await makeGlobalFixture();
    homes.push(home.home);
    await normalizeProject({ cwd: home.agents, home: home.home, runner: goodRunner });

    const result = await detectProject({
      cwd: home.agents,
      home: home.home,
      runner: goodRunner,
    });

    expect(result.scope).toBe('global');
    expect(result.checklist.some((entry) => entry.group === 'Verification')).toBe(false);
    expect(result.diagnostics.some((item) => item.code.startsWith('verification.')))
      .toBe(false);
  });
});

describe('runDetect', () => {
  it('emits stable JSON and uses the configured exit codes', async () => {
    const project = await initialized();
    const first: string[] = [];
    const second: string[] = [];
    const code = await runDetect(
      { ...detectOptions(project), json: true },
      {
        stdout: (value) => first.push(value),
        stderr: () => undefined,
      },
    );
    await runDetect(
      { ...detectOptions(project), json: true },
      {
        stdout: (value) => second.push(value),
        stderr: () => undefined,
      },
    );

    expect(code).toBe(0);
    expect(first.join('')).toBe(second.join(''));
    const payload = JSON.parse(first.join('')) as {
      schemaVersion: number;
      ok: boolean;
      exitCode: number;
      diagnostics: unknown[];
      targets: Array<{ provider: string; statuses: unknown[] }>;
      summary: { errors: number; warnings: number };
      scope: string;
      root: string;
      phase: string;
      checklist: Array<{ group: string; label: string; status: string; next?: string }>;
      score: { ok: number; total: number; percent: number };
      nextActions: string[];
    };
    expect(payload.schemaVersion).toBe(1);
    expect(payload.ok).toBe(true);
    expect(payload.exitCode).toBe(0);
    expect(Array.isArray(payload.diagnostics)).toBe(true);
    expect(payload.targets.map((item) => item.provider)).toEqual(['claude-code']);
    expect(payload.targets[0]?.statuses.length).toBeGreaterThan(0);
    expect(payload.summary.errors).toBe(0);
    expect(payload.scope).toBe('project');
    expect(payload.root).toBe(project.root);
    expect(payload.phase).toBe('initialized');
    expect(payload.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: 'Instructions', label: 'AGENTS.md', status: 'ok' }),
      expect.objectContaining({ group: 'Agents', label: 'reviewer', status: 'ok' }),
      expect.objectContaining({
        group: 'Documentation',
        label: 'docs/AGENTS.md',
        status: 'missing',
        next: 'dab normalize',
      }),
      expect.objectContaining({
        group: 'Skills',
        label: 'dab-architecture-writing',
        status: 'missing',
        next: 'dab normalize',
      }),
    ]));
    expect(payload.score.ok).toBeGreaterThan(0);
    expect(payload.score.total).toBeGreaterThanOrEqual(payload.score.ok);
    expect(payload.nextActions).toEqual(['dab normalize']);

    await writeProjectFile(project.root, 'CLAUDE.md', '# user\n');
    const failing: string[] = [];
    const failingCode = await runDetect(
      { ...detectOptions(project), json: true },
      { stdout: (value) => failing.push(value), stderr: () => undefined },
    );
    expect(failingCode).toBe(3);
    expect((JSON.parse(failing.join('')) as { ok: boolean }).ok).toBe(false);
  });

  it('returns config exit code 2 with a partial preflight checklist', async () => {
    const project = await makeProject();
    projects.push(project);
    const stdout: string[] = [];
    const code = await runDetect(
      {
        cwd: project.root,
        home: dirname(project.root),
        json: true,
        runner: goodRunner,
      },
      { stdout: (value) => stdout.push(value), stderr: () => undefined },
    );

    expect(code).toBe(2);
    const payload = JSON.parse(stdout.join('')) as {
      schemaVersion: number;
      ok: boolean;
      scope: string;
      root: string;
      phase: string;
      checklist: Array<{ label: string; status: string }>;
      score: { total: number };
      error?: { code: string };
    };
    expect(payload.schemaVersion).toBe(1);
    expect(payload.ok).toBe(false);
    expect(payload.scope).toBe('project');
    expect(payload.root).toBe(project.root);
    expect(payload.phase).toBe('partial');
    expect(payload.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'dab.yaml', status: 'missing' }),
    ]));
    expect(payload.score.total).toBeGreaterThan(0);
    expect(payload.error).toBeUndefined();
  });

  it('prints a checklist in human output', async () => {
    const project = await initialized();
    const stdout: string[] = [];
    const code = await runDetect(
      detectOptions(project),
      { stdout: (value) => stdout.push(value), stderr: () => undefined },
    );

    expect(code).toBe(0);
    const text = stdout.join('');
    expect(text).toContain('dab detect');
    expect(text).toContain('Scope: project');
    expect(text).toContain(`Root: ${project.root}`);
    expect(text).toContain('Profile: feature');
    expect(text).toContain('Instructions');
    expect(text).toContain('[OK] AGENTS.md');
    expect(text).toContain('score:');
  });

  it('reports missing practice docs and skills in initialized projects', async () => {
    const project = await initialized();

    const result = await detectProject(detectOptions(project));

    expect(result.exitCode).toBe(0);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'practice.docs-missing', severity: 'warning' }),
      expect.objectContaining({ code: 'practice.skill-missing', severity: 'warning' }),
    ]));
    expect(result.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({
        group: 'Documentation',
        label: 'docs/AGENTS.md',
        status: 'missing',
        next: 'dab normalize',
      }),
      expect.objectContaining({
        group: 'Skills',
        label: 'dab-architecture-writing',
        status: 'missing',
        next: 'dab normalize',
      }),
    ]));
    expect((await detectProject({ ...detectOptions(project), strict: true })).exitCode).toBe(3);
  });

  it('keeps modified managed skills non-strict while stale skills fail strict', async () => {
    const project = await initialized();
    await completePractice(project);
    const skillFile = '.agents/skills/dab-doc-writing/SKILL.md';
    const modified = `${await renderAuthoringSkill('dab-doc-writing', DAB_VERSION)}\nLocal note.\n`;
    await writeProjectFile(project.root, skillFile, modified);
    await syncGeneratedProjections(project.root);

    const modifiedResult = await detectProject(detectOptions(project));
    expect(modifiedResult.exitCode).toBe(0);
    expect(modifiedResult.diagnostics.map((item) => item.code)).toContain(
      'practice.skill-modified',
    );
    expect(modifiedResult.diagnostics.map((item) => item.code)).not.toContain(
      'generated.manifest-stale',
    );
    expect((await detectProject({ ...detectOptions(project), strict: true })).exitCode).toBe(0);
    expect(await readFile(join(project.root, skillFile), 'utf8')).toBe(modified);

    const stale = await renderAuthoringSkill('dab-doc-writing', '0.0.0');
    await writeProjectFile(project.root, skillFile, stale);
    await syncGeneratedProjections(project.root);

    const staleResult = await detectProject(detectOptions(project));
    expect(staleResult.diagnostics.map((item) => item.code)).toContain(
      'practice.skill-stale',
    );
    // Only the stale state drives the strict failure in this fixture.
    expect(staleResult.diagnostics.map((item) => item.code)).not.toContain(
      'generated.manifest-stale',
    );
    expect((await detectProject({ ...detectOptions(project), strict: true })).exitCode).toBe(3);
    expect(await readFile(join(project.root, skillFile), 'utf8')).toBe(stale);
  });

  it('maps initialized diagnostics into checklist entries', async () => {
    const project = await initialized();
    await completePractice(project);
    await writeProjectFile(project.root, 'CLAUDE.md', '# user instructions\n');

    const result = await detectProject(detectOptions(project));

    expect(result.exitCode).toBe(3);
    expect(result.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: 'Instructions', label: 'CLAUDE.md', status: 'error' }),
    ]));
    expect(result.nextActions).toEqual([]);
  });

  it('reports a global checklist without writing settings or gitignore', async () => {
    const home = await makeGlobalFixture();
    homes.push(home.home);
    await normalizeProject({ cwd: home.agents, home: home.home, runner: goodRunner });
    const settings = join(home.home, '.claude/settings.json');
    const settingsContent = '{"permissions":{"allow":["Bash(echo)"]}}\n';
    await writeFile(settings, settingsContent);
    const gitignore = join(home.home, '.gitignore');
    const gitignoreContent = 'node_modules\n';
    await writeFile(gitignore, gitignoreContent);

    const result = await detectProject({
      cwd: home.agents,
      home: home.home,
      runner: goodRunner,
    });

    expect(result.scope).toBe('global');
    expect(result.root).toBe(home.home);
    expect(result.phase).toBe('initialized');
    expect(result.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: 'Agents', label: 'reviewer', status: 'ok' }),
    ]));
    expect(await readFile(settings, 'utf8')).toBe(settingsContent);
    expect(await readFile(gitignore, 'utf8')).toBe(gitignoreContent);
  });

  it('rejects Windows with a versioned JSON error', async () => {
    const project = await makeProject();
    projects.push(project);
    const stdout: string[] = [];
    const code = await runDetect(
      { cwd: project.root, json: true, platform: 'win32', runner: goodRunner },
      { stdout: (value) => stdout.push(value), stderr: () => undefined },
    );

    expect(code).toBe(3);
    const payload = JSON.parse(stdout.join('')) as {
      schemaVersion: number;
      error: { code: string };
    };
    expect(payload.schemaVersion).toBe(1);
    expect(payload.error.code).toBe('platform.unsupported');
  });
});
