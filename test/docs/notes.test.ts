import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { verifyAgentNotes } from '../../src/docs/notes.ts';
import {
  discoverPairedDocs,
  verifyPairingFile,
} from '../../src/docs/pairing.ts';
import { makeTempDir } from '../helpers/tmp.ts';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await makeTempDir('dab-notes-');
  dirs.push(dir);
  return dir;
}

function note(options: {
  status?: string;
  sections?: string[];
  title?: string;
  switchLine?: string;
} = {}): string {
  const sections = options.sections ?? [
    'Problem',
    'Decision',
    'Alternatives considered',
    'Consequences',
  ];
  const status = options.status ?? 'implemented';
  const switchLine = options.switchLine
    ?? 'English | [中文](2026-11-16-example.zh.md)';
  return `# Agent Note: ${options.title ?? 'Example decision'}

Status: ${status}

${switchLine}

${sections.map((section) => `## ${section}\n\nContent.\n`).join('\n')}`;
}

async function writeNote(
  root: string,
  relativePath: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(join(root, relativePath)), { recursive: true });
  await writeFile(join(root, relativePath), content);
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('verifyAgentNotes', () => {
  it('accepts a correctly formatted implemented note', async () => {
    const root = await tempDir();
    await writeNote(
      root,
      '.agents/notes/implemented/architecture/2026-11-16-example.md',
      note(),
    );

    expect(await verifyAgentNotes(root)).toEqual([]);
  });

  it('requires the status to match the lifecycle folder', async () => {
    const root = await tempDir();
    await writeNote(
      root,
      '.agents/notes/proposed/architecture/2026-11-16-example.md',
      note({ status: 'implemented' }),
    );

    expect((await verifyAgentNotes(root)).map((item) => item.code)).toContain('note.status');
  });

  it('rejects a note placed directly under a lifecycle folder', async () => {
    const root = await tempDir();
    await writeNote(
      root,
      '.agents/notes/implemented/2026-11-16-example.md',
      note(),
    );

    expect((await verifyAgentNotes(root)).map((item) => item.code)).toContain('note.class');
  });

  it('rejects unknown lifecycle folders and extra nesting', async () => {
    const root = await tempDir();
    await writeNote(
      root,
      '.agents/notes/draft/architecture/2026-11-16-example.md',
      note(),
    );
    await writeNote(
      root,
      '.agents/notes/implemented/architecture/nested/2026-11-16-example.md',
      note(),
    );

    const files = (await verifyAgentNotes(root))
      .filter((item) => item.code === 'note.class')
      .map((item) => item.file);
    expect(files).toContain('.agents/notes/draft/architecture/2026-11-16-example.md');
    expect(files).toContain('.agents/notes/implemented/architecture/nested/2026-11-16-example.md');
  });

  it('rejects unknown classes and date-less filenames', async () => {
    const root = await tempDir();
    await writeNote(
      root,
      '.agents/notes/implemented/not-a-class/2026-11-16-example.md',
      note(),
    );
    await writeNote(
      root,
      '.agents/notes/implemented/architecture/0001-example.md',
      note(),
    );

    const codes = (await verifyAgentNotes(root)).map((item) => item.code);
    expect(codes).toContain('note.class');
    expect(codes).toContain('note.filename');
  });

  it('requires lifecycle-specific sections', async () => {
    const root = await tempDir();
    await writeNote(
      root,
      '.agents/notes/implemented/architecture/2026-11-16-example.md',
      note({ sections: ['Problem', 'Decision', 'Consequences'] }),
    );

    expect((await verifyAgentNotes(root)).map((item) => item.code)).toContain('note.section');
  });

  it('rejects proposal-era headings in implemented notes', async () => {
    const root = await tempDir();
    await writeNote(
      root,
      '.agents/notes/implemented/architecture/2026-11-16-example.md',
      note({
        sections: [
          'Problem',
          'Decision',
          'Alternatives considered',
          'Consequences',
          'Proposal',
        ],
      }),
    );

    expect((await verifyAgentNotes(root)).map((item) => item.code)).toContain('note.section');
  });

  it('skips README, AGENTS, translations and archived notes', async () => {
    const root = await tempDir();
    await writeNote(root, '.agents/notes/README.md', '# Agent Notes\n');
    await writeNote(root, '.agents/notes/AGENTS.md', '# Note instructions\n');
    await writeNote(
      root,
      '.agents/notes/implemented/architecture/2026-11-16-example.zh.md',
      'not a source note\n',
    );
    await writeNote(
      root,
      '.agents/notes/archived/architecture/2026-11-16-old.md',
      'old format\n',
    );

    expect(await verifyAgentNotes(root)).toEqual([]);
  });
});

describe('Agent Note pairing', () => {
  it('accepts a language switch after the note header', async () => {
    const root = await tempDir();
    const sourceRel = '.agents/notes/implemented/architecture/2026-11-16-example.md';
    const translationRel = '.agents/notes/implemented/architecture/2026-11-16-example.zh.md';
    await writeNote(root, sourceRel, note());
    await writeNote(
      root,
      translationRel,
      note({
        title: '示例决策',
        switchLine: '[English](2026-11-16-example.md) | 中文',
        sections: ['问题', '决策', '备选方案', '后果'],
      }),
    );

    expect(await verifyPairingFile(root, sourceRel, { write: true })).toEqual([]);
    expect(await verifyPairingFile(root, sourceRel)).toEqual([]);
  });

  it('rejects a language switch after the first twelve lines', async () => {
    const root = await tempDir();
    const prefix = Array.from({ length: 13 }, (_, index) => `Line ${index + 1}.`).join('\n\n');
    await writeNote(
      root,
      'docs/late.md',
      `${prefix}\n\nEnglish | [中文](late.zh.md)\n\n# Late\n`,
    );
    await writeNote(
      root,
      'docs/late.zh.md',
      `${prefix}\n\n[English](late.md) | 中文\n\n# 延迟\n`,
    );

    expect((await verifyPairingFile(root, 'docs/late.md')).map((item) => item.code)).toContain(
      'doc.lang-switch',
    );
  });

  it('does not discover archived notes for pairing', async () => {
    const root = await tempDir();
    await writeNote(
      root,
      '.agents/notes/archived/architecture/2026-11-16-old.md',
      '# Old\n',
    );
    await writeNote(
      root,
      '.agents/notes/archived/architecture/2026-11-16-old.zh.md',
      '# 旧\n',
    );

    expect(await discoverPairedDocs(root)).toEqual([]);
  });
});
