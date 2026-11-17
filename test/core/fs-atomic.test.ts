import { afterEach, describe, expect, it } from 'vitest';
import { readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  backupPath,
  lstatOrNull,
  readTextFile,
  replaceSymlink,
  writeFileAtomic,
} from '../../src/core/fs-atomic.ts';
import { makeTempDir, removeTempDir } from '../helpers/tmp.ts';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await makeTempDir();
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => removeTempDir(dir)));
});

describe('atomic file operations', () => {
  it('writes content and leaves no temporary file behind', async () => {
    const dir = await tempDir();
    const file = join(dir, 'settings.json');

    await writeFileAtomic(file, '{"ok":true}\n', 0o640);
    await writeFileAtomic(file, '{"ok":false}\n', 0o640);

    expect(await readFile(file, 'utf8')).toBe('{"ok":false}\n');
    expect((await stat(file)).mode & 0o777).toBe(0o640);
    expect((await readdir(dir)).sort()).toEqual(['settings.json']);
  });

  it('rejects reading files above the byte limit', async () => {
    const dir = await tempDir();
    const file = join(dir, 'large.txt');
    await writeFile(file, '123456789');

    await expect(readTextFile(file, 4)).rejects.toThrow(/too large/i);
  });

  it('replaces an existing symlink', async () => {
    const dir = await tempDir();
    const first = join(dir, 'first.md');
    const second = join(dir, 'second.md');
    const link = join(dir, 'link.md');
    await writeFile(first, 'first');
    await writeFile(second, 'second');
    await symlink('first.md', link);

    await replaceSymlink(link, 'second.md');

    expect((await lstatOrNull(link))?.isSymbolicLink()).toBe(true);
    expect(await readFile(link, 'utf8')).toBe('second');
  });

  it('refuses to replace a physical file with a symlink', async () => {
    const dir = await tempDir();
    const source = join(dir, 'source.md');
    const link = join(dir, 'link.md');
    await writeFile(source, 'source');
    await writeFile(link, 'physical');

    await expect(replaceSymlink(link, 'source.md')).rejects.toThrow(/physical/i);
  });

  it('backs up a physical file without removing the source', async () => {
    const dir = await tempDir();
    const source = join(dir, 'src', 'file.txt');
    const backupRoot = join(dir, 'backups', 'run-1');
    await writeFileAtomic(source, 'original\n');

    const backup = await backupPath(dir, 'src/file.txt', backupRoot);

    expect(backup).toBe(join(backupRoot, 'src', 'file.txt'));
    expect(await readFile(backup, 'utf8')).toBe('original\n');
    expect(await readFile(source, 'utf8')).toBe('original\n');
  });

  it('returns null for missing paths', async () => {
    const dir = await tempDir();
    await expect(lstatOrNull(join(dir, 'missing'))).resolves.toBeNull();
  });
});
