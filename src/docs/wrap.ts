import { join } from 'node:path';
import type { Diagnostic } from '../core/diagnostics.ts';
import { readTextFile } from '../core/fs-atomic.ts';
import { listMarkdownFiles } from './files.ts';

export async function verifyMarkdownWrap(
  root: string,
  files?: readonly string[],
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const targets = files ?? await listMarkdownFiles(root);

  for (const file of targets) {
    let text: string;
    try {
      text = await readTextFile(join(root, file));
    } catch {
      continue;
    }

    if (text.includes('\r')) {
      diagnostics.push({
        code: 'doc.wrap',
        severity: 'error',
        message: 'Markdown must use LF line endings',
        file,
      });
    }
    if (!text.endsWith('\n')) {
      diagnostics.push({
        code: 'doc.wrap',
        severity: 'error',
        message: 'Markdown must end with a single newline',
        file,
      });
    } else if (text.endsWith('\n\n')) {
      diagnostics.push({
        code: 'doc.wrap',
        severity: 'error',
        message: 'Markdown must not end with multiple newlines',
        file,
      });
    }

    const lines = text.split('\n');
    let inFence = false;
    let fenceCharacter = '`';
    let blankRun = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (fence !== null) {
        const marker = fence[1] ?? '```';
        if (!inFence) {
          inFence = true;
          fenceCharacter = marker[0] ?? '`';
        } else if (marker[0] === fenceCharacter) {
          inFence = false;
        }
        blankRun = 0;
        continue;
      }
      if (inFence) {
        continue;
      }

      if (/[ \t]+$/.test(line)) {
        diagnostics.push({
          code: 'doc.wrap',
          severity: 'error',
          message: 'trailing whitespace outside a fenced code block',
          file,
          line: index + 1,
        });
      }
      if (line.includes('\t')) {
        diagnostics.push({
          code: 'doc.wrap',
          severity: 'error',
          message: 'tab outside a fenced code block',
          file,
          line: index + 1,
        });
      }
      if (line.trim().length === 0) {
        blankRun += 1;
        if (blankRun === 3) {
          diagnostics.push({
            code: 'doc.wrap',
            severity: 'error',
            message: 'three or more consecutive blank lines outside a fenced code block',
            file,
            line: index + 1,
          });
        }
      } else {
        blankRun = 0;
      }
    }
  }

  return diagnostics;
}
