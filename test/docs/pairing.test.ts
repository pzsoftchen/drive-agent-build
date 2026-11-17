import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  discoverPairedDocs,
  listPairingGaps,
  verifyAllPairings,
  verifyPairingFile,
} from '../../src/docs/pairing.ts';
import { makeTempDir } from '../helpers/tmp.ts';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await makeTempDir('dab-docs-');
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface PairFixture {
  root: string;
  sourcePath: string;
  translationPath: string;
  recordPath: string;
  source: string;
  translation: string;
}

async function writePair(
  root: string,
  relative = 'README.md',
  sourceBody?: string,
  translationBody?: string,
): Promise<PairFixture> {
  const sourcePath = join(root, relative);
  const directory = dirname(sourcePath);
  const base = relative.split('/').at(-1)?.replace(/\.md$/, '') ?? 'README';
  const translationPath = join(directory, `${base}.zh.md`);
  const recordPath = join(directory, `${base}.i18n.yaml`);
  const source = sourceBody
    ?? `English | [中文](${base}.zh.md)\n\n# Demo\n\nText with \`code\` and [image](image.png).\n\n## Section\n\n- one\n- two\n`;
  const translation = translationBody
    ?? `[English](${base}.md) | 中文\n\n# 演示\n\n包含 \`code\` 和 [图片](image.png) 的文本。\n\n## 章节\n\n- 一\n- 二\n`;
  await mkdir(directory, { recursive: true });
  await writeFile(sourcePath, source);
  await writeFile(translationPath, translation);
  await writeFile(join(directory, 'image.png'), '');
  return { root, sourcePath, translationPath, recordPath, source, translation };
}

