import { join } from 'node:path';
import type { Diagnostic } from '../core/diagnostics.ts';
import { DabError } from '../core/errors.ts';
import { lstatOrNull, readTextFile, writeFileAtomic } from '../core/fs-atomic.ts';
import { assertParentInsideRoot } from '../core/paths.ts';
import {
  authoredFileProblem,
  problemMessage,
  probeLstat,
} from '../core/practice-paths.ts';
import {
  hashSkillBody,
  insertSkillMarker,
  parseSkillMarker,
  removeSkillMarker,
} from '../core/skill-marker.ts';
import {
  AUTHORING_SKILL_NAMES,
  loadAuthoringSkillTemplate,
  type AuthoringSkillName,
} from './skill-templates.ts';

export type ManagedSkillStatus =
  | 'current'
  | 'stale'
  | 'modified'
  | 'legacy'
  | 'unversioned'
  | 'missing';

export interface ManagedSkillState {
  name: AuthoringSkillName;
  /** Repository-relative POSIX path of the installed skill file. */
  file: string;
  status: ManagedSkillStatus;
  version?: string;
  hash?: string;
}

export interface ManagedSkillWrite {
  name: AuthoringSkillName;
  file: string;
  content: string;
}

export interface ManagedSkillPlan {
  states: ManagedSkillState[];
  writes: ManagedSkillWrite[];
  diagnostics: Diagnostic[];
}

export interface ManagedSkillApplyResult {
  created: string[];
  updated: string[];
  migrated: string[];
  skipped: string[];
}

export const MANAGED_SKILL_ROOT = '.agents/skills';

export const MANAGED_SKILL_DIAGNOSTIC_CODES = {
  modified: 'practice.skill-modified',
  legacy: 'practice.skill-legacy',
  unversioned: 'practice.skill-unversioned',
  path: 'practice.skill-path',
} as const;

const PATH_HINT = 'Resolve the path conflict manually; DAB never writes through it.';

export function managedSkillFile(name: AuthoringSkillName): string {
  return `${MANAGED_SKILL_ROOT}/${name}/SKILL.md`;
}

function pathError(file: string, message: string): Diagnostic {
  return {
    code: MANAGED_SKILL_DIAGNOSTIC_CODES.path,
    severity: 'error',
    message: `authoring skill path cannot be managed: ${message}`,
    file,
    hint: PATH_HINT,
  };
}

function modifiedWarning(file: string, name: string): Diagnostic {
  return {
    code: MANAGED_SKILL_DIAGNOSTIC_CODES.modified,
    severity: 'warning',
    message: `authoring skill content no longer matches its marker hash and is preserved: ${name}`,
    file,
    hint: 'Review the current template manually; DAB never overwrites user-modified skills.',
  };
}

function unversionedWarning(file: string, name: string): Diagnostic {
  return {
    code: MANAGED_SKILL_DIAGNOSTIC_CODES.unversioned,
    severity: 'warning',
    message: `authoring skill has no dab-skill marker for ${name}`,
    file,
    hint: 'Confirm the skill content manually; DAB preserves skills without a managed marker.',
  };
}

function legacyMigrationInfo(
  file: string,
  name: string,
  version: string,
): Diagnostic {
  return {
    code: MANAGED_SKILL_DIAGNOSTIC_CODES.legacy,
    severity: 'info',
    message: `legacy authoring skill will be migrated to version ${version}: ${name}`,
    file,
    hint: 'The marker-stripped body matches the current template, so the marker and hash can be upgraded.',
  };
}

function legacyPreservedWarning(file: string, name: string): Diagnostic {
  return {
    code: MANAGED_SKILL_DIAGNOSTIC_CODES.legacy,
    severity: 'warning',
    message: `legacy authoring skill body differs from the current template and is preserved: ${name}`,
    file,
    hint: 'Review the current template manually; DAB never overwrites user-authored content.',
  };
}

/**
 * A managed skill must be a regular file inside the root. Symlinks, special
 * files, unreadable paths and symlinked-parent escapes are blocking conflicts:
 * writing through a rename would replace a user link or escape the project.
 */
async function managedFileProblem(
  root: string,
  file: string,
): Promise<string | undefined> {
  const absolute = join(root, file);
  const state = await probeLstat(absolute);
  if (state.problem !== undefined) {
    return problemMessage(file, state.problem);
  }
  if (state.info === null) {
    try {
      await assertParentInsideRoot(root, file);
    } catch (error) {
      if (error instanceof DabError) {
        return error.message;
      }
      throw error;
    }
    return undefined;
  }
  if (!state.info.isFile()) {
    return `${file} is not a regular file`;
  }
  return authoredFileProblem(root, file);
}

/**
 * Inspect installed authoring skills and plan only the writes DAB owns: a
 * missing skill, an unmodified older template, or a legacy marker whose body
 * still equals the current template. Modified, foreign and unversioned skills
 * are reported but never overwritten.
 */
