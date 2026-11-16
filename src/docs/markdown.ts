import { sha256 } from '../core/hash.ts';

export interface MarkdownHeading {
  level: number;
  text: string;
  line: number;
}

export interface MarkdownCodeBlock {
  lang: string;
  content: string;
  line: number;
}

export interface MarkdownLinkInfo {
  text: string;
  target: string;
  line: number;
  image: boolean;
  external: boolean;
  anchorOnly: boolean;
}

export interface MarkdownTable {
  rows: number;
  columns: number;
  line: number;
}

export interface MarkdownListMarker {
  ordered: boolean;
  marker: string;
  line: number;
}

export interface MarkdownScan {
  headings: MarkdownHeading[];
  codeBlocks: MarkdownCodeBlock[];
  inlineCode: string[];
  links: MarkdownLinkInfo[];
  tables: MarkdownTable[];
  listMarkers: MarkdownListMarker[];
  blockquotes: number;
  horizontalRules: number;
}

export interface MarkdownSection {
  index: number;
  level: number;
  heading: string;
  text: string;
}

export interface FrontmatterSplit {
  frontmatter: string | null;
  body: string;
  bodyStartLine: number;
}

function isExternalTarget(target: string): boolean {
  return target.startsWith('http://')
    || target.startsWith('https://')
    || target.startsWith('mailto:');
}

function cleanTarget(raw: string): string {
  let target = raw.trim();
  if (target.startsWith('<') && target.endsWith('>')) {
    target = target.slice(1, -1).trim();
  }
  return target.split(/\s+/)[0] ?? '';
}

function countCells(line: string): number {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').length;
}

function detectTables(lines: readonly string[], fenceRanges: ReadonlyArray<readonly [number, number]>): MarkdownTable[] {
  const inFence = (index: number): boolean => fenceRanges.some(
    ([start, end]) => index + 1 >= start && index + 1 <= end,
  );
  const tables: MarkdownTable[] = [];
  const separator = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

  for (let index = 0; index < lines.length - 1; index += 1) {
    if (inFence(index)) {
      continue;
    }
    const header = lines[index] ?? '';
    const rule = lines[index + 1] ?? '';
    if (!header.includes('|') || !separator.test(rule)) {
      continue;
    }
    const columns = countCells(header);
    let rows = 1;
    let cursor = index + 2;
    while (
      cursor < lines.length
      && !inFence(cursor)
      && (lines[cursor] ?? '').includes('|')
      && (lines[cursor] ?? '').trim().length > 0
    ) {
      rows += 1;
      cursor += 1;
    }
    tables.push({ rows, columns, line: index + 1 });
    index = cursor - 1;
  }
  return tables;
}

