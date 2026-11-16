import { rm } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { CommandRunner } from '../core/command.ts';
import {
  formatDiagnostics,
  hasErrors,
  sortDiagnostics,
  type Diagnostic,
} from '../core/diagnostics.ts';
import { DabError, ValidationError } from '../core/errors.ts';
import { ExitCode } from '../core/exit-codes.ts';
import { backupPath, lstatOrNull, readTextFile, writeFileAtomic } from '../core/fs-atomic.ts';
import { DAB_GITIGNORE_ENTRIES, ensureGitignoreBlock } from '../core/gitignore.ts';
import { sha256 } from '../core/hash.ts';
import { stableJson } from '../core/json.ts';
import {
  assertParentInsideRoot,
  assertRealPathInsideRoot,
  assertRealPathsDisjoint,
  isPathInside,
  realPathNearest,
  toPosix,
} from '../core/paths.ts';
import { checkClaudeCode } from '../adapter/claude-code/version.ts';
import { compilePolicy } from '../adapter/claude-code/policy-compile.ts';
import {
  applyClaudeMdShim,
  applyProjectionActions,
  discoverProjections,
  planClaudeMdShim,
  planProjectionActions,
  renderClaudeMdShim,
  type ClaudeMdPlan,
  type ProjectionAction,
} from '../adapter/claude-code/projection.ts';
import { renderSettings } from '../adapter/claude-code/settings.ts';
import { checkAgentHookIds, checkHookSafety, checkSecrets } from '../detect/checks.ts';
import { discoverAgents } from '../model/agents.ts';
import { checkAgentsMd } from '../model/agents-md.ts';
import { discoverHooks } from '../model/hooks.ts';
import { loadPolicySources } from '../model/policy.ts';
import {
  loadProjectManifest,
  resolveProjectPaths,
  updateGeneratedManifest,
} from '../model/project-manifest.ts';
import type { GeneratedManifest, ProjectManifest, Projection } from '../model/types.ts';

export interface NormalizeOptions {
  cwd: string;
  dryRun?: boolean;
  fix?: boolean;
  json?: boolean;
  platform?: NodeJS.Platform;
  now?: Date;
  runner?: CommandRunner;
}

export interface NormalizeIO {
  stdout: (value: string) => void;
  stderr: (value: string) => void;
}

interface SettingsPlan {
  action: 'none' | 'create' | 'backup-and-write';
  path: string;
  sha256: string;
  changed: boolean;
  conflict?: Diagnostic;
}

export interface NormalizeResult {
  ok: boolean;
  dryRun: boolean;
  exitCode: ExitCode;
  actions: ProjectionAction[];
  diagnostics: Diagnostic[];
  settings: {
    path: string;
    sha256: string;
    changed: boolean;
  };
  shimAction: ClaudeMdPlan['action'];
  backups: string[];
  gitignore: {
    changed: boolean;
    path: string;
  };
  manifestUpdated: boolean;
}

