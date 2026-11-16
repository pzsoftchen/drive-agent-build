import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scanProject } from '../../src/init/scanner.ts';
import { makeTempDir } from '../helpers/tmp.ts';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await makeTempDir('dab-scan-');
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('scanProject', () => {
  it('detects a TypeScript pnpm repo and its scripts', async () => {
    const root = await tempDir();
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'demo-app',
        scripts: {
          test: 'vitest run',
          build: 'tsc',
          lint: 'eslint .',
          typecheck: 'tsc --noEmit',
        },
      }),
    );
    await writeFile(join(root, 'pnpm-lock.yaml'), '');
    await writeFile(join(root, 'tsconfig.json'), '{}');
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src/index.ts'), 'export {};\n');

    const scan = await scanProject(root);

    expect(scan.language).toBe('typescript');
    expect(scan.packageManager).toBe('pnpm');
    expect(scan.projectName).toBe('demo-app');
    expect(scan.commands.test).toBe('pnpm test');
    expect(scan.commands.build).toBe('pnpm build');
    expect(scan.commands.lint).toBe('pnpm lint');
    expect(scan.commands.typecheck).toBe('pnpm typecheck');
    expect(scan.sourceDirs).toContain('src');
    expect(scan.hasAgentsMd).toBe(false);
    expect(scan.hasClaudeSettings).toBe(false);
  });

  it('detects Python tools', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'pyproject.toml'), '[tool.pytest.ini_options]\n');
    await writeFile(join(root, 'ruff.toml'), '');

    const scan = await scanProject(root);

    expect(scan.language).toBe('python');
    expect(scan.commands.test).toBe('python -m pytest');
    expect(scan.commands.lint).toBe('ruff check .');
    expect(scan.packageManager).toBe('none');
  });

  it('detects Go and Rust standard commands', async () => {
    const goRoot = await tempDir();
    await writeFile(join(goRoot, 'go.mod'), 'module example.com/demo\n');
    const go = await scanProject(goRoot);
    expect(go.language).toBe('go');
    expect(go.commands).toMatchObject({
      test: 'go test ./...',
      build: 'go build ./...',
      lint: 'go vet ./...',
    });

    const rustRoot = await tempDir();
    await writeFile(join(rustRoot, 'Cargo.toml'), '[package]\nname = "demo"\n');
    const rust = await scanProject(rustRoot);
    expect(rust.language).toBe('rust');
    expect(rust.commands).toMatchObject({
      test: 'cargo test',
      build: 'cargo build',
      lint: 'cargo clippy -- -D warnings',
    });
  });

  it('falls back to generic when no ecosystem is detected', async () => {
    const root = await tempDir();
    const scan = await scanProject(root);
    expect(scan.language).toBe('generic');
    expect(scan.packageManager).toBe('none');
    expect(scan.commands.test).toBeUndefined();
    expect(scan.sourceDirs).toEqual([]);
  });

  it('detects existing AGENTS.md, Claude settings and agent files', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'AGENTS.md'), '# Existing\n');
    await mkdir(join(root, '.claude'));
    await writeFile(join(root, '.claude/settings.json'), '{}\n');
    await mkdir(join(root, '.agents/agents'), { recursive: true });
    await writeFile(join(root, '.agents/agents/reviewer.md'), 'x\n');

    const scan = await scanProject(root);

    expect(scan.hasAgentsMd).toBe(true);
    expect(scan.hasClaudeSettings).toBe(true);
    expect(scan.existingAgents).toContain('.agents/agents/reviewer.md');
  });

  it('reports an invalid package.json without crashing', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'package.json'), '{not json');

    const scan = await scanProject(root);

    expect(scan.language).toBe('javascript');
    expect(scan.diagnostics.map((item) => item.code)).toContain('scan.package-json');
  });
});
