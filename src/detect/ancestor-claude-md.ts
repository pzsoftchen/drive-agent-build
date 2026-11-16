import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { lstatOrNull } from '../core/fs-atomic.ts';

const INSTRUCTION_FILES = ['CLAUDE.md', 'CLAUDE.local.md'] as const;

export async function findAncestorInstructionFiles(
  root: string,
  home = homedir(),
): Promise<string[]> {
  const stop = resolve(home);
  let current = dirname(resolve(root));
  const found: string[] = [];

  while (true) {
    for (const name of INSTRUCTION_FILES) {
      const candidate = join(current, name);
      if ((await lstatOrNull(candidate)) !== null) {
        found.push(candidate);
      }
    }
    if (current === stop) {
      break;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return found;
}
