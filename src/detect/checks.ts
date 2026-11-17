import { readdir, readlink } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import type { Diagnostic } from '../core/diagnostics.ts';
import { lstatOrNull, readTextFile } from '../core/fs-atomic.ts';
import { sha256 } from '../core/hash.ts';
import { extractMarkdownLinks } from '../core/markdown-links.ts';
import { isPathInside, toPosix } from '../core/paths.ts';
import { scanSecrets } from '../core/security.ts';
import {
  planInstructions,
  type InstructionMode,
} from '../adapter/claude-code/instructions.ts';
import { checkAgentsMd } from '../model/agents-md.ts';
import { discoverMemory } from '../model/memory.ts';
import type {
  AgentDefinition,
  GeneratedTarget,
  LoadedHook,
  ProjectPaths,
  Projection,
} from '../model/types.ts';
import { findAncestorInstructionFiles } from './ancestor-claude-md.ts';

function relativeFile(root: string, absolute: string): string {
  return toPosix(relative(root, absolute));
}

export async function checkSettings(
  root: string,
  paths: ProjectPaths,
  generated: GeneratedTarget | undefined,
  expected: string,
): Promise<Diagnostic[]> {
  const absolute = join(paths.claude, 'settings.json');
  const file = relativeFile(root, absolute);
  const record = generated?.settings ?? null;
  const info = await lstatOrNull(absolute);
  if (info === null) {
    return [{
      code: 'generated.missing',
      severity: 'error',
      message: 'generated settings file is missing',
      file,
      hint: 'Run dab normalize to build .claude/settings.json.',
    }];
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    return [{
      code: 'claude-settings.unmanaged',
      severity: 'error',
      message: 'generated settings path is not a regular file',
      file,
    }];
  }

  const actual = await readTextFile(absolute);
  if (actual !== expected) {
    return [{
      code: record === null ? 'claude-settings.unmanaged' : 'generated.drift',
      severity: 'error',
      message: 'generated settings do not match the current authored sources',
      file,
      hint: 'Run dab normalize to rebuild them; do not edit generated files by hand.',
    }];
  }

  const diagnostics: Diagnostic[] = [];
  const expectedHash = sha256(expected);
  if (record === null) {
    diagnostics.push({
      code: 'generated.manifest-stale',
      severity: 'warning',
      message: 'settings match but dab.yaml has no generated settings record',
      file: 'dab.yaml',
    });
  } else if (
    record.sha256 !== expectedHash
    || record.path !== '.claude/settings.json'
  ) {
    diagnostics.push({
      code: 'generated.manifest-stale',
      severity: 'warning',
      message: 'dab.yaml records a stale settings hash',
      file: 'dab.yaml',
    });
  }
  return diagnostics;
}

export async function checkInstructionEnvironment(
  root: string,
  home?: string,
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];

  if ((await lstatOrNull(join(root, 'CLAUDE.md'))) !== null) {
    diagnostics.push({
      code: 'claude-md.unmanaged',
      severity: 'error',
      message: 'root CLAUDE.md is user-owned and blocks DAB instructions',
      file: 'CLAUDE.md',
      hint: 'Merge its content into AGENTS.md and remove the file.',
    });
  }
  if ((await lstatOrNull(join(root, 'CLAUDE.local.md'))) !== null) {
    diagnostics.push({
      code: 'claude-md.ancestor',
      severity: 'warning',
      message: 'CLAUDE.local.md in the project root can block AGENTS.md loading',
      file: 'CLAUDE.local.md',
    });
  }
  for (const file of await findAncestorInstructionFiles(root, home)) {
    diagnostics.push({
      code: 'claude-md.ancestor',
      severity: 'warning',
      message: 'an ancestor instruction file can affect Claude Code sessions in this project',
      file: toPosix(relative(root, file)),
    });
  }

  return diagnostics;
}

