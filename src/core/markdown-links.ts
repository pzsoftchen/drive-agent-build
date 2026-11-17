export interface MarkdownLink {
  target: string;
  line: number;
}

export function extractMarkdownLinks(text: string): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  const lines = text.split('\n');
  let inFence = false;
  let fenceCharacter = '`';

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const fence = /^\s*(```+|~~~+)/.exec(line);
    if (fence !== null) {
      const marker = fence[1]?.[0] ?? '`';
      if (!inFence) {
        inFence = true;
        fenceCharacter = marker;
      } else if (marker === fenceCharacter) {
        inFence = false;
      }
      continue;
    }
    if (inFence) {
      continue;
    }

    const cleaned = line.replace(/`[^`]*`/g, '');
    for (const match of cleaned.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      let target = (match[1] ?? '').trim();
      if (target.startsWith('<') && target.endsWith('>')) {
        target = target.slice(1, -1).trim();
      }
      target = target.split(/\s+/)[0] ?? '';
      if (target.length > 0) {
        links.push({ target, line: index + 1 });
      }
    }
  }

  return links;
}