function dedupeDiagnostics(items: readonly Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = [item.code, item.severity, item.file ?? '', item.line ?? '', item.message].join('|');
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function errorDiagnostic(error: DabError, file = 'dab.yaml'): Diagnostic {
  return {
    code: error.code,
    severity: 'error',
    message: error.message,
    file,
    ...(error.hint === undefined ? {} : { hint: error.hint }),
  };
}

function blockedResult(
  options: NormalizeOptions,
  diagnostics: Diagnostic[],
  extras: {
    actions?: ProjectionAction[];
    shimAction?: ClaudeMdPlan['action'];
    settings?: NormalizeResult['settings'];
    exitCode?: ExitCode;
  } = {},
): NormalizeResult {
  return {
    ok: false,
    dryRun: options.dryRun === true,
    exitCode: extras.exitCode ?? ExitCode.Validation,
    actions: extras.actions ?? [],
    diagnostics: sortDiagnostics(dedupeDiagnostics(diagnostics)),
    settings: extras.settings ?? {
      path: '.claude/settings.json',
      sha256: '',
      changed: false,
    },
    shimAction: extras.shimAction ?? 'none',
    backups: [],
    gitignore: { changed: false, path: '' },
    manifestUpdated: false,
  };
}

async function planSettings(
  root: string,
  manifest: ProjectManifest,
  expected: string,
): Promise<SettingsPlan> {
  const path = '.claude/settings.json';
  const absolute = join(root, path);
  const expectedHash = sha256(expected);
  const info = await lstatOrNull(absolute);
  const managed = manifest.generated?.settings !== undefined;

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

async function applySettings(
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
  if (plan.action === 'create') {
    if (info !== null) {
      backups.push(await backupPath(root, plan.path, backupRoot));
      await rm(absolute, { recursive: true, force: true });
    }
    await writeFileAtomic(absolute, expected);
    return backups;
  }
  if (info !== null) {
    backups.push(await backupPath(root, plan.path, backupRoot));
    await rm(absolute, { recursive: true, force: true });
  }
  await writeFileAtomic(absolute, expected);
  return backups;
}

function backupRootFor(root: string, now: Date): string {
  const stamp = now.toISOString().replaceAll(':', '-').replaceAll('.', '-');
  return join(root, '.dab', 'backups', stamp);
}

function withFixWarning(item: Diagnostic): Diagnostic {
  return {
    ...item,
    severity: 'warning',
    hint: 'Resolved with --fix; the original was backed up under .dab/backups/.',
  };
}

async function assertSourceTreesSafe(root: string): Promise<void> {
  await assertRealPathInsideRoot(root, '.claude');
  await assertRealPathInsideRoot(root, '.agents');
  await assertRealPathsDisjoint(root, '.agents', '.claude');
  for (const directory of [
    '.agents/agents',
    '.agents/skills',
    '.agents/rules',
    '.agents/policies',
    '.agents/adapters',
    '.agents/hooks',
    '.agents/memory',
    '.agents/notes',
    '.claude/agents',
    '.claude/skills',
    '.claude/rules',
  ]) {
    await assertRealPathInsideRoot(root, directory);
  }
}

async function projectionOverlapDiagnostics(
  root: string,
  projections: readonly Projection[],
  generated: GeneratedManifest | undefined,
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const agentsExists = (await lstatOrNull(join(root, '.agents'))) !== null;
  const realAgents = agentsExists ? await realPathNearest(root, '.agents') : undefined;
  const sourceReals = new Set<string>();
  for (const projection of projections) {
    sourceReals.add(await realPathNearest(root, projection.source));
  }

  const all = [...projections, ...(generated?.projections ?? [])];
  const seen = new Set<string>();
  for (const projection of all) {
    if (seen.has(projection.target)) {
      continue;
    }
    seen.add(projection.target);
    const targetInfo = await lstatOrNull(join(root, projection.target));
    if (targetInfo?.isSymbolicLink() === true) {
      // A projection symlink is safe to replace: replaceSymlink never
      // follows or deletes the target it points at.
      continue;
    }
    const realTarget = await realPathNearest(root, projection.target);
    if (
      sourceReals.has(realTarget)
      || (realAgents !== undefined && isPathInside(realAgents, realTarget))
    ) {
      diagnostics.push({
        code: 'path.overlap',
        severity: 'error',
        message: `generated target overlaps an authored source: ${projection.target}`,
        file: projection.target,
        hint: 'Use the default disjoint .agents and .claude trees.',
      });
    }
  }
  return diagnostics;
}

export async function normalizeProject(options: NormalizeOptions): Promise<NormalizeResult> {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    throw new ValidationError(
      'Windows is not supported in v0.1',
      'platform.unsupported',
      { hint: 'Use macOS or Linux. Windows junction support is planned for a later release.' },
    );
  }

  const root = resolve(options.cwd);
  const loaded = await loadProjectManifest(root);
  const paths = resolveProjectPaths(root, loaded.manifest);
  const diagnostics: Diagnostic[] = [];

  try {
    await assertSourceTreesSafe(root);
  } catch (error) {
    if (error instanceof DabError) {
      return blockedResult(options, [errorDiagnostic(error)]);
    }
    throw error;
  }

  const backend = await checkClaudeCode(loaded.manifest.target.minVersion, options.runner);
  diagnostics.push(...backend.diagnostics);
  if (backend.diagnostics.some(
    (item) => item.code === 'backend.version' && item.severity === 'error',
  )) {
    return blockedResult(options, diagnostics, { exitCode: ExitCode.Backend });
  }

  const discovered = await discoverProjections(root, paths);
  const agents = await discoverAgents(root, paths.agents);
  const hooks = await discoverHooks(root, paths.agents);
  diagnostics.push(...discovered.diagnostics);
  diagnostics.push(...agents.diagnostics);
  diagnostics.push(...hooks.diagnostics);
  diagnostics.push(...checkAgentHookIds(agents.items, hooks.items));
  diagnostics.push(...await checkHookSafety(hooks.items));
  diagnostics.push(...await checkSecrets(root, paths));
  diagnostics.push(...await projectionOverlapDiagnostics(
    root,
    discovered.projections,
    loaded.manifest.generated,
  ));

  const policies = await loadPolicySources(paths);
  const compiled = compilePolicy(policies.project, policies.adapter, hooks.items);
  diagnostics.push(...compiled.diagnostics);

  const agentsMd = await checkAgentsMd(root);
  diagnostics.push(...agentsMd.diagnostics);

  if (hasErrors(diagnostics)) {
    return blockedResult(options, diagnostics);
  }

  const settingsContent = renderSettings(compiled.effective);
  const projectionPlan = await planProjectionActions(
    root,
    discovered.projections,
    loaded.manifest.generated,
    { fix: options.fix === true },
  );
  diagnostics.push(
    ...projectionPlan.conflicts.map((item) =>
      options.fix === true ? withFixWarning(item) : item),
  );

  const shimPlan = await planClaudeMdShim(root, loaded.manifest, { fix: options.fix === true });
  if (shimPlan.conflict !== undefined) {
    diagnostics.push(shimPlan.conflict);
  }

  const settingsPlan = await planSettings(root, loaded.manifest, settingsContent);
  if (settingsPlan.conflict !== undefined) {
    diagnostics.push(
      options.fix === true ? withFixWarning(settingsPlan.conflict) : settingsPlan.conflict,
    );
  }

  const settingsResult = {
    path: settingsPlan.path,
    sha256: settingsPlan.sha256,
    changed: settingsPlan.changed,
  };

  if (hasErrors(diagnostics)) {
    return blockedResult(options, diagnostics, {
      actions: projectionPlan.actions,
      shimAction: shimPlan.action,
      settings: { ...settingsResult, changed: false },
    });
  }

  if (options.dryRun === true) {
    return {
      ok: true,
      dryRun: true,
      exitCode: ExitCode.Ok,
      actions: projectionPlan.actions,
      diagnostics: sortDiagnostics(diagnostics),
      settings: settingsResult,
      shimAction: shimPlan.action,
      backups: [],
      gitignore: { changed: false, path: join(root, '.gitignore') },
      manifestUpdated: false,
    };
  }

  const backupRoot = backupRootFor(root, options.now ?? new Date());
  const projectionApplied = await applyProjectionActions(root, projectionPlan.actions, {
    backupRoot,
    sourceRoot: '.agents',
  });
  const backups = [...projectionApplied.backups];

  backups.push(...await applyClaudeMdShim(root, shimPlan.action, { backupRoot }));
  backups.push(...(await applySettings(root, settingsPlan, settingsContent, backupRoot)));

  const shimRemoved = shimPlan.action === 'remove' || shimPlan.action === 'backup-and-remove';
  const generated: GeneratedManifest = {
    settings: {
      path: '.claude/settings.json',
      sha256: sha256(settingsContent),
    },
    instructions: loaded.manifest.target.claudeMdShim && !shimRemoved
      ? {
        path: '.claude/CLAUDE.md',
        sha256: sha256(renderClaudeMdShim()),
      }
      : null,
    projections: discovered.projections,
  };
  const manifestUpdated = stableJson(loaded.manifest.generated ?? null) !== stableJson(generated);
  if (manifestUpdated) {
    await updateGeneratedManifest(root, generated);
  }

  const gitignore = await ensureGitignoreBlock(root, DAB_GITIGNORE_ENTRIES);

  return {
    ok: true,
    dryRun: false,
    exitCode: ExitCode.Ok,
    actions: projectionPlan.actions,
    diagnostics: sortDiagnostics(dedupeDiagnostics(diagnostics)),
    settings: settingsResult,
    shimAction: shimPlan.action,
    backups,
    gitignore,
    manifestUpdated,
  };
}

function describeAction(action: ProjectionAction): string {
  switch (action.type) {
    case 'add-manifest':
    case 'remove-manifest':
      return `${action.type} ${action.projection.target}`;
    default:
      return `${action.type} ${action.projection.target} -> ${action.linkTarget}`;
  }
}

function formatHuman(result: NormalizeResult): string {
  const lines: string[] = [];
  lines.push(`dab normalize${result.dryRun ? ' (dry run)' : ''}`);
  for (const action of result.actions) {
    lines.push(`  ${describeAction(action)}`);
  }
  lines.push(`  settings ${result.settings.changed ? 'changed' : 'unchanged'}: ${result.settings.path}`);
  lines.push(`  shim ${result.shimAction}`);
  lines.push(`  manifest ${result.manifestUpdated ? 'updated' : 'unchanged'}`);
  lines.push(`  .gitignore ${result.gitignore.changed ? 'updated' : 'unchanged'}`);
  if (result.backups.length > 0) {
    lines.push(`  backups: ${result.backups.length}`);
    for (const backup of result.backups) {
      lines.push(`    ${toPosix(relative(process.cwd(), backup))}`);
    }
  }
  const diagnostics = formatDiagnostics(result.diagnostics);
  if (diagnostics.length > 0) {
    lines.push(diagnostics.trimEnd());
  }
  lines.push(result.ok ? 'OK' : 'FAILED');
  return `${lines.join('\n')}\n`;
}

export async function runNormalize(
  options: NormalizeOptions,
  io: NormalizeIO,
): Promise<number> {
  try {
    const result = await normalizeProject(options);
    if (options.json === true) {
      io.stdout(stableJson(result));
    } else if (result.ok) {
      io.stdout(formatHuman(result));
    } else {
      io.stderr(formatHuman(result));
    }
    return result.exitCode;
  } catch (error) {
    if (error instanceof DabError) {
      if (options.json === true) {
        io.stdout(stableJson({ ok: false, error: error.toJSON() }));
      } else {
        io.stderr(`dab: ${error.message}\n`);
        if (error.hint !== undefined) {
          io.stderr(`${error.hint}\n`);
        }
      }
      return error.exitCode;
    }
    throw error;
  }
}
