import { join } from 'node:path';
import { lstatOrNull, readTextFile } from '../core/fs-atomic.ts';

export type DocsLanguage = 'en' | 'zh';
export type DocsLanguageSource =
  | 'config'
  | 'docs/AGENTS.md'
  | 'docs/architecture.md'
  | 'AGENTS.md'
  | 'README.md'
  | 'package.json'
  | 'locale'
  | 'default';

export interface DocsLanguageResolution {
  value: DocsLanguage;
  source: DocsLanguageSource;
}

const CJK_PATTERN = /[一-鿿]/gu;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

function stripFencedCode(text: string): string {
  const kept: string[] = [];
  let fence: { marker: string; length: number } | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (fence === undefined) {
      const opening = FENCE_OPEN.exec(line);
      if (opening !== null) {
        const marker = opening[1] ?? '';
        fence = { marker: marker[0] ?? '', length: marker.length };
        continue;
      }
      kept.push(line);
      continue;
    }
    const closing = FENCE_CLOSE.exec(line);
    if (
      closing !== null &&
      (closing[1]?.[0] ?? '') === fence.marker &&
      (closing[1]?.length ?? 0) >= fence.length
    ) {
      fence = undefined;
    }
  }
  return kept.join('\n');
}

function sampleTitleAndFirstParagraph(text: string): string {
  return text
    .split(/\n[ \t]*\n+/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .slice(0, 2)
    .join('\n');
}

export function detectTextLanguage(text: string): DocsLanguage | undefined {
  const sample = sampleTitleAndFirstParagraph(stripFencedCode(text));
  const content = sample.replace(/\s/gu, '');
  if (content.length === 0) {
    return undefined;
  }
  const cjk = content.match(CJK_PATTERN)?.length ?? 0;
  return cjk >= 8 && cjk / content.length >= 0.2 ? 'zh' : 'en';
}

async function detectFromFile(
  root: string,
  relativePath: string,
): Promise<DocsLanguage | undefined> {
  const absolute = join(root, relativePath);
  try {
    if ((await lstatOrNull(absolute)) === null) {
      return undefined;
    }
    return detectTextLanguage(await readTextFile(absolute));
  } catch {
    // An unreadable or oversized source is treated as no signal.
    return undefined;
  }
}

async function detectFromPackageDescription(root: string): Promise<DocsLanguage | undefined> {
  try {
    const absolute = join(root, 'package.json');
    if ((await lstatOrNull(absolute)) === null) {
      return undefined;
    }
    const parsed: unknown = JSON.parse(await readTextFile(absolute));
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }
    const description = (parsed as { description?: unknown }).description;
    return typeof description === 'string' ? detectTextLanguage(description) : undefined;
  } catch {
    return undefined;
  }
}

function detectFromLocale(env: NodeJS.ProcessEnv): DocsLanguage | undefined {
  const locale = env.LC_ALL !== undefined && env.LC_ALL !== '' ? env.LC_ALL : env.LANG;
  if (locale === undefined || locale === '') {
    return undefined;
  }
  return locale.toLowerCase().startsWith('zh') ? 'zh' : undefined;
}

export async function resolveDocsLanguage(input: {
  root: string;
  configured: 'auto' | DocsLanguage;
  env?: NodeJS.ProcessEnv;
}): Promise<DocsLanguageResolution> {
  if (input.configured !== 'auto') {
    return { value: input.configured, source: 'config' };
  }

  const sources: ReadonlyArray<readonly [string, DocsLanguageSource]> = [
    ['docs/AGENTS.md', 'docs/AGENTS.md'],
    ['docs/architecture.md', 'docs/architecture.md'],
    ['AGENTS.md', 'AGENTS.md'],
    ['README.md', 'README.md'],
  ];
  for (const [relativePath, source] of sources) {
    const value = await detectFromFile(input.root, relativePath);
    if (value !== undefined) {
      return { value, source };
    }
  }

  const fromPackage = await detectFromPackageDescription(input.root);
  if (fromPackage !== undefined) {
    return { value: fromPackage, source: 'package.json' };
  }

  // Callers pass the process environment explicitly; omitting it means no locale signal.
  const fromLocale = detectFromLocale(input.env ?? {});
  if (fromLocale !== undefined) {
    return { value: fromLocale, source: 'locale' };
  }

  return { value: 'en', source: 'default' };
}
