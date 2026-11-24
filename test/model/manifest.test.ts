import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigError } from '../../src/core/errors.ts';
import {
  getEnabledTargets,
  getGeneratedTarget,
  getTarget,
  loadProjectManifest,
  parseInterimClaudeOptions,
  resolveProjectPaths,
  updateGeneratedManifest,
  writeProjectManifest,
} from '../../src/model/project-manifest.ts';
import { ProjectManifestSchema } from '../../src/model/schemas.ts';
import type { GeneratedManifest } from '../../src/model/types.ts';
import { makeTempDir } from '../helpers/tmp.ts';
import { writeProjectFile } from '../helpers/project.ts';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await makeTempDir();
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const validManifest = `version: 1
project:
  id: demo
  name: Demo
profile: feature
target:
  provider: claude-code
  minVersion: 2.1.277
paths:
  agents: .agents
  claude: .claude
`;

const validManifestData = {
  version: 2 as const,
  scope: 'project' as const,
  project: { id: 'demo', name: 'Demo' },
  profile: 'feature' as const,
  targets: [{
    provider: 'claude-code' as const,
    enabled: true,
    options: { minVersion: '2.1.277', instructions: 'generated' },
  }],
  paths: { agents: '.agents', claude: '.claude' },
};

const v2Manifest = `version: 2
scope: project
project:
  id: demo
  name: Demo
profile: feature
targets:
  - provider: claude-code
    enabled: true
    options:
      minVersion: 2.1.277
      instructions: generated
paths:
  agents: .agents
  claude: .claude
`;

const generatedRecord: GeneratedManifest = {
  targets: [
    {
      provider: 'claude-code',
      settings: { path: '.claude/settings.json', sha256: 'a'.repeat(64) },
      instructions: {
        path: '.claude/CLAUDE.md',
        mode: 'generated',
        sha256: 'b'.repeat(64),
      },
      projections: [],
    },
  ],
};

