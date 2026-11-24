import { createHash } from 'node:crypto';

/**
 * The `<!-- dab-skill: name@version sha256=... -->` marker written into an
 * installed authoring skill. The hash is optional so legacy installs from
 * 0.1.x still parse.
 */
export interface SkillMarker {
  name: string;
  version: string;
  sha256?: string;
}

const MARKER_LINE =
  /^[ \t]*<!--[ \t]*dab-skill:[ \t]*([a-z0-9-]+)@([^\s>]+)(?:[ \t]+sha256=([0-9a-f]{64}))?[ \t]*-->[ \t]*$/m;

const MARKER_LINE_WITH_NEWLINE =
  /^[ \t]*<!--[ \t]*dab-skill:[^\n]*-->[ \t]*(?:\n|$)/m;

const FRONTMATTER_OPEN = /^---[ \t]*\r?\n/;

function frontmatterEnd(template: string): number {
  const opening = FRONTMATTER_OPEN.exec(template);
  if (opening === null) {
    throw new Error('skill template has no YAML frontmatter');
  }
  const rest = template.slice(opening[0].length);
  const closing = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (closing === null) {
    throw new Error('skill template frontmatter has no closing --- line');
  }
  return opening[0].length + closing.index + closing[0].length;
}

export function formatSkillMarker(marker: SkillMarker & { sha256: string }): string {
  return `<!-- dab-skill: ${marker.name}@${marker.version} sha256=${marker.sha256} -->`;
}

/** Insert the marker immediately after the frontmatter closing `---` line. */
export function insertSkillMarker(
  template: string,
  marker: SkillMarker & { sha256: string },
): string {
  const end = frontmatterEnd(template);
  const prefix = template.slice(0, end);
  const separator = prefix.endsWith('\n') ? '' : '\n';
  return `${prefix}${separator}${formatSkillMarker(marker)}\n${template.slice(end)}`;
}

/**
 * Remove the marker line from skill text. A file without a marker is returned
 * byte-for-byte unchanged, so insertion followed by removal round-trips to the
 * canonical template.
 */
export function removeSkillMarker(text: string): string {
  return text.replace(MARKER_LINE_WITH_NEWLINE, '');
}

/** Alias used by tests and callers that describe the operation as stripping. */
export const stripMarker = removeSkillMarker;

export function parseSkillMarker(text: string): SkillMarker | undefined {
  const match = MARKER_LINE.exec(text);
  if (match === null) {
    return undefined;
  }
  const [, name, version, sha256] = match;
  return {
    name: name as string,
    version: version as string,
    ...(sha256 === undefined ? {} : { sha256 }),
  };
}

/** SHA-256 of the UTF-8 text after removing the marker line. */
export function hashSkillBody(text: string): string {
  return createHash('sha256').update(removeSkillMarker(text), 'utf8').digest('hex');
}
