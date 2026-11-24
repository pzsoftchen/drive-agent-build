import { constants, type Stats } from 'node:fs';
import { access, lstat, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Diagnostic } from './diagnostics.ts';
import { DabError } from './errors.ts';
import { assertParentInsideRoot, isPathInside } from './paths.ts';

export type PathProblem = 'parent-not-directory' | 'access-denied' | 'symlink-loop';

const PATH_PROBLEM_CODES = new Set(['ENOTDIR', 'EACCES', 'EPERM', 'ELOOP']);

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

export function pathProblemFrom(error: unknown): PathProblem | undefined {
  switch (errorCode(error)) {
    case 'ENOTDIR':
      return 'parent-not-directory';
    case 'EACCES':
    case 'EPERM':
      return 'access-denied';
    case 'ELOOP':
      return 'symlink-loop';
    default:
      return undefined;
  }
}

export function problemMessage(path: string, problem: PathProblem): string {
  switch (problem) {
    case 'parent-not-directory':
      return `${path}: a parent component is not a directory`;
    case 'access-denied':
      return `${path}: path cannot be accessed`;
    case 'symlink-loop':
      return `${path}: path contains a symlink loop`;
  }
}

/** Authored parents owned by the practice packs. */
const PRACTICE_PARENT_PATHS = ['.agents/rules', '.agents/skills'] as const;

/**
 * True for a filesystem error caused by `.agents/rules` or `.agents/skills`.
 * Those parents are practice-owned: the practice checks report the governed
 * diagnostic, so discovery may treat the affected fact set as empty. Errors
 * under every other `.agents` path stay loud, because no practice check owns
 * them and silently empty facts would hide a broken authored layout.
 */
export function isAuthoredPathProblem(error: unknown, root: string): boolean {
  if (!PATH_PROBLEM_CODES.has(errorCode(error) ?? '')) {
    return false;
  }
  const path = (error as NodeJS.ErrnoException).path;
  if (path === undefined) {
    return false;
  }
  return PRACTICE_PARENT_PATHS.some(
    (parent) => isPathInside(join(root, parent), path),
  );
}

interface ProbeState {
  info: Stats | null;
  problem?: PathProblem;
}

/** lstat that turns path-state errors into a governed problem instead of throwing. */
async function probe(run: () => Promise<Stats>): Promise<ProbeState> {
  try {
    return { info: await run() };
  } catch (error) {
    const problem = pathProblemFrom(error);
    if (problem !== undefined) {
      return { info: null, problem };
    }
    if (errorCode(error) === 'ENOENT') {
      return { info: null };
    }
    throw error;
  }
}

export function probeLstat(path: string): Promise<ProbeState> {
  return probe(() => lstat(path));
}

export function probeStat(path: string): Promise<ProbeState> {
  return probe(() => stat(path));
}

async function parentInsideProblem(root: string, path: string): Promise<string | undefined> {
  try {
    await assertParentInsideRoot(root, path);
    return undefined;
  } catch (error) {
    if (error instanceof DabError) {
      return error.message;
    }
    throw error;
  }
}

async function resolveLinkProblem(
  root: string,
  absolute: string,
  path: string,
): Promise<{ message?: string; target?: Stats }> {
  try {
    const realRoot = await realpath(root);
    const real = await realpath(absolute);
    if (!isPathInside(realRoot, real)) {
      return { message: `${path} escapes the repository through a symlink` };
    }
    return { target: await stat(absolute) };
  } catch (error) {
    const problem = pathProblemFrom(error);
    if (problem !== undefined) {
      return { message: problemMessage(path, problem) };
    }
    if (errorCode(error) === 'ENOENT') {
      return { message: `${path} is a dangling symlink` };
    }
    throw error;
  }
}

async function readableProblem(absolute: string, path: string): Promise<string | undefined> {
  try {
    await access(absolute, constants.R_OK);
    return undefined;
  } catch (error) {
    const problem = pathProblemFrom(error);
    if (problem !== undefined) {
      return problem === 'access-denied'
        ? `${path} cannot be read`
        : problemMessage(path, problem);
    }
    if (errorCode(error) === 'ENOENT') {
      return `${path} is a dangling symlink`;
    }
    throw error;
  }
}

/**
 * Returns a problem message when an existing authored file is not a regular
 * file that resolves inside the repository and can be read. A missing path is
 * the caller's concern, so `undefined` also means "absent".
 */
export async function authoredFileProblem(
  root: string,
  path: string,
): Promise<string | undefined> {
  const absolute = join(root, path);
  const result = await probeLstat(absolute);
  if (result.problem !== undefined) {
    return problemMessage(path, result.problem);
  }
  if (result.info === null) {
    return undefined;
  }
  const parentProblem = await parentInsideProblem(root, path);
  if (parentProblem !== undefined) {
    return parentProblem;
  }
  if (result.info.isSymbolicLink()) {
    const link = await resolveLinkProblem(root, absolute, path);
    if (link.message !== undefined) {
      return link.message;
    }
    if (link.target?.isFile() !== true) {
      return `${path} is not a regular file`;
    }
  } else if (!result.info.isFile()) {
    return `${path} is not a regular file`;
  }
  return readableProblem(absolute, path);
}

export type AuthoredDirectoryState =
  | { kind: 'missing' }
  | { kind: 'directory'; absolute: string }
  | { kind: 'conflict'; message: string };