export async function planManagedSkills(input: {
  root: string;
  version: string;
  names?: readonly AuthoringSkillName[];
}): Promise<ManagedSkillPlan> {
  const names = [...new Set(input.names ?? AUTHORING_SKILL_NAMES)];
  const states: ManagedSkillState[] = [];
  const writes: ManagedSkillWrite[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const name of names) {
    const file = managedSkillFile(name);
    const template = await loadAuthoringSkillTemplate(name);
    const candidate = insertSkillMarker(template, {
      name,
      version: input.version,
      sha256: hashSkillBody(template),
    });

    const problem = await managedFileProblem(input.root, file);
    if (problem !== undefined) {
      diagnostics.push(pathError(file, problem));
      continue;
    }

    const absolute = join(input.root, file);
    if ((await lstatOrNull(absolute)) === null) {
      states.push({ name, file, status: 'missing' });
      writes.push({ name, file, content: candidate });
      continue;
    }

    let text: string;
    try {
      text = await readTextFile(absolute);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.push(pathError(file, `authoring skill cannot be read: ${message}`));
      continue;
    }

    const marker = parseSkillMarker(text);
    if (marker === undefined || marker.name !== name) {
      states.push({ name, file, status: 'unversioned' });
      diagnostics.push(unversionedWarning(file, name));
      continue;
    }

    if (marker.sha256 === undefined) {
      states.push({ name, file, status: 'legacy', version: marker.version });
      if (removeSkillMarker(text) === template) {
        writes.push({ name, file, content: candidate });
        diagnostics.push(legacyMigrationInfo(file, name, input.version));
      } else {
        diagnostics.push(legacyPreservedWarning(file, name));
      }
      continue;
    }

    const hash = marker.sha256;
    if (hashSkillBody(text) !== hash) {
      states.push({
        name,
        file,
        status: 'modified',
        version: marker.version,
        hash,
      });
      diagnostics.push(modifiedWarning(file, name));
      continue;
    }

    // A matching hash proves the body is unmodified, so any version
    // difference is safe to update. The brief treats "differs" as stale even
    // when the marker is newer than the running package.
    if (marker.version !== input.version) {
      states.push({ name, file, status: 'stale', version: marker.version, hash });
      writes.push({ name, file, content: candidate });
      continue;
    }

    states.push({ name, file, status: 'current', version: marker.version, hash });
  }

  return { states, writes, diagnostics };
}

function unexpectedWrite(state: ManagedSkillState): Error {
  return new Error(
    `managed skill plan has an unexpected write for ${state.status} skill ${state.name}`,
  );
}

/**
 * Apply the planned writes with atomic file replacement. A dry run performs no
 * filesystem writes but reports the same create/update/migrate/skip categories.
 */
export async function applyManagedSkillWrites(
  root: string,
  plan: ManagedSkillPlan,
  options: { dryRun: boolean },
): Promise<ManagedSkillApplyResult> {
  const result: ManagedSkillApplyResult = {
    created: [],
    updated: [],
    migrated: [],
    skipped: [],
  };
  const writes = new Map<AuthoringSkillName, ManagedSkillWrite>();
  for (const write of plan.writes) {
    if (writes.has(write.name)) {
      throw new Error(`managed skill plan has duplicate writes for ${write.name}`);
    }
    writes.set(write.name, write);
  }

  const seen = new Set<AuthoringSkillName>();
  for (const state of plan.states) {
    if (seen.has(state.name)) {
      throw new Error(`managed skill plan has duplicate states for ${state.name}`);
    }
    seen.add(state.name);
    const write = writes.get(state.name);

    switch (state.status) {
      case 'missing':
      case 'stale': {
        if (write === undefined) {
          throw new Error(
            `managed skill plan is missing a ${state.status} write for ${state.name}`,
          );
        }
        if (write.file !== state.file) {
          throw new Error(
            `managed skill plan write path does not match the state for ${state.name}`,
          );
        }
        if (!options.dryRun) {
          await writeFileAtomic(join(root, write.file), write.content);
        }
        if (state.status === 'missing') {
          result.created.push(state.file);
        } else {
          result.updated.push(state.file);
        }
        break;
      }
      case 'legacy': {
        if (write === undefined) {
          result.skipped.push(state.file);
          break;
        }
        if (write.file !== state.file) {
          throw new Error(
            `managed skill plan write path does not match the state for ${state.name}`,
          );
        }
        if (!options.dryRun) {
          await writeFileAtomic(join(root, write.file), write.content);
        }
        result.migrated.push(state.file);
        break;
      }
      case 'current':
      case 'modified':
      case 'unversioned': {
        if (write !== undefined) {
          throw unexpectedWrite(state);
        }
        result.skipped.push(state.file);
        break;
      }
    }
  }

  for (const name of writes.keys()) {
    if (!seen.has(name)) {
      throw new Error(`managed skill plan has a write without a state for ${name}`);
    }
  }

  return result;
}
