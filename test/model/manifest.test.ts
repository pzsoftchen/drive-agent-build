import { afterEach, describe, expect, it } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigError } from '../../src/core/errors.ts';
import {
  loadProjectManifest,
  resolveProjectPaths,
  updateGeneratedManifest,
  writeProjectManifest,
} from '../../src/model/project-manifest.ts';
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

describe('project manifest', () => {
  it('loads a manifest and defaults claudeMdShim to true', async () => {
    const root = await tempDir();
    await writeProjectFile(root, 'dab.yaml', validManifest);

    const { manifest } = await loadProjectManifest(root);

    expect(manifest.target.claudeMdShim).toBe(true);
    expect(manifest.project.id).toBe('demo');
  });

  it('reports a missing manifest as a config error', async () => {
    const root = await tempDir();
    await expect(loadProjectManifest(root)).rejects.toThrow(ConfigError);
    await expect(loadProjectManifest(root)).rejects.toThrow(/dab\.yaml/);
  });

  it('rejects unknown profiles', async () => {
    const root = await tempDir();
    await writeProjectFile(root, 'dab.yaml', validManifest.replace('profile: feature', 'profile: nope'));
    await expect(loadProjectManifest(root)).rejects.toThrow(/profile/);
  });

  it('writes and reloads a manifest', async () => {
    const root = await tempDir();
    const manifest = {
      version: 1 as const,
      project: { id: 'demo', name: 'Demo' },
      profile: 'feature' as const,
      target: { provider: 'claude-code' as const, minVersion: '2.1.277', claudeMdShim: true },
      paths: { agents: '.agents', claude: '.claude' },
    };

    await writeProjectManifest(root, manifest);
    const loaded = await loadProjectManifest(root);
    expect(loaded.manifest).toEqual(manifest);
  });

  it('updates only the generated section and preserves comments', async () => {
    const root = await tempDir();
    await writeProjectFile(root, 'dab.yaml', `# keep this comment\n${validManifest}`);

    await updateGeneratedManifest(root, {
      settings: { path: '.claude/settings.json', sha256: 'a'.repeat(64) },
      instructions: { path: '.claude/CLAUDE.md', sha256: 'b'.repeat(64) },
      projections: [],
    });

    const text = await readFile(join(root, 'dab.yaml'), 'utf8');
    expect(text).toContain('# keep this comment');
    expect(text).toContain('generated:');
    const loaded = await loadProjectManifest(root);
    expect(loaded.manifest.generated?.settings.sha256).toBe('a'.repeat(64));
  });

  it('resolves authored and generated paths inside the project', async () => {
    const root = await tempDir();
    await writeProjectFile(root, 'dab.yaml', validManifest);
    const { manifest } = await loadProjectManifest(root);
    const paths = resolveProjectPaths(root, manifest);

    expect(paths.agents).toBe(join(root, '.agents'));
    expect(paths.claude).toBe(join(root, '.claude'));
    expect(paths.manifest).toBe(join(root, 'dab.yaml'));
  });
});
