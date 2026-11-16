import { lstat, readdir, readFile, readlink, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { Diagnostic } from '../../core/diagnostics.ts';
import {
  backupPath,
  lstatOrNull,
  readTextFile,
  replaceSymlink,
  writeFileAtomic,
} from '../../core/fs-atomic.ts';
import { sha256 } from '../../core/hash.ts';
import { assertParentInsideRoot, relativeLink, resolveInside, toPosix } from '../../core/paths.ts';
import { discoverAgents } from '../../model/agents.ts';
import { discoverRules } from '../../model/rules.ts';
import { discoverSkills } from '../../model/skills.ts';
import type {
  GeneratedManifest,
  ProjectManifest,
  ProjectPaths,
  Projection,
} from '../../model/types.ts';

export interface ProjectionDiscovery {
  projections: Projection[];
  diagnostics: Diagnostic[];
}

export type ProjectionAction =
  | {
    type: 'create-link' | 'repair-link' | 'remove-link' | 'backup-and-replace' | 'backup-and-remove';
    projection: Projection;
    linkTarget: string;
  }
  | {
    type: 'add-manifest' | 'remove-manifest';
    projection: Projection;
  };

export interface ProjectionPlan {
  actions: ProjectionAction[];
  conflicts: Diagnostic[];
}

export interface ClaudeMdPlan {
  action: 'create' | 'repair' | 'none' | 'remove' | 'backup-and-repair' | 'backup-and-remove';
  conflict?: Diagnostic;
}

async function hashDirectory(dir: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  const parts: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      parts.push(`${entry.name}\0link:${await readlink(absolute)}`);
    } else if (entry.isDirectory()) {
      parts.push(`${entry.name}/\0${await hashDirectory(absolute)}`);
    } else if (entry.isFile()) {
      parts.push(`${entry.name}\0${sha256(await readFile(absolute))}`);
    }
  }
  return sha256(parts.join('\n'));
}

async function hashSource(
  root: string,
  source: string,
  diagnostics: Diagnostic[],
): Promise<string | undefined> {
  try {
    const absolute = resolveInside(root, source);
    const info = await lstat(absolute);
    if (info.isDirectory()) {
      return await hashDirectory(absolute);
    }
    return sha256(await readFile(absolute));
  } catch (error) {
    diagnostics.push({
      code: 'projection.source-unreadable',
      severity: 'error',
      message: `cannot hash projection source ${source}: ${error instanceof Error ? error.message : String(error)}`,
      file: source,
    });
    return undefined;
  }
}

export async function discoverProjections(
  root: string,
  paths: ProjectPaths,
): Promise<ProjectionDiscovery> {
  const agents = await discoverAgents(root, paths.agents);
  const skills = await discoverSkills(root, paths.agents);
  const rules = await discoverRules(root, paths.agents);
  const diagnostics = [
    ...agents.diagnostics,
    ...skills.diagnostics,
    ...rules.diagnostics,
  ];
  const projections: Projection[] = [];
  const targets = new Set<string>();

  const addProjection = async (
    projection: Omit<Projection, 'sourceSha256'>,
  ): Promise<void> => {
    const sourceSha256 = await hashSource(root, projection.source, diagnostics);
    if (sourceSha256 === undefined) {
      return;
    }
    if (targets.has(projection.target)) {
      diagnostics.push({
        code: 'projection.duplicate-target',
        severity: 'error',
        message: `duplicate projection target ${projection.target}`,
        file: projection.source,
      });
      return;
    }
    targets.add(projection.target);
    projections.push({ ...projection, sourceSha256 });
  };

  for (const agent of agents.items) {
    await addProjection({
      kind: 'agent',
      name: agent.name,
      source: agent.file,
      target: toPosix(relative(root, join(paths.claude, 'agents', basename(agent.file)))),
      link: 'symlink',
    });
  }
  for (const skill of skills.items) {
    await addProjection({
      kind: 'skill',
      name: skill.name,
      source: skill.dir,
      target: toPosix(relative(root, join(paths.claude, 'skills', basename(skill.dir)))),
      link: 'symlink',
    });
  }
  for (const rule of rules.items) {
    await addProjection({
      kind: 'rule',
      name: rule.name,
      source: rule.file,
      target: toPosix(relative(root, join(paths.claude, 'rules', basename(rule.file)))),
      link: 'symlink',
    });
  }

  const rank = { agent: 0, skill: 1, rule: 2 } as const;
  projections.sort((left, right) =>
    rank[left.kind] - rank[right.kind] || left.target.localeCompare(right.target));

  return { projections, diagnostics };
}