describe('project manifest', () => {
  it('loads a v2 manifest with targets and a per-target generated record', async () => {
    const root = await tempDir();
    await writeProjectFile(root, 'dab.yaml', v2Manifest);

    const loaded = await loadProjectManifest(root, { scope: 'project' });

    expect(loaded.manifest.version).toBe(2);
    expect(loaded.manifest.scope).toBe('project');
    expect(loaded.manifest.targets[0]).toMatchObject({
      provider: 'claude-code',
      enabled: true,
      options: { minVersion: '2.1.277', instructions: 'generated' },
    });
    expect(loaded.legacy).toBe(false);
  });

  it('migrates a v1 project manifest in memory and maps the shim to generated instructions', async () => {
    const root = await tempDir();
    await writeProjectFile(root, 'dab.yaml', validManifest);

    const loaded = await loadProjectManifest(root, { scope: 'project' });

    expect(loaded.legacy).toBe(true);
    expect(loaded.manifest.version).toBe(2);
    expect(loaded.manifest.docs).toEqual({ language: 'auto' });
    expect(loaded.manifest.targets).toEqual([
      {
        provider: 'claude-code',
        enabled: true,
        options: { minVersion: '2.1.277', instructions: 'generated' },
      },
    ]);
  });

  it('carries docs.language from a legacy v1 manifest', async () => {
    const root = await tempDir();
    await writeProjectFile(root, 'dab.yaml', `${validManifest}docs:
  language: en
`);

    const loaded = await loadProjectManifest(root, { scope: 'project' });

    expect(loaded.legacy).toBe(true);
    expect(loaded.manifest.docs.language).toBe('en');
  });

  it('maps a disabled v1 shim to disabled instructions and migrates generated records', async () => {
    const root = await tempDir();
    await writeProjectFile(
      root,
      'dab.yaml',
      `${validManifest.replace('  minVersion: 2.1.277\n', '  minVersion: 2.1.277\n  claudeMdShim: false\n')}generated:
  settings:
    path: .claude/settings.json
    sha256: ${'c'.repeat(64)}
  instructions: null
  projections: []
`,
    );

    const loaded = await loadProjectManifest(root, { scope: 'project' });

    expect(loaded.legacy).toBe(true);
    expect(loaded.manifest.targets[0]?.options).toEqual({
      minVersion: '2.1.277',
      instructions: 'disabled',
    });
    const generated = getGeneratedTarget(loaded.manifest, 'claude-code');
    expect(generated?.settings).toEqual({
      path: '.claude/settings.json',
      sha256: 'c'.repeat(64),
    });
    expect(generated?.instructions).toBeNull();
    expect(generated?.projections).toEqual([]);
  });

  it('rejects a v1 manifest at the global root and a scope mismatch', async () => {
    const home = await tempDir();
    await mkdir(join(home, '.agents'), { recursive: true });
    await writeProjectFile(home, '.agents/dab.yaml', validManifest);

    await expect(loadProjectManifest(home, { scope: 'global' }))
      .rejects.toMatchObject({ code: 'config.manifest-legacy-global' });

    const project = await tempDir();
    await writeProjectFile(
      project,
      'dab.yaml',
      v2Manifest.replace('scope: project', 'scope: global'),
    );
    await expect(loadProjectManifest(project, { scope: 'project' }))
      .rejects.toMatchObject({ code: 'config.scope-mismatch' });
  });

  it('rejects duplicate target providers', async () => {
    const root = await tempDir();
    await writeProjectFile(
      root,
      'dab.yaml',
      v2Manifest.replace(
        '  - provider: claude-code\n    enabled: true\n    options:\n      minVersion: 2.1.277\n      instructions: generated\n',
        '  - provider: claude-code\n  - provider: claude-code\n',
      ),
    );

    await expect(loadProjectManifest(root, { scope: 'project' }))
      .rejects.toMatchObject({ code: 'config.duplicate-target' });
  });

  it('reports a missing manifest as a config error', async () => {
    const root = await tempDir();
    await expect(loadProjectManifest(root)).rejects.toThrow(ConfigError);
    await expect(loadProjectManifest(root)).rejects.toThrow(/dab\.yaml/);
  });

  it('points a missing global manifest at the global init command', async () => {
    const home = await tempDir();
    await expect(loadProjectManifest(home, { scope: 'global' })).rejects.toMatchObject({
      code: 'config.missing',
      hint: expect.stringContaining('dab init ~/.agents'),
    });
  });

  it('rejects unknown profiles', async () => {
    const root = await tempDir();
    await writeProjectFile(
      root,
      'dab.yaml',
      v2Manifest.replace('profile: feature', 'profile: nope'),
    );
    await expect(loadProjectManifest(root)).rejects.toThrow(/profile/);
  });

  it('accepts generic and feature profiles plus docs.language', () => {
    const generic = ProjectManifestSchema.parse({
      ...validManifestData,
      profile: 'generic',
      docs: { language: 'auto' },
    });
    expect(generic.profile).toBe('generic');
    expect(generic.docs.language).toBe('auto');
    for (const language of ['auto', 'en', 'zh'] as const) {
      expect(
        ProjectManifestSchema.parse({ ...validManifestData, docs: { language } }).docs.language,
      ).toBe(language);
    }
  });

  it('defaults docs.language to auto and rejects unknown values', () => {
    expect(
      ProjectManifestSchema.parse({ ...validManifestData, docs: undefined }).docs.language,
    ).toBe('auto');
    expect(() => ProjectManifestSchema.parse({ ...validManifestData, profile: 'other' })).toThrow();
    expect(() =>
      ProjectManifestSchema.parse({ ...validManifestData, docs: { language: 'fr' } }),
    ).toThrow();
  });

  it('writes and reloads a manifest', async () => {
    const root = await tempDir();
    const manifest = {
      version: 2 as const,
      scope: 'project' as const,
      project: { id: 'demo', name: 'Demo' },
      profile: 'feature' as const,
      docs: { language: 'auto' as const },
      targets: [{
        provider: 'claude-code' as const,
        enabled: true,
        options: { minVersion: '2.1.277', instructions: 'generated' },
      }],
      paths: { agents: '.agents', claude: '.claude' },
    };

    await writeProjectManifest(root, manifest);
    const loaded = await loadProjectManifest(root);
    expect(loaded.manifest).toEqual(manifest);
    expect(loaded.legacy).toBe(false);
  });

  it('updates only the generated section and preserves comments', async () => {
    const root = await tempDir();
    await writeProjectFile(root, 'dab.yaml', `# keep this comment\n${v2Manifest}`);

    await updateGeneratedManifest(root, generatedRecord);

    const text = await readFile(join(root, 'dab.yaml'), 'utf8');
    expect(text).toContain('# keep this comment');
    expect(text).toContain('generated:');
    expect(text).toContain('targets:');
    const loaded = await loadProjectManifest(root);
    expect(getGeneratedTarget(loaded.manifest, 'claude-code')?.settings?.sha256).toBe(
      'a'.repeat(64),
    );
    expect(loaded.manifest.targets).toHaveLength(1);
  });

  it('migrates a v1 document to v2 when saving generated records', async () => {
    const root = await tempDir();
    await writeProjectFile(root, 'dab.yaml', `# legacy comment\n${validManifest}`);

    await updateGeneratedManifest(root, generatedRecord);

    const text = await readFile(join(root, 'dab.yaml'), 'utf8');
    expect(text).toContain('# legacy comment');
    expect(text).toContain('version: 2');
    expect(text).toContain('scope: project');
    expect(text).not.toMatch(/^target:/m);
    const loaded = await loadProjectManifest(root);
    expect(loaded.legacy).toBe(false);
    expect(loaded.manifest.targets).toEqual([
      {
        provider: 'claude-code',
        enabled: true,
        options: { minVersion: '2.1.277', instructions: 'generated' },
      },
    ]);
    expect(getGeneratedTarget(loaded.manifest, 'claude-code')?.settings?.sha256).toBe(
      'a'.repeat(64),
    );
  });

  it('resolves authored and generated paths inside the project', async () => {
    const root = await tempDir();
    await writeProjectFile(root, 'dab.yaml', validManifest);
    const { manifest } = await loadProjectManifest(root);
    const paths = resolveProjectPaths(root, manifest);

    expect(paths).toMatchObject({
      root,
      scope: 'project',
      agents: join(root, '.agents'),
      claude: join(root, '.claude'),
      manifest: join(root, 'dab.yaml'),
      instructions: join(root, 'AGENTS.md'),
    });
  });

  it('resolves global manifest and instruction paths inside $HOME/.agents', async () => {
    const home = await tempDir();
    await mkdir(join(home, '.agents'), { recursive: true });
    const manifest = {
      version: 2 as const,
      scope: 'global' as const,
      project: { id: 'demo', name: 'Demo' },
      profile: 'feature' as const,
      docs: { language: 'auto' as const },
      targets: [{
        provider: 'claude-code' as const,
        enabled: true,
        options: { minVersion: '2.1.277', instructions: 'generated' },
      }],
      paths: { agents: '.agents', claude: '.claude' },
    };

    const paths = resolveProjectPaths(home, manifest);

    expect(paths).toMatchObject({
      root: home,
      scope: 'global',
      agents: join(home, '.agents'),
      claude: join(home, '.claude'),
      manifest: join(home, '.agents/dab.yaml'),
      instructions: join(home, '.agents/AGENTS.md'),
    });
  });

  it('reads targets through the provider helpers', async () => {
    const root = await tempDir();
    await writeProjectFile(
      root,
      'dab.yaml',
      v2Manifest.replace(
        '  - provider: claude-code\n    enabled: true\n',
        '  - provider: codex\n    enabled: false\n  - provider: claude-code\n    enabled: true\n',
      ),
    );

    const { manifest } = await loadProjectManifest(root);

    expect(getTarget(manifest, 'codex')).toMatchObject({ provider: 'codex', enabled: false });
    expect(getTarget(manifest, 'dsh')).toBeUndefined();
    expect(getEnabledTargets(manifest).map((target) => target.provider)).toEqual(['claude-code']);
  });
});

describe('interim Claude options', () => {
  it('parses minVersion and instructions', () => {
    expect(parseInterimClaudeOptions({
      provider: 'claude-code',
      enabled: true,
      options: { minVersion: '2.1.277', instructions: 'disabled' },
    })).toEqual({ minVersion: '2.1.277', instructions: 'disabled' });
  });

  it('rejects unknown or malformed options', () => {
    const invalid = [
      { minVersion: '2.1.277', instructions: 'generated', extra: true },
      { instructions: 'generated' },
      { minVersion: '2.1', instructions: 'generated' },
      { minVersion: '2.1.277', instructions: 'symlink' },
    ];
    for (const options of invalid) {
      expect(() => parseInterimClaudeOptions({
        provider: 'claude-code',
        enabled: true,
        options,
      })).toThrow(expect.objectContaining({ code: 'target.invalid-options' }));
    }
  });
});
