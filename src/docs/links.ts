import { dirname, join, resolve } from 'node:path';
import type { Diagnostic } from '../core/diagnostics.ts';
import { lstatOrNull, readTextFile } from '../core/fs-atomic.ts';
import { isPathInside, toPosix } from '../core/paths.ts';
import { listMarkdownFiles } from './files.ts';
import { scanMarkdown, slugifyHeading } from './markdown.ts';

async function anchorExists(file: string, anchor: string): Promise<boolean> {
  const text = await readTextFile(file);
  const slug = slugifyHeading(anchor);
  return scanMarkdown(text).headings.some((heading) => slugifyHeading(heading.text) === slug);
}

export async function verifyMarkdownLinks(root: string): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const files = await listMarkdownFiles(root);

  for (const file of files) {
    const absolute = join(root, file);
    let text: string;
    try {
      text = await readTextFile(absolute);
    } catch {
      continue;
    }
    for (const link of scanMarkdown(text).links) {
      if (link.external) {
        continue;
      }
      const [base = '', ...anchorParts] = link.target.split('#');
      const anchor = anchorParts.join('#');

      if (link.anchorOnly) {
        if (!(await anchorExists(absolute, link.target.slice(1)))) {
          diagnostics.push({
            code: 'doc.link-broken',
            severity: 'error',
            message: `same-file anchor does not exist: ${link.target}`,
            file,
            line: link.line,
          });
        }
        continue;
      }

      if (base.startsWith('/') || base.startsWith('~')) {
        diagnostics.push({
          code: 'doc.link-broken',
          severity: 'error',
          message: `absolute links are not allowed: ${link.target}`,
          file,
          line: link.line,
        });
        continue;
      }

      const target = resolve(dirname(absolute), base);
      if (!isPathInside(root, target)) {
        diagnostics.push({
          code: 'doc.link-broken',
          severity: 'error',
          message: `link escapes the repository: ${link.target}`,
          file,
          line: link.line,
        });
        continue;
      }
      if ((await lstatOrNull(target)) === null) {
        diagnostics.push({
          code: 'doc.link-broken',
          severity: 'error',
          message: `link target does not exist: ${link.target}`,
          file,
          line: link.line,
        });
        continue;
      }
      if (anchor.length > 0 && target.endsWith('.md')) {
        if (!(await anchorExists(target, anchor))) {
          diagnostics.push({
            code: 'doc.link-broken',
            severity: 'error',
            message: `link anchor does not exist: ${link.target}`,
            file,
            line: link.line,
          });
        }
      }
    }
  }

  return diagnostics;
}

export function markdownRelativePath(root: string, absolute: string): string {
  return toPosix(absolute.slice(root.length).replace(/^[\\/]/, ''));
}
