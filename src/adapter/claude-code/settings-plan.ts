import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Diagnostic } from '../../core/diagnostics.ts';
import {
  backupPath,
  lstatOrNull,
  readTextFile,
  writeFileAtomic,
} from '../../core/fs-atomic.ts';
import { sha256 } from '../../core/hash.ts';
import { assertParentInsideRoot } from '../../core/paths.ts';
import type { GeneratedTarget } from '../../model/types.ts';

export interface SettingsPlan {
  action: 'none' | 'create' | 'backup-and-write';
  path: string;
  sha256: string;
  changed: boolean;
  conflict?: Diagnostic;
}

export async function planSettings(
  root: string,
  generated: GeneratedTarget | undefined,
  expected: string,
): Promise<SettingsPlan> {
  const path = '.claude/settings.json';
  const absolute = join(root, path);
  const expectedHash = sha256(expected);
  const info = await lstatOrNull(absolute);
  const managed = generated?.settings !== undefined && generated.settings !== null;

  if (info === null) {
    return { action: 'create', path, sha256: expectedHash, changed: true };
  }

  const isRegularFile = info.isFile() && !info.isSymbolicLink();
  if (isRegularFile) {
    const actual = await readTextFile(absolute);
    if (actual === expected) {
      return { action: 'none', path, sha256: expectedHash, changed: false };
    }
  }

  return {
    action: 'backup-and-write',
    path,
    sha256: expectedHash,
    changed: true,
    ...(managed
      ? {}
      : {
        conflict: {
          code: 'claude-settings.unmanaged',
          severity: 'error' as const,
          message: 'existing .claude/settings.json is not DAB-managed',
          file: path,
          hint: 'Move or merge the file into .agents/ policies, then rerun with --fix to back it up and replace it.',
        } satisfies Diagnostic,
      }),
  };
}

export async function applySettings(
  root: string,
  plan: SettingsPlan,
  expected: string,
  backupRoot: string,
): Promise<string[]> {
  if (plan.action === 'none') {
    return [];
  }
  const absolute = join(root, plan.path);
  await assertParentInsideRoot(root, plan.path);
  const info = await lstatOrNull(absolute);
  const backups: string[] = [];
  if (info !== null) {
    backups.push(await backupPath(root, plan.path, backupRoot));
    await rm(absolute, { recursive: true, force: true });
  }
  await writeFileAtomic(absolute, expected);
  return backups;
}
