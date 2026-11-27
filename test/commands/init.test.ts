import { afterEach, describe, expect, it } from 'vitest';
import { chmod, lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initializeProject, runInit } from '../../src/commands/init.ts';
import { normalizeProject } from '../../src/commands/normalize.ts';
import type { CommandRunner } from '../../src/core/command.ts';
import {
  parseGateRunnerMarker,
  parseGateSnapshot,
} from '../../src/core/gate-artifacts.ts';
import { lstatOrNull } from '../../src/core/fs-atomic.ts';
import { DAB_VERSION } from '../../src/core/version.ts';
import { renderGateStarter } from '../../src/init/gate-templates.ts';
import { renderGateRunner } from '../../src/init/gate-runner-template.ts';
import { scanProject } from '../../src/init/scanner.ts';
import { renderAuthoringSkill } from '../../src/init/skill-templates.ts';
import {
  getGeneratedTarget,
  loadProjectManifest,
} from '../../src/model/project-manifest.ts';
import { makeTempDir } from '../helpers/tmp.ts';

const goodRunner: CommandRunner = async () => ({
  stdout: '2.1.325 (Claude Code)\n',
  stderr: '',
  exitCode: 0,
});

const GATE_FILES = [
  '.agents/gates.yaml',
  'scripts/dab-check.mjs',
  'scripts/dab-gates.json',
] as const;

const VALID_GATE_CONFIG = `version: 1
gates:
  source:
    mode: required
  code:
    commands:
      test:
        command: custom-test
        mode: required
  docs:
    mode: check
`;

const dirs: string[] = [];
const canDenyRead = process.platform !== 'win32'
  && typeof process.getuid === 'function'
  && process.getuid() !== 0;

async function tempDir(): Promise<string> {
  const dir = await makeTempDir('dab-init-');
  dirs.push(dir);
  return dir;
}

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    },
  };
}

async function packageJson(root: string, name = 'demo-app'): Promise<void> {
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name, scripts: { test: 'vitest run', build: 'tsc' } }),
  );
}

function featureManifest(language: 'auto' | 'en' | 'zh'): string {
  return `version: 2
scope: project
project:
  id: demo-app
  name: demo-app
profile: feature
docs:
  language: ${language}
targets:
  - provider: claude-code
    enabled: true
    options:
      minVersion: 2.1.277
      instructions: symlink
paths:
  agents: .agents
  claude: .claude
`;
}

