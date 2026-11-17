import { afterEach, describe, expect, it } from 'vitest';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyMarkdownWrap } from '../../src/docs/wrap.ts';
import { makeTempDir } from '../helpers/tmp.ts';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await makeTempDir('dab-wrap-');
  dirs.push(dir);
  return dir;
}

async function check(content: string): Promise<string[]> {
  const root = await tempDir();
  await writeFile(join(root, 'README.md'), content);
  return (await verifyMarkdownWrap(root)).map((item) => item.code);
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('verifyMarkdownWrap', () => {
  it('accepts a clean document, including code-block whitespace', async () => {
    const codes = await check(
      '# Title\n\nText.\n\n```ts\nconst x = 1;   \n\tindented\n```\n',
    );
    expect(codes).toEqual([]);
  });

  it.each([
    ['CRLF', '# Title\r\n\r\nText.\r\n'],
    ['missing final newline', '# Title\n\nText.'],
    ['double final newline', '# Title\n\nText.\n\n'],
    ['trailing whitespace', '# Title\n\nText.   \n'],
    ['tab outside code', '# Title\n\n\tText.\n'],
    ['three blank lines', '# Title\n\n\n\nText.\n'],
  ])('rejects %s', async (_label, content) => {
    const codes = await check(content);
    expect(codes).toContain('doc.wrap');
  });
});
