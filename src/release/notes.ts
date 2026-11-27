import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ReleaseNotesInput {
  version: string;
  english: string;
  chinese: string;
  repositoryUrl: string;
}

function normalizeVersion(value: string): string {
  return value.replace(/^v/, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract the body of one exact version section from a changelog.
 *
 * The heading stays out of the release body because GitHub already shows the
 * tag title; the section body is the user-facing release log.
 */
export function extractReleaseSection(changelog: string, version: string): string {
  const normalized = normalizeVersion(version);
  const heading = new RegExp(
    `^##\\s+${escapeRegExp(normalized)}(?:\\s+[—-]\\s+.*)?\\s*$`,
    'm',
  );
  const match = heading.exec(changelog);
  if (match === null) {
    throw new Error(`release section ${normalized} not found in changelog`);
  }
  const rest = changelog.slice(match.index + match[0].length);
  const next = /^##\s+/m.exec(rest);
  const section = (next === null ? rest : rest.slice(0, next.index)).trim();
  if (section.length === 0) {
    throw new Error(`release section ${normalized} is empty`);
  }
  return section;
}

/**
 * Build a GitHub Release body with English and Simplified Chinese release logs.
 * The changelog remains the single source of truth; this only composes the
 * paired sections into one body.
 */
export function renderReleaseNotes(input: ReleaseNotesInput): string {
  const version = normalizeVersion(input.version);
  const english = extractReleaseSection(input.english, version);
  const chinese = extractReleaseSection(input.chinese, version);
  const repository = input.repositoryUrl
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
  const tag = `v${version}`;
  return [
    '## English',
    '',
    english,
    '',
    '## 中文',
    '',
    chinese,
    '',
    '---',
    '',
    `Full changelog: [English](${repository}/blob/${tag}/CHANGELOG.md) · [中文](${repository}/blob/${tag}/CHANGELOG.zh.md)`,
    '',
  ].join('\n');
}

interface PackageMetadata {
  repository?: { url?: string };
}

export async function loadReleaseNotes(root: string, tag: string): Promise<string> {
  const packagePath = join(root, 'package.json');
  const packageText = await readFile(packagePath, 'utf8');
  const metadata = JSON.parse(packageText) as PackageMetadata;
  const repositoryUrl = metadata.repository?.url;
  if (repositoryUrl === undefined) {
    throw new Error(`package.json has no repository.url: ${packagePath}`);
  }
  const [english, chinese] = await Promise.all([
    readFile(join(root, 'CHANGELOG.md'), 'utf8'),
    readFile(join(root, 'CHANGELOG.zh.md'), 'utf8'),
  ]);
  return renderReleaseNotes({
    version: tag,
    english,
    chinese,
    repositoryUrl,
  });
}