export async function checkInstructions(
  root: string,
  paths: ProjectPaths,
  mode: InstructionMode,
  generated?: GeneratedTarget,
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const target = join(root, '.claude', 'CLAUDE.md');
  const plan = await planInstructions({ root, paths, mode, generated });

  if (plan.conflict !== undefined) {
    diagnostics.push(plan.conflict);
  } else if (plan.action !== 'none') {
    const present = (await lstatOrNull(target)) !== null;
    diagnostics.push({
      code: present ? 'claude-md.instructions-drift' : 'claude-md.instructions-missing',
      severity: 'error',
      message: present
        ? '.claude/CLAUDE.md does not match the DAB-managed instructions'
        : 'DAB-managed .claude/CLAUDE.md instructions are missing',
      file: '.claude/CLAUDE.md',
      hint: 'Run dab normalize to rebuild the instruction output; do not edit it by hand.',
    });
  }

  const record = generated?.instructions ?? null;
  if (mode === 'disabled') {
    if (record !== null) {
      diagnostics.push({
        code: 'generated.manifest-stale',
        severity: 'warning',
        message: 'dab.yaml records instructions while claude-code instructions are disabled',
        file: 'dab.yaml',
      });
    }
    return diagnostics;
  }
  if ((await lstatOrNull(paths.instructions)) === null) {
    // The missing source is reported as agents-md.missing; there is no stale record.
    return diagnostics;
  }

  if (record === null) {
    diagnostics.push({
      code: 'generated.manifest-stale',
      severity: 'warning',
      message: 'dab.yaml does not record the managed .claude/CLAUDE.md instructions',
      file: 'dab.yaml',
    });
  } else if (
    record.path !== '.claude/CLAUDE.md'
    || record.mode !== mode
    || (plan.sha256 !== undefined && record.sha256 !== plan.sha256)
  ) {
    diagnostics.push({
      code: 'generated.manifest-stale',
      severity: 'warning',
      message: 'dab.yaml records stale .claude/CLAUDE.md instructions',
      file: 'dab.yaml',
    });
  }

  return diagnostics;
}