const PRACTICE_DOC_FILES = ['docs/AGENTS.md', 'docs/architecture.md'] as const;
const PRACTICE_SKILL_FILES = [
  '.agents/skills/dab-doc-writing/SKILL.md',
  '.agents/skills/dab-architecture-writing/SKILL.md',
  '.agents/skills/dab-decision-notes/SKILL.md',
] as const;

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('runInit', () => {
  it('defaults to generic with docs.language auto', async () => {
    const root = await tempDir();
    const result = await initializeProject({ cwd: root });
    const manifest = await loadProjectManifest(root, { scope: 'project' });
    expect(result.ok).toBe(true);
    expect(manifest.manifest.profile).toBe('generic');
    expect(manifest.manifest.docs.language).toBe('auto');
    expect(await readFile(join(root, 'dab.yaml'), 'utf8')).toContain('profile: generic');
    expect(await readFile(join(root, 'dab.yaml'), 'utf8')).toContain('docs:\n  language: auto');
  });

  it('does not scaffold advanced hooks or shared memory by default', async () => {
    const root = await tempDir();

    const result = await initializeProject({ cwd: root });

    expect(result.ok).toBe(true);
    expect(result.created).not.toContain('.agents/hooks/protect-generated/hook.yaml');
    expect(result.created).not.toContain('.agents/hooks/protect-generated/run.mjs');
    expect(result.created).not.toContain('.agents/memory/INDEX.md');
    expect(await lstatOrNull(join(root, '.agents/hooks'))).toBeNull();
    expect(await lstatOrNull(join(root, '.agents/memory'))).toBeNull();
    const agentsMd = await readFile(join(root, 'AGENTS.md'), 'utf8');
    expect(agentsMd).toContain(
      'Durable team knowledge lives in `.agents/notes/` and project docs',
    );
    expect(agentsMd).not.toContain('.agents/memory/');
  });

  it('does not plan advanced hooks or shared memory in --dry-run', async () => {
    const root = await tempDir();

    const result = await initializeProject({ cwd: root, dryRun: true });

    expect(result.ok).toBe(true);
    expect(result.created.some(
      (file) => file.startsWith('.agents/hooks/') || file.startsWith('.agents/memory/'),
    )).toBe(false);
    expect(await lstatOrNull(join(root, '.agents'))).toBeNull();
  });

  it('accepts feature as a compatibility profile', async () => {
    const root = await tempDir();
    const result = await initializeProject({ cwd: root, profile: 'feature' });
    expect(result.ok).toBe(true);
    expect((await loadProjectManifest(root, { scope: 'project' })).manifest.profile).toBe('feature');
    expect(await readFile(join(root, 'dab.yaml'), 'utf8')).toContain('profile: feature');
    expect(result.created).toEqual(expect.arrayContaining([
      'docs/AGENTS.md',
      '.agents/skills/dab-doc-writing/SKILL.md',
    ]));
    expect(result.created.some(
      (file) => file.startsWith('.agents/hooks/') || file.startsWith('.agents/memory/'),
    )).toBe(false);
    expect(await lstatOrNull(join(root, '.agents/hooks'))).toBeNull();
    expect(await lstatOrNull(join(root, '.agents/memory'))).toBeNull();
  });

  it('creates a full skeleton and normalized Claude Code outputs', async () => {
    const root = await tempDir();
    await packageJson(root);
    const captureResult = capture();

    const code = await runInit(
      { cwd: root, json: true },
      captureResult.io,
    );

    expect(code).toBe(0);
    const payload = JSON.parse(captureResult.stdout.join('')) as {
      schemaVersion: number;
      ok: boolean;
      scope: string;
      root: string;
      scopeRoot: string;
      created: string[];
      normalize: { ok: boolean };
    };
    expect(payload.schemaVersion).toBe(1);
    expect(payload.ok).toBe(true);
    expect(payload.scope).toBe('project');
    expect(payload.root).toBe(root);
    expect(payload.scopeRoot).toBe(root);
    expect(payload.created).toEqual(expect.arrayContaining(['AGENTS.md', 'dab.yaml']));
    expect(payload.created).not.toContain('.agents/hooks/protect-generated/hook.yaml');
    expect(payload.created).not.toContain('.agents/memory/INDEX.md');
    expect(await lstatOrNull(join(root, '.agents/hooks'))).toBeNull();
    expect(await lstatOrNull(join(root, '.agents/memory'))).toBeNull();
    expect(payload.normalize.ok).toBe(true);

    expect(await lstatOrNull(join(root, 'AGENTS.md'))).not.toBeNull();
    expect(await lstatOrNull(join(root, 'dab.yaml'))).not.toBeNull();
    expect((await lstatOrNull(join(root, '.claude/CLAUDE.md')))?.isSymbolicLink()).toBe(true);
    expect(await readlink(join(root, '.claude/CLAUDE.md'))).toBe('../AGENTS.md');
    expect(await lstatOrNull(join(root, '.claude/settings.json'))).not.toBeNull();
    expect(await readlink(join(root, '.claude/agents/implementer.md'))).toContain(
      '.agents/agents/implementer.md',
    );
    expect(await readlink(join(root, '.claude/skills/doc-sync'))).toContain(
      '.agents/skills/doc-sync',
    );
    expect(await lstatOrNull(join(root, '.claude/rules/testing.md'))).not.toBeNull();
    expect(await lstatOrNull(join(root, '.claude/settings.local.json'))).toBeNull();

    expect(await lstatOrNull(join(root, '.agents/rules/docs-bilingual.md'))).toBeNull();
    expect(await lstatOrNull(join(root, '.claude/rules/docs-bilingual.md'))).toBeNull();

    const manifest = await loadProjectManifest(root);
    expect(manifest.manifest.profile).toBe('generic');
    expect(manifest.manifest.docs.language).toBe('auto');
    expect(manifest.manifest.scope).toBe('project');
    const generated = getGeneratedTarget(manifest.manifest, 'claude-code');
    expect(generated?.instructions?.mode).toBe('symlink');
    expect(generated?.projections.length ?? 0).toBeGreaterThan(0);
  });

  it('generates single-language core documentation templates', async () => {
    const root = await tempDir();
    await initializeProject({ cwd: root });

    const agentsMd = await readFile(join(root, 'AGENTS.md'), 'utf8');
    const docSync = await readFile(join(root, '.agents/skills/doc-sync/SKILL.md'), 'utf8');

    expect(agentsMd).not.toContain('English and Chinese');
    expect(agentsMd).toContain('Update project documentation when a user-facing behavior changes.');
    expect(docSync).not.toContain('English and Chinese');
    expect(docSync).toContain(
      'description: Updates project documentation and runs the documentation gates.',
    );
  });

  it('preserves an existing AGENTS.md', async () => {
    const root = await tempDir();
    await packageJson(root);
    await writeFile(join(root, 'AGENTS.md'), '# Custom project instructions\n');
    const captureResult = capture();

    const code = await runInit({ cwd: root, json: true }, captureResult.io);

    expect(code).toBe(0);
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe(
      '# Custom project instructions\n',
    );
    const payload = JSON.parse(captureResult.stdout.join('')) as { skipped: string[] };
    expect(payload.skipped).toContain('AGENTS.md');
  });

  it('writes authored files and leaves unmanaged settings pending', async () => {
    const root = await tempDir();
    await mkdir(join(root, '.claude'));
    await writeFile(join(root, '.claude/settings.json'), '{"permissions":{}}\n');
    const captureResult = capture();

    const code = await runInit({ cwd: root, json: true }, captureResult.io);

    expect(code).toBe(0);
    const payload = JSON.parse(captureResult.stdout.join('')) as {
      ok: boolean;
      dryRun: boolean;
      pending: Array<{ code: string }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.dryRun).toBe(false);
    expect(payload.pending.map((item) => item.code)).toContain('claude-settings.unmanaged');
    expect(await lstatOrNull(join(root, 'AGENTS.md'))).not.toBeNull();
    expect(await lstatOrNull(join(root, 'dab.yaml'))).not.toBeNull();
    expect(await lstatOrNull(join(root, '.agents'))).not.toBeNull();
    expect(await readFile(join(root, '.claude/settings.json'), 'utf8')).toBe(
      '{"permissions":{}}\n',
    );
    expect(await lstatOrNull(join(root, '.claude/CLAUDE.md'))).toBeNull();
  });

  it('aborts without writes on an unmanaged root CLAUDE.md', async () => {
    const root = await tempDir();
    await packageJson(root);
    await writeFile(join(root, 'CLAUDE.md'), '# user instructions\n');
    const captureResult = capture();

    const code = await runInit({ cwd: root, json: true }, captureResult.io);

    expect(code).toBe(3);
    expect(await lstatOrNull(join(root, 'AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(root, 'dab.yaml'))).toBeNull();
    expect(await readFile(join(root, 'CLAUDE.md'), 'utf8')).toBe('# user instructions\n');
  });

  it('writes authored files and leaves an unmanaged .claude/CLAUDE.md pending', async () => {
    const root = await tempDir();
    await packageJson(root);
    await mkdir(join(root, '.claude'));
    await writeFile(join(root, '.claude/CLAUDE.md'), 'user memory\n');
    const captureResult = capture();

    const code = await runInit({ cwd: root, json: true }, captureResult.io);

    expect(code).toBe(0);
    const payload = JSON.parse(captureResult.stdout.join('')) as {
      ok: boolean;
      pending: Array<{ code: string }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.pending.map((item) => item.code)).toContain('claude-md.unmanaged');
    expect(await lstatOrNull(join(root, 'AGENTS.md'))).not.toBeNull();
    expect(await lstatOrNull(join(root, 'dab.yaml'))).not.toBeNull();
    expect(await readFile(join(root, '.claude/CLAUDE.md'), 'utf8')).toBe('user memory\n');
  });

  it('previews without writing when --dry-run is used', async () => {
    const parent = await tempDir();
    const target = join(parent, 'new-project');
    const captureResult = capture();

    const code = await runInit(
      { cwd: parent, path: 'new-project', dryRun: true, json: true },
      captureResult.io,
    );

    expect(code).toBe(0);
    const payload = JSON.parse(captureResult.stdout.join('')) as {
      ok: boolean;
      dryRun: boolean;
      created: string[];
      pending: unknown[];
    };
    expect(payload.ok).toBe(true);
    expect(payload.dryRun).toBe(true);
    expect(payload.created).toEqual(expect.arrayContaining(['AGENTS.md', 'dab.yaml']));
    expect(payload.pending).toEqual([]);
    expect(await lstatOrNull(target)).toBeNull();
  });

  it('reports pending conflicts in --dry-run without writing', async () => {
    const root = await tempDir();
    await packageJson(root);
    await mkdir(join(root, '.claude'));
    await writeFile(join(root, '.claude/settings.json'), '{"permissions":{}}\n');
    const captureResult = capture();

    const code = await runInit({ cwd: root, dryRun: true, json: true }, captureResult.io);

    expect(code).toBe(0);
    const payload = JSON.parse(captureResult.stdout.join('')) as {
      dryRun: boolean;
      pending: Array<{ code: string }>;
    };
    expect(payload.dryRun).toBe(true);
    expect(payload.pending.map((item) => item.code)).toContain('claude-settings.unmanaged');
    expect(await lstatOrNull(join(root, 'AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(root, 'dab.yaml'))).toBeNull();
    expect(await readFile(join(root, '.claude/settings.json'), 'utf8')).toBe(
      '{"permissions":{}}\n',
    );
  });

  it('can be completed by normalize --fix after pending conflicts', async () => {
    const root = await tempDir();
    await packageJson(root);
    await mkdir(join(root, '.claude'));
    await writeFile(join(root, '.claude/settings.json'), '{"permissions":{}}\n');
    await runInit({ cwd: root }, capture().io);

    const normalized = await normalizeProject({
      cwd: root,
      fix: true,
      now: new Date('2026-11-16T12:00:00Z'),
    });

    expect(normalized.ok).toBe(true);
    expect(await readFile(join(root, '.claude/settings.json'), 'utf8')).not.toBe(
      '{"permissions":{}}\n',
    );
    expect(await lstatOrNull(join(root, '.claude/CLAUDE.md'))).not.toBeNull();
    expect(normalized.backups.some((item) => item.endsWith('.claude/settings.json'))).toBe(true);
    expect(normalized.backups.every((item) => item.startsWith('.dab/backups/'))).toBe(true);
    expect(normalized.gitignore.path).toBe('.gitignore');
  });

  it('keeps unknown-frontmatter warnings in dry-run output', async () => {
    const root = await tempDir();
    await packageJson(root);
    await mkdir(join(root, '.agents/agents'), { recursive: true });
    await writeFile(
      join(root, '.agents/agents/typo.md'),
      '---\nname: typo\ndescription: Typo.\ntoolz: Read\n---\nBody.\n',
    );
    const captureResult = capture();

    const code = await runInit({ cwd: root, dryRun: true, json: true }, captureResult.io);

    expect(code).toBe(0);
    const payload = JSON.parse(captureResult.stdout.join('')) as {
      scopeRoot: string;
      diagnostics: Array<{ code: string }>;
    };
    expect(payload.scopeRoot).toBe(root);
    expect(payload.diagnostics.map((item) => item.code))
      .toContain('agent.unknown-frontmatter');
  });

  it('rejects --ai with --dry-run', async () => {
    const root = await tempDir();
    const captureResult = capture();

    const code = await runInit(
      { cwd: root, ai: true, dryRun: true, json: true },
      captureResult.io,
    );

    expect(code).toBe(2);
    const payload = JSON.parse(captureResult.stdout.join('')) as {
      error: { code: string };
    };
    expect(payload.error.code).toBe('usage.ai-dry-run');
  });

  it('rejects an unknown profile without writing', async () => {
    const root = await tempDir();
    const captureResult = capture();

    const code = await runInit(
      { cwd: root, profile: 'nope' as 'generic' },
      captureResult.io,
    );

    expect(code).toBe(2);
    expect(await lstatOrNull(join(root, 'AGENTS.md'))).toBeNull();
  });

  it('is idempotent', async () => {
    const root = await tempDir();
    await packageJson(root);
    await runInit({ cwd: root }, capture().io);
    const agents = await readFile(join(root, 'AGENTS.md'), 'utf8');
    const settings = await readFile(join(root, '.claude/settings.json'), 'utf8');
    const captureResult = capture();

    const code = await runInit({ cwd: root, json: true }, captureResult.io);

    expect(code).toBe(0);
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe(agents);
    expect(await readFile(join(root, '.claude/settings.json'), 'utf8')).toBe(settings);
    const payload = JSON.parse(captureResult.stdout.join('')) as { created: string[] };
    expect(payload.created).toEqual([]);
  });

  it('applies a confirmed AI proposal', async () => {
    const root = await tempDir();
    await packageJson(root);
    const proposal = {
      agentsMdAddition: '## AI rules\n\n- Prefer small diffs.\n',
      agents: [
        {
          name: 'ai-helper',
          description: 'Helps with scoped implementation work.',
          body: 'You help with scoped implementation work.',
        },
      ],
    };
    const runner: CommandRunner = async () => ({
      stdout: JSON.stringify({ result: JSON.stringify(proposal) }),
      stderr: '',
      exitCode: 0,
    });
    const captureResult = capture();

    const code = await runInit(
      {
        cwd: root,
        ai: true,
        json: true,
        runner,
        confirm: async () => true,
      },
      captureResult.io,
    );

    expect(code).toBe(0);
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toContain('## AI rules');
    expect(await lstatOrNull(join(root, '.agents/agents/ai-helper.md'))).not.toBeNull();
    const payload = JSON.parse(captureResult.stdout.join('')) as {
      ai: { applied: boolean };
    };
    expect(payload.ai.applied).toBe(true);
  });

  it('writes nothing when the AI proposal is declined', async () => {
    const root = await tempDir();
    await packageJson(root);
    const runner: CommandRunner = async () => ({
      stdout: JSON.stringify({
        result: JSON.stringify({ agentsMdAddition: 'note\n', agents: [] }),
      }),
      stderr: '',
      exitCode: 0,
    });
    const captureResult = capture();

    const code = await runInit(
      {
        cwd: root,
        ai: true,
        json: true,
        runner,
        confirm: async () => false,
      },
      captureResult.io,
    );

    expect(code).toBe(0);
    expect(await lstatOrNull(join(root, 'AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(root, 'dab.yaml'))).toBeNull();
    expect(await lstatOrNull(join(root, '.agents'))).toBeNull();
    const payload = JSON.parse(captureResult.stdout.join('')) as {
      ai: { applied: boolean };
    };
    expect(payload.ai.applied).toBe(false);
  });

  it('rejects invalid AI JSON without writing', async () => {
    const root = await tempDir();
    await packageJson(root);
    const runner: CommandRunner = async () => ({
      stdout: JSON.stringify({ result: 'not json' }),
      stderr: '',
      exitCode: 0,
    });
    const captureResult = capture();

    const code = await runInit(
      {
        cwd: root,
        ai: true,
        json: true,
        runner,
        confirm: async () => true,
      },
      captureResult.io,
    );

    expect(code).toBe(2);
    expect(await lstatOrNull(join(root, 'AGENTS.md'))).toBeNull();
    const payload = JSON.parse(captureResult.stdout.join('')) as {
      schemaVersion: number;
      error: { code: string };
    };
    expect(payload.schemaVersion).toBe(1);
    expect(payload.error.code).toBe('ai.invalid-proposal');
  });

  it('requires confirmation for AI init', async () => {
    const root = await tempDir();
    const captureResult = capture();
    const code = await runInit({ cwd: root, ai: true, json: true }, captureResult.io);
    expect(code).toBe(2);
    expect(await lstatOrNull(join(root, 'AGENTS.md'))).toBeNull();
    const payload = JSON.parse(captureResult.stdout.join('')) as {
      schemaVersion: number;
      error: { code: string };
    };
    expect(payload.schemaVersion).toBe(1);
    expect(payload.error.code).toBe('init.ai-confirmation-required');
  });

  it('aborts before writing when existing authored sources are invalid', async () => {
    const root = await tempDir();
    await packageJson(root);
    await mkdir(join(root, '.agents/agents'), { recursive: true });
    await writeFile(join(root, '.agents/agents/bad.md'), '---\nname: bad\n---\nBody.\n');
    const captureResult = capture();

    const code = await runInit({ cwd: root, json: true }, captureResult.io);

    expect(code).toBe(3);
    expect(await lstatOrNull(join(root, 'AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(root, 'dab.yaml'))).toBeNull();
  });

  it('supports an init path argument', async () => {
    const parent = await tempDir();
    const captureResult = capture();

    const code = await runInit(
      { cwd: parent, path: 'project', json: true },
      captureResult.io,
    );

    expect(code).toBe(0);
    expect(await lstatOrNull(join(parent, 'project/AGENTS.md'))).not.toBeNull();
    expect(await lstatOrNull(join(parent, 'project/dab.yaml'))).not.toBeNull();
  });

  it('leaves existing .claude agents and skills to normalize instead of importing them', async () => {
    const root = await tempDir();
    await packageJson(root);
    const agent = '---\nname: extra\ndescription: Extra.\n---\nExtra.\n';
    const skill = '---\nname: pdf-tools\ndescription: PDF.\n---\nPDF.\n';
    await mkdir(join(root, '.claude/agents'), { recursive: true });
    await mkdir(join(root, '.claude/skills/pdf-tools'), { recursive: true });
    await writeFile(join(root, '.claude/agents/extra.md'), agent);
    await writeFile(join(root, '.claude/skills/pdf-tools/SKILL.md'), skill);
    const captureResult = capture();

    const code = await runInit({ cwd: root, json: true }, captureResult.io);

    expect(code).toBe(0);
    // Init keeps its behavior on existing .claude trees: no import, no backup.
    expect(await lstatOrNull(join(root, '.agents/agents/extra.md'))).toBeNull();
    expect(await lstatOrNull(join(root, '.agents/skills/pdf-tools'))).toBeNull();
    expect((await lstat(join(root, '.claude/agents/extra.md'))).isFile()).toBe(true);
    expect((await lstat(join(root, '.claude/skills/pdf-tools/SKILL.md'))).isFile()).toBe(true);
    expect(await readFile(join(root, '.claude/agents/extra.md'), 'utf8')).toBe(agent);
    expect(await lstatOrNull(join(root, '.dab'))).toBeNull();
  });

  it('creates single-language docs and authoring skills by default', async () => {
    const root = await tempDir();

    const result = await initializeProject({ cwd: root });

    expect(result.ok).toBe(true);
    expect(result.created).toEqual(expect.arrayContaining([
      ...PRACTICE_DOC_FILES,
      ...PRACTICE_SKILL_FILES,
    ]));
    expect(result.created).not.toContain('docs/AGENTS.zh.md');
    expect(result.created).not.toContain('.agents/rules/docs-bilingual.md');
    const agentsMd = await readFile(join(root, 'AGENTS.md'), 'utf8');
    expect(agentsMd).toContain(
      '## Documentation\n\n- [docs/AGENTS.md](docs/AGENTS.md)\n- [docs/architecture.md](docs/architecture.md)',
    );
    const skill = await readFile(join(root, PRACTICE_SKILL_FILES[0]), 'utf8');
    expect(skill).toContain('<!-- dab-skill: dab-doc-writing@');
    expect(['en', 'zh']).toContain(result.language.value);
    expect((await lstat(join(root, '.claude/skills/dab-doc-writing'))).isSymbolicLink()).toBe(true);
  });

  it('adds Documentation links when docs exist or are planned', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs/AGENTS.md'), '# Authored docs\n');

    const result = await initializeProject({ cwd: root });

    expect(result.ok).toBe(true);
    expect(result.created).not.toContain('docs/AGENTS.md');
    expect(result.created).toContain('docs/architecture.md');
    expect(await readFile(join(root, 'docs/AGENTS.md'), 'utf8')).toBe('# Authored docs\n');
    const agentsMd = await readFile(join(root, 'AGENTS.md'), 'utf8');
    expect(agentsMd).toContain('## Documentation');
    expect(agentsMd).toContain('- [docs/architecture.md](docs/architecture.md)');
  });

  it('does not add the Documentation section when a bilingual rule policy-skips docs', async () => {
    const root = await tempDir();
    await mkdir(join(root, '.agents/rules'), { recursive: true });
    await writeFile(join(root, '.agents/rules/docs-bilingual.md'), 'paired docs');

    const result = await initializeProject({ cwd: root });

    expect(result.ok).toBe(true);
    expect(result.created).not.toContain('docs/AGENTS.md');
    expect(result.created).not.toContain('docs/architecture.md');
    expect(result.created).toContain(PRACTICE_SKILL_FILES[0]);
    expect(await lstatOrNull(join(root, 'docs'))).toBeNull();
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).not.toContain('## Documentation');
    expect(await readFile(join(root, '.agents/rules/docs-bilingual.md'), 'utf8'))
      .toBe('paired docs');
    expect(result.diagnostics.map((item) => item.code))
      .toContain('practice.docs-bilingual-policy');
    for (const path of ['docs/AGENTS.md', 'docs/architecture.md']) {
      expect(result.diagnostics.filter(
        (item) => item.code === 'practice.docs-bilingual-policy' && item.file === path,
      )).toHaveLength(1);
    }
    // A docs policy skip never blocks authoring skills or Claude targets.
    expect((await lstat(join(root, '.claude/CLAUDE.md'))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(root, '.claude/skills/dab-doc-writing'))).isSymbolicLink()).toBe(true);
  });

  it('passes --ai proposals through the planner', async () => {
    const root = await tempDir();
    await packageJson(root);
    const proposal = {
      agentsMdAddition: '## AI rules\n\n- Prefer small diffs.\n',
      agents: [
        {
          name: 'ai-helper',
          description: 'Helps with scoped implementation work.',
          body: 'You help with scoped implementation work.',
        },
      ],
    };
    const runner: CommandRunner = async () => ({
      stdout: JSON.stringify({ result: JSON.stringify(proposal) }),
      stderr: '',
      exitCode: 0,
    });

    const code = await runInit(
      { cwd: root, ai: true, json: true, runner, confirm: async () => true },
      capture().io,
    );

    expect(code).toBe(0);
    expect(await lstatOrNull(join(root, '.agents/agents/ai-helper.md'))).not.toBeNull();
    const agentsMd = await readFile(join(root, 'AGENTS.md'), 'utf8');
    expect(agentsMd).toContain('## AI rules');
    expect(agentsMd).toContain('## Documentation');
    expect((await lstat(join(root, '.claude/agents/ai-helper.md'))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(root, '.claude/agents/ai-helper.md')))
      .toContain('.agents/agents/ai-helper.md');
  });

  it('reports language in JSON and does not overwrite an existing manifest', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'dab.yaml'), featureManifest('en'));
    const captureResult = capture();

    const code = await runInit(
      { cwd: root, profile: 'generic', json: true },
      captureResult.io,
    );

    expect(code).toBe(0);
    const payload = JSON.parse(captureResult.stdout.join('')) as {
      language: { value: string; source: string };
      created: string[];
    };
    expect(payload.language).toEqual({ value: 'en', source: 'config' });
    expect(payload.created).not.toContain('dab.yaml');
    const manifest = await loadProjectManifest(root);
    expect(manifest.manifest.profile).toBe('feature');
    expect(manifest.manifest.docs.language).toBe('en');
    expect(await readFile(join(root, 'docs/AGENTS.md'), 'utf8'))
      .toContain('# Documentation guide');
  });

  it('reports the resolved language in human output', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'dab.yaml'), featureManifest('zh'));
    const captureResult = capture();

    const code = await runInit({ cwd: root }, captureResult.io);

    expect(code).toBe(0);
    expect(captureResult.stdout.join('')).toContain('Language: zh (source: config)');
    expect(await readFile(join(root, 'docs/AGENTS.md'), 'utf8')).toContain('# 文档规范');
  });

  it('skips existing docs and authoring skills without overwriting them', async () => {
    const root = await tempDir();
    const authoredSkill = '---\nname: dab-doc-writing\ndescription: Custom.\n---\nCustom.\n';
    await mkdir(join(root, 'docs'), { recursive: true });
    await mkdir(join(root, '.agents/skills/dab-doc-writing'), { recursive: true });
    await writeFile(join(root, 'docs/AGENTS.md'), '# Authored docs\n');
    await writeFile(
      join(root, '.agents/skills/dab-doc-writing/SKILL.md'),
      authoredSkill,
    );

    const result = await initializeProject({ cwd: root });

    expect(result.ok).toBe(true);
    expect(result.created).not.toContain('docs/AGENTS.md');
    expect(result.created).not.toContain('.agents/skills/dab-doc-writing/SKILL.md');
    expect(result.created).toContain('docs/architecture.md');
    expect(result.created).toContain('.agents/skills/dab-architecture-writing/SKILL.md');
    expect(result.skipped).toContain('.agents/skills/dab-doc-writing');
    expect(await readFile(join(root, 'docs/AGENTS.md'), 'utf8')).toBe('# Authored docs\n');
    expect(await readFile(join(root, '.agents/skills/dab-doc-writing/SKILL.md'), 'utf8'))
      .toBe(authoredSkill);
  });

  it('does not update an existing managed authoring skill', async () => {
    const root = await tempDir();
    const file = '.agents/skills/dab-doc-writing/SKILL.md';
    const stale = await renderAuthoringSkill('dab-doc-writing', '0.1.0');
    await mkdir(join(root, '.agents/skills/dab-doc-writing'), { recursive: true });
    await writeFile(join(root, file), stale);

    const result = await initializeProject({ cwd: root });

    expect(result.ok).toBe(true);
    expect(await readFile(join(root, file), 'utf8')).toBe(stale);
  });

  it('leaves a physical .claude authoring skill pending instead of scaffolding it', async () => {
    const root = await tempDir();
    const physical = '---\nname: dab-doc-writing\ndescription: Existing physical skill.\n---\n# Existing\n';
    await mkdir(join(root, '.claude/skills/dab-doc-writing'), { recursive: true });
    await writeFile(join(root, '.claude/skills/dab-doc-writing/SKILL.md'), physical);

    const preview = await initializeProject({ cwd: root, dryRun: true });

    expect(preview.pending).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'practice.skill-import-pending',
        file: '.claude/skills/dab-doc-writing',
      }),
    ]));
    expect(preview.created).not.toContain('.agents/skills/dab-doc-writing/SKILL.md');
    expect(preview.created).toContain('.agents/skills/dab-architecture-writing/SKILL.md');
    expect(await readFile(join(root, '.claude/skills/dab-doc-writing/SKILL.md'), 'utf8'))
      .toBe(physical);
    expect(await lstatOrNull(join(root, '.agents/skills/dab-doc-writing'))).toBeNull();

    const result = await initializeProject({ cwd: root });

    expect(result.ok).toBe(true);
    expect(result.normalize).toBeNull();
    expect(result.pending).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'practice.skill-import-pending',
        file: '.claude/skills/dab-doc-writing',
      }),
    ]));
    expect(result.created).not.toContain('.agents/skills/dab-doc-writing/SKILL.md');
    expect(result.created).toContain('.agents/skills/dab-architecture-writing/SKILL.md');
    expect(await lstatOrNull(join(root, '.agents/skills/dab-doc-writing/SKILL.md'))).toBeNull();
    expect(await readFile(join(root, '.claude/skills/dab-doc-writing/SKILL.md'), 'utf8'))
      .toBe(physical);
  });

  it('reports a physical authoring skill import pending without suggesting --fix', async () => {
    const root = await tempDir();
    await mkdir(join(root, '.claude/skills/dab-decision-notes'), { recursive: true });
    await writeFile(
      join(root, '.claude/skills/dab-decision-notes/SKILL.md'),
      '---\nname: dab-decision-notes\ndescription: Existing.\n---\n# Existing\n',
    );
    const captureResult = capture();

    const code = await runInit({ cwd: root }, captureResult.io);

    const output = captureResult.stdout.join('');
    expect(code).toBe(0);
    expect(output).toContain('practice.skill-import-pending');
    expect(output).toContain('next: dab normalize\n');
    expect(output).not.toContain('next: dab normalize --fix');
  });

  it('keeps authored and physical skill trees untouched when both exist', async () => {
    const root = await tempDir();
    const authored = '---\nname: dab-doc-writing\ndescription: Authored.\n---\n# Authored\n';
    const physical = '---\nname: dab-doc-writing\ndescription: Physical.\n---\n# Physical\n';
    await mkdir(join(root, '.agents/skills/dab-doc-writing'), { recursive: true });
    await mkdir(join(root, '.claude/skills/dab-doc-writing'), { recursive: true });
    await writeFile(join(root, '.agents/skills/dab-doc-writing/SKILL.md'), authored);
    await writeFile(join(root, '.claude/skills/dab-doc-writing/SKILL.md'), physical);

    const result = await initializeProject({ cwd: root });

    expect(result.created).not.toContain('.agents/skills/dab-doc-writing/SKILL.md');
    expect(result.skipped).toContain('.agents/skills/dab-doc-writing');
    expect(result.pending.some((item) => item.code === 'practice.skill-import-pending')).toBe(false);
    expect(await readFile(join(root, '.agents/skills/dab-doc-writing/SKILL.md'), 'utf8'))
      .toBe(authored);
    expect(await readFile(join(root, '.claude/skills/dab-doc-writing/SKILL.md'), 'utf8'))
      .toBe(physical);
    // The physical `.claude` copy is an unmanaged projection candidate, so init
    // reports it as pending and skips the nested normalize instead of replacing it.
    expect(result.ok).toBe(true);
    expect(result.normalize).toBeNull();
    expect(result.pending).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'projection.physical-copy',
        file: '.claude/skills/dab-doc-writing',
      }),
    ]));
  });

  it('plans docs and skills without writing in --dry-run', async () => {
    const root = await tempDir();

    const result = await initializeProject({ cwd: root, dryRun: true });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.created).toEqual(expect.arrayContaining([
      ...PRACTICE_DOC_FILES,
      ...PRACTICE_SKILL_FILES,
    ]));
    expect(result.language.value).toMatch(/^(en|zh)$/);
    expect(await lstatOrNull(join(root, 'docs'))).toBeNull();
    expect(await lstatOrNull(join(root, '.agents'))).toBeNull();
    expect(await lstatOrNull(join(root, 'AGENTS.md'))).toBeNull();
  });

  it('blocks all writes when docs/AGENTS.md links outside the root', async () => {
    const root = await tempDir();
    const outside = await tempDir();
    await writeFile(join(outside, 'AGENTS.md'), '# outside\n');
    await mkdir(join(root, 'docs'), { recursive: true });
    await symlink(join(outside, 'AGENTS.md'), join(root, 'docs/AGENTS.md'));

    const result = await initializeProject({ cwd: root });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.diagnostics.some(
      (item) => item.severity === 'error'
        && item.file === 'docs/AGENTS.md'
        && (item.code === 'path.conflict' || item.code === 'practice.docs-path'),
    )).toBe(true);
    expect(await lstatOrNull(join(root, 'AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(root, 'dab.yaml'))).toBeNull();
    expect(await lstatOrNull(join(root, 'docs/architecture.md'))).toBeNull();
    expect(await lstatOrNull(join(root, '.agents/skills/dab-doc-writing'))).toBeNull();
  });

  it('blocks all writes when a skill directory links to a file', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'target.txt'), 'not a skill\n');
    await mkdir(join(root, '.agents/skills'), { recursive: true });
    await symlink(join(root, 'target.txt'), join(root, '.agents/skills/dab-doc-writing'));

    const result = await initializeProject({ cwd: root });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.diagnostics.some(
      (item) => item.severity === 'error'
        && item.file === '.agents/skills/dab-doc-writing'
        && (item.code === 'path.conflict' || item.code === 'practice.skill-path'),
    )).toBe(true);
    expect(await lstatOrNull(join(root, 'AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(root, 'dab.yaml'))).toBeNull();
    expect(await lstatOrNull(join(root, '.agents/skills/dab-architecture-writing'))).toBeNull();
  });

  it('governs a regular file at .agents/rules without an internal error', async () => {
    const root = await tempDir();
    await mkdir(join(root, '.agents'), { recursive: true });
    await writeFile(join(root, '.agents/rules'), 'not a directory\n');

    const result = await initializeProject({ cwd: root });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.diagnostics.some(
      (item) => item.severity === 'error'
        && item.file?.startsWith('.agents/rules')
        && (item.code === 'path.conflict' || item.code === 'practice.docs-path'),
    )).toBe(true);
    expect(await lstatOrNull(join(root, 'AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(root, 'dab.yaml'))).toBeNull();
    expect(await readFile(join(root, '.agents/rules'), 'utf8')).toBe('not a directory\n');
  });

  it('governs a regular file at .agents/skills without an internal error', async () => {
    const root = await tempDir();
    await mkdir(join(root, '.agents'), { recursive: true });
    await writeFile(join(root, '.agents/skills'), 'not a directory\n');

    const result = await initializeProject({ cwd: root });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.diagnostics.some(
      (item) => item.severity === 'error'
        && item.file?.startsWith('.agents/skills')
        && (item.code === 'path.conflict' || item.code === 'practice.skill-path'),
    )).toBe(true);
    expect(await lstatOrNull(join(root, 'AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(root, 'dab.yaml'))).toBeNull();
  });

  it('governs a regular file at .agents/hooks without an internal error', async () => {
    const root = await tempDir();
    await mkdir(join(root, '.agents'), { recursive: true });
    await writeFile(join(root, '.agents/hooks'), 'not a directory\n');

    const result = await initializeProject({ cwd: root });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'path.conflict',
        severity: 'error',
        file: '.agents/hooks',
      }),
    ]));
    expect(await lstatOrNull(join(root, 'AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(root, 'dab.yaml'))).toBeNull();
    expect(await lstatOrNull(join(root, '.agents/AGENTS.md'))).toBeNull();
    expect(await readFile(join(root, '.agents/hooks'), 'utf8')).toBe('not a directory\n');
  });

  it('governs a regular file at .agents/agents without an internal error', async () => {
    const root = await tempDir();
    await mkdir(join(root, '.agents'), { recursive: true });
    await writeFile(join(root, '.agents/agents'), 'not a directory\n');

    const result = await initializeProject({ cwd: root });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'path.conflict',
        severity: 'error',
        file: '.agents/agents',
      }),
    ]));
    expect(await lstatOrNull(join(root, 'AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(root, 'dab.yaml'))).toBeNull();
    expect(await readFile(join(root, '.agents/agents'), 'utf8')).toBe('not a directory\n');
  });

  it('governs a regular file at .agents/notes without an internal error', async () => {
    const root = await tempDir();
    await mkdir(join(root, '.agents'), { recursive: true });
    await writeFile(join(root, '.agents/notes'), 'not a directory\n');

    const result = await initializeProject({ cwd: root });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'path.conflict',
        severity: 'error',
        file: '.agents/notes',
      }),
    ]));
    expect(await lstatOrNull(join(root, 'AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(root, 'dab.yaml'))).toBeNull();
    expect(await readFile(join(root, '.agents/notes'), 'utf8')).toBe('not a directory\n');
  });

  it('governs a dangling .agents/notes symlink without an internal error', async () => {
    const root = await tempDir();
    await mkdir(join(root, '.agents'), { recursive: true });
    await symlink('missing-notes', join(root, '.agents/notes'), 'dir');

    const result = await initializeProject({ cwd: root });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'path.conflict',
        severity: 'error',
        file: '.agents/notes',
      }),
    ]));
    expect(await lstatOrNull(join(root, 'AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(root, 'dab.yaml'))).toBeNull();
  });

  it.each(['hooks', 'rules', 'notes'])(
    'governs an unreadable .agents/%s directory without an internal error',
    async (parent) => {
      if (!canDenyRead) {
        return;
      }
      const root = await tempDir();
      const directory = join(root, '.agents', parent);
      await mkdir(directory, { recursive: true });
      await chmod(directory, 0o000);
      try {
        const result = await initializeProject({ cwd: root });

        expect(result.ok).toBe(false);
        expect(result.exitCode).toBe(3);
        expect(result.diagnostics).toEqual(expect.arrayContaining([
          expect.objectContaining({
            severity: 'error',
            file: `.agents/${parent}`,
          }),
        ]));
        expect(result.diagnostics.some(
          (item) => item.severity === 'error' && item.file === `.agents/${parent}`,
        )).toBe(true);
        expect(await lstatOrNull(join(root, 'AGENTS.md'))).toBeNull();
        expect(await lstatOrNull(join(root, 'dab.yaml'))).toBeNull();
        expect(await lstatOrNull(join(root, '.agents/skills/dab-doc-writing'))).toBeNull();
      } finally {
        await chmod(directory, 0o755);
      }
    },
  );

  it('fails loudly on an unreadable nested user skill directory', async () => {
    if (!canDenyRead) {
      return;
    }
    const root = await tempDir();
    const broken = join(root, '.agents/skills/broken');
    await mkdir(broken, { recursive: true });
    await writeFile(
      join(broken, 'SKILL.md'),
      '---\nname: broken\ndescription: Broken.\n---\nBody.\n',
    );
    await chmod(broken, 0o000);
    try {
      const result = await initializeProject({ cwd: root });

      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(3);
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'skill.unreadable',
          severity: 'error',
          file: '.agents/skills/broken',
        }),
      ]));
      expect(await lstatOrNull(join(root, 'AGENTS.md'))).toBeNull();
      expect(await lstatOrNull(join(root, 'dab.yaml'))).toBeNull();
    } finally {
      await chmod(broken, 0o755);
    }
  });

  it('omits Documentation links when the bilingual rule skips an existing and a missing doc', async () => {
    const root = await tempDir();
    await mkdir(join(root, '.agents/rules'), { recursive: true });
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, '.agents/rules/docs-bilingual.md'), 'paired docs');
    await writeFile(join(root, 'docs/AGENTS.md'), '# Authored docs\n');

    const result = await initializeProject({ cwd: root });

    expect(result.ok).toBe(true);
    expect(await readFile(join(root, 'docs/AGENTS.md'), 'utf8')).toBe('# Authored docs\n');
    expect(await lstatOrNull(join(root, 'docs/architecture.md'))).toBeNull();
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).not.toContain('## Documentation');
  });

  it('omits Documentation links when the bilingual rule skips two existing docs', async () => {
    const root = await tempDir();
    await mkdir(join(root, '.agents/rules'), { recursive: true });
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, '.agents/rules/docs-bilingual.md'), 'paired docs');
    await writeFile(join(root, 'docs/AGENTS.md'), '# Authored docs\n');
    await writeFile(join(root, 'docs/architecture.md'), '# Authored architecture\n');

    const result = await initializeProject({ cwd: root });

    expect(result.ok).toBe(true);
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).not.toContain('## Documentation');
  });

  it('reports a non-directory .claude authoring skill as an import conflict, not a pending import', async () => {
    const root = await tempDir();
    await mkdir(join(root, '.claude/skills'), { recursive: true });
    await writeFile(join(root, '.claude/skills/dab-doc-writing'), 'not a directory\n');
    const captureResult = capture();

    const code = await runInit({ cwd: root }, captureResult.io);

    const output = captureResult.stdout.join('');
    expect(code).toBe(0);
    expect(output).toContain('pending conflicts:');
    expect(output).toContain('practice.skill-import-conflict');
    expect(output).not.toContain('practice.skill-import-pending');
    expect(output).not.toContain('next: dab normalize');
    expect(await lstatOrNull(join(root, '.agents/skills/dab-doc-writing'))).toBeNull();
    expect(await readFile(join(root, '.claude/skills/dab-doc-writing'), 'utf8'))
      .toBe('not a directory\n');
    const result = await initializeProject({ cwd: root });
    expect(result.pending).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'practice.skill-import-conflict',
        severity: 'warning',
        file: '.claude/skills/dab-doc-writing',
      }),
    ]));
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.pending.every((item) => !item.hint?.includes('dab normalize'))).toBe(true);
  });

  it('blocks all writes on a planner path conflict', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'docs/AGENTS.md'), { recursive: true });

    const result = await initializeProject({ cwd: root });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.conflicts.some((item) => item.code === 'path.conflict')).toBe(true);
    expect(await lstatOrNull(join(root, 'AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(root, 'dab.yaml'))).toBeNull();
    expect(await lstatOrNull(join(root, '.agents/skills/dab-doc-writing'))).toBeNull();
  });
});

