import { afterEach, describe, expect, it } from 'vitest';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyDocBudgets } from '../../src/docs/budgets.ts';
import { makeTempDir } from '../helpers/tmp.ts';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await makeTempDir('dab-budget-');
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('verifyDocBudgets', () => {
  it('accepts documents at or under budget', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'README.md'), '# A\n\nB\n');
    const diagnostics = await verifyDocBudgets(root, { 'README.md': 3 }, new Set());
    expect(diagnostics).toEqual([]);
  });

  it('flags documents over budget and missing required documents', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'README.md'), '# A\n\nB\n\nC\n');
    const over = await verifyDocBudgets(root, { 'README.md': 3 }, new Set());
    expect(over.map((item) => item.code)).toContain('doc.budget');

    const missing = await verifyDocBudgets(root, { 'docs/architecture.md': 10 }, new Set());
    expect(missing.map((item) => item.code)).toContain('doc.budget-missing');
  });

  it('skips optional documents when absent', async () => {
    const root = await tempDir();
    const diagnostics = await verifyDocBudgets(
      root,
      { 'docs/AGENTS.md': 10 },
      new Set(['docs/AGENTS.md']),
    );
    expect(diagnostics).toEqual([]);
  });
});
