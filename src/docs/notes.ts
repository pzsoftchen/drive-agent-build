import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Diagnostic } from '../core/diagnostics.ts';
import { readTextFile } from '../core/fs-atomic.ts';
import { parseFrontmatter } from '../model/frontmatter.ts';
import { NoteFrontmatterSchema } from '../model/schemas.ts';
import {
  NOTE_FILENAME,
  NOTE_HEADINGS,
  NOTE_STATUSES,
} from './config.ts';
import { extractFrontmatter, scanMarkdown } from './markdown.ts';

export async function verifyAgentNotes(root: string): Promise<Diagnostic[]> {
  const directory = join(root, '.agents/notes');
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const diagnostics: Diagnostic[] = [];
  for (const entry of entries
    .filter((item) => item.isFile() && item.name.endsWith('.md'))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.endsWith('.zh.md') || entry.name === 'INDEX.md') {
      continue;
    }
    const file = `.agents/notes/${entry.name}`;
    if (!NOTE_FILENAME.test(entry.name)) {
      diagnostics.push({
        code: 'note.filename',
        severity: 'error',
        message: 'Agent Note filename must be NNNN-kebab-case.md',
        file,
      });
    }

    const text = await readTextFile(join(root, file));
    const split = extractFrontmatter(text);
    if (split.frontmatter === null) {
      diagnostics.push({
        code: 'note.frontmatter',
        severity: 'error',
        message: 'Agent Note is missing YAML frontmatter',
        file,
      });
      continue;
    }

    let parsed;
    try {
      parsed = parseFrontmatter(text, file);
    } catch (error) {
      diagnostics.push({
        code: 'note.frontmatter',
        severity: 'error',
        message: `Agent Note frontmatter cannot be parsed: ${error instanceof Error ? error.message : String(error)}`,
        file,
      });
      continue;
    }

    const rawStatus = parsed.data.status;
    if (typeof rawStatus === 'string'
      && !(NOTE_STATUSES as readonly string[]).includes(rawStatus)) {
      diagnostics.push({
        code: 'note.status',
        severity: 'error',
        message: `unsupported Agent Note status: ${rawStatus}`,
        file,
      });
    }

    const validated = NoteFrontmatterSchema.safeParse(parsed.data);
    if (!validated.success) {
      diagnostics.push({
        code: 'note.frontmatter',
        severity: 'error',
        message: 'Agent Note frontmatter does not match the required schema',
        file,
        hint: 'Requires status, date, authors and review_by.',
      });
    }

    const headings = new Set(
      scanMarkdown(parsed.body).headings
        .filter((heading) => heading.level === 2)
        .map((heading) => heading.text),
    );
    for (const required of NOTE_HEADINGS) {
      if (!headings.has(required)) {
        diagnostics.push({
          code: 'note.section',
          severity: 'error',
          message: `Agent Note is missing required section: ${required}`,
          file,
        });
      }
    }
  }

  return diagnostics;
}
