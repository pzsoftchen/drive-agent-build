import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runDocSync } from '../../src/docs/doc-sync.ts';
import { verifyPairingFile } from '../../src/docs/pairing.ts';
import { makeTempDir } from '../helpers/tmp.ts';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await makeTempDir('dab-docsync-');
  dirs.push(dir);
  return dir;
}

async function makeValidRoot(): Promise<string> {
  const root = await tempDir();
  await writeFile(join(root, 'AGENTS.md'), '# Project\n');
  await writeFile(
    join(root, 'README.md'),
    'English | [中文](README.zh.md)\n\n# Demo\n\nA paragraph.\n',
  );
  await writeFile(
    join(root, 'README.zh.md'),
    '[English](README.md) | 中文\n\n# 演示\n\n一段文字。\n',
  );
  await verifyPairingFile(root, 'README.md', { write: true });
  return root;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('runDocSync', () => {
  it('passes all gates on a clean documentation set', async () => {
    const root = await makeValidRoot();
    const result = await runDocSync(root, {
      budgets: { 'AGENTS.md': 200, 'README.md': 220, 'README.zh.md': 220 },
      optionalBudgets: new Set(),
    });
    expect(result.ok).toBe(true);
    expect(result.diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
  });

  it('fails when any gate fails', async () => {
    const root = await makeValidRoot();
    await writeFile(
      join(root, 'README.md'),
      'English | [中文](README.zh.md)\n\n# Demo\n\n[missing](docs/nope.md)\n',
    );

    const result = await runDocSync(root, {
      budgets: { 'AGENTS.md': 200, 'README.md': 220, 'README.zh.md': 220 },
      optionalBudgets: new Set(),
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain('doc.link-broken');
  });

  it('includes agent note format failures', async () => {
    const root = await makeValidRoot();
    await mkdir(join(root, '.agents/notes'), { recursive: true });
    await writeFile(join(root, '.agents/notes/0001-bad.md'), '## Context\n');

    const result = await runDocSync(root, {
      budgets: { 'AGENTS.md': 200, 'README.md': 220, 'README.zh.md': 220 },
      optionalBudgets: new Set(),
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain('note.frontmatter');
  });
});
