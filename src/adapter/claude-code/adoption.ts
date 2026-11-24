import { constants } from 'node:fs';
import type { Dirent } from 'node:fs';
import { copyFile, cp, readdir, readlink, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { compareStrings } from '../../core/compare.ts';
import type { Diagnostic } from '../../core/diagnostics.ts';
import {
  backupPath,
  ensureDir,
  lstatOrNull,
  readTextFile,
  replaceSymlink,
} from '../../core/fs-atomic.ts';
import {
  assertParentInsideRoot,
  isPathInside,
  relativeLink,
  resolveInside,
  toPosix,
} from '../../core/paths.ts';
import { isAuthoredPathProblem } from '../../core/practice-paths.ts';
import { discoverAgents, validateAgentSource } from '../../model/agents.ts';
import { DiagnosticCodes } from '../../model/diagnostics-codes.ts';
import { getGeneratedTarget } from '../../model/project-manifest.ts';
import type { Scope } from '../../model/scope.ts';
import { discoverSkills, validateSkillSource } from '../../model/skills.ts';
import type { DiscoveryResult, ProjectManifest } from '../../model/types.ts';

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
  applyFailed: 'adoption.apply-failed',
  sourceMissing: 'adoption.source-missing',
  sourceSymlinkEscape: 'adoption.source-symlink-escape',
  targetExists: 'adoption.target-exists',
  targetMissing: 'adoption.target-missing',
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
    message: `existing symlink is not managed by DAB and has no authored source: ${source}`,
    file: source,
    hint: `Point it at ${target} after adding that authored source, or remove the symlink; DAB never imports or deletes an unmanaged link.`,
  };
}

/**
 * Root-relative `.claude` paths recorded as generated projections. The
 * projection plan owns these targets: managed symlink drift is repaired, and a
 * stale record is removed, without the adoption import planner reporting the
 * path as an unmanaged conflict.
 */
function managedProjectionTargets(manifest?: ProjectManifest): Set<string> {
  const generated = manifest === undefined
    ? undefined
    : getGeneratedTarget(manifest, 'claude-code');
  return new Set((generated?.projections ?? []).map((projection) => projection.target));
}

/**
 * An entry symlink that does not resolve to its expected `.agents` source is
 * not an import candidate. When the projection plan owns the target (recorded
 * or backed by an authored source), it repairs the link, or reports and
 * `--fix`-backs it up; adoption only reports links DAB cannot map.
 */