function conflict(code: string, projection: Projection, message: string): Diagnostic {
  return {
    code,
    severity: 'error',
    message,
    file: projection.target,
  };
}

async function linkResolvesTo(targetPath: string, sourcePath: string): Promise<boolean> {
  try {
    const raw = await readlink(targetPath);
    return resolve(dirname(targetPath), raw) === resolve(sourcePath);
  } catch {
    return false;
  }
}

export async function planProjectionActions(
  root: string,
  projections: readonly Projection[],
  generated?: GeneratedManifest,
  options: { fix?: boolean } = {},
): Promise<ProjectionPlan> {
  const actions: ProjectionAction[] = [];
  const conflicts: Diagnostic[] = [];
  const managed = new Map(
    (generated?.projections ?? []).map((projection) => [projection.target, projection]),
  );
  const expectedTargets = new Set(projections.map((projection) => projection.target));

  for (const projection of projections) {
    let targetAbs: string;
    let sourceAbs: string;
    let linkTarget: string;
    try {
      targetAbs = resolveInside(root, projection.target);
      sourceAbs = resolveInside(root, projection.source);
      linkTarget = relativeLink(targetAbs, sourceAbs);
    } catch (error) {
      conflicts.push(conflict(
        'projection.target-escape',
        projection,
        `projection path escapes the project: ${error instanceof Error ? error.message : String(error)}`,
      ));
      continue;
    }

    const actual = await lstatOrNull(targetAbs);
    const isManaged = managed.has(projection.target);
    if (actual === null) {
      actions.push({ type: 'create-link', projection, linkTarget });
      if (!isManaged) {
        actions.push({ type: 'add-manifest', projection });
      }
      continue;
    }

    if (actual.isSymbolicLink()) {
      if (await linkResolvesTo(targetAbs, sourceAbs)) {
        if (!isManaged) {
          actions.push({ type: 'add-manifest', projection });
        }
        continue;
      }
      if (isManaged) {
        actions.push({ type: 'repair-link', projection, linkTarget });
      } else {
        conflicts.push(conflict(
          'projection.unmanaged',
          projection,
          `target is an unmanaged symlink: ${projection.target}`,
        ));
        if (options.fix === true) {
          actions.push({ type: 'backup-and-replace', projection, linkTarget });
        }
      }
      continue;
    }

    conflicts.push(conflict(
      'projection.physical-copy',
      projection,
      `target is a physical file or directory, not a DAB symlink: ${projection.target}`,
    ));
    if (options.fix === true) {
      actions.push({ type: 'backup-and-replace', projection, linkTarget });
    }
  }

  for (const [target, projection] of managed) {
    if (expectedTargets.has(target)) {
      continue;
    }
    let targetAbs: string;
    let sourceAbs: string;
    let linkTarget: string;
    try {
      targetAbs = resolveInside(root, projection.target);
      sourceAbs = resolveInside(root, projection.source);
      linkTarget = relativeLink(targetAbs, sourceAbs);
    } catch (error) {
      conflicts.push(conflict(
        'projection.target-escape',
        projection,
        `projection path escapes the project: ${error instanceof Error ? error.message : String(error)}`,
      ));
      continue;
    }

    const actual = await lstatOrNull(targetAbs);
    if (actual === null) {
      actions.push({ type: 'remove-manifest', projection });
      continue;
    }
    if (actual.isSymbolicLink() && await linkResolvesTo(targetAbs, sourceAbs)) {
      actions.push({ type: 'remove-link', projection, linkTarget });
      actions.push({ type: 'remove-manifest', projection });
      continue;
    }
    conflicts.push(conflict(
      actual.isSymbolicLink() ? 'projection.unmanaged' : 'projection.physical-copy',
      projection,
      `target of a removed source is not a DAB symlink: ${projection.target}`,
    ));
    if (options.fix === true) {
      actions.push({ type: 'backup-and-remove', projection, linkTarget });
      actions.push({ type: 'remove-manifest', projection });
    }
  }

  return { actions, conflicts };
}

