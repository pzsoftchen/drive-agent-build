import { lstat, readdir, readFile, readlink, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { compareStrings } from '../../core/compare.ts';
import type { Diagnostic } from '../../core/diagnostics.ts';
import {
  backupPath,
  lstatOrNull,
  replaceSymlink,
} from '../../core/fs-atomic.ts';
import { sha256 } from '../../core/hash.ts';
import {
  assertParentInsideRoot,
  assertRealPathNotInside,
  relativeLink,
  resolveInside,
  toPosix,
} from '../../core/paths.ts';
import { discoverAgents } from '../../model/agents.ts';
import { discoverRules } from '../../model/rules.ts';
import { discoverSkills } from '../../model/skills.ts';
import type {
  AgentDefinition,
  GeneratedTarget,
  ProjectPaths,
  Projection,
  RuleDefinition,
  SkillDefinition,
} from '../../model/types.ts';

export interface ProjectionDiscovery {
  projections: Projection[];
  diagnostics: Diagnostic[];
}

export interface ProjectionSources {
  agents: readonly AgentDefinition[];
  skills: readonly SkillDefinition[];
  rules: readonly RuleDefinition[];
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

export { renderClaudeMdShim } from './instructions.ts';

async function hashDirectory(dir: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  const parts: string[] = [];
  for (const entry of entries.sort((left, right) => compareStrings(left.name, right.name))) {
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
  sources?: ProjectionSources,
): Promise<ProjectionDiscovery> {
  let agentItems: readonly AgentDefinition[];
  let skillItems: readonly SkillDefinition[];
  let ruleItems: readonly RuleDefinition[];
  const diagnostics: Diagnostic[] = [];
  if (sources === undefined) {
    const agents = await discoverAgents(root, paths.agents);
    const skills = await discoverSkills(root, paths.agents);
    const rules = await discoverRules(root, paths.agents);
    diagnostics.push(
      ...agents.diagnostics,
      ...skills.diagnostics,
      ...rules.diagnostics,
    );
    agentItems = agents.items;
    skillItems = skills.items;
    ruleItems = rules.items;
  } else {
    agentItems = sources.agents;
    skillItems = sources.skills;
    ruleItems = sources.rules;
  }
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

  for (const agent of agentItems) {
    await addProjection({
      kind: 'agent',
      name: agent.name,
      source: agent.file,
      target: toPosix(relative(root, join(paths.claude, 'agents', basename(agent.file)))),
      link: 'symlink',
    });
  }
  for (const skill of skillItems) {
    await addProjection({
      kind: 'skill',
      name: skill.name,
      source: skill.dir,
      target: toPosix(relative(root, join(paths.claude, 'skills', basename(skill.dir)))),
      link: 'symlink',
    });
  }
  for (const rule of ruleItems) {
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
    rank[left.kind] - rank[right.kind] || compareStrings(left.target, right.target));

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
  generated?: GeneratedTarget,
  options: { fix?: boolean; importedTargets?: ReadonlySet<string> } = {},
): Promise<ProjectionPlan> {
  const actions: ProjectionAction[] = [];
  const conflicts: Diagnostic[] = [];
  const managed = new Map(
    (generated?.projections ?? []).map((projection) => [projection.target, projection]),
  );
  const expectedTargets = new Set(projections.map((projection) => projection.target));
  const importedTargets = options.importedTargets ?? new Set<string>();

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
    if (importedTargets.has(projection.target)) {
      // The adoption import owns this entry: it backs the existing target up
      // and installs the per-entry symlink after this plan is gated.
      continue;
    }
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
    if (expectedTargets.has(target) || importedTargets.has(target)) {
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
  options: { backupRoot?: string; sourceRoot?: string } = {},
): Promise<{ applied: number; backups: string[] }> {
  let applied = 0;
  const backups: string[] = [];

  for (const action of actions) {
    if (action.type === 'add-manifest' || action.type === 'remove-manifest') {
      continue;
    }
    await assertParentInsideRoot(root, action.projection.target);
    if (options.sourceRoot !== undefined) {
      await assertRealPathNotInside(root, action.projection.target, options.sourceRoot);
    }
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

