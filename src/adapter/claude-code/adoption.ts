import { readdir, readlink } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { compareStrings } from '../../core/compare.ts';
import type { Diagnostic } from '../../core/diagnostics.ts';
import { lstatOrNull, readTextFile } from '../../core/fs-atomic.ts';
import {
  assertParentInsideRoot,
  resolveInside,
  toPosix,
} from '../../core/paths.ts';
import { validateAgentSource } from '../../model/agents.ts';
import { DiagnosticCodes } from '../../model/diagnostics-codes.ts';
import type { Scope } from '../../model/scope.ts';
import { validateSkillSource } from '../../model/skills.ts';
import type { ProjectManifest } from '../../model/types.ts';

export interface ClaudeAdoptionEntry {
  kind: 'agent' | 'skill';
  name: string;
  source: string;
  target: string;
  writeSource: boolean;
  replaceTarget: boolean;
  diagnostics: Diagnostic[];
}

export interface ClaudeAdoptionPlan {
  entries: ClaudeAdoptionEntry[];
  diagnostics: Diagnostic[];
}

export interface ClaudeAdoptionInput {
  root: string;
  scope: Scope;
  agentsRoot: string;
  claudeRoot: string;
  manifest?: ProjectManifest;
}

const AdoptionCodes = {
  contentDiffers: 'adoption.content-differs',
  skillExtraFiles: 'adoption.skill-extra-files',
  nameMismatch: 'adoption.name-mismatch',
  unmanagedSymlink: 'adoption.unmanaged-symlink',
  sourceEscape: 'adoption.source-escape',
  targetEscape: 'adoption.target-escape',
  targetConflict: 'adoption.target-conflict',
  sourceUnreadable: 'adoption.source-unreadable',
  targetUnreadable: 'adoption.target-unreadable',
} as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readDirOrEmpty(dir: string): Promise<Dirent[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.sort((left, right) => compareStrings(left.name, right.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function relativePath(root: string, absolute: string): string {
  return toPosix(relative(root, absolute));
}

/**
 * DAB owns `.claude` entries one by one. A directory-level symlink would make
 * every entry resolve through it, so it is a conflict instead of a fact.
 */
async function sourceRootDiagnostic(
  root: string,
  sourceDir: string,
  label: string,
): Promise<Diagnostic | undefined> {
  const info = await lstatOrNull(sourceDir);
  if (info?.isSymbolicLink() !== true) {
    return undefined;
  }
  return {
    code: AdoptionCodes.unmanagedSymlink,
    severity: 'error',
    message: `${label} is a directory symlink; DAB manages .claude entries one by one`,
    file: relativePath(root, sourceDir),
    hint: 'Replace the directory symlink with a real directory so each entry can be imported.',
  };
}

/**
 * Reject sources and targets that escape the adoption root, either through a
 * relative path or through a symlinked parent directory.
 */
async function pathDiagnostic(
  root: string,
  file: string,
  code: string,
  label: string,
): Promise<Diagnostic | undefined> {
  try {
    resolveInside(root, file);
    await assertParentInsideRoot(root, file);
    return undefined;
  } catch (error) {
    return {
      code,
      severity: 'error',
      message: `${label} escapes the adoption root: ${errorMessage(error)}`,
      file,
    };
  }
}

async function linkResolvesTo(linkPath: string, expectedPath: string): Promise<boolean> {
  try {
    const raw = await readlink(linkPath);
    return resolve(dirname(linkPath), raw) === resolve(expectedPath);
  } catch {
    return false;
  }
}

function unmanagedSymlink(source: string, target: string): Diagnostic {
  return {
    code: AdoptionCodes.unmanagedSymlink,
    severity: 'error',
    message: `existing symlink is not managed by DAB: ${source}`,
    file: source,
    hint: `Point it at ${target} or move the path out of .claude before rerunning normalize.`,
  };
}

function nameMismatch(
  kind: 'agent' | 'skill',
  source: string,
  declared: string,
  basename: string,
): Diagnostic {
  return {
    code: AdoptionCodes.nameMismatch,
    severity: 'warning',
    message: `${kind} ${source} declares name ${declared} but is imported as ${basename}`,
    file: source,
    hint: 'The frontmatter name is the fact id; the .claude basename is preserved, so rename both to align.',
  };
}

function contentDiffers(kind: 'agent' | 'skill', source: string, target: string): Diagnostic {
  return {
    code: AdoptionCodes.contentDiffers,
    severity: 'warning',
    message: `${kind} ${source} differs from the existing .agents source ${target}; keeping .agents and backing up .claude`,
    file: target,
    hint: 'The .agents copy is the source of truth; update it if the .claude version should win.',
  };
}

function duplicateName(
  kind: 'agent' | 'skill',
  name: string,
  file: string,
  existing: string,
): Diagnostic {
  return {
    code: kind === 'agent'
      ? DiagnosticCodes.agentDuplicateName
      : DiagnosticCodes.skillDuplicateName,
    severity: 'error',
    message: `duplicate ${kind} name ${name}`,
    file,
    hint: `The name is already used by ${existing}.`,
  };
}

function targetConflict(kind: 'agent' | 'skill', target: string): Diagnostic {
  const expected = kind === 'agent' ? 'a regular file' : 'a directory';
  return {
    code: AdoptionCodes.targetConflict,
    severity: 'error',
    message: `${kind} target is not ${expected}: ${target}`,
    file: target,
    hint: 'Move the existing entry or remove it before importing.',
  };
}

function unreadable(
  code: string,
  file: string,
  error: unknown,
): Diagnostic {
  return {
    code,
    severity: 'error',
    message: `cannot read ${file}: ${errorMessage(error)}`,
    file,
  };
}

async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readDirOrEmpty(dir)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      result.push(...await listFiles(join(dir, entry.name), path));
    } else {
      result.push(path);
    }
  }
  return result;
}

