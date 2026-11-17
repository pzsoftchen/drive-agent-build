import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyMarkdownLinks } from '../../src/docs/links.ts';
import { makeTempDir } from '../helpers/tmp.ts';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await makeTempDir('dab-links-');
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('verifyMarkdownLinks', () => {
  it('accepts internal, anchor and external links', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs/a.md'), '# A\n\n## Section one\n');
    await writeFile(
      join(root, 'README.md'),
      `# Top

[ok](docs/a.md)
[anchor](docs/a.md#section-one)
[external](https://example.com)
[self](#top)

\`\`\`md
[fake](docs/missing.md)
\`\`\`
`,
    );

    expect(await verifyMarkdownLinks(root)).toEqual([]);
  });

  it('flags broken files and anchors', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs/a.md'), '# A\n\n## Section one\n');
    await writeFile(
      join(root, 'README.md'),
      `# Top

[bad](docs/missing.md)
[bad anchor](docs/a.md#missing)
[absolute](/etc/passwd)
`,
    );

    const diagnostics = await verifyMarkdownLinks(root);

    expect(diagnostics.filter((item) => item.code === 'doc.link-broken')).toHaveLength(3);
    expect(diagnostics.some((item) => item.message.includes('docs/missing.md'))).toBe(true);
    expect(diagnostics.some((item) => item.message.includes('missing'))).toBe(true);
  });
});
