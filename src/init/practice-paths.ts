import { constants, type Stats } from 'node:fs';
import { access, lstat, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DabError } from '../core/errors.ts';
import { assertParentInsideRoot, isPathInside } from '../core/paths.ts';

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

/**
 * True for a filesystem error caused by an authored `.agents` path with a file
 * parent, denied access or a symlink loop. Callers that already report the
 * practice parent problem can treat the affected discovery as empty instead of
 * failing with an internal error.
 */
export function isAuthoredPathProblem(error: unknown, root: string): boolean {
  if (!PATH_PROBLEM_CODES.has(errorCode(error) ?? '')) {
    return false;
  }
  const path = (error as NodeJS.ErrnoException).path;
  return path !== undefined && isPathInside(join(root, '.agents'), path);
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

/**
 * Classify an existing authored directory target. Real directories and
 * symlinks that resolve inside the repository to a directory are acceptable;
 * special files, dangling or escaping links and unreadable paths are conflicts.
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
    const result = await probeStat(join(root, path));
    if (result.problem !== undefined) {
      problems[key] = { path, message: problemMessage(path, result.problem) };
    } else if (result.info !== null && !result.info.isDirectory()) {
      problems[key] = { path, message: `${path} is not a directory` };
    }
  }
  return problems;
}