describe('init gates', () => {
  it('creates the project gate verification files', async () => {
    const root = await tempDir();
    await packageJson(root);
    const expectedStarter = renderGateStarter(await scanProject(root));

    const result = await initializeProject({ cwd: root });

    expect(result.ok).toBe(true);
    expect(result.created).toEqual(expect.arrayContaining([...GATE_FILES]));
    expect(await readFile(join(root, '.agents/gates.yaml'), 'utf8')).toBe(expectedStarter);

    const runner = await readFile(join(root, 'scripts/dab-check.mjs'), 'utf8');
    expect(parseGateRunnerMarker(runner)).toMatchObject({ version: DAB_VERSION });

    const snapshot = parseGateSnapshot(await readFile(join(root, 'scripts/dab-gates.json'), 'utf8'));
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) {
      expect(snapshot.snapshot.gates.code.commands.test).toEqual({
        command: 'npm test',
        mode: 'required',
      });
    }
  });

  it('lists gate files in --dry-run without writing', async () => {
    const root = await tempDir();
    await packageJson(root);

    const result = await initializeProject({ cwd: root, dryRun: true });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.created).toEqual(expect.arrayContaining([...GATE_FILES]));
    expect(await lstatOrNull(join(root, '.agents/gates.yaml'))).toBeNull();
    expect(await lstatOrNull(join(root, 'scripts'))).toBeNull();
  });

  it('skips existing gate files instead of overwriting them', async () => {
    const root = await tempDir();
    await mkdir(join(root, '.agents'), { recursive: true });
    await mkdir(join(root, 'scripts'), { recursive: true });
    const existingRunner = 'authored runner\n';
    const existingSnapshot = '{"authored":true}\n';
    await writeFile(join(root, '.agents/gates.yaml'), VALID_GATE_CONFIG);
    await writeFile(join(root, 'scripts/dab-check.mjs'), existingRunner);
    await writeFile(join(root, 'scripts/dab-gates.json'), existingSnapshot);

    const result = await initializeProject({ cwd: root });

    expect(result.ok).toBe(true);
    for (const file of GATE_FILES) {
      expect(result.created).not.toContain(file);
      expect(result.skipped).toContain(file);
    }
    expect(await readFile(join(root, '.agents/gates.yaml'), 'utf8')).toBe(VALID_GATE_CONFIG);
    expect(await readFile(join(root, 'scripts/dab-check.mjs'), 'utf8')).toBe(existingRunner);
    expect(await readFile(join(root, 'scripts/dab-gates.json'), 'utf8')).toBe(existingSnapshot);
  });

  it('does not create gate files in global scope', async () => {
    const home = await tempDir();

    const result = await initializeProject({
      cwd: home,
      path: '.agents',
      home,
      runner: goodRunner,
    });

    expect(result.ok).toBe(true);
    expect(result.scope).toBe('global');
    for (const file of GATE_FILES) {
      expect(result.created).not.toContain(file);
    }
    expect(await lstatOrNull(join(home, '.agents/gates.yaml'))).toBeNull();
    expect(await lstatOrNull(join(home, 'scripts'))).toBeNull();
  });

  it('does not update an existing stale runner during init', async () => {
    const root = await tempDir();
    await packageJson(root);
    await mkdir(join(root, '.agents'), { recursive: true });
    await mkdir(join(root, 'scripts'), { recursive: true });
    const staleRunner = renderGateRunner('0.0.1');
    await writeFile(join(root, '.agents/gates.yaml'), VALID_GATE_CONFIG);
    await writeFile(join(root, 'scripts/dab-check.mjs'), staleRunner);

    const result = await initializeProject({ cwd: root });

    expect(result.ok).toBe(true);
    expect(result.normalize).not.toBeNull();
    expect(await readFile(join(root, 'scripts/dab-check.mjs'), 'utf8')).toBe(staleRunner);
    // The missing snapshot is created from the authored config, never from the
    // scanner, and the stale runner is not replaced by init or its normalize.
    const snapshot = parseGateSnapshot(await readFile(join(root, 'scripts/dab-gates.json'), 'utf8'));
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) {
      expect(snapshot.snapshot.gates.code.commands.test).toEqual({
        command: 'custom-test',
        mode: 'required',
      });
    }
  });

  it('refuses all writes when .agents/gates.yaml is invalid', async () => {
    const root = await tempDir();
    await packageJson(root);
    await mkdir(join(root, '.agents'), { recursive: true });
    await writeFile(join(root, '.agents/gates.yaml'), 'version: nope\n');

    const result = await initializeProject({ cwd: root });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.diagnostics.some(
      (item) => item.severity === 'error'
        && item.file === '.agents/gates.yaml'
        && item.code.startsWith('gate.config'),
    )).toBe(true);
    expect(await readFile(join(root, '.agents/gates.yaml'), 'utf8')).toBe('version: nope\n');
    expect(await lstatOrNull(join(root, 'scripts'))).toBeNull();
    expect(await lstatOrNull(join(root, 'AGENTS.md'))).toBeNull();
    expect(await lstatOrNull(join(root, 'dab.yaml'))).toBeNull();
  });

  it('blocks a gate artifact path conflict before writing the skeleton', async () => {
    const root = await tempDir();
    await packageJson(root);
    await mkdir(join(root, 'scripts'), { recursive: true });
    await writeFile(join(root, 'scripts/shared-runner.mjs'), '// shared\n');
    await symlink('shared-runner.mjs', join(root, 'scripts/dab-check.mjs'));

    const dryRun = await initializeProject({ cwd: root, dryRun: true });
    expect(dryRun.ok).toBe(false);
    expect(dryRun.exitCode).toBe(3);
    expect(dryRun.diagnostics).toContainEqual(expect.objectContaining({
      code: 'verification.artifact-path',
      severity: 'error',
      file: 'scripts/dab-check.mjs',
    }));
    expect(await lstatOrNull(join(root, '.agents/gates.yaml'))).toBeNull();
    expect(await lstatOrNull(join(root, 'AGENTS.md'))).toBeNull();

    const real = await initializeProject({ cwd: root });
    expect(real.ok).toBe(false);
    expect(await lstatOrNull(join(root, '.agents/gates.yaml'))).toBeNull();
    expect(await lstatOrNull(join(root, 'dab.yaml'))).toBeNull();
    expect(await lstatOrNull(join(root, 'scripts/dab-gates.json'))).toBeNull();
  });
});
