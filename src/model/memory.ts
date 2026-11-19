import { readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { compareStrings } from '../core/compare.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { lstatOrNull, readTextFile } from '../core/fs-atomic.ts';
import { isPathInside, toPosix } from '../core/paths.ts';
import { DiagnosticCodes } from './diagnostics-codes.ts';
import { parseFrontmatter } from './frontmatter.ts';
import { MemoryEntrySchema } from './schemas.ts';
import type { DiscoveryResult, MemoryEntry } from './types.ts';

function zodMessage(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path.length === 0 ? issue.message : `${path}: ${issue.message}`;
    })
    .join('; ');
}

async function listMarkdown(dir: string, depth = 0): Promise<string[]> {
  if (depth > 3) {
    return [];
  }
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => compareStrings(left.name, right.name))) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMarkdown(absolute, depth + 1)));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(absolute);
    }
  }
  return files;
}

function extractLocalLinks(text: string): string[] {
  const links: string[] = [];
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = (match[1] ?? '').trim();
    if (raw.length === 0 || raw.startsWith('#') || raw.startsWith('http://')
      || raw.startsWith('https://') || raw.startsWith('mailto:')) {
      continue;
    }
    const target = raw.split('#')[0] ?? '';
    if (target.length > 0) {
      links.push(target);
    }
  }
  return links;
}

export async function discoverMemory(
  root: string,
  agentsDir: string,
  today = new Date(),
): Promise<DiscoveryResult<MemoryEntry>> {
  const memoryDir = join(agentsDir, 'memory');
  const files = await listMarkdown(memoryDir);
  const items: MemoryEntry[] = [];
  const diagnostics: Diagnostic[] = [];
  const todayIso = today.toISOString().slice(0, 10);

  const indexPath = join(memoryDir, 'INDEX.md');
  const indexExists = (await lstatOrNull(indexPath)) !== null;
  let indexText = '';
  if (indexExists) {
    indexText = await readTextFile(indexPath);
  } else if ((await lstatOrNull(memoryDir)) !== null) {
    diagnostics.push({
      code: DiagnosticCodes.memoryIndexMissing,
      severity: 'warning',
      message: 'memory directory has no INDEX.md',
      file: toPosix(relative(root, memoryDir)),
      hint: 'Add .agents/memory/INDEX.md and list every shared memory entry.',
    });
  }

  const linkedPaths = new Set<string>();
  for (const link of extractLocalLinks(indexText)) {
    const target = resolve(memoryDir, link);
    if (!isPathInside(memoryDir, target)) {
      diagnostics.push({
        code: DiagnosticCodes.memoryIndexBroken,
        severity: 'error',
        message: `memory index link escapes the memory directory: ${link}`,
        file: toPosix(relative(root, indexPath)),
      });
      continue;
    }
    linkedPaths.add(target);
    if ((await lstatOrNull(target)) === null) {
      diagnostics.push({
        code: DiagnosticCodes.memoryIndexBroken,
        severity: 'error',
        message: `memory index link is broken: ${link}`,
        file: toPosix(relative(root, indexPath)),
      });
    }
  }

  for (const file of files) {
    if (file === indexPath) {
      continue;
    }
    const relativeFile = toPosix(relative(root, file));
    let parsed;
    try {
      parsed = parseFrontmatter(await readTextFile(file), relativeFile);
    } catch (error) {
      diagnostics.push({
        code: DiagnosticCodes.memoryInvalidEntry,
        severity: 'error',
        message: `invalid memory entry: ${error instanceof Error ? error.message : String(error)}`,
        file: relativeFile,
        line: 1,
      });
      continue;
    }

    const validated = MemoryEntrySchema.safeParse(parsed.data);
    if (!validated.success) {
      diagnostics.push({
        code: DiagnosticCodes.memoryInvalidEntry,
        severity: 'error',
        message: `invalid memory entry: ${zodMessage(validated.error)}`,
        file: relativeFile,
        line: 1,
      });
      continue;
    }

    const data = validated.data;
    if (data.review_by < todayIso) {
      diagnostics.push({
        code: DiagnosticCodes.memoryExpired,
        severity: 'warning',
        message: `memory review is overdue (${data.review_by})`,
        file: relativeFile,
        hint: 'Review, update, or supersede this shared memory entry.',
      });
    }

    const absolute = resolve(file);
    if (indexExists && !linkedPaths.has(absolute)) {
      diagnostics.push({
        code: DiagnosticCodes.memoryUnlisted,
        severity: 'warning',
        message: 'memory entry is not listed in INDEX.md',
        file: relativeFile,
      });
    }

    items.push({
      file: relativeFile,
      title: data.title,
      source: data.source,
      reviewBy: data.review_by,
      ...(data.updated === undefined ? {} : { updated: data.updated }),
      ...(data.status === undefined ? {} : { status: data.status }),
      body: parsed.body,
    });
  }

  return { items, diagnostics };
}

export function memoryRelativePaths(items: readonly MemoryEntry[]): string[] {
  return items.map((item) => item.file.split(sep).join('/'));
}