describe('translation pairing', () => {
  it('writes a record for a correct pair and verifies it', async () => {
    const root = await tempDir();
    const pair = await writePair(root);

    const created = await verifyPairingFile(root, 'README.md', { write: true });
    expect(created).toEqual([]);
    const record = await readFile(pair.recordPath, 'utf8');
    expect(record).toContain('version: 1');
    expect(record).toContain('source: README.md');
    expect(record).toContain('translation: README.zh.md');
    expect(record).toContain('sections:');

    expect(await verifyPairingFile(root, 'README.md')).toEqual([]);
    expect(await verifyPairingFile(root, 'README.zh.md')).toEqual([]);
  });

  it('reports missing translation and missing record', async () => {
    const root = await tempDir();
    const pair = await writePair(root);
    await verifyPairingFile(root, 'README.md', { write: true });

    await rm(pair.translationPath);
    expect((await verifyPairingFile(root, 'README.md')).map((item) => item.code)).toContain(
      'doc.pair-missing',
    );

    const second = await writePair(root);
    await rm(second.recordPath);
    expect((await verifyPairingFile(root, 'README.md')).map((item) => item.code)).toContain(
      'doc.record-missing',
    );
  });

  it('rejects a wrong language switch', async () => {
    const root = await tempDir();
    const pair = await writePair(root);
    await writeFile(
      pair.translationPath,
      pair.translation.replace('[English](README.md) | 中文', 'English | [中文](README.md)'),
    );

    expect((await verifyPairingFile(root, 'README.md')).map((item) => item.code)).toContain(
      'doc.lang-switch',
    );
  });

  it('rejects heading, list and table structure differences', async () => {
    const root = await tempDir();
    const pair = await writePair(root);
    await writeFile(pair.translationPath, `${pair.translation}\n### Extra\n`);
    expect((await verifyPairingFile(root, 'README.md')).map((item) => item.code)).toContain(
      'doc.structure',
    );

    const second = await writePair(root);
    await writeFile(second.translationPath, `${second.translation}- three\n`);
    expect((await verifyPairingFile(root, 'README.md')).map((item) => item.code)).toContain(
      'doc.structure',
    );

    const third = await writePair(root);
    await writeFile(
      third.sourcePath,
      `${third.source}\n| A | B |\n|---|---|\n| 1 | 2 |\n`,
    );
    expect((await verifyPairingFile(root, 'README.md')).map((item) => item.code)).toContain(
      'doc.structure',
    );
  });

  it('rejects translated fenced code and inline code', async () => {
    const root = await tempDir();
    const pair = await writePair(root);
    await writeFile(
      pair.sourcePath,
      `${pair.source}\n\`\`\`ts\nconst x = 1;\n\`\`\`\n`,
    );
    await writeFile(
      pair.translationPath,
      `${pair.translation}\n\`\`\`ts\nconst y = 1;\n\`\`\`\n`,
    );
    expect((await verifyPairingFile(root, 'README.md')).map((item) => item.code)).toContain(
      'doc.code',
    );

    const second = await writePair(root);
    await writeFile(
      second.translationPath,
      second.translation.replace('`code`', '`kode`'),
    );
    expect((await verifyPairingFile(root, 'README.md')).map((item) => item.code)).toContain(
      'doc.code',
    );
  });

  it('rejects external link mismatches', async () => {
    const root = await tempDir();
    const pair = await writePair(root);
    await writeFile(
      pair.sourcePath,
      `${pair.source}\n[source](https://a.example)\n`,
    );
    await writeFile(
      pair.translationPath,
      `${pair.translation}\n[source](https://b.example)\n`,
    );
    expect((await verifyPairingFile(root, 'README.md')).map((item) => item.code)).toContain(
      'doc.links',
    );
  });

  it('detects a one-sided edit through stale hashes and reconfirms with --write', async () => {
    const root = await tempDir();
    const pair = await writePair(root);
    await verifyPairingFile(root, 'README.md', { write: true });

    await writeFile(pair.sourcePath, pair.source.replace('Text with', 'Changed text with'));
    const stale = await verifyPairingFile(root, 'README.md');
    expect(stale.map((item) => item.code)).toContain('doc.i18n-stale');
    expect(stale.some((item) => item.hint?.includes('--write'))).toBe(true);

    expect(await verifyPairingFile(root, 'README.md', { write: true })).toEqual([]);
    expect(await verifyPairingFile(root, 'README.md')).toEqual([]);
  });

  it('requires Chinese docs to link to the zh.md counterpart', async () => {
    const root = await tempDir();
    await writePair(root, 'docs/guide.md');
    await verifyPairingFile(root, 'docs/guide.md', { write: true });

    const pair = await writePair(
      root,
      'README.md',
      `English | [中文](README.zh.md)\n\n# Demo\n\n[Guide](docs/guide.md)\n`,
      `[English](README.md) | 中文\n\n# 演示\n\n[指南](docs/guide.md)\n`,
    );
    const wrong = await verifyPairingFile(root, 'README.md', { write: true });
    expect(wrong.map((item) => item.code)).toContain('doc.links');

    await writeFile(
      pair.translationPath,
      pair.translation.replace('docs/guide.md', 'docs/guide.zh.md'),
    );
    expect(await verifyPairingFile(root, 'README.md', { write: true })).toEqual([]);
  });

  it('lists gaps and ignores excluded instruction paths', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'docs/i18n'), { recursive: true });
    await mkdir(join(root, '.agents/agents'), { recursive: true });
    await mkdir(join(root, '.agents/memory'), { recursive: true });
    await writeFile(join(root, 'AGENTS.md'), '# Agents\n');
    await writeFile(join(root, 'docs/i18n/terminology.md'), '# Terms\n');
    await writeFile(join(root, '.agents/agents/reviewer.md'), '# Role\n');
    await writeFile(join(root, '.agents/memory/note.md'), '# Memory\n');
    await writeFile(join(root, 'README.md'), 'English | [中文](README.zh.md)\n\n# Demo\n');
    await writeFile(join(root, 'orphan.zh.md'), 'orphan\n');

    const sources = await discoverPairedDocs(root);
    expect(sources).toEqual(['README.md']);

    const gaps = await listPairingGaps(root);
    expect(gaps.missingTranslations).toContain('README.md');
    expect(gaps.missingRecords).toContain('README.md');
    expect(gaps.orphanTranslations).toContain('orphan.zh.md');
  });

  it('keeps docs/superpowers specs and plans Chinese-only', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'docs/superpowers/specs'), { recursive: true });
    await mkdir(join(root, 'docs/superpowers/plans'), { recursive: true });
    await writeFile(join(root, 'docs/superpowers/specs/spec.md'), '# 规范\n');
    await writeFile(join(root, 'docs/superpowers/plans/plan.md'), '# 计划\n');
    await writeFile(join(root, 'docs/superpowers/specs/old.zh.md'), '# 旧规范\n');
    await writeFile(join(root, 'docs/superpowers/plans/old.i18n.yaml'), 'version: 1\n');

    expect(await discoverPairedDocs(root)).toEqual([]);
    expect(await listPairingGaps(root)).toEqual({
      missingTranslations: [],
      missingRecords: [],
      orphanTranslations: [],
      orphanRecords: [],
    });
  });

  it('runs all pair checks and reports missing records', async () => {
    const root = await tempDir();
    await writePair(root, 'README.md');
    await writePair(root, 'docs/guide.md');
    await verifyPairingFile(root, 'README.md', { write: true });
    // docs/guide.md deliberately has no record.
    const report = await verifyAllPairings(root);
    expect(report.diagnostics.map((item) => item.code)).toContain('doc.record-missing');
  });
});
