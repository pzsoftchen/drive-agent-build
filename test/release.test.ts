import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PROGRAM_VERSION } from '../src/cli.ts';

const root = process.cwd();

describe('release metadata', () => {
  it('declares the v0.1 package contract', async () => {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      version: string;
      license: string;
      engines: { node: string };
      bin: Record<string, string>;
      repository: { url: string };
    };

    expect(pkg.version).toBe(PROGRAM_VERSION);
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.license).toBe('MIT');
    expect(pkg.engines.node).toBe('>=24.9');
    expect(pkg.bin.dab).toBe('dist/cli.js');
    expect(pkg.repository.url).toContain('drive-agent-build');
  });

  it('runs the full verification pipeline in CI without Claude credentials', async () => {
    const workflow = await readFile(join(root, '.github/workflows/ci.yml'), 'utf8');

    for (const expected of [
      'node-version: 24',
      'pnpm install --frozen-lockfile',
      'pnpm build',
      'pnpm typecheck',
      'pnpm test',
      'pnpm doc-sync',
      'node dist/cli.js normalize',
      'git diff --exit-code',
      'node dist/cli.js detect --json',
      'node dist/cli.js normalize --dry-run --json',
      'node dist/cli.js policy explain --json',
    ]) {
      expect(workflow).toContain(expected);
    }
    expect(workflow).not.toContain('ANTHROPIC_API_KEY');
    expect(workflow).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('ships a bilingual changelog triple', async () => {
    expect(await readFile(join(root, 'CHANGELOG.md'), 'utf8')).toContain('# Changelog');
    expect(await readFile(join(root, 'CHANGELOG.zh.md'), 'utf8')).toContain('# 变更日志');
    expect(await readFile(join(root, 'CHANGELOG.i18n.yaml'), 'utf8')).toContain('version: 1');
  });
});