export async function applyProjectionActions(
  root: string,
  actions: readonly ProjectionAction[],
  options: { backupRoot?: string } = {},
): Promise<{ applied: number; backups: string[] }> {
  let applied = 0;
  const backups: string[] = [];

  for (const action of actions) {
    if (action.type === 'add-manifest' || action.type === 'remove-manifest') {
      continue;
    }
    await assertParentInsideRoot(root, action.projection.target);
    const targetAbs = resolveInside(root, action.projection.target);
    switch (action.type) {
      case 'create-link':
      case 'repair-link':
        await replaceSymlink(targetAbs, action.linkTarget);
        applied += 1;
        break;
      case 'remove-link': {
        const actual = await lstatOrNull(targetAbs);
        if (actual?.isSymbolicLink() === true) {
          await rm(targetAbs, { force: true });
          applied += 1;
        }
        break;
      }
      case 'backup-and-replace': {
        if (options.backupRoot === undefined) {
          throw new Error('backupRoot is required for backup actions');
        }
        backups.push(await backupPath(root, action.projection.target, options.backupRoot));
        await rm(targetAbs, { recursive: true, force: true });
        await replaceSymlink(targetAbs, action.linkTarget);
        applied += 1;
        break;
      }
      case 'backup-and-remove': {
        if (options.backupRoot === undefined) {
          throw new Error('backupRoot is required for backup actions');
        }
        backups.push(await backupPath(root, action.projection.target, options.backupRoot));
        await rm(targetAbs, { recursive: true, force: true });
        applied += 1;
        break;
      }
    }
  }

  return { applied, backups };
}

export function renderClaudeMdShim(): string {
  return '<!-- Generated by DAB from AGENTS.md. Do not edit. Run `dab normalize` to regenerate. -->\n@../AGENTS.md\n';
}

function unmanagedClaudeConflict(message: string): Diagnostic {
  return {
    code: 'claude-md.unmanaged',
    severity: 'error',
    message,
    hint: 'Merge the file content into AGENTS.md, remove the unmanaged CLAUDE.md, then run dab normalize.',
  };
}

export async function planClaudeMdShim(
  root: string,
  manifest: ProjectManifest,
  options: { fix?: boolean } = {},
): Promise<ClaudeMdPlan> {
  const rootClaude = join(root, 'CLAUDE.md');
  if ((await lstatOrNull(rootClaude)) !== null) {
    return {
      action: 'none',
      conflict: unmanagedClaudeConflict('root CLAUDE.md is user-owned and blocks DAB instructions'),
    };
  }

  const target = join(root, '.claude', 'CLAUDE.md');
  const actual = await lstatOrNull(target);
  const managed = manifest.generated?.instructions !== undefined
    && manifest.generated.instructions !== null;
  const enabled = manifest.target.claudeMdShim;

  if (!enabled) {
    if (actual === null) {
      return { action: 'none' };
    }
    if (managed) {
      return { action: 'remove' };
    }
    if (options.fix === true) {
      return { action: 'backup-and-remove' };
    }
    return {
      action: 'none',
      conflict: unmanagedClaudeConflict('unmanaged .claude/CLAUDE.md exists while the shim is disabled'),
    };
  }

  if (actual === null) {
    return { action: 'create' };
  }
  if (!actual.isFile() || actual.isSymbolicLink()) {
    if (options.fix === true) {
      return { action: 'backup-and-repair' };
    }
    return {
      action: 'none',
      conflict: unmanagedClaudeConflict('.claude/CLAUDE.md is not a regular generated file'),
    };
  }

  const content = await readTextFile(target);
  if (content === renderClaudeMdShim()) {
    return { action: 'none' };
  }
  if (managed) {
    return { action: 'repair' };
  }
  if (options.fix === true) {
    return { action: 'backup-and-repair' };
  }
  return {
    action: 'none',
    conflict: unmanagedClaudeConflict('.claude/CLAUDE.md exists but is not DAB-managed'),
  };
}

export async function applyClaudeMdShim(
  root: string,
  action: ClaudeMdPlan['action'],
  options: { backupRoot?: string } = {},
): Promise<void> {
  if (action === 'none') {
    return;
  }
  const target = join(root, '.claude', 'CLAUDE.md');
  await assertParentInsideRoot(root, '.claude/CLAUDE.md');
  if (action === 'remove') {
    await rm(target, { force: true });
    return;
  }
  if (action === 'backup-and-remove' || action === 'backup-and-repair') {
    if (options.backupRoot === undefined) {
      throw new Error('backupRoot is required for shim backup actions');
    }
    await backupPath(root, '.claude/CLAUDE.md', options.backupRoot);
    if (action === 'backup-and-remove') {
      await rm(target, { recursive: true, force: true });
      return;
    }
  }
  await writeFileAtomic(target, renderClaudeMdShim());
}
