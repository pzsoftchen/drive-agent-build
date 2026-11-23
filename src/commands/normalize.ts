import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { runCommand, type CommandRunner } from '../core/command.ts';
import {
  formatDiagnostics,
  hasErrors,
  sortDiagnostics,
  type Diagnostic,
} from '../core/diagnostics.ts';
import { DabError } from '../core/errors.ts';
import { ExitCode } from '../core/exit-codes.ts';
import { lstatOrNull } from '../core/fs-atomic.ts';
import { DAB_GITIGNORE_ENTRIES, ensureGitignoreBlock } from '../core/gitignore.ts';
import { contractJson, stableJson } from '../core/json.ts';
import {
  assertRealPathInsideRoot,
  assertRealPathsDisjoint,
  isPathInside,
  realPathNearest,
  toPosix,
} from '../core/paths.ts';
import { assertSupportedPlatform } from '../core/platform.ts';
import { getTargetAdapter } from '../adapter/registry.ts';
import type {
  TargetInstructionsPlan,
  TargetNormalizePlan,
  TargetSettingsPlan,
} from '../adapter/types.ts';
import type { ClaudeAdoptionEntry } from '../adapter/claude-code/adoption.ts';
import { parseClaudeTargetOptions } from '../adapter/claude-code/options.ts';
import { discoverProjections } from '../adapter/claude-code/projection.ts';
import { checkClaudeCode } from '../adapter/claude-code/version.ts';
import { checkAgentHooks, checkHookSafety, checkSecrets } from '../detect/checks.ts';
import {
  applyNormalizeAdoption,
  prepareNormalizeAdoption,
  type NormalizeAdoptionResult,
} from '../init/adoption.ts';
import { checkAgentsMd } from '../model/agents-md.ts';
import { discoverSourceFacts } from '../model/facts.ts';
import {
  getEnabledTargets,
  getGeneratedTarget,
  loadProjectManifest,
  resolveProjectPaths,
  updateGeneratedManifest,
} from '../model/project-manifest.ts';
import type { Scope } from '../model/scope.ts';
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

/**
 * Paths in this result are relative to `root`. `root` is absolute so consumers
 * can resolve them without guessing which directory the command walked up from.
 */
