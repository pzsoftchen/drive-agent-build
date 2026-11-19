import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();

describe('release metadata', () => {
  it('declares the v0.1 package contract', async () => {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
      license: string;
      engines: { node: string };
      bin: Record<string, string>;
      repository: { url: string };
      homepage?: string;
      bugs?: { url?: string };
      files?: string[];
      publishConfig?: { access?: string };
    };

    expect(pkg.name).toBe('@saydone/dab');
    expect(pkg.version).toMatch(/^0\.1\.\d+$/);
    expect(pkg.license).toBe('MIT');
    expect(pkg.engines.node).toBe('>=24.9');
    expect(pkg.bin.dab).toBe('dist/cli.js');
    expect(pkg.repository.url).toContain('drive-agent-build');
    expect(pkg.homepage).toContain('drive-agent-build');
    expect(pkg.bugs?.url).toContain('drive-agent-build');
    expect(pkg.files).toEqual(expect.arrayContaining(['CHANGELOG.md', 'CHANGELOG.zh.md']));
    expect(pkg.publishConfig?.access).toBe('public');
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
      'node dist/cli.js detect --strict --json',
      'node dist/cli.js normalize --dry-run --json',
      'node dist/cli.js policy explain --json',
      'npm pack',
      'npx --no-install @saydone/dab --version',
    ]) {
      expect(workflow).toContain(expected);
    }
    expect(workflow).not.toContain('ANTHROPIC_API_KEY');
    expect(workflow).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('publishes tagged releases from GitHub Actions with provenance', async () => {
    const workflow = await readFile(join(root, '.github/workflows/release.yml'), 'utf8');

    for (const expected of [
      'tags:',
      "'v*'",
      'environment: npm-release',
      'id-token: write',
      'npm publish --provenance --access public',
      'gh release create',
      'npm view "@saydone/dab@$version"',
      'npx --no-install @saydone/dab --version',
    ]) {
      expect(workflow).toContain(expected);
    }
    expect(workflow).not.toContain('NODE_AUTH_TOKEN');
    expect(workflow).not.toContain('NPM_TOKEN');
    expect(workflow).not.toContain('ANTHROPIC_API_KEY');
    expect(workflow).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('documents the scoped npx and global install paths', async () => {
    const readme = await readFile(join(root, 'README.md'), 'utf8');

    expect(readme).toContain('npx @saydone/dab');
    expect(readme).toContain('npm install -g @saydone/dab');
  });

  it('ships a bilingual changelog triple', async () => {
    expect(await readFile(join(root, 'CHANGELOG.md'), 'utf8')).toContain('# Changelog');
    expect(await readFile(join(root, 'CHANGELOG.zh.md'), 'utf8')).toContain('# 变更日志');
    expect(await readFile(join(root, 'CHANGELOG.i18n.yaml'), 'utf8')).toContain('version: 1');
  });
});
