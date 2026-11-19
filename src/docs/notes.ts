import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { compareStrings } from '../core/compare.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { readTextFile } from '../core/fs-atomic.ts';
import { toPosix } from '../core/paths.ts';
import {
  NOTE_CLASSES,
  NOTE_FILENAME,
  NOTE_FORBIDDEN_IMPLEMENTED_HEADINGS,
  NOTE_HEADINGS,
  NOTE_LIFECYCLES,
} from './config.ts';
import { scanMarkdown } from './markdown.ts';

type NoteLifecycle = (typeof NOTE_LIFECYCLES)[number];

function isSkippedSource(name: string): boolean {
  return name.endsWith('.zh.md')
    || name === 'README.md'
    || name === 'AGENTS.md'
    || name === 'INDEX.md';
}

async function walkNoteMarkdown(
  directory: string,
  root: string,
  relativeDir = '',
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries.sort((left, right) => compareStrings(left.name, right.name))) {
    const child = relativeDir.length === 0 ? entry.name : `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (relativeDir.length === 0 && entry.name === 'archived') {
        continue;
      }
      files.push(...await walkNoteMarkdown(join(directory, entry.name), root, child));
    } else if (entry.isFile() && entry.name.endsWith('.md') && !isSkippedSource(entry.name)) {
      files.push(toPosix(relative(root, join(directory, entry.name))));
    }
  }
  return files;
}

async function listNoteFiles(root: string): Promise<string[]> {
  return walkNoteMarkdown(
    join(root, '.agents/notes'),
    join(root, '.agents/notes'),
  );
}

export async function verifyAgentNotes(root: string): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const notesRoot = join(root, '.agents/notes');

  for (const absoluteFile of await listNoteFiles(root)) {
    const file = `.agents/notes/${absoluteFile}`;
    const parts = absoluteFile.split('/');
    if (parts.length !== 3) {
      diagnostics.push({
        code: 'note.class',
        severity: 'error',
        message: 'Agent Note must live at {lifecycle}/{class}/YYYY-MM-DD-topic.md',
        file,
      });
      continue;
    }

    const [lifecycleName, className, name] = parts;
    if (!(NOTE_LIFECYCLES as readonly string[]).includes(lifecycleName ?? '')) {
      diagnostics.push({
        code: 'note.class',
        severity: 'error',
        message: `Agent Note lifecycle is not recognized: ${lifecycleName ?? '(missing)'}`,
        file,
        hint: `Allowed lifecycles: ${NOTE_LIFECYCLES.join(', ')}.`,
      });
      continue;
    }
    if (!(NOTE_CLASSES as readonly string[]).includes(className ?? '')) {
      diagnostics.push({
        code: 'note.class',
        severity: 'error',
        message: `Agent Note class is not recognized: ${className ?? '(missing)'}`,
        file,
        hint: `Allowed classes: ${NOTE_CLASSES.join(', ')}.`,
      });
      continue;
    }

    const lifecycle = lifecycleName as NoteLifecycle;
    if (!NOTE_FILENAME.test(name ?? '')) {
      diagnostics.push({
        code: 'note.filename',
        severity: 'error',
        message: 'Agent Note filename must be YYYY-MM-DD-kebab-case.md',
        file,
      });
    }

    const text = await readTextFile(join(notesRoot, absoluteFile));
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const title = lines[0] ?? '';
    const blank = (lines[1] ?? '').trim();
    const statusLine = lines[2] ?? '';

    if (!title.startsWith('# Agent Note: ') || title.slice('# Agent Note: '.length).trim().length === 0) {
      diagnostics.push({
        code: 'note.header',
        severity: 'error',
        message: 'Agent Note must start with "# Agent Note: <title>"',
        file,
      });
      continue;
    }
    if (blank.length !== 0 || !statusLine.startsWith('Status: ')) {
      diagnostics.push({
        code: 'note.header',
        severity: 'error',
        message: 'Agent Note header must be title, blank line, Status line',
        file,
      });
      continue;
    }

    const statusText = statusLine.slice('Status: '.length).trim();
    const status = statusText.split(/\s+/)[0] ?? '';
    if (!(NOTE_LIFECYCLES as readonly string[]).includes(status)) {
      diagnostics.push({
        code: 'note.status',
        severity: 'error',
        message: `unsupported Agent Note status: ${statusText}`,
        file,
      });
    } else {
      if (status !== lifecycle) {
        diagnostics.push({
          code: 'note.status',
          severity: 'error',
          message: `Status ${status} does not match lifecycle folder ${lifecycle}`,
          file,
        });
      }
      if (status !== 'rejected' && statusText !== status) {
        diagnostics.push({
          code: 'note.status',
          severity: 'error',
          message: 'Only rejected notes may add a reason to the Status line',
          file,
        });
      }
      if (status === 'rejected' && statusText === 'rejected') {
        diagnostics.push({
          code: 'note.status',
          severity: 'error',
          message: 'Rejected notes must include a one-line rejection reason',
          file,
        });
      }
    }

    const headings = new Set(
      scanMarkdown(text).headings
        .filter((heading) => heading.level === 2)
        .map((heading) => heading.text),
    );
    for (const required of NOTE_HEADINGS[lifecycle]) {
      if (!headings.has(required)) {
        diagnostics.push({
          code: 'note.section',
          severity: 'error',
          message: `Agent Note is missing required section: ${required}`,
          file,
        });
      }
    }

    if (lifecycle === 'implemented') {
      for (const forbidden of NOTE_FORBIDDEN_IMPLEMENTED_HEADINGS) {
        if (headings.has(forbidden)) {
          diagnostics.push({
            code: 'note.section',
            severity: 'error',
            message: `Implemented Agent Note must not use proposal-era section: ${forbidden}`,
            file,
          });
        }
      }
    }
  }

  return diagnostics;
}
