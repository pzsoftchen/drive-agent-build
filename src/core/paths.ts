import { dirname, isAbsolute as isNativeAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
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

export function joinPosix(...parts: string[]): string {
  return parts
    .filter((part) => part.length > 0)
    .map((part) => part.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, ''))
    .join('/');
}

export function absoluteJoin(root: string, ...parts: string[]): string {
  return join(root, ...parts);
}
