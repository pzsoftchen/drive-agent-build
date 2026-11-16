import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyAgentNotes } from '../../src/docs/notes.ts';
import { makeTempDir } from '../helpers/tmp.ts';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await makeTempDir('dab-notes-');
  dirs.push(dir);
  return dir;
}

function note(overrides: { status?: string; omit?: string } = {}): string {
  const sections = [
    'Context',
    'Decision',
    'Consequences',
    'Alternatives considered',
    'Verification',
    'References',
  ].filter((section) => section !== overrides.omit);
  return `---
status: ${overrides.status ?? 'implemented'}
date: 2026-11-16
authors: [DAB contributors]
review_by: 2027-05-16
---
# Note

${sections.map((section) => `## ${section}\n\nContent.\n`).join('\n')}`;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('verifyAgentNotes', () => {
  it('accepts a correctly formatted note', async () => {
    const root = await tempDir();
    await mkdir(join(root, '.agents/notes'), { recursive: true });
    await writeFile(join(root, '.agents/notes/0001-example.md'), note());

    expect(await verifyAgentNotes(root)).toEqual([]);
  });

  it('requires every lifecycle section', async () => {
    const root = await tempDir();
    await mkdir(join(root, '.agents/notes'), { recursive: true });
    await writeFile(
      join(root, '.agents/notes/0001-example.md'),
      note({ omit: 'Alternatives considered' }),
    );

    expect((await verifyAgentNotes(root)).map((item) => item.code)).toContain('note.section');
  });

  it('rejects archived status and bad filenames', async () => {
    const root = await tempDir();
    await mkdir(join(root, '.agents/notes'), { recursive: true });
    await writeFile(join(root, '.agents/notes/bad-name.md'), note({ status: 'archived' }));

    const codes = (await verifyAgentNotes(root)).map((item) => item.code);
    expect(codes).toContain('note.status');
    expect(codes).toContain('note.filename');
  });

  it('rejects notes without frontmatter and ignores translations', async () => {
    const root = await tempDir();
    await mkdir(join(root, '.agents/notes'), { recursive: true });
    await writeFile(join(root, '.agents/notes/0001-bad.md'), '## Context\n');
    await writeFile(join(root, '.agents/notes/0001-bad.zh.md'), 'not a source\n');

    const diagnostics = await verifyAgentNotes(root);
    expect(diagnostics.map((item) => item.code)).toContain('note.frontmatter');
    expect(diagnostics.some((item) => item.file.endsWith('.zh.md'))).toBe(false);
  });
});
