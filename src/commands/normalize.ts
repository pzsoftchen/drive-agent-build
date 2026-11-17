import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import type { CommandRunner } from '../core/command.ts';
import {
  formatDiagnostics,
  hasErrors,
  sortDiagnostics,
  type Diagnostic,
} from '../core/diagnostics.ts';
import { ConfigError, DabError, ValidationError } from '../core/errors.ts';
import { ExitCode } from '../core/exit-codes.ts';
import { lstatOrNull } from '../core/fs-atomic.ts';
import { DAB_GITIGNORE_ENTRIES, ensureGitignoreBlock } from '../core/gitignore.ts';
import { stableJson } from '../core/json.ts';
import {
  assertRealPathInsideRoot,
  assertRealPathsDisjoint,
  isPathInside,
  realPathNearest,
  toPosix,
} from '../core/paths.ts';
import { claudeCodeAdapter } from '../adapter/claude-code/adapter.ts';
import { parseClaudeTargetOptions } from '../adapter/claude-code/options.ts';
import {
  discoverProjections,
  type ClaudeMdPlan,
  type ProjectionAction,
} from '../adapter/claude-code/projection.ts';
import { checkClaudeCode } from '../adapter/claude-code/version.ts';
import { checkAgentHookIds, checkHookSafety, checkSecrets } from '../detect/checks.ts';
import { checkAgentsMd } from '../model/agents-md.ts';
import { discoverSourceFacts } from '../model/facts.ts';
import {
  getGeneratedTarget,
  getTarget,
  loadProjectManifest,
  resolveProjectPaths,
  updateGeneratedManifest,
} from '../model/project-manifest.ts';
import { resolveSourceRoot } from '../model/scope.ts';
import type {
  GeneratedManifest,
  GeneratedTarget,
  Projection,
} from '../model/types.ts';

export interface NormalizeOptions {
  cwd: string;
  home?: string;
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

function backupRootFor(root: string, now: Date): string {
  const stamp = now.toISOString().replaceAll(':', '-').replaceAll('.', '-');
  return join(root, '.dab', 'backups', stamp);
}

const SHIM_ACTIONS = new Set<ClaudeMdPlan['action']>([
  'none',
  'create',
  'repair',
  'remove',
  'backup-and-repair',
  'backup-and-remove',
]);

function shimActionOf(action: string | undefined): ClaudeMdPlan['action'] {
  if (action === undefined) {
    return 'none';
  }
  if (!SHIM_ACTIONS.has(action as ClaudeMdPlan['action'])) {
    throw new Error(`unexpected instruction action: ${action}`);
  }
  return action as ClaudeMdPlan['action'];
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
  generated: GeneratedTarget | undefined,
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

  const home = options.home ?? homedir();
  const sourceRoot = await resolveSourceRoot({ cwd: resolve(options.cwd), home });
  const root = sourceRoot.root;
  const loaded = await loadProjectManifest(root, { scope: sourceRoot.scope });
  const paths = resolveProjectPaths(root, loaded.manifest);
  const claudeTarget = getTarget(loaded.manifest, 'claude-code');
  if (claudeTarget === undefined) {
    throw new ConfigError('manifest has no claude-code target', 'target.claude-missing');
  }
  const claudeOptions = parseClaudeTargetOptions(claudeTarget);
  const diagnostics: Diagnostic[] = [];

  try {
    await assertSourceTreesSafe(root);
  } catch (error) {
    if (error instanceof DabError) {
      return blockedResult(options, [errorDiagnostic(error)]);
    }
    throw error;
  }

  // Runtime incompatibility takes precedence over authored-source validation, as
  // it did before the adapter seam. The adapter still checks for direct callers.
  const runtime = await checkClaudeCode(claudeOptions.minVersion, options.runner);
  if (runtime.diagnostics.some(
    (item) => item.code === 'backend.version' && item.severity === 'error',
  )) {
    return blockedResult(options, runtime.diagnostics, { exitCode: ExitCode.Backend });
  }

  const facts = await discoverSourceFacts(root, paths);
  diagnostics.push(
    ...facts.agents.diagnostics,
    ...facts.skills.diagnostics,
    ...facts.rules.diagnostics,
    ...facts.hooks.diagnostics,
  );
  diagnostics.push(...checkAgentHookIds(facts.agents.items, facts.hooks.items));
  diagnostics.push(...await checkHookSafety(facts.hooks.items));
  diagnostics.push(...await checkSecrets(root, paths));

  const discovered = await discoverProjections(root, paths, {
    agents: facts.agents.items,
    skills: facts.skills.items,
    rules: facts.rules.items,
  });
  diagnostics.push(...discovered.diagnostics);
  diagnostics.push(...await projectionOverlapDiagnostics(
    root,
    discovered.projections,
    getGeneratedTarget(loaded.manifest, 'claude-code'),
  ));

  const agentsMd = await checkAgentsMd(root, paths.instructions);
  diagnostics.push(...agentsMd.diagnostics);

  if (hasErrors(diagnostics)) {
    return blockedResult(options, diagnostics);
  }

  const plan = await claudeCodeAdapter.normalize({
    paths,
    manifest: loaded.manifest,
    target: claudeTarget,
    facts,
    fix: options.fix === true,
    dryRun: options.dryRun === true,
    ...(options.runner === undefined ? {} : { runner: options.runner }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  diagnostics.push(...plan.diagnostics);

  const settingsResult = plan.settings ?? {
    path: '.claude/settings.json',
    sha256: '',
    changed: false,
  };
  const shimAction = shimActionOf(plan.instructions?.action);

  if (hasErrors(diagnostics)) {
    const backendError = diagnostics.some(
      (item) => item.code === 'backend.version' && item.severity === 'error',
    );
    return blockedResult(options, diagnostics, {
      actions: plan.projectionActions,
      shimAction,
      settings: { ...settingsResult, changed: false },
      ...(backendError ? { exitCode: ExitCode.Backend } : {}),
    });
  }

  if (options.dryRun === true) {
    return {
      ok: true,
      dryRun: true,
      exitCode: ExitCode.Ok,
      actions: plan.projectionActions,
      diagnostics: sortDiagnostics(diagnostics),
      settings: settingsResult,
      shimAction,
      backups: [],
      gitignore: { changed: false, path: join(root, '.gitignore') },
      manifestUpdated: false,
    };
  }

  const backupRoot = backupRootFor(root, options.now ?? new Date());
  const applied = await plan.apply({ backupRoot });

  const generated: GeneratedManifest = { targets: [plan.generated] };
  const manifestUpdated = loaded.legacy
    || stableJson(loaded.manifest.generated ?? null) !== stableJson(generated);
  if (manifestUpdated) {
    await updateGeneratedManifest(root, generated, { scope: sourceRoot.scope });
  }

  const gitignore = await ensureGitignoreBlock(root, DAB_GITIGNORE_ENTRIES);

  return {
    ok: true,
    dryRun: false,
    exitCode: ExitCode.Ok,
    actions: plan.projectionActions,
    diagnostics: sortDiagnostics(dedupeDiagnostics(diagnostics)),
    settings: settingsResult,
    shimAction,
    backups: applied.backups,
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
