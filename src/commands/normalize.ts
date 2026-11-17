import { homedir } from 'node:os';
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
import { getTargetAdapter } from '../adapter/registry.ts';
import type {
  TargetInstructionsPlan,
  TargetNormalizePlan,
  TargetSettingsPlan,
} from '../adapter/types.ts';
import { parseClaudeTargetOptions } from '../adapter/claude-code/options.ts';
import { discoverProjections } from '../adapter/claude-code/projection.ts';
import { checkClaudeCode } from '../adapter/claude-code/version.ts';
import { checkAgentHookIds, checkHookSafety, checkSecrets } from '../detect/checks.ts';
import { checkAgentsMd } from '../model/agents-md.ts';
import { discoverSourceFacts } from '../model/facts.ts';
import {
  getEnabledTargets,
  getGeneratedTarget,
  loadProjectManifest,
  resolveProjectPaths,
  updateGeneratedManifest,
} from '../model/project-manifest.ts';
import { resolveSourceRoot } from '../model/scope.ts';
import type {
  GeneratedManifest,
  GeneratedTarget,
  Projection,
  TargetProvider,
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

export interface TargetNormalizeResult {
  provider: TargetProvider;
  actions: string[];
  settings?: TargetSettingsPlan;
  instructions?: TargetInstructionsPlan;
  backups: string[];
}

export interface NormalizeResult {
  ok: boolean;
  dryRun: boolean;
  exitCode: ExitCode;
  actions: string[];
  targets: TargetNormalizeResult[];
  diagnostics: Diagnostic[];
  settings: {
    path: string;
    sha256: string;
    changed: boolean;
  };
  shimAction: string;
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

function emptySettings(): NormalizeResult['settings'] {
  return {
    path: '.claude/settings.json',
    sha256: '',
    changed: false,
  };
}

function targetResult(
  plan: TargetNormalizePlan,
  backups: readonly string[] = [],
): TargetNormalizeResult {
  return {
    provider: plan.provider,
    actions: plan.actions,
    ...(plan.settings === undefined ? {} : { settings: plan.settings }),
    ...(plan.instructions === undefined ? {} : { instructions: plan.instructions }),
    backups: [...backups],
  };
}

function claudeTargetResult(
  targets: readonly TargetNormalizeResult[],
): TargetNormalizeResult | undefined {
  return targets.find((item) => item.provider === 'claude-code');
}

function topLevelSettings(
  targets: readonly TargetNormalizeResult[],
  changed?: boolean,
): NormalizeResult['settings'] {
  const settings = claudeTargetResult(targets)?.settings;
  if (settings === undefined) {
    return emptySettings();
  }
  return changed === undefined ? { ...settings } : { ...settings, changed };
}

function compatShimAction(targets: readonly TargetNormalizeResult[]): string {
  return claudeTargetResult(targets)?.instructions?.action ?? 'none';
}

function blockedResult(
  options: NormalizeOptions,
  diagnostics: Diagnostic[],
  extras: {
    targets?: TargetNormalizeResult[];
    compatTargets?: readonly TargetNormalizeResult[];
    exitCode?: ExitCode;
  } = {},
): NormalizeResult {
  const targets = extras.targets ?? [];
  const compat = extras.compatTargets ?? targets;
  return {
    ok: false,
    dryRun: options.dryRun === true,
    exitCode: extras.exitCode ?? ExitCode.Validation,
    actions: targets.flatMap((item) => item.actions),
    targets,
    diagnostics: sortDiagnostics(dedupeDiagnostics(diagnostics)),
    settings: topLevelSettings(compat, false),
    shimAction: compatShimAction(compat),
    backups: [],
    gitignore: { changed: false, path: '' },
    manifestUpdated: false,
  };
}

function backupRootFor(root: string, now: Date): string {
  const stamp = now.toISOString().replaceAll(':', '-').replaceAll('.', '-');
  return join(root, '.dab', 'backups', stamp);
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
  const enabledTargets = getEnabledTargets(loaded.manifest);
  const claudeTarget = enabledTargets.find((target) => target.provider === 'claude-code');
  // Parse before source safety so malformed Claude options still fail loudly for
  // direct callers, matching the pre-adapter behavior.
  const claudeOptions = claudeTarget === undefined
    ? undefined
    : parseClaudeTargetOptions(claudeTarget);
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
  if (claudeOptions !== undefined) {
    const runtime = await checkClaudeCode(claudeOptions.minVersion, options.runner);
    if (runtime.diagnostics.some(
      (item) => item.code === 'backend.version' && item.severity === 'error',
    )) {
      return blockedResult(options, runtime.diagnostics, { exitCode: ExitCode.Backend });
    }
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

  if (claudeTarget !== undefined) {
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
  }

  const agentsMd = await checkAgentsMd(root, paths.instructions);
  diagnostics.push(...agentsMd.diagnostics);

  if (enabledTargets.length === 0) {
    diagnostics.push({
      code: 'target.none',
      severity: 'error',
      file: 'dab.yaml',
      message: 'manifest has no enabled targets',
      hint: 'Enable at least one target or omit it from the manifest.',
    });
    return blockedResult(options, diagnostics);
  }

  const plans: TargetNormalizePlan[] = [];
  for (const target of enabledTargets) {
    const adapter = getTargetAdapter(target.provider);
    if (adapter === undefined) {
      diagnostics.push({
        code: 'target.unsupported',
        severity: 'error',
        file: 'dab.yaml',
        message: `no adapter is available for target ${target.provider}`,
        hint: 'Remove or disable the target until its adapter is implemented.',
      });
      continue;
    }
    const plan = await adapter.normalize({
      paths,
      manifest: loaded.manifest,
      target,
      facts,
      fix: options.fix === true,
      dryRun: options.dryRun === true,
      ...(options.runner === undefined ? {} : { runner: options.runner }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    diagnostics.push(...plan.diagnostics);
    plans.push(plan);
  }

  if (hasErrors(diagnostics)) {
    const backendError = diagnostics.some(
      (item) => item.code === 'backend.version' && item.severity === 'error',
    );
    return blockedResult(options, diagnostics, {
      compatTargets: plans.map((plan) => targetResult(plan)),
      ...(backendError ? { exitCode: ExitCode.Backend } : {}),
    });
  }

  if (options.dryRun === true) {
    const targets = plans.map((plan) => targetResult(plan));
    return {
      ok: true,
      dryRun: true,
      exitCode: ExitCode.Ok,
      actions: targets.flatMap((item) => item.actions),
      targets,
      diagnostics: sortDiagnostics(diagnostics),
      settings: topLevelSettings(targets),
      shimAction: compatShimAction(targets),
      backups: [],
      gitignore: { changed: false, path: join(root, '.gitignore') },
      manifestUpdated: false,
    };
  }

  const backupRoot = backupRootFor(root, options.now ?? new Date());
  const targets: TargetNormalizeResult[] = [];
  for (const plan of plans) {
    const applied = await plan.apply({ backupRoot });
    targets.push(targetResult(plan, applied.backups));
  }

  const generated: GeneratedManifest = {
    targets: plans.map((plan) => plan.generated),
  };
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
    actions: targets.flatMap((item) => item.actions),
    targets,
    diagnostics: sortDiagnostics(dedupeDiagnostics(diagnostics)),
    settings: topLevelSettings(targets),
    shimAction: compatShimAction(targets),
    backups: claudeTargetResult(targets)?.backups ?? [],
    gitignore,
    manifestUpdated,
  };
}

function formatHuman(result: NormalizeResult): string {
  const lines: string[] = [];
  lines.push(`dab normalize${result.dryRun ? ' (dry run)' : ''}`);
  for (const action of result.actions) {
    lines.push(`  ${action}`);
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
