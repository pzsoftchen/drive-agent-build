import { describe, expect, it } from 'vitest';
import {
  extractFrontmatter,
  scanMarkdown,
  splitSections,
} from '../../src/docs/markdown.ts';

const sample = `# Title

Intro with \`code\` and [link](docs/a.md).

## Section

- one
- two

1. first
2. second

| A | B |
|---|---|
| 1 | 2 |

\`\`\`ts
const x = 1;
\`\`\`

> quote

---
`;

describe('scanMarkdown', () => {
  it('finds headings, code, links, lists, tables and blockquotes', () => {
    const scan = scanMarkdown(sample);

    expect(scan.headings.map((heading) => [heading.level, heading.text])).toEqual([
      [1, 'Title'],
      [2, 'Section'],
    ]);
    expect(scan.codeBlocks).toHaveLength(1);
    expect(scan.codeBlocks[0]).toMatchObject({ lang: 'ts', content: 'const x = 1;' });
    expect(scan.inlineCode).toEqual(['code']);
    expect(scan.links.map((link) => link.target)).toEqual(['docs/a.md']);
    expect(scan.listMarkers.map((marker) => marker.ordered)).toEqual([
      false,
      false,
      true,
      true,
    ]);
    expect(scan.tables).toHaveLength(1);
    expect(scan.tables[0]).toMatchObject({ rows: 2, columns: 2 });
    expect(scan.blockquotes).toBe(1);
    expect(scan.horizontalRules).toBe(1);
  });

  it('ignores markdown-looking content inside fenced code', () => {
    const scan = scanMarkdown(`# Real

\`\`\`md
# Fake
- fake
[link](fake.md)
\`\`\`
`);
    expect(scan.headings.map((heading) => heading.text)).toEqual(['Real']);
    expect(scan.links).toEqual([]);
    expect(scan.listMarkers).toEqual([]);
  });
});

describe('splitSections', () => {
  it('returns a preamble and one section per heading', () => {
    const sections = splitSections(sample);
    expect(sections.map((section) => section.level)).toEqual([0, 1, 2]);
    expect(sections[1]?.heading).toBe('Title');
    expect(sections[1]?.text).toContain('# Title');
    expect(sections[2]?.text).toContain('## Section');
  });
});

describe('extractFrontmatter', () => {
  it('returns raw frontmatter and the body', () => {
    const parsed = extractFrontmatter('---\ntitle: Demo\n---\n\n# Body\n');
    expect(parsed.frontmatter).toBe('title: Demo');
    expect(parsed.body).toBe('\n# Body\n');
    expect(parsed.bodyStartLine).toBe(4);
  });

  it('returns null frontmatter when absent', () => {
    const parsed = extractFrontmatter('# Body\n');
    expect(parsed.frontmatter).toBeNull();
    expect(parsed.body).toBe('# Body\n');
    expect(parsed.bodyStartLine).toBe(1);
  });
});