interface CandidatePlan {
  entries: ClaudeAdoptionEntry[];
  diagnostics: Diagnostic[];
}

async function planAgents(input: ClaudeAdoptionInput): Promise<CandidatePlan> {
  const sourceDir = join(input.claudeRoot, 'agents');
  const entries: ClaudeAdoptionEntry[] = [];
  const diagnostics: Diagnostic[] = [];
  const names = new Map<string, string>();
  const rootDiagnostic = await sourceRootDiagnostic(input.root, sourceDir, '.claude/agents');
  if (rootDiagnostic !== undefined) {
    return { entries, diagnostics: [rootDiagnostic] };
  }

  for (const entry of await readDirOrEmpty(sourceDir)) {
    if (!entry.name.endsWith('.md')) {
      continue;
    }
    const sourceAbs = join(sourceDir, entry.name);
    const source = relativePath(input.root, sourceAbs);
    const target = relativePath(input.root, join(input.agentsRoot, 'agents', entry.name));

    const sourceEscape = await pathDiagnostic(
      input.root,
      source,
      AdoptionCodes.sourceEscape,
      'agent source',
    );
    const targetEscape = await pathDiagnostic(
      input.root,
      target,
      AdoptionCodes.targetEscape,
      'agent target',
    );
    if (sourceEscape !== undefined || targetEscape !== undefined) {
      if (sourceEscape !== undefined) {
        diagnostics.push(sourceEscape);
      }
      if (targetEscape !== undefined) {
        diagnostics.push(targetEscape);
      }
      continue;
    }

    if (entry.isSymbolicLink()) {
      const expected = resolveInside(input.agentsRoot, join('agents', entry.name));
      if (await linkResolvesTo(sourceAbs, expected)) {
        continue;
      }
      diagnostics.push(unmanagedSymlink(source, target));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    const validated = await validateAgentSource(input.root, sourceAbs);
    if (validated.item === undefined) {
      diagnostics.push(...validated.diagnostics);
      continue;
    }

    const entryDiagnostics = [...validated.diagnostics];
    const sourceBasename = entry.name.slice(0, -'.md'.length);
    if (validated.item.name !== sourceBasename) {
      entryDiagnostics.push(nameMismatch('agent', source, validated.item.name, entry.name));
    }

    const existing = names.get(validated.item.name);
    if (existing !== undefined) {
      diagnostics.push(
        ...entryDiagnostics,
        duplicateName('agent', validated.item.name, source, existing),
      );
      continue;
    }
    names.set(validated.item.name, source);

    const targetAbs = resolveInside(input.root, target);
    const targetInfo = await lstatOrNull(targetAbs);
    let writeSource = true;
    if (targetInfo !== null) {
      if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) {
        diagnostics.push(...entryDiagnostics, targetConflict('agent', target));
        continue;
      }
      writeSource = false;
      let sourceContent: string;
      let targetContent: string;
      try {
        sourceContent = await readTextFile(sourceAbs);
      } catch (error) {
        diagnostics.push(
          ...entryDiagnostics,
          unreadable(AdoptionCodes.sourceUnreadable, source, error),
        );
        continue;
      }
      try {
        targetContent = await readTextFile(targetAbs);
      } catch (error) {
        diagnostics.push(
          ...entryDiagnostics,
          unreadable(AdoptionCodes.targetUnreadable, target, error),
        );
        continue;
      }
      if (sourceContent !== targetContent) {
        entryDiagnostics.push(contentDiffers('agent', source, target));
      }
    }

    entries.push({
      kind: 'agent',
      name: validated.item.name,
      source,
      target,
      writeSource,
      replaceTarget: true,
      diagnostics: entryDiagnostics,
    });
  }

  return { entries, diagnostics };
}

