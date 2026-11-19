import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { compareStrings } from '../../src/core/compare.ts';

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listTypeScriptFiles(absolute));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(absolute);
    }
  }
  return files;
}

describe('compareStrings', () => {
  it('orders by code unit instead of the process locale', () => {
    expect(compareStrings('B', 'a')).toBeLessThan(0);
    expect(compareStrings('a', 'B')).toBeGreaterThan(0);
    expect(compareStrings('same', 'same')).toBe(0);
    expect(['中', 'a', 'B'].sort(compareStrings)).toEqual(['B', 'a', '中']);
  });
});

describe('deterministic source ordering', () => {
  it('does not use localeCompare anywhere in src', async () => {
    const root = process.cwd();
    const offenders: string[] = [];
    for (const file of await listTypeScriptFiles(join(root, 'src'))) {
      if ((await readFile(file, 'utf8')).includes('localeCompare')) {
        offenders.push(relative(root, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
