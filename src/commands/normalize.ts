import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { runCommand, type CommandRunner } from '../core/command.ts';
import {
  dedupeDiagnostics,
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
import { previewClaudeAdoption } from '../adapter/claude-code/adoption.ts';
import { parseClaudeTargetOptions } from '../adapter/claude-code/options.ts';
import { discoverProjections } from '../adapter/claude-code/projection.ts';
import { checkClaudeCode } from '../adapter/claude-code/version.ts';
import { checkAgentHooks, checkHookSafety, checkSecrets } from '../detect/checks.ts';
import {
  applyNormalizeAdoption,
  planManagedSkillWrites,
  planSourceWrites,
  prepareNormalizeAdoption,
  summarizeManagedSkills,
  writeSourceFiles,
  type ManagedSkillSummary,
  type MinimalSourcePlan,
  type NormalizeAdoptionResult,
} from '../init/adoption.ts';
import type { DocsLanguageResolution } from '../init/docs-language.ts';
import { applyManagedSkillWrites } from '../init/managed-skills.ts';
import type { AuthoredScaffoldPlan } from '../init/practice.ts';
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
  /**
   * Internal: skip Claude import planning/application. `dab init` sets it so an
   * existing `.claude` tree is not imported as an init side effect.
   */
  suppressImports?: boolean;
  /**
   * Internal: skip managed authoring-skill planning/updates. `dab init` sets it
   * so init never updates an existing installed skill; only `dab normalize`
   * owns managed updates.
   */
  suppressManagedSkills?: boolean;
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

/** Practice artifacts (docs and authoring skills) handled by this normalization. */
export interface NormalizePracticesResult {
  profile: 'generic' | 'feature';
  mode: 'adoption' | 'converge';
  language: DocsLanguageResolution;
  /** Documentation files, never authoring skill files. */
  created: string[];
  skipped: string[];
  policySkipped: string[];
  /** Practice-owned directories, never core `.agents` directories. */
  directories: string[];
  skills: {
    /** Authoring skill files created this run (or planned by a dry run). */
    created: string[];
    /** Existing skill files and directories left untouched. */
    skipped: string[];
    /** Managed stale skills rewritten to the current template. */
    updated: string[];
    /** Managed legacy markers upgraded when the body matched the template. */
    migrated: string[];
    /** User-modified bodies preserved with a warning. */
    modified: string[];
    /** Newer or uncomparable installed versions preserved with a warning. */
    newer: string[];
    /** Legacy-marker bodies that differ from the template and were preserved. */
    legacy: string[];
    /** Skills without a managed marker, preserved with a warning. */
    unversioned: string[];
    /** Markers naming another skill, preserved with a warning. */
    markerMismatch: string[];
    /** Targets changed between planning and applying; preserved with a warning. */
    concurrent: string[];
  };
  diagnostics: Diagnostic[];
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
  /** Absent for global scope, which never owns project docs or authoring skills. */
  practices?: NormalizePracticesResult;
}

const PRACTICE_SKILL_PREFIX = '.agents/skills/';

function isDocsPracticePath(path: string): boolean {
  return path === 'docs' || path.startsWith('docs/');
}

function isAuthoringSkillPath(path: string): boolean {
  return path.startsWith(PRACTICE_SKILL_PREFIX)
    && path.slice(PRACTICE_SKILL_PREFIX.length).startsWith('dab-');
}

function isPracticeDirectory(path: string): boolean {
  return isDocsPracticePath(path) || isAuthoringSkillPath(path);
}

function policySkipDiagnostic(path: string): Diagnostic {
  return {
    code: 'practice.docs-bilingual-policy',
    severity: 'warning',
    message: `project bilingual rule skips single-language documentation: ${path}`,
    file: path,
    hint: 'Remove .agents/rules/docs-bilingual.md to let DAB scaffold single-language docs.',
  };
}

function policySkipWarnings(plan: AuthoredScaffoldPlan | undefined): Diagnostic[] {
  return (plan?.policySkipped ?? []).filter(isDocsPracticePath).map(policySkipDiagnostic);
}

function uniquePaths(...lists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const list of lists) {
    for (const path of list) {
      if (!seen.has(path)) {
        seen.add(path);
        result.push(path);
      }
    }
  }
  return result;
}

