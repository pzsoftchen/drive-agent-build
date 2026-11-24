import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { detectTextLanguage, resolveDocsLanguage } from '../../src/init/docs-language.ts';
import { makeTempDir } from '../helpers/tmp.ts';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await makeTempDir('dab-docs-language-');
  dirs.push(dir);
  return dir;
}

const ZH_AGENTS = '# 项目说明\n\n这是中文文档。';
const ZH_ARCHITECTURE = '# 架构说明\n\n这是中文架构文档。';
const ZH_README = '# README\n\n这是中文文档，用于测试。';

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('detectTextLanguage', () => {
  it('ignores code fences and requires 20% plus 8 CJK characters', () => {
    expect(detectTextLanguage('```\n中文中文中文\n```\nEnglish only')).toBe('en');
    expect(detectTextLanguage('short 中文')).toBe('en');
    expect(detectTextLanguage('# 中文\n\n这是中文文档。')).toBe('zh');
  });

  it('returns undefined when the sampled text has no non-whitespace content', () => {
    expect(detectTextLanguage('')).toBeUndefined();
    expect(detectTextLanguage('   \n\n\t')).toBeUndefined();
    expect(detectTextLanguage('```\n中文中文中文\n```')).toBeUndefined();
  });

  it('returns en for mostly English text even when the title is Chinese', () => {
    expect(
      detectTextLanguage(
        '# 中文\n\nThis is an English paragraph that is clearly longer than the Chinese title.',
      ),
    ).toBe('en');
  });
});

describe('resolveDocsLanguage', () => {
  it('uses explicit config first', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'README.md'), '中文 README');
    await expect(resolveDocsLanguage({ root, configured: 'en' })).resolves.toEqual({
      value: 'en',
      source: 'config',
    });
  });

  it('prefers docs/AGENTS.md over docs/architecture.md', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'docs/AGENTS.md'), ZH_AGENTS);
    await writeFile(join(root, 'docs/architecture.md'), '# Architecture\n\nEnglish.');
    await expect(resolveDocsLanguage({ root, configured: 'auto' })).resolves.toEqual({
      value: 'zh',
      source: 'docs/AGENTS.md',
    });
  });

  it('prefers docs/architecture.md over the root AGENTS.md', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'docs/architecture.md'), ZH_ARCHITECTURE);
    await writeFile(join(root, 'AGENTS.md'), '# Agents\n\nEnglish.');
    await expect(resolveDocsLanguage({ root, configured: 'auto' })).resolves.toEqual({
      value: 'zh',
      source: 'docs/architecture.md',
    });
  });

  it('skips a source that has no language signal', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'docs/AGENTS.md'), '```\n中文中文中文中文中文\n```\n');
    await writeFile(join(root, 'README.md'), ZH_README);
    await expect(resolveDocsLanguage({ root, configured: 'auto' })).resolves.toEqual({
      value: 'zh',
      source: 'README.md',
    });
  });

  it('falls through AGENTS.md, README.md, package description, then locale', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'AGENTS.md'), ZH_AGENTS);
    await writeFile(join(root, 'README.md'), ZH_README);
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ description: '这是一个中文项目的说明。' }),
    );

    await expect(
      resolveDocsLanguage({ root, configured: 'auto', env: {} }),
    ).resolves.toEqual({ value: 'zh', source: 'AGENTS.md' });

    await rm(join(root, 'AGENTS.md'));
    await expect(
      resolveDocsLanguage({ root, configured: 'auto', env: {} }),
    ).resolves.toEqual({ value: 'zh', source: 'README.md' });

    await rm(join(root, 'README.md'));
    await expect(
      resolveDocsLanguage({ root, configured: 'auto', env: {} }),
    ).resolves.toEqual({ value: 'zh', source: 'package.json' });

    await rm(join(root, 'package.json'));
    await expect(
      resolveDocsLanguage({ root, configured: 'auto', env: { LANG: 'zh_CN.UTF-8' } }),
    ).resolves.toEqual({ value: 'zh', source: 'locale' });

    await expect(resolveDocsLanguage({ root, configured: 'auto', env: {} })).resolves.toEqual({
      value: 'en',
      source: 'default',
    });
  });

  it('ignores an unparseable package.json', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'package.json'), '{not json');
    await expect(resolveDocsLanguage({ root, configured: 'auto', env: {} })).resolves.toEqual({
      value: 'en',
      source: 'default',
    });
  });

  it('uses LC_ALL before LANG and ignores non-zh locales', async () => {
    const root = await tempDir();
    await expect(
      resolveDocsLanguage({
        root,
        configured: 'auto',
        env: { LC_ALL: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' },
      }),
    ).resolves.toEqual({ value: 'zh', source: 'locale' });
    await expect(
      resolveDocsLanguage({ root, configured: 'auto', env: { LC_ALL: 'C', LANG: 'zh_CN.UTF-8' } }),
    ).resolves.toEqual({ value: 'en', source: 'default' });
    await expect(
      resolveDocsLanguage({ root, configured: 'auto', env: { LC_ALL: 'en_US.UTF-8' } }),
    ).resolves.toEqual({ value: 'en', source: 'default' });
  });

  it('defaults to en with source default when there is no signal', async () => {
    const root = await tempDir();
    await expect(resolveDocsLanguage({ root, configured: 'auto' })).resolves.toEqual({
      value: 'en',
      source: 'default',
    });
  });
});
