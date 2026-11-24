import { dirname, isAbsolute as isNativeAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { ConfigError } from './errors.ts';

export function toPosix(value: string): string {
  return value.replaceAll('\\', '/');
}

export function assertRelativePath(value: string, label: string): string {
  if (value.length === 0) {
    throw new ConfigError(`${label} must not be empty`, 'path.empty');
  }
  if (value.includes('\0')) {
    throw new ConfigError(`${label} contains a NUL byte`, 'path.nul');
  }
  const posix = toPosix(value);
  if (isNativeAbsolute(value) || isNativeAbsolute(posix) || /^[A-Za-z]:\//.test(posix)) {
    throw new ConfigError(`${label} must be relative: ${value}`, 'path.absolute');
  }
  if (posix.startsWith('~')) {
    throw new ConfigError(`${label} must not start with "~": ${value}`, 'path.home');
  }
  const normalized = normalize(posix).replaceAll('\\', '/');
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new ConfigError(`${label} escapes the project: ${value}`, 'path.escape');
  }
  return normalized;
}

export function isPathInside(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  return normalizedCandidate === normalizedRoot
    || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

export function resolveInside(root: string, relativePath: string): string {
  const normalized = assertRelativePath(relativePath, 'path');
  const resolved = resolve(root, normalized);
  if (!isPathInside(root, resolved)) {
    throw new ConfigError(`path escapes the project: ${relativePath}`, 'path.escape');
  }
  return resolved;
}

export function relativeLink(fromTarget: string, toSource: string): string {
  return toPosix(relative(dirname(fromTarget), toSource));
}

async function lstatOrNullPath(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function assertParentInsideRoot(root: string, relativePath: string): Promise<void> {
  if ((await lstatOrNullPath(root)) === null) {
    return;
  }
  const absolute = resolveInside(root, relativePath);
  let parent = dirname(absolute);
  let info = await lstatOrNullPath(parent);
  while (info === null) {
    const next = dirname(parent);
    if (next === parent) {
      break;
    }
    parent = next;
    info = await lstatOrNullPath(parent);
  }

  const realRoot = await realpath(root);
  let realParent: string;
  try {
    realParent = await realpath(parent);
  } catch (error) {
    // The nearest existing parent is a symlink whose target does not exist.
    // It cannot be proven to stay inside the root, and writing through it would
    // create or fail on a path outside the tree, so fail loud with the same
    // governed code as any other symlinked-parent escape.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigError(
        `path parent is a dangling symlink: ${relativePath}`,
        'path.symlink-escape',
        { hint: 'Replace the dangling symlink with a real directory inside the root, or remove it.' },
      );
    }
    throw error;
  }
  if (!isPathInside(realRoot, realParent)) {
    throw new ConfigError(
      `path escapes through a symlinked parent: ${relativePath}`,
      'path.symlink-escape',
    );
  }
}

export async function realPathNearest(root: string, relativePath: string): Promise<string> {
  const absolute = resolveInside(root, relativePath);
  let current = absolute;
  while (true) {
    const info = await lstatOrNullPath(current);
    if (info !== null) {
      try {
        return await realpath(current);
      } catch (error) {
        // A dangling symlink has lstat metadata but no realpath; judge it by
        // its parent. Replacing or removing the entry never follows the link.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }
    const next = dirname(current);
    if (next === current) {
      return current;
    }
    current = next;
  }
}

export async function assertRealPathInsideRoot(
  root: string,
  relativePath: string,
): Promise<void> {
  if ((await lstatOrNullPath(root)) === null) {
    return;
  }
  const realRoot = await realpath(root);
  const real = await realPathNearest(root, relativePath);
  if (!isPathInside(realRoot, real)) {
    throw new ConfigError(
      `path escapes through a symlink: ${relativePath}`,
      'path.symlink-escape',
    );
  }
}

export async function assertRealPathsDisjoint(
  root: string,
  first: string,
  second: string,
): Promise<void> {
  const firstAbsolute = resolveInside(root, first);
  const secondAbsolute = resolveInside(root, second);
  if ((await lstatOrNullPath(firstAbsolute)) === null
    || (await lstatOrNullPath(secondAbsolute)) === null) {
    return;
  }
  const realFirst = await realPathNearest(root, first);
  const realSecond = await realPathNearest(root, second);
  if (isPathInside(realFirst, realSecond) || isPathInside(realSecond, realFirst)) {
    throw new ConfigError(
      `authored and generated trees overlap: ${first} and ${second}`,
      'path.overlap',
    );
  }
}

export async function assertRealPathNotInside(
  root: string,
  candidate: string,
  protectedPath: string,
): Promise<void> {
  const realCandidate = await realPathNearest(root, candidate);
  const realProtected = await realPathNearest(root, protectedPath);
  if (isPathInside(realProtected, realCandidate)) {
    throw new ConfigError(
      `refusing to write a generated path inside an authored source tree: ${candidate}`,
      'path.overlap',
    );
  }
}

export function joinPosix(...parts: string[]): string {
  return parts
    .filter((part) => part.length > 0)
    .map((part) => part.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, ''))
    .join('/');
}

export function absoluteJoin(root: string, ...parts: string[]): string {
  return join(root, ...parts);
}