function buildPractices(
  plan: AuthoredScaffoldPlan,
  created: readonly string[],
  skipped: readonly string[],
  diagnostics: readonly Diagnostic[],
  managed: ManagedSkillSummary = summarizeManagedSkills(undefined),
): NormalizePracticesResult {
  const practiceCreated = created.filter(
    (path) => isDocsPracticePath(path) || isAuthoringSkillPath(path),
  );
  // `plan.skipped` is the planner's existing-path report; write-time skips add
  // only the files the planner planned but another writer created first.
  const practiceSkipped = [...new Set([
    ...plan.skipped.filter(
      (path) => isDocsPracticePath(path) || isAuthoringSkillPath(path),
    ),
    ...skipped.filter(
      (path) => isDocsPracticePath(path) || isAuthoringSkillPath(path),
    ),
  ])];
  return {
    profile: plan.profile,
    mode: plan.mode === 'converge' ? 'converge' : 'adoption',
    language: plan.docsLanguage,
    created: practiceCreated.filter((path) => !isAuthoringSkillPath(path)),
    skipped: practiceSkipped.filter((path) => !isAuthoringSkillPath(path)),
    policySkipped: plan.policySkipped.filter(isDocsPracticePath),
    directories: plan.directories.filter(isPracticeDirectory),
    skills: {
      // The authoring pack writes missing files; the managed writer only
      // creates a missing SKILL.md when the pack skipped an existing directory.
      created: uniquePaths(
        practiceCreated.filter(isAuthoringSkillPath),
        managed.created,
      ),
      skipped: uniquePaths(
        practiceSkipped.filter(isAuthoringSkillPath),
        managed.skipped,
      ),
      updated: managed.updated,
      migrated: managed.migrated,
      modified: managed.modified,
      newer: managed.newer,
      legacy: managed.legacy,
      unversioned: managed.unversioned,
      markerMismatch: managed.markerMismatch,
      concurrent: managed.concurrent,
    },
    diagnostics: [...diagnostics],
  };
}

function practiceExtras(
  scope: Scope,
  practices: NormalizePracticesResult | undefined,
): { practices?: NormalizePracticesResult } {
  return scope === 'project' && practices !== undefined ? { practices } : {};
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
    practices?: NormalizePracticesResult;
  } = {},
): NormalizeResult {
  const targets = extras.targets ?? [];
  const compat = extras.compatTargets ?? targets;
  const adoptionActions = extras.adoption === undefined
    ? []
    : [...extras.adoption.sourceActions, ...extras.adoption.importActions];
  return {
    ok: false,
    root,
    scope,
    dryRun: options.dryRun === true,
    exitCode: extras.exitCode ?? ExitCode.Validation,
    actions: [...adoptionActions, ...targets.flatMap((item) => item.actions)],
    targets,
    diagnostics: sortDiagnostics(dedupeDiagnostics(diagnostics)),
    settings: topLevelSettings(compat, false),
    shimAction: compatShimAction(compat),
    backups: [],
    gitignore: { changed: false, path: '' },
    manifestUpdated: false,
    ...(extras.adoption === undefined ? {} : { adoption: extras.adoption }),
    ...(extras.practices === undefined ? {} : { practices: extras.practices }),
  };
}