export async function checkProjections(
  root: string,
  paths: ProjectPaths,
  projections: readonly Projection[],
  generated: GeneratedTarget | undefined,
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const managed = new Map(
    (generated?.projections ?? []).map((projection) => [projection.target, projection]),
  );
  const expected = new Set(projections.map((projection) => projection.target));

  for (const projection of projections) {
    const absolute = join(root, projection.target);
    const info = await lstatOrNull(absolute);
    if (info === null) {
      diagnostics.push({
        code: 'projection.broken',
        severity: 'error',
        message: 'projection target is missing',
        file: projection.target,
        hint: 'Run dab normalize.',
      });
    } else if (info.isSymbolicLink()) {
      const raw = await readlink(absolute);
      const resolved = resolve(dirname(absolute), raw);
      const expectedSource = resolve(root, projection.source);
      if (resolved !== expectedSource || !isPathInside(root, resolved)) {
        diagnostics.push({
          code: 'projection.broken',
          severity: 'error',
          message: 'projection symlink does not point at its authored source',
          file: projection.target,
        });
      }
    } else {
      diagnostics.push({
        code: 'projection.physical-copy',
        severity: 'error',
        message: 'projection target is a physical copy, not a DAB symlink',
        file: projection.target,
        hint: 'Remove the copy and run dab normalize; use --fix to back it up automatically.',
      });
    }

    const record = managed.get(projection.target);
    if (record === undefined) {
      diagnostics.push({
        code: 'projection.unmanaged',
        severity: 'warning',
        message: 'projection is not recorded in dab.yaml',
        file: projection.target,
      });
    } else if (record.sourceSha256 !== projection.sourceSha256) {
      diagnostics.push({
        code: 'generated.manifest-stale',
        severity: 'warning',
        message: 'dab.yaml records a stale source hash for this projection',
        file: 'dab.yaml',
        hint: 'Run dab normalize to refresh the manifest.',
      });
    }
  }

  for (const [target, projection] of managed) {
    if (expected.has(target)) {
      continue;
    }
    const info = await lstatOrNull(join(root, target));
    if (info === null) {
      diagnostics.push({
        code: 'generated.manifest-stale',
        severity: 'warning',
        message: 'managed projection has no source and no target',
        file: 'dab.yaml',
        hint: `Stale projection: ${projection.source}`,
      });
    } else if (info.isSymbolicLink()) {
      diagnostics.push({
        code: 'projection.broken',
        severity: 'error',
        message: 'managed projection source was removed',
        file: target,
      });
    } else {
      diagnostics.push({
        code: 'projection.physical-copy',
        severity: 'error',
        message: 'target of a removed source is not a DAB symlink',
        file: target,
      });
    }
  }

  const directories = [
    { dir: 'agents', prefix: '.claude/agents' },
    { dir: 'skills', prefix: '.claude/skills' },
    { dir: 'rules', prefix: '.claude/rules' },
  ] as const;
  for (const { dir, prefix } of directories) {
    let entries;
    try {
      entries = await readdir(join(paths.claude, dir), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      throw error;
    }
    for (const entry of entries) {
      const target = `${prefix}/${entry.name}`;
      if (!expected.has(target) && !managed.has(target)) {
        diagnostics.push({
          code: 'projection.unmanaged',
          severity: 'warning',
          message: 'unmanaged entry in the generated Claude Code tree',
          file: target,
          hint: 'Move the fact into .agents/ or remove it; DAB never modifies unmanaged files.',
        });
      }
    }
  }

  if (generated !== undefined) {
    const fingerprint = (items: readonly Projection[]): string =>
      items
        .map((item) => `${item.target}|${item.source}|${item.sourceSha256}`)
        .sort()
        .join('\n');
    if (fingerprint(projections) !== fingerprint(generated.projections)) {
      diagnostics.push({
        code: 'generated.manifest-stale',
        severity: 'warning',
        message: 'projection manifest is stale',
        file: 'dab.yaml',
        hint: 'Run dab normalize to refresh the generated section.',
      });
    }
  }

  return diagnostics;
}

export async function checkHookSafety(hooks: readonly LoadedHook[]): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  for (const hook of hooks) {
    const file = `${hook.dir}/${toPosix(hook.spec.entry)}`;
    const info = await lstatOrNull(hook.entryPath);
    if (info === null || !info.isFile()) {
      diagnostics.push({
        code: 'hook.unsafe',
        severity: 'error',
        message: 'hook entry is not a regular file',
        file,
      });
      continue;
    }
    let text: string;
    try {
      text = await readTextFile(hook.entryPath);
    } catch (error) {
      diagnostics.push({
        code: 'hook.unsafe',
        severity: 'error',
        message: `hook entry cannot be read safely: ${error instanceof Error ? error.message : String(error)}`,
        file,
      });
      continue;
    }
    if (text.includes('\0')) {
      diagnostics.push({
        code: 'hook.unsafe',
        severity: 'error',
        message: 'hook entry contains a NUL byte',
        file,
      });
    }
    if (text.includes('\r\n')) {
      diagnostics.push({
        code: 'hook.unsafe',
        severity: 'error',
        message: 'hook entry must use LF line endings',
        file,
      });
    }
    if (hook.spec.runner === 'exec') {
      if ((info.mode & 0o111) === 0) {
        diagnostics.push({
          code: 'hook.unsafe',
          severity: 'error',
          message: 'exec hook is not executable',
          file,
        });
      }
      if (!(text.split('\n')[0] ?? '').startsWith('#!')) {
        diagnostics.push({
          code: 'hook.unsafe',
          severity: 'error',
          message: 'exec hook is missing a shebang',
          file,
        });
      }
    }
    diagnostics.push(...scanSecrets(text, file));
  }
  return diagnostics;
}

export function checkAgentHookIds(
  agents: readonly AgentDefinition[],
  hooks: readonly LoadedHook[],
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const used = new Map<string, string>();
  for (const hook of hooks) {
    used.set(hook.spec.id, hook.metadataPath);
  }
  for (const agent of agents) {
    for (const hook of agent.hooks) {
      const existing = used.get(hook.id);
      if (existing !== undefined) {
        diagnostics.push({
          code: 'hook.duplicate-id',
          severity: 'error',
          message: `agent ${agent.name} reuses hook id ${hook.id}`,
          file: hook.source,
          hint: `The id is already used by ${existing}.`,
        });
      } else {
        used.set(hook.id, hook.source);
      }
    }
  }
  return diagnostics;
}