export function scanMarkdown(text: string): MarkdownScan {
  const normalized = text.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const headings: MarkdownHeading[] = [];
  const codeBlocks: MarkdownCodeBlock[] = [];
  const inlineCode: string[] = [];
  const links: MarkdownLinkInfo[] = [];
  const listMarkers: MarkdownListMarker[] = [];
  const fenceRanges: Array<[number, number]> = [];
  let blockquotes = 0;
  let horizontalRules = 0;
  let inFence = false;
  let fenceCharacter = '`';
  let fenceLength = 0;
  let fenceStart = 0;
  let fenceLanguage = '';
  let fenceLines: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence !== null) {
      const marker = fence[1] ?? '```';
      const info = fence[2] ?? '';
      if (!inFence) {
        inFence = true;
        fenceCharacter = marker[0] ?? '`';
        fenceLength = marker.length;
        fenceStart = index + 1;
        fenceLanguage = info.trim().split(/\s+/)[0] ?? '';
        fenceLines = [];
      } else if (
        (marker[0] ?? '') === fenceCharacter
        && marker.length >= fenceLength
        && info.trim().length === 0
      ) {
        codeBlocks.push({ lang: fenceLanguage, content: fenceLines.join('\n'), line: fenceStart });
        fenceRanges.push([fenceStart, index + 1]);
        inFence = false;
      } else {
        fenceLines.push(line);
      }
      continue;
    }

    if (inFence) {
      fenceLines.push(line);
      continue;
    }

    const heading = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading !== null) {
      headings.push({
        level: (heading[1] ?? '').length,
        text: (heading[2] ?? '').trim(),
        line: index + 1,
      });
    }

    if (/^ {0,3}>\s?/.test(line)) {
      blockquotes += 1;
    }

    const isHorizontalRule = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line);
    if (isHorizontalRule) {
      horizontalRules += 1;
    } else {
      const list = /^ {0,3}([-*+]|\d+[.)])\s+/.exec(line);
      if (list !== null) {
        const marker = list[1] ?? '';
        listMarkers.push({
          ordered: /^\d/.test(marker),
          marker,
          line: index + 1,
        });
      }
    }

    const withoutCode = line.replace(/(`+)(.*?)\1/g, (full: string, _ticks: string, content: string) => {
      inlineCode.push(content);
      return ' '.repeat(full.length);
    });

    for (const match of withoutCode.matchAll(/!?\[([^\]]*)\]\(([^)]+)\)/g)) {
      const target = cleanTarget(match[2] ?? '');
      if (target.length === 0) {
        continue;
      }
      links.push({
        text: match[1] ?? '',
        target,
        line: index + 1,
        image: (match[0] ?? '').startsWith('!'),
        external: isExternalTarget(target),
        anchorOnly: target.startsWith('#'),
      });
    }
  }

  if (inFence) {
    codeBlocks.push({ lang: fenceLanguage, content: fenceLines.join('\n'), line: fenceStart });
    fenceRanges.push([fenceStart, lines.length]);
  }

  return {
    headings,
    codeBlocks,
    inlineCode,
    links,
    tables: detectTables(lines, fenceRanges),
    listMarkers,
    blockquotes,
    horizontalRules,
  };
}

export function splitSections(text: string): MarkdownSection[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const scan = scanMarkdown(normalized);
  const sections: MarkdownSection[] = [];
  const firstHeadingLine = scan.headings[0]?.line ?? lines.length + 1;
  sections.push({
    index: 0,
    level: 0,
    heading: '',
    text: lines.slice(0, Math.max(0, firstHeadingLine - 1)).join('\n'),
  });

  scan.headings.forEach((heading, headingIndex) => {
    const start = heading.line - 1;
    const end = scan.headings[headingIndex + 1]?.line
      ? (scan.headings[headingIndex + 1]?.line ?? lines.length + 1) - 1
      : lines.length;
    sections.push({
      index: headingIndex + 1,
      level: heading.level,
      heading: heading.text,
      text: lines.slice(start, end).join('\n'),
    });
  });

  return sections;
}

export function structureSignature(scan: MarkdownScan): string {
  return JSON.stringify({
    headings: scan.headings.map((heading) => heading.level),
    lists: scan.listMarkers.map((marker) => (marker.ordered ? `o:${marker.marker}` : `u:${marker.marker}`)),
    tables: scan.tables.map((table) => `${table.rows}x${table.columns}`),
    blockquotes: scan.blockquotes,
    rules: scan.horizontalRules,
    codeLanguages: scan.codeBlocks.map((block) => block.lang),
    linkCount: scan.links.length,
    externalLinks: scan.links.filter((link) => link.external).map((link) => link.target),
  });
}

export function extractFrontmatter(text: string): FrontmatterSplit {
  const normalized = text.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  if ((lines[0] ?? '').trim() !== '---') {
    return { frontmatter: null, body: normalized, bodyStartLine: 1 };
  }
  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').trim();
    if (line === '---' || line === '...') {
      end = index;
      break;
    }
  }
  if (end === -1) {
    return { frontmatter: null, body: normalized, bodyStartLine: 1 };
  }
  return {
    frontmatter: lines.slice(1, end).join('\n'),
    body: lines.slice(end + 1).join('\n'),
    bodyStartLine: end + 2,
  };
}

export function contentHash(text: string): string {
  return sha256(text.replace(/\r\n?/g, '\n'));
}

export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/`[^`]*`/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