function adoptionExtras(
  adoption: NormalizeAdoptionResult | undefined,
): { adoption?: NormalizeAdoptionResult } {
  return adoption === undefined ? {} : { adoption };
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
    ...(options.suppressImports === true ? { suppressImports: true } : {}),
    ...(options.suppressManagedSkills === true ? { suppressManagedSkills: true } : {}),
  });
  const root = preparation.sourceRoot.root;
  const scope = preparation.sourceRoot.scope;
  const backupRoot = backupRootFor(root, options.now ?? new Date());
  const practicePlan = preparation.practicePlan;
  const sourceProblems = preparation.sourceProblems ?? [];
  const managedDiagnostics = preparation.managedSkills?.diagnostics ?? [];
  // The authoring pack creates missing skills it planned; the managed writer
  // owns existing stale/legacy files and missing SKILL.md under a user-owned
  // directory. Exactly one writer therefore plans each skill file.
  const managedWritePlan = preparation.managedSkills === undefined
    ? undefined
    : planManagedSkillWrites(
      preparation.managedSkills,
      new Set(Object.keys(practicePlan?.files ?? {})),
    );
  let managed = summarizeManagedSkills(managedWritePlan);
  const practiceWarnings = scope === 'project' ? policySkipWarnings(practicePlan) : [];
  const practiceDiagnostics = [
    ...(practicePlan?.diagnostics ?? []),
    ...managedDiagnostics,
    ...practiceWarnings,
    ...sourceProblems,
  ];
  const imports = preparation.claudePlan?.entries ?? [];
  const importDiagnostics = preparation.claudePlan?.diagnostics ?? [];
  const preparationDiagnostics = [
    ...preparation.diagnostics,
    ...importDiagnostics,
    ...practiceWarnings,
  ];
  const importPreview = preparation.claudePlan === undefined
    ? { actions: [], backups: [] }
    : previewClaudeAdoption(root, preparation.claudePlan, backupRoot);
  let practices: NormalizePracticesResult | undefined;
  let adoption: NormalizeAdoptionResult = {
    phase: preparation.phase,
    ...(preparation.sourcePlan === undefined ? {} : { sourcePlan: preparation.sourcePlan }),
    sourceActions: [],
    importActions: [],
    imports: [],
    backups: [],
    diagnostics: [...preparationDiagnostics],
  };

  if (preparation.phase !== 'initialized' && preparation.sourcePlan !== undefined) {
    const sourcePlan = preparation.sourcePlan;
    const practicesFor = (
      created: readonly string[],
      skipped: readonly string[],
      managedSummary: ManagedSkillSummary = managed,
    ): NormalizePracticesResult | undefined => practicePlan === undefined
      ? undefined
      : buildPractices(
        practicePlan,
        created,
        skipped,
        practiceDiagnostics,
        managedSummary,
      );

    // Any invalid import candidate gates the minimal source copy as well, so a
    // rejected plan writes neither `.agents` nor `.claude`. Planned practice
    // paths stay in the result even though nothing is written.
    if (hasErrors(preparationDiagnostics)) {
      const planned = await planSourceWrites(root, sourcePlan);
      practices = practicesFor(planned.create, planned.skip);
      return blockedResult(root, scope, options, preparationDiagnostics, {
        adoption,
        ...practiceExtras(scope, practices),
      });
    }
    const applied = await applyNormalizeAdoption(
      { ...preparation, claudePlan: undefined, managedSkills: managedWritePlan },
      { dryRun: options.dryRun === true, backupRoot },
    );
    // Apply-time managed warnings (a concurrent change) belong to the run and
    // the practice report, not only to the adoption step.
    preparationDiagnostics.push(...applied.diagnostics);
    practiceDiagnostics.push(...applied.diagnostics);
    adoption = {
      ...adoption,
      sourceActions: applied.actions,
      diagnostics: [...adoption.diagnostics, ...applied.diagnostics],
    };
    practices = practicesFor(applied.created, applied.skipped, applied.managed);
    if (hasErrors(applied.diagnostics)) {
      const planned = await planSourceWrites(root, sourcePlan);
      practices = practicesFor(planned.create, planned.skip);
      return blockedResult(
        root,
        scope,
        options,
        [...preparationDiagnostics, ...applied.diagnostics],
        { adoption, ...practiceExtras(scope, practices) },
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
        actions: [...applied.actions, ...importPreview.actions],
        targets: [],
        diagnostics: sortDiagnostics(dedupeDiagnostics(preparationDiagnostics)),
        settings: emptySettings(),
        shimAction: 'none',
        backups: importPreview.backups,
        gitignore: { changed: false, path: '' },
        manifestUpdated: false,
        adoption: {
          ...adoption,
          importActions: importPreview.actions,
          backups: importPreview.backups,
          imports,
        },
        ...practiceExtras(scope, practices),
      };
    }
  }

  // Converge plans practice writes before target planning so newly scaffolded
  // docs and skills are discovered and projected in the same run. A blocking
  // practice error returns before anything is written.
  let practiceSourcePlan: MinimalSourcePlan | undefined;
  if (preparation.phase === 'initialized' && practicePlan !== undefined) {
    if (hasErrors(practicePlan.diagnostics) || hasErrors(managedDiagnostics)) {
      practices = buildPractices(practicePlan, [], [], practiceDiagnostics, managed);
      return blockedResult(root, scope, options, preparationDiagnostics, {
        ...adoptionExtras(adoption),
        ...practiceExtras(scope, practices),
      });
    }
    practiceSourcePlan = {
      files: practicePlan.files,
      directories: practicePlan.directories,
      manifest: practicePlan.manifest ?? preparation.manifest,
    };
    const planned = await planSourceWrites(root, practiceSourcePlan);
    practices = buildPractices(
      practicePlan,
      planned.create,
      planned.skip,
      practiceDiagnostics,
      managed,
    );
  }

  // A broken non-practice source parent ( `.agents/agents`, `.agents/hooks`,
  // `.agents/memory`, `.agents/policies` or `.agents/adapters`) already made
  // preparation skip imports. Discovery would fail with an internal error, so
  // report the governed conflict and keep the planned practice fields unread.
  if (sourceProblems.length > 0) {
    practices = practicePlan === undefined
      ? undefined
      : buildPractices(practicePlan, [], [], practiceDiagnostics, managed);
    return blockedResult(root, scope, options, preparationDiagnostics, {
      ...adoptionExtras(adoption),
      ...practiceExtras(scope, practices),
    });
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
      return blockedResult(root, scope, options, [errorDiagnostic(error)], {
        ...adoptionExtras(adoption),
        ...practiceExtras(scope, practices),
      });
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
        ...practiceExtras(scope, practices),
      });
    }
  }

  // Errors already known before target planning (invalid imports, scan or
  // planner errors) and a manifest without an enabled target must not scaffold
  // practice files. Skip the writes now; the blocked result is returned after
  // the read-only source/projection diagnostics below so those still surface.
  const blockedBeforePlanning = hasErrors(preparationDiagnostics)
    || enabledTargets.length === 0;

  // Practice writes run after the source-tree safety gate but before target
  // planning, so the new files become projections of this same normalization.
  // Managed skill writes share this phase; a dry run reports the same plan
  // without touching bytes.
  if (practiceSourcePlan !== undefined && practicePlan !== undefined
    && !blockedBeforePlanning) {
    if (options.dryRun !== true) {
      const written = await writeSourceFiles(root, practiceSourcePlan);
      if (managedWritePlan !== undefined) {
        const appliedManaged = await applyManagedSkillWrites(
          root,
          managedWritePlan,
          { dryRun: false },
        );
        // Revalidation can turn a planned write into a preserved file, so the
        // report is rebuilt from the apply outcome rather than the plan.
        managed = summarizeManagedSkills(managedWritePlan, appliedManaged);
        practiceDiagnostics.push(...appliedManaged.diagnostics);
        diagnostics.push(...appliedManaged.diagnostics);
      }
      practices = buildPractices(
        practicePlan,
        written.created,
        written.skipped,
        practiceDiagnostics,
        managed,
      );
    }
    if (managed.actions.length > 0) {
      adoption = {
        ...adoption,
        sourceActions: [...adoption.sourceActions, ...managed.actions],
      };
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
    return blockedResult(root, scope, options, diagnostics, {
      ...adoptionExtras(adoption),
      ...practiceExtras(scope, practices),
    });
  }

  // Known preparation errors block before target planning and before any
  // import/target apply; practice writes were already skipped above.
  if (hasErrors(preparationDiagnostics)) {
    return blockedResult(root, scope, options, diagnostics, {
      ...adoptionExtras(adoption),
      ...practiceExtras(scope, practices),
    });
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
      // The import step owns these targets and replaces them after the
      // preflight, so the adapter must not plan competing backup actions.
      importedTargets: imports.map((entry) => entry.source),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    diagnostics.push(...plan.diagnostics);
    plans.push(plan);
  }

  if (hasErrors(diagnostics)) {
    const backendError = diagnostics.some(
      (item) => item.code === 'backend.version' && item.severity === 'error',
    );
    return blockedResult(root, scope, options, diagnostics, {
      compatTargets: plans.map((plan) => targetResult(plan)),
      ...(backendError ? { exitCode: ExitCode.Backend } : {}),
      ...adoptionExtras(adoption),
      ...practiceExtras(scope, practices),
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
      actions: [
        ...adoption.sourceActions,
        ...importPreview.actions,
        ...targets.flatMap((item) => item.actions),
      ],
      targets,
      diagnostics: sortDiagnostics(diagnostics),
      settings: topLevelSettings(targets),
      shimAction: compatShimAction(targets),
      backups: importPreview.backups,
      gitignore: {
        changed: false,
        path: paths.scope === 'global' ? '' : '.gitignore',
      },
      manifestUpdated: false,
      ...adoptionExtras({
        ...adoption,
        importActions: importPreview.actions,
        backups: importPreview.backups,
        imports,
      }),
      ...practiceExtras(scope, practices),
    };
  }

  // Imports replace physical `.claude` entries with per-entry symlinks only
  // after every plan is clean; `.claude` stays untouched on earlier failures.
  if (preparation.claudePlan !== undefined) {
    const imported = await applyNormalizeAdoption(
      { ...preparation, sourcePlan: undefined, managedSkills: undefined },
      { dryRun: false, backupRoot },
    );
    // Apply returns absolute paths; NormalizeResult paths are root-relative.
    const importedBackups = imported.backups.map(
      (backup) => toPosix(relative(root, resolve(root, backup))),
    );
    if (hasErrors(imported.diagnostics)) {
      // Apply does not report per-entry success, so a failed run claims no
      // imports; actions, backups and diagnostics still describe what happened.
      adoption = {
        ...adoption,
        imports: [],
        importActions: imported.actions,
        backups: [...adoption.backups, ...importedBackups],
        diagnostics: [...adoption.diagnostics, ...imported.diagnostics],
      };
      return blockedResult(
        root,
        scope,
        options,
        [...diagnostics, ...imported.diagnostics],
        { adoption, ...practiceExtras(scope, practices) },
      );
    }
    adoption = {
      ...adoption,
      imports,
      importActions: imported.actions,
      backups: [...adoption.backups, ...importedBackups],
      diagnostics: [...adoption.diagnostics, ...imported.diagnostics],
    };
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
    actions: [
      ...adoption.sourceActions,
      ...adoption.importActions,
      ...targets.flatMap((item) => item.actions),
    ],
    targets,
    diagnostics: sortDiagnostics(dedupeDiagnostics(diagnostics)),
    settings: topLevelSettings(targets),
    shimAction: compatShimAction(targets),
    backups: claudeTargetResult(targets)?.backups ?? [],
    gitignore: {
      changed: gitignore.changed,
      path: gitignore.path === '' ? '' : toPosix(relative(root, gitignore.path)),
    },
    manifestUpdated,
    ...adoptionExtras(adoption),
    ...practiceExtras(scope, practices),
  };
}

function formatHuman(result: NormalizeResult): string {
  const lines: string[] = [];
  lines.push(`dab normalize${result.dryRun ? ' (dry run)' : ''}`);
  if (result.practices !== undefined) {
    lines.push(
      `Language: ${result.practices.language.value} (source: ${result.practices.language.source})`,
    );
  }
  for (const action of result.actions) {
    lines.push(`  ${action}`);
  }
  if (result.practices?.mode === 'converge') {
    // Adoption already reports these paths through its source actions. A skill
    // the managed writer created (an existing directory without SKILL.md) is
    // already in the action list as `create skill`, so do not print it twice.
    const skills = result.practices.skills;
    const actions = new Set(result.actions);
    for (const file of result.practices.created) {
      lines.push(`  create ${file}`);
    }
    for (const file of skills.created) {
      if (!actions.has(`create skill ${file}`)) {
        lines.push(`  create ${file}`);
      }
    }
    for (const file of result.practices.skipped) {
      lines.push(`  skip ${file}`);
    }
    // A managed skill file is current (the directory skip already reports it)
    // or has its own `skip skill ... (...)` action, so a plain file skip is
    // always redundant. A directory skip is misleading when the managed writer
    // created, updated or migrated its child.
    const writtenDirectories = new Set(
      [...skills.created, ...skills.updated, ...skills.migrated].flatMap((file) => {
        const index = file.lastIndexOf('/');
        return index === -1 ? [] : [file.slice(0, index)];
      }),
    );
    for (const file of skills.skipped) {
      if (file.endsWith('/SKILL.md') || writtenDirectories.has(file)) {
        continue;
      }
      lines.push(`  skip ${file}`);
    }
  }
  lines.push(`  settings ${result.settings.changed ? 'changed' : 'unchanged'}: ${result.settings.path}`);
  lines.push(`  shim ${result.shimAction}`);
  lines.push(`  manifest ${result.manifestUpdated ? 'updated' : 'unchanged'}`);
  lines.push(`  .gitignore ${result.gitignore.changed ? 'updated' : 'unchanged'}`);
  const backups = [...new Set([
    ...(result.adoption?.backups ?? []),
    ...result.backups,
  ])];
  if (backups.length > 0) {
    lines.push(`  ${result.dryRun ? 'planned ' : ''}backups: ${backups.length}`);
    for (const backup of backups) {
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
