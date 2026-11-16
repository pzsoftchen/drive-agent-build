import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Diagnostic } from '../core/diagnostics.ts';
import { readTextFile } from '../core/fs-atomic.ts';
import {
  NOTE_CLASSES,
  NOTE_FILENAME,
  NOTE_FORBIDDEN_IMPLEMENTED_HEADINGS,
  NOTE_HEADINGS,
  NOTE_LIFECYCLES,
} from './config.ts';
import { scanMarkdown } from './markdown.ts';

type NoteLifecycle = (typeof NOTE_LIFECYCLES)[number];

async function listNoteFiles(root: string): Promise<string[]> {
  const base = join(root, '.agents/notes');
  const files: string[] = [];

  for (const lifecycle of NOTE_LIFECYCLES) {
    const lifecycleDir = join(base, lifecycle);
    let classEntries;
    try {
      classEntries = await readdir(lifecycleDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      throw error;
    }

    for (const classEntry of classEntries
      .filter((item) => item.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const classDir = join(lifecycleDir, classEntry.name);
      let fileEntries;
      try {
        fileEntries = await readdir(classDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const fileEntry of fileEntries
        .filter((item) => item.isFile() && item.name.endsWith('.md'))
        .sort((left, right) => left.name.localeCompare(right.name))) {
        files.push(`${lifecycle}/${classEntry.name}/${fileEntry.name}`);
      }
    }
  }

  return files;
}

function isSkippedSource(name: string): boolean {
  return name.endsWith('.zh.md')
    || name === 'README.md'
    || name === 'AGENTS.md'
    || name === 'INDEX.md';
}

export async function verifyAgentNotes(root: string): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const files = await listNoteFiles(root);

  for (const relativeFile of files) {
    const name = basename(relativeFile);
    if (isSkippedSource(name)) {
      continue;
    }
    const [lifecycleName, className] = relativeFile.split('/');
    const lifecycle = lifecycleName as NoteLifecycle;
    const file = `.agents/notes/${relativeFile}`;

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

    if (!NOTE_FILENAME.test(name)) {
      diagnostics.push({
        code: 'note.filename',
        severity: 'error',
        message: 'Agent Note filename must be YYYY-MM-DD-kebab-case.md',
        file,
      });
    }

    const text = await readTextFile(join(root, file));
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
