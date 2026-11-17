import { afterEach, describe, expect, it } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureGitignoreBlock } from '../../src/core/gitignore.ts';
import { makeTempDir } from '../helpers/tmp.ts';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await makeTempDir();
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('ensureGitignoreBlock', () => {
  it('creates a managed block and is idempotent', async () => {
    const root = await tempDir();
    const entries = ['.claude/settings.json', '.dab/'];

    const first = await ensureGitignoreBlock(root, entries);
    const second = await ensureGitignoreBlock(root, entries);

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    const text = await readFile(join(root, '.gitignore'), 'utf8');
    expect(text).toContain('# >>> dab managed >>>');
    expect(text).toContain('.claude/settings.json');
    expect(text).toContain('.dab/');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('preserves content outside the block and updates entries in place', async () => {
    const root = await tempDir();
    await writeFile(join(root, '.gitignore'), 'node_modules/\n# keep\n');

    await ensureGitignoreBlock(root, ['.claude/settings.json']);
    const updated = await ensureGitignoreBlock(root, ['.claude/CLAUDE.md']);
    const text = await readFile(join(root, '.gitignore'), 'utf8');

    expect(updated.changed).toBe(true);
    expect(text).toContain('node_modules/');
    expect(text).toContain('# keep');
    expect(text).toContain('.claude/CLAUDE.md');
    expect(text).not.toContain('.claude/settings.json');
    expect(text.match(/# >>> dab managed >>>/g)).toHaveLength(1);
  });

  it('rejects a half-written managed block', async () => {
    const root = await tempDir();
    await writeFile(join(root, '.gitignore'), '# >>> dab managed >>>\n.claude/\n');
    await expect(ensureGitignoreBlock(root, ['.claude/'])).rejects.toThrow(/managed block/i);
  });
});