async function directoryAccessProblem(
  absolute: string,
  path: string,
): Promise<string | undefined> {
  try {
    await access(absolute, constants.R_OK | constants.X_OK);
    return undefined;
  } catch (error) {
    const problem = pathProblemFrom(error);
    if (problem !== undefined || errorCode(error) === 'ENOENT') {
      return `${path} cannot be accessed`;
    }
    throw error;
  }
}

/**
 * Classify an existing authored directory target. Real directories and
 * symlinks that resolve inside the repository to a directory are acceptable;
 * special files, dangling or escaping links and directories without read or
 * search permission are conflicts, so later discovery cannot fail with EACCES.
 */
export async function authoredDirectoryState(
  root: string,
  path: string,
): Promise<AuthoredDirectoryState> {
  const absolute = join(root, path);
  const result = await probeLstat(absolute);
  if (result.problem !== undefined) {
    return { kind: 'conflict', message: problemMessage(path, result.problem) };
  }
  if (result.info === null) {
    return { kind: 'missing' };
  }
  const parentProblem = await parentInsideProblem(root, path);
  if (parentProblem !== undefined) {
    return { kind: 'conflict', message: parentProblem };
  }
  if (result.info.isSymbolicLink()) {
    const link = await resolveLinkProblem(root, absolute, path);
    if (link.message !== undefined) {
      return { kind: 'conflict', message: link.message };
    }
    if (link.target?.isDirectory() !== true) {
      return { kind: 'conflict', message: `${path} is not a directory` };
    }
  } else if (!result.info.isDirectory()) {
    return { kind: 'conflict', message: `${path} is not a directory` };
  }
  const accessProblem = await directoryAccessProblem(absolute, path);
  if (accessProblem !== undefined) {
    return { kind: 'conflict', message: accessProblem };
  }
  return { kind: 'directory', absolute };
}

export interface PracticeParentProblem {
  path: string;
  message: string;
}

export interface PracticeParentProblems {
  docs?: PracticeParentProblem;
  skills?: PracticeParentProblem;
}

/**
 * The authored layout gives the bilingual rule and authoring skills a fixed
 * parent: `.agents/rules` and `.agents/skills`. A regular file at either path
 * makes discovery and child writes fail with ENOTDIR, so probe both parents and
 * let callers report a governed path error instead of an internal error.
 */
export async function practiceParentProblems(root: string): Promise<PracticeParentProblems> {
  const problems: PracticeParentProblems = {};
  for (const [path, key] of [
    ['.agents/rules', 'docs'],
    ['.agents/skills', 'skills'],
  ] as const) {
    const absolute = join(root, path);
    const result = await probeStat(absolute);
    if (result.problem !== undefined) {
      problems[key] = { path, message: problemMessage(path, result.problem) };
      continue;
    }
    if (result.info === null) {
      continue;
    }
    if (!result.info.isDirectory()) {
      problems[key] = { path, message: `${path} is not a directory` };
      continue;
    }
    const accessProblem = await directoryAccessProblem(absolute, path);
    if (accessProblem !== undefined) {
      problems[key] = { path, message: accessProblem };
    }
  }
  return problems;
}

/**
 * Authored parents that discovery and validation read directly. The practice
 * parents `.agents/rules` and `.agents/skills` are owned by
 * `practiceParentProblems`; every other parent must still be a directory.
 */
export const CORE_SOURCE_PARENT_PATHS = [
  '.agents/agents',
  '.agents/hooks',
  '.agents/memory',
  '.agents/notes',
  '.agents/policies',
  '.agents/adapters',
] as const;

/**
 * Probe the non-practice source parents. A regular file, dangling link,
 * denied access or symlink loop at any of them makes discovery fail or silently
 * empty, so commands report a governed `path.conflict` and block before
 * discovery instead of raising an internal error or hiding the layout.
 */
export async function sourceParentProblems(root: string): Promise<PracticeParentProblem[]> {
  const problems: PracticeParentProblem[] = [];
  for (const path of CORE_SOURCE_PARENT_PATHS) {
    const absolute = join(root, path);
    const link = await probeLstat(absolute);
    if (link.problem !== undefined) {
      problems.push({ path, message: problemMessage(path, link.problem) });
      continue;
    }
    if (link.info === null) {
      continue;
    }
    if (link.info.isSymbolicLink()) {
      const target = await probeStat(absolute);
      if (target.problem !== undefined) {
        problems.push({ path, message: problemMessage(path, target.problem) });
        continue;
      }
      if (target.info === null) {
        problems.push({ path, message: `${path} is a dangling symlink` });
        continue;
      }
      if (!target.info.isDirectory()) {
        problems.push({ path, message: `${path} is not a directory` });
        continue;
      }
    } else if (!link.info.isDirectory()) {
      problems.push({ path, message: `${path} is not a directory` });
      continue;
    }
    const accessProblem = await directoryAccessProblem(absolute, path);
    if (accessProblem !== undefined) {
      problems.push({ path, message: accessProblem });
    }
  }
  return problems;
}

export function sourceParentDiagnostic(problem: PracticeParentProblem): Diagnostic {
  return {
    code: 'path.conflict',
    severity: 'error',
    message: problem.message,
    file: problem.path,
    hint: 'Resolve the path conflict manually; DAB never writes through it.',
  };
}

export function practiceParentDiagnostics(
  problems: PracticeParentProblems,
): Diagnostic[] {
  return [problems.docs, problems.skills]
    .flatMap((problem) => problem === undefined ? [] : [sourceParentDiagnostic(problem)]);
}
