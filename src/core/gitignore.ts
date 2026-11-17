import { join } from 'node:path';
import { ConfigError } from './errors.ts';
import { lstatOrNull, readTextFile, writeFileAtomic } from './fs-atomic.ts';

const START = '# >>> dab managed >>>';
const END = '# <<< dab managed <<<';

export const DAB_GITIGNORE_ENTRIES = [
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.claude/CLAUDE.md',
  '.claude/agents/',
  '.claude/skills/',
  '.claude/rules/',
  '.dab/',
];

export interface GitignoreResult {
  changed: boolean;
  path: string;
}

export async function ensureGitignoreBlock(
  root: string,
  entries: readonly string[],
): Promise<GitignoreResult> {
  const path = join(root, '.gitignore');
  const exists = (await lstatOrNull(path)) !== null;
  const text = exists ? await readTextFile(path) : '';
  const lines = text.split(/\r?\n/);
  if (text.endsWith('\n')) {
    lines.pop();
  }

  const startIndex = lines.findIndex((line) => line.trim() === START);
  const endIndex = lines.findIndex((line) => line.trim() === END);
  if ((startIndex === -1) !== (endIndex === -1) || (startIndex !== -1 && endIndex < startIndex)) {
    throw new ConfigError(
      'half-written dab managed block in .gitignore',
      'gitignore.markers',
      { hint: 'Remove the incomplete "# >>> dab managed >>>" block and run dab normalize again.' },
    );
  }

  const block = [START, ...entries, END];
  let nextLines: string[];
  if (startIndex !== -1) {
    nextLines = [
      ...lines.slice(0, startIndex),
      ...block,
      ...lines.slice(endIndex + 1),
    ];
  } else {
    nextLines = [...lines];
    while (nextLines.length > 0 && nextLines[nextLines.length - 1] === '') {
      nextLines.pop();
    }
    if (nextLines.length > 0) {
      nextLines.push('');
    }
    nextLines.push(...block);
  }

  const next = `${nextLines.join('\n')}\n`;
  if (next === text) {
    return { changed: false, path };
  }
  await writeFileAtomic(path, next);
  return { changed: true, path };
}
