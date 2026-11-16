import { extname, join, relative } from 'node:path';
import { readdir, realpath } from 'node:fs/promises';
import type { Diagnostic } from '../core/diagnostics.ts';
import { lstatOrNull } from '../core/fs-atomic.ts';
import {
  assertRealPathInsideRoot,
  assertRelativePath,
  isPathInside,
  resolveInside,
  toPosix,
} from '../core/paths.ts';
import { loadYamlDocument } from '../core/yaml.ts';
import { DiagnosticCodes } from './diagnostics-codes.ts';
import { HookSpecSchema } from './schemas.ts';
import type { DiscoveryResult, LoadedHook } from './types.ts';

function zodMessage(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path.length === 0 ? issue.message : `${path}: ${issue.message}`;
    })
    .join('; ');
}

export async function discoverHooks(
  root: string,
  agentsDir: string,
): Promise<DiscoveryResult<LoadedHook>> {
  const sourceDir = join(agentsDir, 'hooks');
  let entries;
  try {
    entries = await readdir(sourceDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { items: [], diagnostics: [] };
    }
    throw error;
  }

  const items: LoadedHook[] = [];
  const diagnostics: Diagnostic[] = [];
  const ids = new Set<string>();

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }
    const hookDir = join(sourceDir, entry.name);
    const metadataPath = join(hookDir, 'hook.yaml');
    const metadataFile = toPosix(relative(root, metadataPath));
    if ((await lstatOrNull(metadataPath)) === null) {
      diagnostics.push({
        code: DiagnosticCodes.hookMetadataMissing,
        severity: 'warning',
        message: `hook directory ${entry.name} has no hook.yaml`,
        file: toPosix(relative(root, hookDir)),
      });
      continue;
    }
    try {
      await assertRealPathInsideRoot(root, metadataFile);
    } catch (error) {
      diagnostics.push({
        code: DiagnosticCodes.hookInvalid,
        severity: 'error',
        message: `hook metadata cannot be resolved safely: ${error instanceof Error ? error.message : String(error)}`,
        file: metadataFile,
      });
      continue;
    }

    let document;
    try {
      document = await loadYamlDocument(metadataPath);
    } catch (error) {
      diagnostics.push({
        code: DiagnosticCodes.hookInvalid,
        severity: 'error',
        message: `invalid hook metadata: ${error instanceof Error ? error.message : String(error)}`,
        file: metadataFile,
      });
      continue;
    }

    const validated = HookSpecSchema.safeParse(document.toJS());
    if (!validated.success) {
      diagnostics.push({
        code: DiagnosticCodes.hookInvalid,
        severity: 'error',
        message: `invalid hook metadata: ${zodMessage(validated.error)}`,
        file: metadataFile,
      });
      continue;
    }

    const spec = validated.data;
    if (spec.id !== entry.name) {
      diagnostics.push({
        code: DiagnosticCodes.hookInvalid,
        severity: 'error',
        message: `hook id ${spec.id} must match its directory ${entry.name}`,
        file: metadataFile,
      });
      continue;
    }
    if (ids.has(spec.id)) {
      diagnostics.push({
        code: DiagnosticCodes.hookDuplicateId,
        severity: 'error',
        message: `duplicate hook id ${spec.id}`,
        file: metadataFile,
      });
      continue;
    }

    let entryPath: string;
    try {
      entryPath = resolveInside(hookDir, assertRelativePath(spec.entry, 'hook entry'));
    } catch (error) {
      diagnostics.push({
        code: DiagnosticCodes.hookEntry,
        severity: 'error',
        message: `hook entry must stay inside ${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
        file: metadataFile,
      });
      continue;
    }
    const entryInfo = await lstatOrNull(entryPath);
    if (entryInfo === null) {
      diagnostics.push({
        code: DiagnosticCodes.hookMissingEntry,
        severity: 'error',
        message: `hook entry does not exist: ${spec.entry}`,
        file: metadataFile,
      });
      continue;
    }
    if (!entryInfo.isFile()) {
      diagnostics.push({
        code: DiagnosticCodes.hookEntry,
        severity: 'error',
        message: `hook entry must be a regular file: ${spec.entry}`,
        file: metadataFile,
      });
      continue;
    }
    try {
      const realEntry = await realpath(entryPath);
      const realHookDir = await realpath(hookDir);
      if (!isPathInside(realHookDir, realEntry)) {
        diagnostics.push({
          code: DiagnosticCodes.hookEntry,
          severity: 'error',
          message: `hook entry escapes its hook directory: ${spec.entry}`,
          file: metadataFile,
        });
        continue;
      }
    } catch (error) {
      diagnostics.push({
        code: DiagnosticCodes.hookEntry,
        severity: 'error',
        message: `hook entry cannot be resolved safely: ${error instanceof Error ? error.message : String(error)}`,
        file: metadataFile,
      });
      continue;
    }
    if (spec.runner === 'node' && !['.js', '.mjs', '.cjs'].includes(extname(entryPath))) {
      diagnostics.push({
        code: DiagnosticCodes.hookInvalid,
        severity: 'error',
        message: `node hook runner requires a .js, .mjs or .cjs entry: ${spec.entry}`,
        file: metadataFile,
      });
      continue;
    }

    ids.add(spec.id);
    items.push({
      spec,
      dir: toPosix(relative(root, hookDir)),
      entryPath,
      metadataPath: metadataFile,
    });
  }

  return { items, diagnostics };
}