function symlinkDiagnostic(
  source: string,
  target: string,
  hasAuthoredSource: boolean,
  managed: ReadonlySet<string>,
): Diagnostic | undefined {
  // Recorded projection targets are root-relative `.claude` paths, which is
  // exactly the `source` path here; `target` is the `.agents` destination.
  if (managed.has(source) || hasAuthoredSource) {
    return undefined;
  }
  return unmanagedSymlink(source, target);
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

function skillSymlinkEscape(file: string): Diagnostic {
  return {
    code: AdoptionCodes.sourceSymlinkEscape,
    severity: 'error',
    message: `skill source contains a symlink that escapes the adoption root: ${file}`,
    file,
    hint: 'Remove the symlink or point it inside the adoption root before rerunning normalize.',
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

async function planAgents(
  input: ClaudeAdoptionInput,
  authored: ReadonlyMap<string, string>,
  managed: ReadonlySet<string>,
): Promise<CandidatePlan> {
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
      const expectedInfo = await lstatOrNull(expected);
      const problem = symlinkDiagnostic(
        source,
        target,
        expectedInfo?.isFile() === true,
        managed,
      );
      if (problem !== undefined) {
        diagnostics.push(problem);
      }
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

    // Copying a different `.claude` file into `.agents` must not introduce a
    // name already used by an authored agent. The same file/target pair is the
    // existing-entry case and stays importable.
    const authoredFile = authored.get(validated.item.name);
    if (authoredFile !== undefined && authoredFile !== target) {
      diagnostics.push(
        ...entryDiagnostics,
        duplicateName('agent', validated.item.name, source, authoredFile),
      );
      continue;
    }

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

async function planSkills(
  input: ClaudeAdoptionInput,
  authored: ReadonlyMap<string, string>,
  managed: ReadonlySet<string>,
): Promise<CandidatePlan> {
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
      const expectedInfo = await lstatOrNull(expected);
      const problem = symlinkDiagnostic(
        source,
        target,
        expectedInfo?.isDirectory() === true,
        managed,
      );
      if (problem !== undefined) {
        diagnostics.push(problem);
      }
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

    const authoredDir = authored.get(validated.item.name);
    if (authoredDir !== undefined && authoredDir !== target) {
      diagnostics.push(
        ...entryDiagnostics,
        duplicateName('skill', validated.item.name, source, authoredDir),
      );
      continue;
    }

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

    // A fresh skill directory is copied wholesale, so an escaping symlink is a
    // plan error: the zero-write gate must see it before copying anything.
    if (writeSource) {
      try {
        const escaping = await findEscapingSymlink(input.root, sourceAbs);
        if (escaping !== undefined) {
          diagnostics.push(
            ...entryDiagnostics,
            skillSymlinkEscape(relativePath(input.root, escaping)),
          );
          continue;
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

interface AuthoredFacts {
  agents: Map<string, string>;
  skills: Map<string, string>;
  diagnostics: Diagnostic[];
}

/**
 * Only the exact `.agents/rules` and `.agents/skills` parents are
 * practice-owned: a failure there is reported by the practice checks, so
 * imports treat the affected tree as empty. A nested unreadable skill directory
 * is reported per entry by `discoverSkills` and keeps its sibling facts.
 */
async function discoverAuthored<T>(
  root: string,
  run: () => Promise<DiscoveryResult<T>>,
): Promise<DiscoveryResult<T>> {
  try {
    return await run();
  } catch (error) {
    if (isAuthoredPathProblem(error, root)) {
      return { items: [], diagnostics: [] };
    }
    throw error;
  }
}

/**
 * Authored names already used under `.agents`. Only valid discovered items are
 * indexed; discovery diagnostics surface through the import plan so preflight
 * and initialized runs report the same governed skill errors.
 */
async function authoredFacts(input: ClaudeAdoptionInput): Promise<AuthoredFacts> {
  const [agents, skills] = await Promise.all([
    discoverAuthored(input.root, () => discoverAgents(input.root, input.agentsRoot)),
    discoverAuthored(input.root, () => discoverSkills(input.root, input.agentsRoot)),
  ]);
  const agentNames = new Map<string, string>();
  for (const item of agents.items) {
    if (!agentNames.has(item.name)) {
      agentNames.set(item.name, item.file);
    }
  }
  const skillNames = new Map<string, string>();
  for (const item of skills.items) {
    if (!skillNames.has(item.name)) {
      skillNames.set(item.name, item.dir);
    }
  }
  // Only skill discovery is fault-isolated per entry. Agent diagnostics keep
  // their existing pipeline ownership, while an unreadable nested skill must
  // surface here so preflight cannot plan an import around a hidden skill.
  return {
    agents: agentNames,
    skills: skillNames,
    diagnostics: [...skills.diagnostics],
  };
}

/**
 * Plan the import of physical `.claude/agents/*.md` files and
 * `.claude/skills/<dir>/SKILL.md` directories into the authored `.agents`
 * tree. The plan is read-only; applying it is a separate step.
 */
export async function planClaudeAdoption(
  input: ClaudeAdoptionInput,
): Promise<ClaudeAdoptionPlan> {
  const authored = await authoredFacts(input);
  const managed = managedProjectionTargets(input.manifest);
  const agents = await planAgents(input, authored.agents, managed);
  const skills = await planSkills(input, authored.skills, managed);
  const entries = [...agents.entries, ...skills.entries];
  return {
    entries,
    diagnostics: [
      ...authored.diagnostics,
      ...agents.diagnostics,
      ...skills.diagnostics,
      ...entries.flatMap((entry) => entry.diagnostics),
    ],
  };
}

export interface ClaudeAdoptionApplyInput {
  root: string;
  plan: ClaudeAdoptionPlan;
  backupRoot: string;
}

export interface ClaudeAdoptionApplyResult {
  actions: string[];
  backups: string[];
  diagnostics: Diagnostic[];
}

interface ApplyContext {
  root: string;
  backupRoot: string;
  actions: string[];
  backups: string[];
}

function applyDiagnostic(
  code: string,
  file: string,
  message: string,
  hint?: string,
): Diagnostic {
  return {
    code,
    severity: 'error',
    message,
    file,
    ...(hint === undefined ? {} : { hint }),
  };
}

function applyFailure(entry: ClaudeAdoptionEntry, error: unknown): Diagnostic {
  return applyDiagnostic(
    AdoptionCodes.applyFailed,
    entry.source,
    `cannot import ${entry.kind} ${entry.source}: ${errorMessage(error)}`,
    'Fix the filesystem error and rerun normalize; the reported copies, backups and links are kept.',
  );
}

type SafePath =
  | { ok: true; absolute: string }
  | { ok: false; error: unknown };

async function safeResolve(root: string, relativePath: string): Promise<SafePath> {
  try {
    const absolute = resolveInside(root, relativePath);
    await assertParentInsideRoot(root, relativePath);
    return { ok: true, absolute };
  } catch (error) {
    return { ok: false, error };
  }
}

function targetComponents(raw: string): string[] {
  const normalized = sep === '\\' ? raw.replaceAll('/', '\\') : raw;
  return normalized.split(sep).filter((part) => part.length > 0 && part !== '.');
}

/**
 * Resolve a dangling link target the way the filesystem would: existing
 * symlink components are expanded before later `..` components are applied.
 * Only after the first missing component is the remainder collapsed lexically,
 * because nothing below a missing path can be traversed.
 */
async function resolveLinkTarget(linkPath: string, raw: string): Promise<string> {
  let resolved = isAbsolute(raw) ? parse(raw).root : await realpath(dirname(linkPath));
  const pending = targetComponents(raw);
  let depth = 0;

  while (pending.length > 0) {
    const component = pending.shift()!;
    if (component === '..') {
      resolved = dirname(resolved);
      continue;
    }
    const candidate = join(resolved, component);
    const info = await lstatOrNull(candidate);
    if (info === null) {
      return resolve(resolved, component, ...pending);
    }
    if (info.isSymbolicLink()) {
      depth += 1;
      if (depth > 40) {
        throw new Error(`too many levels of symbolic links: ${linkPath}`);
      }
      const nested = await readlink(candidate);
      if (isAbsolute(nested)) {
        resolved = parse(nested).root;
      }
      pending.unshift(...targetComponents(nested));
      continue;
    }
    resolved = candidate;
    if (pending.length > 0 && !info.isDirectory()) {
      return resolve(candidate, ...pending);
    }
  }

  return resolved;
}

/**
 * Copying a skill directory must not smuggle a link to a path outside the
 * adoption root into the authored tree. Links are copied verbatim, so they are
 * never followed while copying; this check decides whether they may be copied.
 * The check must be filesystem-aware: `symlink/..` is resolved through the
 * symlink, not collapsed lexically before it.
 */
async function symlinkEscapesRoot(root: string, linkPath: string): Promise<boolean> {
  const realRoot = await realpath(root);
  let target: string;
  try {
    target = await realpath(linkPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      throw error;
    }
    target = await resolveLinkTarget(linkPath, await readlink(linkPath));
  }
  return !isPathInside(realRoot, target);
}

async function findEscapingSymlink(
  root: string,
  dir: string,
): Promise<string | undefined> {
  for (const entry of await readDirOrEmpty(dir)) {
    const entryPath = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      if (await symlinkEscapesRoot(root, entryPath)) {
        return entryPath;
      }
    } else if (entry.isDirectory()) {
      const nested = await findEscapingSymlink(root, entryPath);
      if (nested !== undefined) {
        return nested;
      }
    }
  }
  return undefined;
}

/**
 * Copy into a staging directory and rename, so a failed copy never leaves a
 * half-written skill that a later run would treat as the authored source.
 */
async function copySkillDirectory(sourceAbs: string, targetAbs: string): Promise<void> {
  await ensureDir(dirname(targetAbs));
  const staging = join(
    dirname(targetAbs),
    `.${basename(targetAbs)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    await cp(sourceAbs, staging, {
      recursive: true,
      force: false,
      errorOnExist: true,
      dereference: false,
      verbatimSymlinks: true,
    });
    await rename(staging, targetAbs);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function applyAdoptionEntry(
  context: ApplyContext,
  entry: ClaudeAdoptionEntry,
): Promise<Diagnostic | undefined> {
  if (!entry.writeSource && !entry.replaceTarget) {
    return undefined;
  }

  const source = await safeResolve(context.root, entry.source);
  if (!source.ok) {
    return applyDiagnostic(
      AdoptionCodes.sourceEscape,
      entry.source,
      `${entry.kind} source is not a safe import path: ${errorMessage(source.error)}`,
      'Rerun normalize to rebuild the import plan.',
    );
  }
  const target = await safeResolve(context.root, entry.target);
  if (!target.ok) {
    return applyDiagnostic(
      AdoptionCodes.targetEscape,
      entry.target,
      `${entry.kind} target is not a safe import path: ${errorMessage(target.error)}`,
      'Rerun normalize to rebuild the import plan.',
    );
  }

  const sourceInfo = await lstatOrNull(source.absolute);
  const expectedSource = entry.kind === 'agent'
    ? sourceInfo?.isFile() === true
    : sourceInfo?.isDirectory() === true;
  if (sourceInfo === null || sourceInfo.isSymbolicLink() || !expectedSource) {
    return applyDiagnostic(
      AdoptionCodes.sourceMissing,
      entry.source,
      `${entry.kind} source is no longer a physical ${entry.kind === 'agent' ? 'file' : 'directory'}: ${entry.source}`,
      'Rerun normalize to rebuild the import plan.',
    );
  }

  const targetInfo = await lstatOrNull(target.absolute);
  if (entry.writeSource) {
    if (targetInfo !== null) {
      return applyDiagnostic(
        AdoptionCodes.targetExists,
        entry.target,
        `refusing to overwrite the existing .agents source: ${entry.target}`,
        'Rerun normalize so the plan keeps the existing source and only migrates the .claude entry.',
      );
    }
  } else {
    if (targetInfo === null) {
      return applyDiagnostic(
        AdoptionCodes.targetMissing,
        entry.target,
        `the existing .agents source disappeared before the import: ${entry.target}`,
        'Rerun normalize to rebuild the import plan.',
      );
    }
    const expectedTarget = entry.kind === 'agent'
      ? targetInfo.isFile()
      : targetInfo.isDirectory();
    if (targetInfo.isSymbolicLink() || !expectedTarget) {
      return applyDiagnostic(
        AdoptionCodes.targetConflict,
        entry.target,
        `${entry.kind} target is not ${entry.kind === 'agent' ? 'a regular file' : 'a directory'}: ${entry.target}`,
        'Move the existing entry or remove it before importing.',
      );
    }
  }

  if (entry.writeSource) {
    if (entry.kind === 'skill') {
      const escaping = await findEscapingSymlink(context.root, source.absolute);
      if (escaping !== undefined) {
        return skillSymlinkEscape(relativePath(context.root, escaping));
      }
      await copySkillDirectory(source.absolute, target.absolute);
    } else {
      await ensureDir(dirname(target.absolute));
      await copyFile(source.absolute, target.absolute, constants.COPYFILE_EXCL);
    }
    context.actions.push(`import ${entry.source} -> ${entry.target}`);
  }

  if (entry.replaceTarget) {
    const backup = await backupPath(context.root, entry.source, context.backupRoot);
    context.backups.push(backup);
    context.actions.push(`backup ${entry.source} -> ${relativePath(context.root, backup)}`);
    await rm(source.absolute, { recursive: true, force: true });
    const linkTarget = relativeLink(source.absolute, target.absolute);
    await replaceSymlink(source.absolute, linkTarget);
    context.actions.push(`symlink ${entry.source} -> ${linkTarget}`);
  }

  return undefined;
}

/**
 * Apply a Claude import plan: copy importable agents/skills into the authored
 * `.agents` tree, then back up and replace each `.claude` entry with a
 * per-entry symlink. Existing `.agents` sources are never overwritten.
 * A backup failure aborts before replacement; there is no automatic rollback,
 * so `actions` and `backups` report writes that already happened and a rerun
 * rebuilds the plan from the resulting tree.
 */
export async function applyClaudeAdoption(
  input: ClaudeAdoptionApplyInput,
): Promise<ClaudeAdoptionApplyResult> {
  const actions: string[] = [];
  const backups: string[] = [];
  const diagnostics: Diagnostic[] = [];
  const context: ApplyContext = {
    root: input.root,
    backupRoot: input.backupRoot,
    actions,
    backups,
  };

  for (const entry of input.plan.entries) {
    try {
      const problem = await applyAdoptionEntry(context, entry);
      if (problem !== undefined) {
        diagnostics.push(problem);
      }
    } catch (error) {
      diagnostics.push(applyFailure(entry, error));
      break;
    }
  }

  return { actions, backups, diagnostics };
}

export interface ClaudeAdoptionPreview {
  actions: string[];
  backups: string[];
}

/**
 * Describe what `applyClaudeAdoption` would do without touching the
 * filesystem. Backup paths are relative to `root`, matching the applied
 * result. Used by `dab normalize --dry-run`.
 */
export function previewClaudeAdoption(
  root: string,
  plan: ClaudeAdoptionPlan,
  backupRoot: string,
): ClaudeAdoptionPreview {
  const actions: string[] = [];
  const backups: string[] = [];
  for (const entry of plan.entries) {
    if (entry.writeSource) {
      actions.push(`import ${entry.source} -> ${entry.target}`);
    }
    if (entry.replaceTarget) {
      const backup = toPosix(relative(root, join(backupRoot, entry.source)));
      backups.push(backup);
      actions.push(`backup ${entry.source} -> ${backup}`);
      actions.push(
        `symlink ${entry.source} -> ${relativeLink(
          resolve(root, entry.source),
          resolve(root, entry.target),
        )}`,
      );
    }
  }
  return { actions, backups };
}
