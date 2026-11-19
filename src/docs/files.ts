import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { compareStrings } from '../core/compare.ts';
import { toPosix } from '../core/paths.ts';

const SKIP_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  '.dab',
  '.claude',
  '.superpowers',
]);

export async function listMarkdownFiles(root: string, dir = ''): Promise<string[]> {
  const absolute = join(root, dir);
  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries.sort((left, right) => compareStrings(left.name, right.name))) {
    const child = dir.length === 0 ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      const frozenNotes = child === '.agents/notes/archived'
        || child.startsWith('.agents/notes/archived/');
      if (!SKIP_DIRECTORIES.has(entry.name) && !frozenNotes) {
        files.push(...await listMarkdownFiles(root, child));
      }
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(toPosix(child));
    }
  }
  return files;
}