async function planSkills(input: ClaudeAdoptionInput): Promise<CandidatePlan> {
  const sourceDir = join(input.claudeRoot, 'skills');
  const entries: ClaudeAdoptionEntry[] = [];
  const diagnostics: Diagnostic[] = [];
  const names = new Map<string, string>();
  const rootDiagnostic = await sourceRootDiagnostic(input.root, sourceDir, '.claude/skills');
  if (rootDiagnostic !== undefined) {
    return { entries, diagnostics: [rootDiagnostic] };
  }

  for (const entry of await readDirOrEmpty(sourceDir)) {
    const sourceAbs = join(sourceDir, entry.name);
    const source = relativePath(input.root, sourceAbs);
    const target = relativePath(input.root, join(input.agentsRoot, 'skills', entry.name));

    const sourceEscape = await pathDiagnostic(
      input.root,
      source,
      AdoptionCodes.sourceEscape,
      'skill source',
    );
    const targetEscape = await pathDiagnostic(
      input.root,
      target,
      AdoptionCodes.targetEscape,
      'skill target',
    );
    if (sourceEscape !== undefined || targetEscape !== undefined) {
      if (sourceEscape !== undefined) {
        diagnostics.push(sourceEscape);
      }
      if (targetEscape !== undefined) {
        diagnostics.push(targetEscape);
      }
      continue;
    }

    if (entry.isSymbolicLink()) {
      const expected = resolveInside(input.agentsRoot, join('skills', entry.name));
      if (await linkResolvesTo(sourceAbs, expected)) {
        continue;
      }
      diagnostics.push(unmanagedSymlink(source, target));
      continue;
    }
    if (!entry.isDirectory()) {
      continue;
    }

    const validated = await validateSkillSource(input.root, sourceAbs);
    if (validated.item === undefined) {
      diagnostics.push(...validated.diagnostics);
      continue;
    }

    const entryDiagnostics = [...validated.diagnostics];
    if (validated.item.name !== entry.name) {
      entryDiagnostics.push(nameMismatch('skill', source, validated.item.name, entry.name));
    }

    const existing = names.get(validated.item.name);
    if (existing !== undefined) {
      diagnostics.push(
        ...entryDiagnostics,
        duplicateName('skill', validated.item.name, source, existing),
      );
      continue;
    }
    names.set(validated.item.name, source);

    const targetAbs = resolveInside(input.root, target);
    const targetInfo = await lstatOrNull(targetAbs);
    let writeSource = true;
    if (targetInfo !== null) {
      if (targetInfo.isSymbolicLink() || !targetInfo.isDirectory()) {
        diagnostics.push(...entryDiagnostics, targetConflict('skill', target));
        continue;
      }
      writeSource = false;

      const sourceSkillFile = join(sourceAbs, 'SKILL.md');
      const targetSkillFile = join(targetAbs, 'SKILL.md');
      let sourceContent: string;
      let targetContent: string | undefined;
      try {
        sourceContent = await readTextFile(sourceSkillFile);
      } catch (error) {
        diagnostics.push(
          ...entryDiagnostics,
          unreadable(AdoptionCodes.sourceUnreadable, `${source}/SKILL.md`, error),
        );
        continue;
      }
      try {
        const targetSkillInfo = await lstatOrNull(targetSkillFile);
        targetContent = targetSkillInfo === null ? undefined : await readTextFile(targetSkillFile);
      } catch (error) {
        diagnostics.push(
          ...entryDiagnostics,
          unreadable(AdoptionCodes.targetUnreadable, `${target}/SKILL.md`, error),
        );
        continue;
      }
      if (sourceContent !== targetContent) {
        entryDiagnostics.push(contentDiffers('skill', source, target));
      }

      try {
        const sourceFiles = await listFiles(sourceAbs);
        const targetFiles = new Set(await listFiles(targetAbs));
        const extraFiles = sourceFiles.filter(
          (file) => file !== 'SKILL.md' && !targetFiles.has(file),
        );
        if (extraFiles.length > 0) {
          entryDiagnostics.push({
            code: AdoptionCodes.skillExtraFiles,
            severity: 'warning',
            message: `skill ${source} has extra files that are not merged into ${target}: ${extraFiles.join(', ')}`,
            file: source,
            hint: 'The .agents copy is the source of truth; extra files stay in the backup after replacement.',
          });
        }
      } catch (error) {
        diagnostics.push(
          ...entryDiagnostics,
          unreadable(AdoptionCodes.sourceUnreadable, source, error),
        );
        continue;
      }
    }

    entries.push({
      kind: 'skill',
      name: validated.item.name,
      source,
      target,
      writeSource,
      replaceTarget: true,
      diagnostics: entryDiagnostics,
    });
  }

  return { entries, diagnostics };
}

/**
 * Plan the import of physical `.claude/agents/*.md` files and
 * `.claude/skills/<dir>/SKILL.md` directories into the authored `.agents`
 * tree. The plan is read-only; applying it is a separate step.
 */
export async function planClaudeAdoption(
  input: ClaudeAdoptionInput,
): Promise<ClaudeAdoptionPlan> {
  const agents = await planAgents(input);
  const skills = await planSkills(input);
  const entries = [...agents.entries, ...skills.entries];
  return {
    entries,
    diagnostics: [
      ...agents.diagnostics,
      ...skills.diagnostics,
      ...entries.flatMap((entry) => entry.diagnostics),
    ],
  };
}