const SECRET_EXTENSIONS = new Set([
  '.md',
  '.yaml',
  '.yml',
  '.json',
  '.js',
  '.mjs',
  '.cjs',
  '.sh',
  '.txt',
]);

const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'coverage', '.dab', '.superpowers']);

async function walkFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > 6) {
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
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) {
        files.push(...(await walkFiles(absolute, depth + 1)));
      }
    } else if (entry.isFile() && SECRET_EXTENSIONS.has(extname(entry.name))) {
      files.push(absolute);
    }
  }
  return files;
}

export async function checkSecrets(root: string, paths: ProjectPaths): Promise<Diagnostic[]> {
  const candidates = new Set<string>([
    paths.instructions,
    paths.manifest,
    ...(await walkFiles(paths.agents)),
  ]);
  const diagnostics: Diagnostic[] = [];
  for (const file of [...candidates].sort()) {
    if ((await lstatOrNull(file)) === null) {
      continue;
    }
    try {
      const text = await readTextFile(file, 262_144);
      diagnostics.push(...scanSecrets(text, relativeFile(root, file)));
    } catch {
      // Unreadable or oversized files are handled by their owning check.
    }
  }
  return diagnostics;
}

export async function checkMemory(
  root: string,
  paths: ProjectPaths,
  now?: Date,
): Promise<Diagnostic[]> {
  const memory = await discoverMemory(root, paths.agents, now);
  const diagnostics = [...memory.diagnostics];
  const paragraphs = new Map<string, string>();

  for (const item of memory.items) {
    for (const paragraph of item.body.split(/\n\s*\n/)) {
      const normalized = paragraph.replace(/\s+/g, ' ').trim();
      if (normalized.length < 20) {
        continue;
      }
      const hash = sha256(normalized);
      const existing = paragraphs.get(hash);
      if (existing !== undefined) {
        diagnostics.push({
          code: 'memory.duplicate-paragraph',
          severity: 'error',
          message: 'duplicate memory paragraph',
          file: item.file,
          hint: `The same paragraph also appears in ${existing}.`,
        });
      } else {
        paragraphs.set(hash, item.file);
      }
    }
  }

  for (const dir of ['agent-memory', 'agent-memory-local', 'memory', 'projects']) {
    const absolute = join(paths.claude, dir);
    if ((await lstatOrNull(absolute)) !== null) {
      diagnostics.push({
        code: 'memory.project-artifact',
        severity: 'error',
        message: `team memory or auto memory artifact exists in the repository: ${dir}`,
        file: toPosix(relative(root, absolute)),
        hint: 'Keep personal auto memory machine-local; put shared knowledge in .agents/memory/.',
      });
    }
  }

  return diagnostics;
}

export async function checkAgentsMdState(
  scopeRoot: string,
  paths: ProjectPaths,
): Promise<Diagnostic[]> {
  const size = await checkAgentsMd(scopeRoot, paths.instructions);
  const diagnostics = [...size.diagnostics];
  if ((await lstatOrNull(paths.instructions)) === null) {
    return diagnostics;
  }

  const file = relativeFile(scopeRoot, paths.instructions);
  const base = dirname(paths.instructions);
  const text = await readTextFile(paths.instructions);
  for (const link of extractMarkdownLinks(text)) {
    const target = link.target.split('#')[0] ?? '';
    if (
      target.length === 0
      || target.startsWith('http://')
      || target.startsWith('https://')
      || target.startsWith('mailto:')
    ) {
      continue;
    }
    const absolute = target.startsWith('/') ? target : resolve(base, target);
    if (!isPathInside(scopeRoot, absolute) || (await lstatOrNull(absolute)) === null) {
      diagnostics.push({
        code: 'agents-md.broken-link',
        severity: 'error',
        message: `AGENTS.md link does not resolve: ${link.target}`,
        file,
        line: link.line,
      });
    }
  }
  return diagnostics;
}
