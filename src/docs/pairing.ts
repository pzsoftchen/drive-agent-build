import { readdir } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import type { Diagnostic } from '../core/diagnostics.ts';
import { lstatOrNull, readTextFile, writeFileAtomic } from '../core/fs-atomic.ts';
import { isPathInside, toPosix } from '../core/paths.ts';
import { parseFrontmatter } from '../model/frontmatter.ts';
import {
  contentHash,
  extractFrontmatter,
  scanMarkdown,
  splitSections,
} from './markdown.ts';

const I18nRecordSchema = z
  .object({
    version: z.literal(1),
    source: z.string().min(1),
    translation: z.string().min(1),
    frontmatter: z
      .object({
        source: z.string(),
        translation: z.string(),
      })
      .strict(),
    sections: z.array(
      z
        .object({
          index: z.number().int().nonnegative(),
          level: z.number().int().min(0).max(6),
          source: z.string(),
          translation: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

export type I18nRecord = z.infer<typeof I18nRecordSchema>;

export interface PairPaths {
  source: string;
  translation: string;
  record: string;
}

export interface PairingGaps {
  missingTranslations: string[];
  missingRecords: string[];
  orphanTranslations: string[];
  orphanRecords: string[];
}

export interface PairingReport {
  diagnostics: Diagnostic[];
  gaps: PairingGaps;
  checked: number;
}

export interface PairingOptions {
  write?: boolean;
  list?: boolean;
}

const SKIP_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  '.dab',
  '.claude',
  '.superpowers',
]);

const EXCLUDED_PREFIXES = [
  '.agents/agents/',
  '.agents/skills/',
  '.agents/rules/',
  '.agents/memory/',
  '.agents/hooks/',
  '.agents/policies/',
  '.agents/adapters/',
  'docs/i18n/',
];

function relativePath(root: string, file: string): string {
  return toPosix(relative(root, resolve(root, file)));
}

export function isPairingCandidate(file: string): boolean {
  const posix = toPosix(file).replace(/^\.\//, '');
  if (!posix.endsWith('.md') || posix.endsWith('.zh.md')) {
    return false;
  }
  const name = basename(posix);
  if (name === 'AGENTS.md' || name === 'CLAUDE.md') {
    return false;
  }
  if (EXCLUDED_PREFIXES.some((prefix) => posix.startsWith(prefix))) {
    return false;
  }
  if (posix.startsWith('.agents/notes/') && name !== 'INDEX.md') {
    return true;
  }
  if (posix === 'README.md' || posix === 'CONTRIBUTING.md' || posix === 'CHANGELOG.md') {
    return true;
  }
  return posix.startsWith('docs/') && !posix.startsWith('docs/i18n/');
}

function skipDirectory(relativeDir: string): boolean {
  const posix = toPosix(relativeDir).replace(/^\.\//, '');
  if (SKIP_DIRECTORIES.has(posix)) {
    return true;
  }
  return EXCLUDED_PREFIXES.some((prefix) => posix === prefix.replace(/\/$/, '') || posix.startsWith(prefix));
}

async function walkFiles(root: string, dir = '', output: string[] = []): Promise<string[]> {
  const absolute = join(root, dir);
  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return output;
    }
    throw error;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = dir.length === 0 ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!skipDirectory(child)) {
        await walkFiles(root, child, output);
      }
    } else if (entry.isFile() && (entry.name.endsWith('.md')
      || entry.name.endsWith('.i18n.yaml'))) {
      output.push(toPosix(child));
    }
  }
  return output;
}

export async function discoverPairedDocs(root: string): Promise<string[]> {
  const files = await walkFiles(root);
  return files.filter((file) => isPairingCandidate(file)).sort();
}

export async function pairPaths(root: string, file: string): Promise<PairPaths | undefined> {
  const posix = relativePath(root, file);
  let source: string;
  if (posix.endsWith('.zh.md')) {
    source = posix.replace(/\.zh\.md$/, '.md');
  } else if (posix.endsWith('.i18n.yaml')) {
    source = posix.replace(/\.i18n\.yaml$/, '.md');
  } else if (posix.endsWith('.md')) {
    source = posix;
  } else {
    return undefined;
  }
  if (!isPairingCandidate(source)) {
    return undefined;
  }
  const translation = source.replace(/\.md$/, '.zh.md');
  const record = source.replace(/\.md$/, '.i18n.yaml');
  return { source, translation, record };
}

export async function listPairingGaps(root: string): Promise<PairingGaps> {
  const sources = await discoverPairedDocs(root);
  const missingTranslations: string[] = [];
  const missingRecords: string[] = [];
  for (const source of sources) {
    const paths = await pairPaths(root, source);
    if (paths === undefined) {
      continue;
    }
    if ((await lstatOrNull(join(root, paths.translation))) === null) {
      missingTranslations.push(source);
    }
    if ((await lstatOrNull(join(root, paths.record))) === null) {
      missingRecords.push(source);
    }
  }

  const allFiles = await walkFiles(root);
  const orphanTranslations: string[] = [];
  const orphanRecords: string[] = [];
  for (const file of allFiles) {
    if (file.endsWith('.zh.md')) {
      const source = file.replace(/\.zh\.md$/, '.md');
      if (!isPairingCandidate(source) || (await lstatOrNull(join(root, source))) === null) {
        orphanTranslations.push(file);
      }
    } else if (file.endsWith('.i18n.yaml')) {
      const source = file.replace(/\.i18n\.yaml$/, '.md');
      if (!isPairingCandidate(source) || (await lstatOrNull(join(root, source))) === null) {
        orphanRecords.push(file);
      }
    }
  }

  return {
    missingTranslations: missingTranslations.sort(),
    missingRecords: missingRecords.sort(),
    orphanTranslations: [...new Set(orphanTranslations)].sort(),
    orphanRecords: [...new Set(orphanRecords)].sort(),
  };
}

interface DocRead {
  text: string;
  body: string;
  frontmatter: string | null;
  bodyStartLine: number;
  switchError?: Diagnostic;
}

function switchLine(sourceRel: string, translationRel: string, english: boolean): string {
  const baseSource = basename(sourceRel);
  const baseTranslation = basename(translationRel);
  return english
    ? `English | [中文](${baseTranslation})`
    : `[English](${baseSource}) | 中文`;
}

async function readDoc(
  root: string,
  relativeFile: string,
  expectedSwitch: string,
): Promise<DocRead> {
  const absolute = join(root, relativeFile);
  const text = await readTextFile(absolute);
  const split = extractFrontmatter(text);
  const lines = split.body.split('\n');
  const firstContent = lines.findIndex((line) => line.trim().length > 0);
  let switchError: Diagnostic | undefined;
  if (firstContent === -1 || lines[firstContent]?.trim() !== expectedSwitch) {
    switchError = {
      code: 'doc.lang-switch',
      severity: 'error',
      message: `missing or incorrect language switch; expected: ${expectedSwitch}`,
      file: relativeFile,
      line: split.bodyStartLine + Math.max(0, firstContent),
    };
  }
  if (firstContent !== -1) {
    lines[firstContent] = '';
  }
  return {
    text,
    body: lines.join('\n'),
    frontmatter: split.frontmatter,
    bodyStartLine: split.bodyStartLine,
    ...(switchError === undefined ? {} : { switchError }),
  };
}

function add(
  diagnostics: Diagnostic[],
  code: string,
  message: string,
  file: string,
  line?: number,
  hint?: string,
): void {
  diagnostics.push({
    code,
    severity: 'error',
    message,
    file,
    ...(line === undefined ? {} : { line }),
    ...(hint === undefined ? {} : { hint }),
  });
}

function mapLocalTarget(
  target: string,
  sourceRel: string,
  translationRel: string,
  root: string,
  pairedSources: ReadonlySet<string>,
): string {
  const base = target.split('#')[0] ?? '';
  if (base.length === 0) {
    return base;
  }
  const absolute = resolve(dirname(join(root, sourceRel)), base);
  if (!isPathInside(root, absolute)) {
    return base;
  }
  const resolvedRel = toPosix(relative(root, absolute));
  if (pairedSources.has(resolvedRel) && resolvedRel.endsWith('.md')) {
    const zhRel = resolvedRel.replace(/\.md$/, '.zh.md');
    return toPosix(relative(dirname(join(root, translationRel)), join(root, zhRel)));
  }
  return base;
}

function compareLinks(
  sourceLinks: ReturnType<typeof scanMarkdown>['links'],
  translationLinks: ReturnType<typeof scanMarkdown>['links'],
  sourceRel: string,
  translationRel: string,
  root: string,
  pairedSources: ReadonlySet<string>,
  diagnostics: Diagnostic[],
  sectionLine: number,
): void {
  if (sourceLinks.length !== translationLinks.length) {
    add(
      diagnostics,
      'doc.links',
      `link count differs in section ${sectionLine}: ${sourceLinks.length} != ${translationLinks.length}`,
      sourceRel,
      sectionLine,
    );
    return;
  }

  for (let index = 0; index < sourceLinks.length; index += 1) {
    const source = sourceLinks[index];
    const translation = translationLinks[index];
    if (source === undefined || translation === undefined) {
      continue;
    }
    if (source.external) {
      if (translation.target !== source.target) {
        add(
          diagnostics,
          'doc.links',
          `external link differs: ${source.target} != ${translation.target}`,
          sourceRel,
          source.line,
        );
      }
      continue;
    }
    if (source.anchorOnly) {
      if (!translation.anchorOnly) {
        add(
          diagnostics,
          'doc.links',
          'anchor-only link does not correspond in the translation',
          sourceRel,
          source.line,
        );
      }
      continue;
    }

    const sourceBase = source.target.split('#')[0] ?? '';
    if (sourceBase.endsWith('.zh.md')) {
      add(
        diagnostics,
        'doc.links',
        `English documentation must not link to a Chinese counterpart: ${source.target}`,
        sourceRel,
        source.line,
      );
    }
    const expected = mapLocalTarget(
      source.target,
      sourceRel,
      translationRel,
      root,
      pairedSources,
    );
    const translationBase = translation.target.split('#')[0] ?? '';
    if (translationBase !== expected) {
      add(
        diagnostics,
        'doc.links',
        `local link should point at ${expected}, got ${translation.target}`,
        translationRel,
        translation.line,
      );
    }
    const sourceAnchor = source.target.includes('#');
    const translationAnchor = translation.target.includes('#');
    if (sourceAnchor !== translationAnchor) {
      add(
        diagnostics,
        'doc.links',
        'link anchor presence differs between languages',
        translationRel,
        translation.line,
      );
    }
  }
}

function compareSection(
  sourceScan: ReturnType<typeof scanMarkdown>,
  translationScan: ReturnType<typeof scanMarkdown>,
  sourceRel: string,
  translationRel: string,
  root: string,
  pairedSources: ReadonlySet<string>,
  sectionLine: number,
  diagnostics: Diagnostic[],
): void {
  const listShape = (markers: ReturnType<typeof scanMarkdown>['listMarkers']): string[] =>
    markers.map((marker) => (marker.ordered ? `o:${marker.marker}` : `u:${marker.marker}`));
  if (JSON.stringify(listShape(sourceScan.listMarkers)) !== JSON.stringify(listShape(translationScan.listMarkers))) {
    add(
      diagnostics,
      'doc.structure',
      'list markers differ in shape',
      sourceRel,
      sectionLine,
    );
  }

  const tableShape = (tables: ReturnType<typeof scanMarkdown>['tables']): string[] =>
    tables.map((table) => `${table.rows}x${table.columns}`);
  if (JSON.stringify(tableShape(sourceScan.tables)) !== JSON.stringify(tableShape(translationScan.tables))) {
    add(
      diagnostics,
      'doc.structure',
      'table shape differs',
      sourceRel,
      sectionLine,
    );
  }

  if (sourceScan.blockquotes !== translationScan.blockquotes) {
    add(
      diagnostics,
      'doc.structure',
      'blockquote count differs',
      sourceRel,
      sectionLine,
    );
  }
  if (sourceScan.horizontalRules !== translationScan.horizontalRules) {
    add(
      diagnostics,
      'doc.structure',
      'horizontal rule count differs',
      sourceRel,
      sectionLine,
    );
  }

  if (JSON.stringify(sourceScan.inlineCode) !== JSON.stringify(translationScan.inlineCode)) {
    add(
      diagnostics,
      'doc.code',
      'inline code spans must be byte-identical in both languages',
      sourceRel,
      sectionLine,
    );
  }

  if (sourceScan.codeBlocks.length !== translationScan.codeBlocks.length) {
    add(
      diagnostics,
      'doc.code',
      'fenced code block count differs',
      sourceRel,
      sectionLine,
    );
  } else {
    for (let index = 0; index < sourceScan.codeBlocks.length; index += 1) {
      const source = sourceScan.codeBlocks[index];
      const translation = translationScan.codeBlocks[index];
      if (
        source === undefined
        || translation === undefined
        || source.lang !== translation.lang
        || source.content !== translation.content
      ) {
        add(
          diagnostics,
          'doc.code',
          'fenced code blocks must be byte-identical in both languages',
          sourceRel,
          sectionLine,
        );
        break;
      }
    }
  }

  compareLinks(
    sourceScan.links,
    translationScan.links,
    sourceRel,
    translationRel,
    root,
    pairedSources,
    diagnostics,
    sectionLine,
  );
}

function serializeRecord(record: I18nRecord): string {
  const text = stringifyYaml(record, { lineWidth: 0 });
  return text.endsWith('\n') ? text : `${text}\n`;
}

function readRecord(text: string): I18nRecord | undefined {
  try {
    const parsed = I18nRecordSchema.safeParse(parseYaml(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export async function verifyPairingFile(
  root: string,
  file: string,
  options: PairingOptions = {},
): Promise<Diagnostic[]> {
  const paths = await pairPaths(root, file);
  if (paths === undefined) {
    return [{
      code: 'doc.not-candidate',
      severity: 'error',
      message: 'file is not part of the bilingual documentation set',
      file: relativePath(root, file),
    }];
  }

  const diagnostics: Diagnostic[] = [];
  if ((await lstatOrNull(join(root, paths.source))) === null) {
    return [{
      code: 'doc.source-missing',
      severity: 'error',
      message: 'paired English source is missing',
      file: paths.source,
    }];
  }
  if ((await lstatOrNull(join(root, paths.translation))) === null) {
    return [{
      code: 'doc.pair-missing',
      severity: 'error',
      message: 'Chinese translation is missing',
      file: paths.source,
      hint: `Create ${paths.translation} and rerun the pairing check.`,
    }];
  }

  const source = await readDoc(root, paths.source, switchLine(paths.source, paths.translation, true));
  const translation = await readDoc(
    root,
    paths.translation,
    switchLine(paths.source, paths.translation, false),
  );
  for (const doc of [source, translation]) {
    if (doc.switchError !== undefined) {
      diagnostics.push(doc.switchError);
    }
  }

  try {
    const sourceFm = parseFrontmatter(source.text, paths.source);
    const translationFm = parseFrontmatter(translation.text, paths.translation);
    const sourceKeys = Object.keys(sourceFm.data).sort();
    const translationKeys = Object.keys(translationFm.data).sort();
    if (JSON.stringify(sourceKeys) !== JSON.stringify(translationKeys)) {
      add(
        diagnostics,
        'doc.frontmatter',
        'frontmatter keys differ between languages',
        paths.source,
        1,
      );
    }
  } catch (error) {
    add(
      diagnostics,
      'doc.frontmatter',
      `frontmatter cannot be compared: ${error instanceof Error ? error.message : String(error)}`,
      paths.source,
      1,
    );
  }

  const sourceScan = scanMarkdown(source.body);
  const translationScan = scanMarkdown(translation.body);
  const sourceSections = splitSections(source.body);
  const translationSections = splitSections(translation.body);
  const pairedSources = new Set(await discoverPairedDocs(root));

  if (sourceSections.length !== translationSections.length) {
    add(
      diagnostics,
      'doc.structure',
      `section count differs: ${sourceSections.length} != ${translationSections.length}`,
      paths.source,
      1,
    );
  }
  const sectionCount = Math.min(sourceSections.length, translationSections.length);
  for (let index = 0; index < sectionCount; index += 1) {
    const sourceSection = sourceSections[index];
    const translationSection = translationSections[index];
    if (sourceSection === undefined || translationSection === undefined) {
      continue;
    }
    if (sourceSection.level !== translationSection.level) {
      add(
        diagnostics,
        'doc.structure',
        `heading level differs in section ${index}`,
        paths.source,
        1,
      );
      continue;
    }
    compareSection(
      scanMarkdown(sourceSection.text),
      scanMarkdown(translationSection.text),
      paths.source,
      paths.translation,
      root,
      pairedSources,
      sourceScan.headings[index - 1]?.line ?? 1,
      diagnostics,
    );
  }

  const record: I18nRecord = {
    version: 1,
    source: paths.source,
    translation: paths.translation,
    frontmatter: {
      source: contentHash(source.frontmatter ?? ''),
      translation: contentHash(translation.frontmatter ?? ''),
    },
    sections: sourceSections.map((section, index) => ({
      index,
      level: section.level,
      source: contentHash(section.text),
      translation: contentHash(translationSections[index]?.text ?? ''),
    })),
  };

  const recordPath = join(root, paths.record);
  const recordInfo = await lstatOrNull(recordPath);
  if (recordInfo === null) {
    add(
      diagnostics,
      'doc.record-missing',
      'translation pairing record is missing',
      paths.record,
      undefined,
      'Run pnpm run verify-translation-pairing --write after confirming both sides.',
    );
  } else {
    const existing = readRecord(await readTextFile(recordPath));
    if (existing === undefined) {
      add(diagnostics, 'doc.record-invalid', 'translation pairing record is invalid', paths.record);
    } else if (JSON.stringify(existing) !== JSON.stringify(record)) {
      add(
        diagnostics,
        'doc.i18n-stale',
        'translation pairing record is stale',
        paths.record,
        undefined,
        'Run pnpm run verify-translation-pairing --write after confirming both sides.',
      );
    }
  }

  const hasStructuralErrors = diagnostics.some(
    (item) => item.severity === 'error'
      && item.code !== 'doc.record-missing'
      && item.code !== 'doc.i18n-stale'
      && item.code !== 'doc.record-invalid',
  );
  if (options.write === true && !hasStructuralErrors) {
    await writeFileAtomic(recordPath, serializeRecord(record));
    return diagnostics.filter(
      (item) => item.code !== 'doc.record-missing'
        && item.code !== 'doc.i18n-stale'
        && item.code !== 'doc.record-invalid',
    );
  }

  return diagnostics;
}

function gapDiagnostics(gaps: PairingGaps): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const file of gaps.missingTranslations) {
    add(diagnostics, 'doc.pair-missing', 'Chinese translation is missing', file);
  }
  for (const file of gaps.missingRecords) {
    add(diagnostics, 'doc.record-missing', 'translation pairing record is missing', file);
  }
  for (const file of gaps.orphanTranslations) {
    add(diagnostics, 'doc.orphan', 'orphan Chinese translation has no English source', file);
  }
  for (const file of gaps.orphanRecords) {
    add(diagnostics, 'doc.orphan', 'orphan translation record has no English source', file);
  }
  return diagnostics;
}

export async function verifyAllPairings(
  root: string,
  options: PairingOptions = {},
): Promise<PairingReport> {
  const sources = await discoverPairedDocs(root);
  const gaps = await listPairingGaps(root);
  if (options.list === true) {
    return {
      diagnostics: gapDiagnostics(gaps),
      gaps,
      checked: sources.length,
    };
  }

  const diagnostics: Diagnostic[] = [];
  for (const source of sources) {
    diagnostics.push(...await verifyPairingFile(root, source, { write: options.write === true }));
  }
  diagnostics.push(...gapDiagnostics(gaps).filter((item) => item.code === 'doc.orphan'));
  return {
    diagnostics,
    gaps,
    checked: sources.length,
  };
}
