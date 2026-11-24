import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hashSkillBody,
  insertSkillMarker,
  parseSkillMarker,
  removeSkillMarker,
  stripMarker,
  type SkillMarker,
} from '../core/skill-marker.ts';

export const AUTHORING_SKILL_NAMES = [
  'dab-doc-writing',
  'dab-architecture-writing',
  'dab-decision-notes',
] as const;

export type AuthoringSkillName = (typeof AUTHORING_SKILL_NAMES)[number];

// From both `src/init/` and `dist/init/`, `../..` is the package root, where
// the published `skills/` directory lives.
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function loadAuthoringSkillTemplate(
  name: AuthoringSkillName,
): Promise<string> {
  return readFile(join(PACKAGE_ROOT, 'skills', name, 'SKILL.md'), 'utf8');
}

export async function renderAuthoringSkill(
  name: AuthoringSkillName,
  version: string,
): Promise<string> {
  const template = await loadAuthoringSkillTemplate(name);
  return insertSkillMarker(template, {
    name,
    version,
    sha256: hashSkillBody(template),
  });
}

export { hashSkillBody, insertSkillMarker, parseSkillMarker, removeSkillMarker, stripMarker };
export type { SkillMarker };