export interface NormalizeResult {
  ok: boolean;
  root: string;
  scope: Scope;
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
  adoption?: NormalizeAdoptionResult;
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
  root?: string,
): TargetNormalizeResult {
  return {
    provider: plan.provider,
    actions: plan.actions,
    ...(plan.settings === undefined ? {} : { settings: plan.settings }),
    ...(plan.instructions === undefined ? {} : { instructions: plan.instructions }),
    backups: root === undefined
      ? [...backups]
      : backups.map((backup) => toPosix(relative(root, resolve(root, backup)))),
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
  root: string,
  scope: Scope,
  options: NormalizeOptions,
  diagnostics: Diagnostic[],
  extras: {
    targets?: TargetNormalizeResult[];
    compatTargets?: readonly TargetNormalizeResult[];
    exitCode?: ExitCode;
    adoption?: NormalizeAdoptionResult;
  } = {},
): NormalizeResult {
  const targets = extras.targets ?? [];
  const compat = extras.compatTargets ?? targets;
  return {
    ok: false,
    root,
    scope,
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
    ...(extras.adoption === undefined ? {} : { adoption: extras.adoption }),
  };
}

function adoptionExtras(
  adoption: NormalizeAdoptionResult | undefined,
): { adoption?: NormalizeAdoptionResult } {
  return adoption === undefined ? {} : { adoption };
}

/**
 * A physical `.claude/agents/<name>.md` or `.claude/skills/<name>` that the
 * import plan replaces with a symlink is not a normalized projection conflict:
 * the import resolves it. Every other projection conflict still blocks.
 */
function withoutImportResolvedConflicts(
  diagnostics: readonly Diagnostic[],
  imports: readonly ClaudeAdoptionEntry[],
): Diagnostic[] {
  if (imports.length === 0) {
    return [...diagnostics];
  }
  const sources = new Set(imports.map((entry) => entry.source));
  return diagnostics.filter(
    (item) => item.code !== 'projection.physical-copy'
      || item.file === undefined
      || !sources.has(item.file),
  );
}

function backupRootFor(root: string, now: Date): string {
  const stamp = now.toISOString().replaceAll(':', '-').replaceAll('.', '-');
  return join(root, '.dab', 'backups', stamp);
}

/**
 * The command layer checks the runtime before source validation and the target
 * adapter checks again for direct callers. Cache the version command so both
 * checks observe one `claude --version` invocation.
 */
function memoizeClaudeVersion(runner: CommandRunner = runCommand): CommandRunner {
  let cached: ReturnType<CommandRunner> | undefined;
  return (cmd, args, opts) => {
    if (cmd === 'claude' && args.length === 1 && args[0] === '--version') {
      // Resolve inside a promise so a synchronous throw is cached too.
      cached ??= Promise.resolve().then(() => runner(cmd, args, opts));
      return cached;
    }
    return runner(cmd, args, opts);
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
  assertSupportedPlatform(options.platform);

  const runner = memoizeClaudeVersion(options.runner);
  const home = resolve(options.home ?? homedir());
  const cwd = resolve(options.cwd);
  // Adoption runs before source-root resolution: an uninitialized scope has no
  // manifest for resolveSourceRoot to anchor on.
  const preparation = await prepareNormalizeAdoption({
    cwd,
    home,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const root = preparation.sourceRoot.root;
  const scope = preparation.sourceRoot.scope;
  const backupRoot = backupRootFor(root, options.now ?? new Date());
  const imports = preparation.claudePlan?.entries ?? [];
  const importDiagnostics = preparation.claudePlan?.diagnostics ?? [];
  const preparationDiagnostics = [...preparation.diagnostics, ...importDiagnostics];
  let adoption: NormalizeAdoptionResult = {
    phase: preparation.phase,
    ...(preparation.sourcePlan === undefined ? {} : { sourcePlan: preparation.sourcePlan }),
    sourceActions: [],
    imports: [],
    backups: [],
    diagnostics: [...preparationDiagnostics],
  };

  if (preparation.phase !== 'initialized' && preparation.sourcePlan !== undefined) {
    // Any invalid import candidate gates the minimal source copy as well, so a
    // rejected plan writes neither `.agents` nor `.claude`.
    if (hasErrors(preparationDiagnostics)) {
      return blockedResult(root, scope, options, preparationDiagnostics, { adoption });
    }
    const applied = await applyNormalizeAdoption(
      { ...preparation, claudePlan: undefined },
      { dryRun: options.dryRun === true, backupRoot },
    );
    adoption = {
      ...adoption,
      sourceActions: applied.actions,
      diagnostics: [...adoption.diagnostics, ...applied.diagnostics],
    };
    if (hasErrors(applied.diagnostics)) {
      return blockedResult(
        root,
        scope,
        options,
        [...preparationDiagnostics, ...applied.diagnostics],
        { adoption },
      );
    }
    if (options.dryRun === true) {
      // The target plan needs the written source tree, so an adoption dry run
      // previews the source and import plan and leaves the target plan out.
      return {
        ok: true,
        root,
        scope,
        dryRun: true,
        exitCode: ExitCode.Ok,
        actions: applied.actions,
        targets: [],
        diagnostics: sortDiagnostics(dedupeDiagnostics(preparationDiagnostics)),
        settings: emptySettings(),
        shimAction: 'none',
        backups: [],
        gitignore: { changed: false, path: '' },
        manifestUpdated: false,
        adoption: { ...adoption, imports },
      };
    }
  }

  const loaded = await loadProjectManifest(root, { scope });
  const paths = resolveProjectPaths(root, loaded.manifest);
  const enabledTargets = getEnabledTargets(loaded.manifest);
  const claudeTarget = enabledTargets.find((target) => target.provider === 'claude-code');
  // Parse before source safety so malformed Claude options still fail loudly for
  // direct callers, matching the pre-adapter behavior.
  const claudeOptions = claudeTarget === undefined
    ? undefined
    : parseClaudeTargetOptions(claudeTarget);
  const diagnostics: Diagnostic[] = [...preparationDiagnostics];

  try {
    await assertSourceTreesSafe(root);
  } catch (error) {
    if (error instanceof DabError) {
      return blockedResult(root, scope, options, [errorDiagnostic(error)], adoptionExtras(adoption));
    }
    throw error;
  }

  // Runtime incompatibility takes precedence over authored-source validation, as
  // it did before the adapter seam. The adapter still checks for direct callers.
  if (claudeOptions !== undefined) {
    const runtime = await checkClaudeCode(claudeOptions.minVersion, runner);
    if (runtime.diagnostics.some(
      (item) => item.code === 'backend.version' && item.severity === 'error',
    )) {
      return blockedResult(root, scope, options, runtime.diagnostics, {
        exitCode: ExitCode.Backend,
        ...adoptionExtras(adoption),
      });
    }
  }

  const facts = await discoverSourceFacts(root, paths);
  diagnostics.push(
    ...facts.agents.diagnostics,
    ...facts.skills.diagnostics,
    ...facts.rules.diagnostics,
    ...facts.hooks.diagnostics,
  );
  diagnostics.push(...checkAgentHooks(facts.agents.items, facts.hooks.items));
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
    return blockedResult(root, scope, options, diagnostics, adoptionExtras(adoption));
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
      runner,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    diagnostics.push(...plan.diagnostics);
    plans.push(plan);
  }

  // Import targets that the plan replaces with a symlink are not conflicts; a
  // blocked run still reports every diagnostic it found.
  const blockingDiagnostics = withoutImportResolvedConflicts(diagnostics, imports);
  if (hasErrors(blockingDiagnostics)) {
    const backendError = blockingDiagnostics.some(
      (item) => item.code === 'backend.version' && item.severity === 'error',
    );
    return blockedResult(root, scope, options, diagnostics, {
      compatTargets: plans.map((plan) => targetResult(plan)),
      ...(backendError ? { exitCode: ExitCode.Backend } : {}),
      ...adoptionExtras(adoption),
    });
  }

  if (options.dryRun === true) {
    const targets = plans.map((plan) => targetResult(plan));
    return {
      ok: true,
      root,
      scope,
      dryRun: true,
      exitCode: ExitCode.Ok,
      actions: targets.flatMap((item) => item.actions),
      targets,
      diagnostics: sortDiagnostics(blockingDiagnostics),
      settings: topLevelSettings(targets),
      shimAction: compatShimAction(targets),
      backups: [],
      gitignore: {
        changed: false,
        path: paths.scope === 'global' ? '' : '.gitignore',
      },
      manifestUpdated: false,
      ...adoptionExtras({ ...adoption, imports }),
    };
  }

  // Imports replace physical `.claude` entries with per-entry symlinks only
  // after every plan is clean; `.claude` stays untouched on earlier failures.
  if (preparation.claudePlan !== undefined) {
    const imported = await applyNormalizeAdoption(
      { ...preparation, sourcePlan: undefined },
      { dryRun: false, backupRoot },
    );
    adoption = {
      ...adoption,
      imports,
      // Apply returns absolute paths; NormalizeResult paths are root-relative.
      backups: [
        ...adoption.backups,
        ...imported.backups.map((backup) => toPosix(relative(root, resolve(root, backup)))),
      ],
      diagnostics: [...adoption.diagnostics, ...imported.diagnostics],
    };
    if (hasErrors(imported.diagnostics)) {
      return blockedResult(
        root,
        scope,
        options,
        [...blockingDiagnostics, ...imported.diagnostics],
        { adoption },
      );
    }
  }

  const targets: TargetNormalizeResult[] = [];
  for (const plan of plans) {
    const applied = await plan.apply({ backupRoot });
    targets.push(targetResult(plan, applied.backups, root));
  }

  const generated: GeneratedManifest = {
    targets: plans.map((plan) => plan.generated),
  };
  const manifestUpdated = loaded.legacy
    || stableJson(loaded.manifest.generated ?? null) !== stableJson(generated);
  if (manifestUpdated) {
    await updateGeneratedManifest(root, generated, { scope });
  }

  // $HOME/.gitignore is user-owned; global scope never manages it.
  const gitignore = paths.scope === 'global'
    ? { changed: false, path: '' }
    : await ensureGitignoreBlock(root, DAB_GITIGNORE_ENTRIES);

  return {
    ok: true,
    root,
    scope,
    dryRun: false,
    exitCode: ExitCode.Ok,
    actions: targets.flatMap((item) => item.actions),
    targets,
    diagnostics: sortDiagnostics(dedupeDiagnostics(blockingDiagnostics)),
    settings: topLevelSettings(targets),
    shimAction: compatShimAction(targets),
    backups: claudeTargetResult(targets)?.backups ?? [],
    gitignore: {
      changed: gitignore.changed,
      path: gitignore.path === '' ? '' : toPosix(relative(root, gitignore.path)),
    },
    manifestUpdated,
    ...adoptionExtras(adoption),
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
      lines.push(`    ${toPosix(relative(process.cwd(), resolve(result.root, backup)))}`);
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
      io.stdout(contractJson(result));
    } else if (result.ok) {
      io.stdout(formatHuman(result));
    } else {
      io.stderr(formatHuman(result));
    }
    return result.exitCode;
  } catch (error) {
    if (error instanceof DabError) {
      if (options.json === true) {
        io.stdout(contractJson({ ok: false, error: error.toJSON() }));
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
