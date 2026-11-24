import { cp, lstat, mkdir, open, readFile, rename, rm, symlink, chmod } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, relative } from 'node:path';
import {
  assertParentInsideRoot,
  assertRelativePath,
  isPathInside,
  toPosix,
} from './paths.ts';

function temporaryName(filePath: string, suffix: string): string {
  return join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${randomBytes(6).toString('hex')}.${suffix}`,
  );
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function lstatOrNull(filePath: string): Promise<Stats | null> {
  try {
    return await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function readTextFile(filePath: string, maxBytes = 1_048_576): Promise<string> {
  const info = await lstat(filePath);
  if (info.size > maxBytes) {
    throw new Error(`file too large to read (${info.size} > ${maxBytes} bytes): ${filePath}`);
  }
  return readFile(filePath, 'utf8');
}

/**
 * Create a file only when it does not exist. `wx` makes the check and the
 * create one filesystem operation, so an authored file that appears between
 * planning and writing is never replaced. Returns false when the path exists.
 */
export async function writeFileIfAbsent(
  filePath: string,
  data: string,
  mode = 0o644,
): Promise<boolean> {
  await ensureDir(dirname(filePath));
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, 'wx', mode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw error;
  }
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(filePath, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  return true;
}

export async function writeFileAtomic(
  filePath: string,
  data: string | Buffer,
  mode = 0o644,
): Promise<void> {
  await ensureDir(dirname(filePath));
  const tempPath = temporaryName(filePath, 'tmp');
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, 'w', mode);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(tempPath, mode);
    await rename(tempPath, filePath);
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function replaceSymlink(linkPath: string, target: string): Promise<void> {
  const existing = await lstatOrNull(linkPath);
  if (existing !== null && !existing.isSymbolicLink()) {
    throw new Error(`refusing to replace physical path with a symlink: ${linkPath}`);
  }
  await ensureDir(dirname(linkPath));
  const tempPath = temporaryName(linkPath, 'link');
  await symlink(target, tempPath);
  try {
    await rename(tempPath, linkPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function backupPath(
  root: string,
  relativePath: string,
  backupRoot: string,
): Promise<string> {
  const normalized = assertRelativePath(relativePath, 'backup path');
  const source = join(root, normalized);
  const destination = join(backupRoot, normalized);
  if (!isPathInside(root, source)) {
    throw new Error(`backup source escapes the project: ${relativePath}`);
  }
  await assertParentInsideRoot(root, normalized);
  const destinationRelative = toPosix(relative(root, destination));
  await assertParentInsideRoot(root, destinationRelative);
  await ensureDir(dirname(destination));
  await cp(source, destination, {
    recursive: true,
    force: true,
    verbatimSymlinks: true,
  });
  return destination;
}
