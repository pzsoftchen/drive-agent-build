import { readlink, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import {
  dedupeDiagnostics,
  hasErrors,
  type Diagnostic,
} from '../core/diagnostics.ts';
import { ConfigError, DabError } from '../core/errors.ts';
import { ensureDir, lstatOrNull, writeFileIfAbsent } from '../core/fs-atomic.ts';
import {
  assertParentInsideRoot,
  assertRealPathInsideRoot,
  assertRealPathsDisjoint,
  isPathInside,
  toPosix,
} from '../core/paths.ts';
import { DAB_VERSION } from '../core/version.ts';
import {
  applyClaudeAdoption,
  planClaudeAdoption,
  type ClaudeAdoptionEntry,
  type ClaudeAdoptionPlan,
} from '../adapter/claude-code/adoption.ts';
import { resolveDocsLanguage } from './docs-language.ts';
import {
  applyGateArtifacts,
  GATE_ARTIFACT_DIAGNOSTIC_CODES,
  gateConcurrentChangeWarning,
  planGateArtifacts,
  type GateArtifactApplyResult,
  type GateArtifactPlan,
} from './gate-artifacts.ts';
import {
  applyManagedSkillWrites,
  MANAGED_SKILL_DIAGNOSTIC_CODES,
  planManagedSkills,
  type ManagedSkillApplyResult,
  type ManagedSkillPlan,
  type ManagedSkillState,
} from './managed-skills.ts';
import {
  AUTHORING_SKILL_NAMES,
  type AuthoringSkillName,
} from './skill-templates.ts';
import { loadProjectManifest, resolveProjectPaths } from '../model/project-manifest.ts';
import { resolveScopeMarker, type Scope, type SourceRoot } from '../model/scope.ts';
import type { ProjectManifest, ProjectPaths } from '../model/types.ts';
import { minimalSourcePlan, type MinimalSourcePlan } from './minimal-source.ts';
import {
  PRACTICE_PACKS,
  planAuthoredScaffold,
  type AuthoredScaffoldPlan,
  type ResolvedProfile,
} from './practice.ts';
import {
  practiceParentDiagnostics,
  practiceParentProblems,
  probeLstat,
  sourceParentDiagnostic,
  sourceParentProblems,
} from '../core/practice-paths.ts';
import { scanProject, type ScanResult } from './scanner.ts';

export { minimalSourcePlan, type MinimalSourcePlan } from './minimal-source.ts';

export type AdoptionPhase = 'initialized' | 'partial' | 'uninitialized';

export interface AdoptionRoot {
  scope: Scope;
  root: string;
  sourceRoot: string;
  manifestPath: string;
  instructionsPath: string;
  phase: AdoptionPhase;
  manifestValid: boolean;
}

async function isManifestValid(marker: {
  root: string;
  scope: Scope;
  hasManifest: boolean;
}): Promise<boolean> {
  if (!marker.hasManifest) {
    return false;
  }
  try {
    await loadProjectManifest(marker.root, { scope: marker.scope });
    return true;
  } catch (error) {
    // An authored manifest that cannot be parsed stays in place; callers see
    // manifestValid=false and must not overwrite it.
    if (error instanceof ConfigError) {
      return false;
    }
    throw error;
  }
}

function classifyPhase(input: {
  manifestValid: boolean;
  hasManifest: boolean;
  hasAgents: boolean;
}): AdoptionPhase {
  if (input.manifestValid && input.hasAgents) {
    return 'initialized';
  }
  if (input.hasManifest || input.hasAgents) {
    return 'partial';
  }
  return 'uninitialized';
}

export async function resolveAdoptionRoot(
  input: { cwd: string; home: string },
): Promise<AdoptionRoot> {
  const marker = await resolveScopeMarker(input);
  const manifestValid = await isManifestValid(marker);
  return {
    scope: marker.scope,
    root: marker.root,
    sourceRoot: marker.sourceRoot,
    manifestPath: marker.manifestPath,
    instructionsPath: marker.instructionsPath,
    phase: classifyPhase({
      manifestValid,
      hasManifest: marker.hasManifest,
      hasAgents: marker.hasAgents,
    }),
    manifestValid,
  };
}

export async function planSourceWrites(
  root: string,
  plan: MinimalSourcePlan,
): Promise<{ create: string[]; skip: string[] }> {
  const create: string[] = [];
  const skip: string[] = [];
  for (const relativePath of Object.keys(plan.files)) {
    // This is a reporting-only plan for blocked and dry runs. A path-state
    // error on the parent is already governed by the caller, so the path is
    // reported as skipped instead of failing with an internal error.
    const state = await probeLstat(join(root, relativePath));
    if (state.info === null && state.problem === undefined) {
      create.push(relativePath);
    } else {
      skip.push(relativePath);
    }
  }
  return { create, skip };
}

export async function writeSourceFiles(
  root: string,
  plan: MinimalSourcePlan,
): Promise<{ created: string[]; skipped: string[] }> {
  for (const directory of plan.directories) {
    await ensureDir(join(root, directory));
  }
  const created: string[] = [];
  const skipped: string[] = [];
  for (const [relativePath, content] of Object.entries(plan.files)) {
    if (await writeFileIfAbsent(join(root, relativePath), content)) {
      created.push(relativePath);
    } else {
      skipped.push(relativePath);
    }
  }
  return { created, skipped };
}

export interface NormalizeAdoptionPreparation {
  sourceRoot: SourceRoot;
  phase: AdoptionPhase;
  manifest: ProjectManifest;
  paths: ProjectPaths;
  sourcePlan?: MinimalSourcePlan;
  /** Practice docs/skills plan. In adoption mode its files are the source plan. */
  practicePlan?: AuthoredScaffoldPlan;
  claudePlan?: ClaudeAdoptionPlan;
  /**
   * Managed `dab-*` authoring-skill states. Computed for project scope after
   * the practice preflight and before target planning.
   */
  managedSkills?: ManagedSkillPlan;
  /**
   * Managed gate artifacts. Computed for project scope after the practice plan
   * so missing files the pack owns are never planned by a second writer.
   */
  gates?: NormalizeGatePreparation;
  /**
   * Governed conflicts at non-practice `.agents` source parents. They block
   * every write, so import planning is skipped and discovery never runs.
   */
  sourceProblems?: Diagnostic[];
  diagnostics: Diagnostic[];
}

export interface NormalizeAdoptionResult {
  phase: AdoptionPhase;
  sourcePlan?: MinimalSourcePlan;
  sourceActions: string[];
  /** Import actions applied on a real run or planned by a dry run. */
  importActions: string[];
  imports?: ClaudeAdoptionEntry[];
  /** Import backups created on a real run or planned by a dry run. */
  backups: string[];
  diagnostics: Diagnostic[];
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return resolve(path);
    }
    throw error;
  }
}

/**
 * A project fallback can resolve to `$HOME` (for example a dotfiles git repo).
 * `$HOME/.agents` is the global source root in that case, so writing a project
 * skeleton there would silently convert the global source into a project.
 */
async function assertProjectHomeNotGlobal(
  adoption: AdoptionRoot,
  home: string,
): Promise<void> {
  if (adoption.scope !== 'project' || adoption.phase === 'initialized') {
    return;
  }
  if ((await lstatOrNull(join(home, '.agents'))) === null) {
    return;
  }
  if (await canonicalPath(adoption.root) !== await canonicalPath(home)) {
    return;
  }
  throw new ConfigError(
    'refusing to adopt project source at $HOME while ~/.agents is the global source root',
    'config.source-root-nested',
    { hint: 'Run dab normalize from inside ~/.agents to adopt global scope.' },
  );
}

function sourceRootOf(adoption: AdoptionRoot): SourceRoot {
  return {
    scope: adoption.scope,
    root: adoption.root,
    sourceRoot: adoption.sourceRoot,
    manifest: adoption.manifestPath,
    instructions: adoption.instructionsPath,
  };
}

/**
 * Plan the import of physical `.claude/agents` and `.claude/skills` entries.
 * The plan is read-only, runs for every phase (including initialized scopes),
 * and is gated by the caller before any source or `.claude` write.
 */
async function planImports(
  adoption: AdoptionRoot,
  manifest: ProjectManifest,
  paths: ProjectPaths,
): Promise<ClaudeAdoptionPlan> {
  return planClaudeAdoption({
    root: adoption.root,
    scope: adoption.scope,
    agentsRoot: paths.agents,
    claudeRoot: paths.claude,
    manifest,
  });
}

/**
 * Managed authoring-skill operations as reported to normalize. `created`,
 * `updated`, `migrated` and `skipped` are the action categories applied (or
 * planned by a dry run); the remaining lists carry the preserved states, and
 * `actions` is the stable human/JSON action text.
 */
export interface ManagedSkillSummary {
  actions: string[];
  created: string[];
  updated: string[];
  migrated: string[];
  skipped: string[];
  /** Body hash no longer matches the marker; preserved. */
  modified: string[];
  /** Installed version is newer or uncomparable; preserved. */
  newer: string[];
  /** Legacy marker body differs from the template; preserved. */
  legacy: string[];
  /** No managed marker at all; preserved. */
  unversioned: string[];
  /** Marker names a different skill; preserved. */
  markerMismatch: string[];
  /** Targets changed between planning and applying; preserved. */
  concurrent: string[];
}

function emptyManagedSkillSummary(): ManagedSkillSummary {
  return {
    actions: [],
    created: [],
    updated: [],
    migrated: [],
    skipped: [],
    modified: [],
    newer: [],
    legacy: [],
    unversioned: [],
    markerMismatch: [],
    concurrent: [],
  };
}

/**
 * The authoring pack owns missing skill files it planned itself, so the managed
 * writer must not also create them. Legacy, stale and skipped states are
 * untouched by the pack because an existing skill directory is user-owned.
 */
export function planManagedSkillWrites(
  plan: ManagedSkillPlan,
  practiceFiles: ReadonlySet<string>,
): ManagedSkillPlan {
  const states = plan.states.filter(
    (state) => state.status !== 'missing' || !practiceFiles.has(state.file),
  );
  const retained = new Set(states.map((state) => state.file));
  return {
    states,
    writes: plan.writes.filter((write) => retained.has(write.file)),
    diagnostics: [...plan.diagnostics],
  };
}

/**
 * Derive the normalize report from the writes plan. When the plan was applied,
 * `applied` carries the revalidation outcome: a target that changed after
 * planning moves from created/updated/migrated to the preserved `concurrent`
 * list instead of claiming a write that did not happen. A dry run passes the
 * same apply result (with no bytes written) so both modes agree.
 */
export function summarizeManagedSkills(
  plan: ManagedSkillPlan | undefined,
  applied?: ManagedSkillApplyResult,
): ManagedSkillSummary {
  const summary = emptyManagedSkillSummary();
  if (plan === undefined) {
    return summary;
  }
  const writes = new Set(plan.writes.map((write) => write.file));
  const mismatched = new Set(
    plan.diagnostics
      .filter((item) => item.code === MANAGED_SKILL_DIAGNOSTIC_CODES.mismatch)
      .flatMap((item) => (item.file === undefined ? [] : [item.file])),
  );
  const created = new Set(applied?.created ?? []);
  const updated = new Set(applied?.updated ?? []);
  const migrated = new Set(applied?.migrated ?? []);
  const concurrent = new Set(applied?.concurrent ?? []);

  const markApplied = (
    state: ManagedSkillState,
    written: ReadonlySet<string>,
    kind: 'create' | 'update' | 'migrate',
  ): void => {
    if (applied === undefined || written.has(state.file)) {
      if (kind === 'create') {
        summary.created.push(state.file);
      } else if (kind === 'update') {
        summary.updated.push(state.file);
      } else {
        summary.migrated.push(state.file);
      }
      summary.actions.push(`${kind} skill ${state.file}`);
      return;
    }
    if (concurrent.has(state.file)) {
      summary.skipped.push(state.file);
      summary.concurrent.push(state.file);
      summary.actions.push(`skip skill ${state.file} (concurrent-change)`);
      return;
    }
    throw new Error(
      `managed skill apply result has no ${kind} outcome for ${state.name}`,
    );
  };

  for (const state of plan.states) {
    switch (state.status) {
      case 'missing': {
        markApplied(state, created, 'create');
        break;
      }
      case 'stale': {
        markApplied(state, updated, 'update');
        break;
      }
      case 'legacy': {
        if (writes.has(state.file)) {
          markApplied(state, migrated, 'migrate');
        } else {
          summary.skipped.push(state.file);
          summary.legacy.push(state.file);
          summary.actions.push(`skip skill ${state.file} (legacy)`);
        }
        break;
      }
      case 'current': {
        summary.skipped.push(state.file);
        break;
      }
      case 'modified': {
        summary.skipped.push(state.file);
        summary.modified.push(state.file);
        summary.actions.push(`skip skill ${state.file} (modified)`);
        break;
      }
      case 'newer': {
        summary.skipped.push(state.file);
        summary.newer.push(state.file);
        summary.actions.push(`skip skill ${state.file} (newer)`);
        break;
      }
      case 'unversioned': {
        summary.skipped.push(state.file);
        if (mismatched.has(state.file)) {
          summary.markerMismatch.push(state.file);
          summary.actions.push(`skip skill ${state.file} (marker-mismatch)`);
        } else {
          summary.unversioned.push(state.file);
          summary.actions.push(`skip skill ${state.file} (unversioned)`);
        }
        break;
      }
    }
  }
  return summary;
}

export const GATE_UPDATES_SUPPRESSED_REASON = 'gate updates are suppressed by init';

/**
 * Gate preparation for one normalize run. `states` and `diagnostics` are the
 * unfiltered Task 3 inspection used for reporting; `plan` is the write plan
 * after the one-writer filter and the init suppression switch.
 */
export interface NormalizeGatePreparation {
  states: GateArtifactPlan['states'];
  diagnostics: Diagnostic[];
  /** Write plan after the one-writer filter and the init suppression switch. */
  plan: GateArtifactPlan;
}

/**
 * Managed gate operations as reported to normalize. `actions` is the stable
 * human/JSON action text; the remaining lists describe the applied (or dry-run
 * planned) result, and `diagnostics` carries every Task 3 diagnostic.
 */
export interface NormalizeGateSummary {
  actions: string[];
  created: string[];
  updated: string[];
  skipped: string[];
  modified: string[];
  diagnostics: Diagnostic[];
}

/**
 * Exactly one writer per path. The verification practice pack owns every
 * missing gate file it planned, so the gate writer drops those creates. With
 * `suppressUpdates` (init's nested normalize) an existing stale artifact is
 * preserved as a skip while missing artifacts are still created.
 */
export function planGateWrites(
  plan: GateArtifactPlan,
  practiceFiles: ReadonlySet<string>,
  options: { suppressUpdates?: boolean } = {},
): GateArtifactPlan {
  const actions: GateArtifactPlan['actions'] = [];
  const files: Record<string, string> = {};
  for (const action of plan.actions) {
    if (action.kind === 'create' && practiceFiles.has(action.path)) {
      continue;
    }
    if (action.kind === 'update' && options.suppressUpdates === true) {
      actions.push({
        path: action.path,
        kind: 'skip',
        reason: GATE_UPDATES_SUPPRESSED_REASON,
      });
      continue;
    }
    actions.push({ ...action });
    const content = plan.files[action.path];
    if (content !== undefined) {
      files[action.path] = content;
    }
  }
  return {
    files,
    actions,
    diagnostics: [...plan.diagnostics],
    states: plan.states.map((state) => ({ ...state })),
  };
}

/**
 * How a gate summary was produced. `blocked` never claims a write: a run that
 * stops before its source phase creates and updates nothing. `apply` claims
 * only the writer's outcomes. `dry-run` may report the planned create/update
 * states because it describes what a real run would do.
 */
export type GateSummaryMode = 'apply' | 'dry-run' | 'blocked';

/**
 * Derive the normalize gate report from the Task 3 states and the explicit
 * outcome mode. A `missing` state the practice pack wrote is still created by
 * this run; a stale update that was suppressed, blocked or lost a concurrent
 * race is reported as skipped instead of claiming a write that did not happen.
 */
export function summarizeGates(
  prepared: NormalizeGatePreparation | undefined,
  options: {
    mode: GateSummaryMode;
    practiceCreated?: ReadonlySet<string>;
    practiceSkipped?: ReadonlySet<string>;
    applied?: GateArtifactApplyResult;
  },
): NormalizeGateSummary {
  const summary: NormalizeGateSummary = {
    actions: [],
    created: [],
    updated: [],
    skipped: [],
    modified: [],
    diagnostics: [],
  };
  if (prepared === undefined) {
    return summary;
  }
  if (options.mode === 'apply' && options.applied === undefined) {
    throw new Error('gate apply summary requires an apply result');
  }
  const blocked = options.mode === 'blocked' || hasErrors(prepared.diagnostics);
  const allowedPlanned = options.mode === 'dry-run';
  const practiceCreated = options.practiceCreated ?? new Set<string>();
  const practiceSkipped = options.practiceSkipped ?? new Set<string>();
  const created = new Set(options.applied?.created ?? []);
  const updated = new Set(options.applied?.updated ?? []);
  const applyDiagnostics = options.applied?.diagnostics ?? [];
  const concurrent = new Set(
    applyDiagnostics
      .filter((item) => item.code === GATE_ARTIFACT_DIAGNOSTIC_CODES.concurrentChange)
      .flatMap((item) => (item.file === undefined ? [] : [item.file])),
  );
  const pathErrors = new Set(
    applyDiagnostics
      .filter(
        (item) => item.severity === 'error'
          && item.code === GATE_ARTIFACT_DIAGNOSTIC_CODES.path,
      )
      .flatMap((item) => (item.file === undefined ? [] : [item.file])),
  );
  const suppressed = new Set(
    prepared.plan.actions
      .filter(
        (action) => action.kind === 'skip'
          && action.reason === GATE_UPDATES_SUPPRESSED_REASON,
      )
      .map((action) => action.path),
  );

  const actionForSkipped = (path: string): void => {
    if (concurrent.has(path)) {
      summary.actions.push(`skip gate ${path} (concurrent-change)`);
    } else if (pathErrors.has(path)) {
      summary.actions.push(`skip gate ${path} (path-conflict)`);
    }
  };

  for (const state of prepared.states) {
    switch (state.status) {
      case 'missing': {
        // A practice-owned missing file is created by the source writer; when
        // that write is skipped the file appeared between planning and writing.
        const appearedConcurrently = options.mode !== 'blocked'
          && practiceSkipped.has(state.path)
          && !practiceCreated.has(state.path);
        if (appearedConcurrently) {
          concurrent.add(state.path);
          summary.diagnostics.push(gateConcurrentChangeWarning(state.path));
        }
        const claimed = !blocked && !appearedConcurrently && (
          created.has(state.path)
          || practiceCreated.has(state.path)
          || (allowedPlanned && options.applied === undefined)
        );
        if (claimed) {
          summary.created.push(state.path);
          summary.actions.push(`create gate ${state.path}`);
        } else {
          summary.skipped.push(state.path);
          actionForSkipped(state.path);
        }
        break;
      }
      case 'stale': {
        if (suppressed.has(state.path)) {
          summary.skipped.push(state.path);
          summary.actions.push(`skip gate ${state.path} (updates-suppressed)`);
        } else if (
          !blocked
          && (updated.has(state.path) || (allowedPlanned && options.applied === undefined))
        ) {
          summary.updated.push(state.path);
          summary.actions.push(`update gate ${state.path}`);
        } else {
          summary.skipped.push(state.path);
          actionForSkipped(state.path);
        }
        break;
      }
      case 'current': {
        summary.skipped.push(state.path);
        break;
      }
      case 'modified': {
        summary.skipped.push(state.path);
        summary.modified.push(state.path);
        summary.actions.push(`skip gate ${state.path} (modified)`);
        break;
      }
      case 'unversioned': {
        summary.skipped.push(state.path);
        summary.actions.push(`skip gate ${state.path} (unversioned)`);
        break;
      }
      case 'newer': {
        summary.skipped.push(state.path);
        summary.actions.push(`skip gate ${state.path} (newer)`);
        break;
      }
    }
  }
  summary.diagnostics = dedupeDiagnostics([
    ...prepared.diagnostics,
    ...applyDiagnostics,
    ...summary.diagnostics,
  ]);
  return summary;
}

export interface PrepareAdoptionInput {
  cwd: string;
  home: string;
  now?: Date;
  /**
   * Skip the Claude import plan entirely. `dab init` uses this so its existing
   * behavior on an existing `.claude` tree is preserved: imports are
   * normalize's job, not an init side effect.
   */
  suppressImports?: boolean;
  /**
   * Skip managed authoring-skill planning. `dab init` already installs missing
   * skills and must never update an existing one, so its nested normalize run
   * disables managed updates.
   */
  suppressManagedSkills?: boolean;
  /**
   * Skip managed gate runner/snapshot updates while still allowing missing
   * artifacts to be created. `dab init` sets it so its nested normalize never
   * replaces an existing generated gate artifact.
   */
  suppressGateUpdates?: boolean;
}

/**
 * Plan authored practice artifacts through the shared planner. Normalize uses
 * adoption mode before a manifest exists and converge mode afterwards; the
 * production pack registry is always explicit.
 *
 * A regular file at `.agents/rules` or `.agents/skills` breaks discovery and
 * child writes with ENOTDIR. The planner reports child conflicts for adoption,
 * but converge has no core targets, so probe both parents first and return a
 * governed practice diagnostic with an empty plan.
 */
async function planPractices(input: {
  root: string;
  scope: Scope;
  scan: ScanResult;
  profile: ResolvedProfile;
  mode: 'adoption' | 'converge';
  manifest?: ProjectManifest;
}): Promise<AuthoredScaffoldPlan> {
  const docsLanguage = await resolveDocsLanguage({
    root: input.root,
    configured: input.manifest?.docs.language ?? 'auto',
    env: process.env,
  });
  if (input.scope === 'project') {
    const problems = await practiceParentProblems(input.root);
    const diagnostics: Diagnostic[] = [];
    for (const [code, problem] of [
      ['practice.docs-path', problems.docs],
      ['practice.skill-path', problems.skills],
    ] as const) {
      if (problem === undefined) {
        continue;
      }
      diagnostics.push({
        code,
        severity: 'error',
        message: problem.message,
        file: problem.path,
        hint: 'Resolve the path conflict manually; DAB never writes through it.',
      });
    }
    if (diagnostics.length > 0) {
      return {
        profile: input.profile,
        mode: input.mode,
        files: {},
        directories: [],
        skipped: [],
        policySkipped: [],
        diagnostics,
        ...(input.manifest === undefined ? {} : { manifest: input.manifest }),
        docsLanguage,
      };
    }
  }
  return planAuthoredScaffold({
    root: input.root,
    scope: input.scope,
    scan: input.scan,
    profile: input.profile,
    mode: input.mode,
    version: DAB_VERSION,
    env: process.env,
    ...(input.manifest === undefined ? {} : { manifest: input.manifest }),
  }, PRACTICE_PACKS);
}

/**
 * The practice planner resolves real parent paths, which cannot resolve a
 * dangling `.agents` symlink. Normalize still needs to reach its source-write
 * safety gate to report the alias/escape, so detect this layout before planning
 * and use the minimal plan instead of throwing a raw filesystem error.
 */
async function danglingSourceDiagnostic(root: string): Promise<Diagnostic | undefined> {
  const agents = join(root, '.agents');
  const info = await lstatOrNull(agents);
  if (info?.isSymbolicLink() !== true) {
    return undefined;
  }
  try {
    await realpath(agents);
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  if (await lexicalAlias(root, '.agents', '.claude')) {
    return {
      code: 'path.overlap',
      severity: 'error',
      message: 'authored and generated trees overlap: .agents and .claude',
      file: '.agents',
    };
  }
  return {
    code: 'path.symlink-escape',
    severity: 'error',
    message: 'authored source parent is a dangling symlink: .agents',
    file: '.agents',
  };
}

/**
 * Names of authoring skills whose `.agents` source is written by a Claude
 * import. A physical `.claude/skills/dab-*` entry is an import fact; the import
 * owns that skill, so the authoring pack and the managed writer must both stay
 * away from it.
 */
function importedAuthoringSkillNames(
  claudePlan: ClaudeAdoptionPlan | undefined,
): Set<AuthoringSkillName> {
  const imported = new Set<AuthoringSkillName>();
  for (const entry of claudePlan?.entries ?? []) {
    if (entry.kind !== 'skill' || !entry.writeSource) {
      continue;
    }
    for (const name of AUTHORING_SKILL_NAMES) {
      if (entry.target === `.agents/skills/${name}`) {
        imported.add(name);
      }
    }
  }
  return imported;
}

function suppressImportedAuthoringSkillTemplates(
  plan: AuthoredScaffoldPlan,
  imported: ReadonlySet<AuthoringSkillName>,
): AuthoredScaffoldPlan {
  if (imported.size === 0) {
    return plan;
  }
  const targets = new Set(
    [...imported].map((name) => `.agents/skills/${name}`),
  );
  const suppressed = (path: string): boolean => {
    for (const target of targets) {
      if (path === target || path.startsWith(`${target}/`)) {
        return true;
      }
    }
    return false;
  };
  return {
    ...plan,
    files: Object.fromEntries(
      Object.entries(plan.files).filter(([path]) => !suppressed(path)),
    ),
    directories: plan.directories.filter((path) => !suppressed(path)),
  };
}

/**
 * Plan managed `dab-*` skills for project scope only. Imports that will write
 * a missing `.agents` source are excluded: the import owns that skill and
 * `applyClaudeAdoption` refuses to overwrite a source that appeared first.
 */
async function planManagedSkillsFor(
  root: string,
  scope: Scope,
  options: { suppress?: boolean; imported: ReadonlySet<AuthoringSkillName> },
): Promise<ManagedSkillPlan | undefined> {
  if (scope !== 'project' || options.suppress === true) {
    return undefined;
  }
  const names = AUTHORING_SKILL_NAMES.filter((name) => !options.imported.has(name));
  return planManagedSkills({ root, version: DAB_VERSION, names });
}

/**
 * Plan managed gate artifacts for project scope only. The verification pack
 * already owns every missing gate file, so its planned paths are filtered out
 * of the gate write plan; only existing-artifact updates reach the writer.
 */
async function planGatesFor(
  root: string,
  scope: Scope,
  scan: ScanResult,
  practiceFiles: ReadonlySet<string>,
  options: { suppressUpdates?: boolean },
): Promise<NormalizeGatePreparation | undefined> {
  if (scope !== 'project') {
    return undefined;
  }
  const plan = await planGateArtifacts({ root, scan, version: DAB_VERSION });
  return {
    states: plan.states,
    diagnostics: plan.diagnostics,
    plan: planGateWrites(plan, practiceFiles, {
      ...(options.suppressUpdates === true ? { suppressUpdates: true } : {}),
    }),
  };
}

export async function prepareNormalizeAdoption(
  input: PrepareAdoptionInput,
): Promise<NormalizeAdoptionPreparation> {
  const adoption = await resolveAdoptionRoot({ cwd: input.cwd, home: input.home });
  const sourceRoot = sourceRootOf(adoption);
  const manifestKey = toPosix(relative(adoption.root, adoption.manifestPath));
  const hasManifest = (await lstatOrNull(adoption.manifestPath)) !== null;
  // Project practice parents are probed by the practice planner, which owns
  // their `practice.docs-path`/`practice.skill-path` codes. Global scope has no
  // practice packs, so their access and type conflicts are governed here.
  const sourceProblems = [
    ...(await sourceParentProblems(adoption.root)).map(sourceParentDiagnostic),
    ...(adoption.scope === 'global'
      ? practiceParentDiagnostics(await practiceParentProblems(adoption.root))
      : []),
  ];
  const sourceExtras = sourceProblems.length === 0
    ? {}
    : { sourceProblems };
  // Import planning reads the authored agents and skills trees. A broken core
  // source parent already blocks the run, so the plan is skipped instead of
  // failing discovery with an internal error.
  const importPlan = (manifest: ProjectManifest, paths: ProjectPaths) =>
    input.suppressImports === true || sourceProblems.length > 0
      ? Promise.resolve(undefined)
      : planImports(adoption, manifest, paths);

  if (hasManifest && !adoption.manifestValid) {
    // Re-run the loader so callers receive the exact ConfigError (invalid
    // manifest, scope mismatch, unsupported paths) and nothing is overwritten.
    await loadProjectManifest(adoption.root, { scope: adoption.scope });
    throw new ConfigError(`invalid ${manifestKey}`, 'config.invalid');
  }
  const sourceProblem = await danglingSourceDiagnostic(adoption.root);

  if (hasManifest) {
    const loaded = await loadProjectManifest(adoption.root, { scope: adoption.scope });
    const paths = resolveProjectPaths(adoption.root, loaded.manifest);
    if (adoption.phase === 'initialized') {
      if (sourceProblem !== undefined) {
        return {
          sourceRoot,
          phase: adoption.phase,
          manifest: loaded.manifest,
          paths,
          claudePlan: await importPlan(loaded.manifest, paths),
          ...sourceExtras,
          diagnostics: [sourceProblem, ...sourceProblems],
        };
      }
      const scan = await scanProject(adoption.root);
      const claudePlan = await importPlan(loaded.manifest, paths);
      const imported = importedAuthoringSkillNames(claudePlan);
      const practicePlan = suppressImportedAuthoringSkillTemplates(
        await planPractices({
          root: adoption.root,
          scope: adoption.scope,
          scan,
          profile: loaded.manifest.profile,
          mode: 'converge',
          manifest: loaded.manifest,
        }),
        imported,
      );
      const managedSkills = await planManagedSkillsFor(adoption.root, adoption.scope, {
        suppress: input.suppressManagedSkills,
        imported,
      });
      const gates = await planGatesFor(
        adoption.root,
        adoption.scope,
        scan,
        new Set(Object.keys(practicePlan.files)),
        { suppressUpdates: input.suppressGateUpdates === true },
      );
      return {
        sourceRoot,
        phase: adoption.phase,
        manifest: loaded.manifest,
        paths,
        practicePlan,
        claudePlan,
        ...(managedSkills === undefined ? {} : { managedSkills }),
        ...(gates === undefined ? {} : { gates }),
        ...sourceExtras,
        diagnostics: [
          ...scan.diagnostics,
          ...practicePlan.diagnostics,
          ...(managedSkills?.diagnostics ?? []),
          ...(gates?.diagnostics ?? []),
          ...sourceProblems,
        ],
      };
    }
    await assertProjectHomeNotGlobal(adoption, input.home);
    const scan = await scanProject(adoption.root);
    if (sourceProblem !== undefined) {
      const plan = minimalSourcePlan(scan, adoption.scope);
      const { [manifestKey]: _authored, ...files } = plan.files;
      return {
        sourceRoot,
        phase: adoption.phase,
        manifest: loaded.manifest,
        paths,
        sourcePlan: { ...plan, files, manifest: loaded.manifest },
        claudePlan: await importPlan(loaded.manifest, paths),
        ...sourceExtras,
        diagnostics: [sourceProblem, ...scan.diagnostics, ...sourceProblems],
      };
    }
    const claudePlan = await importPlan(loaded.manifest, paths);
    const imported = importedAuthoringSkillNames(claudePlan);
    const practicePlan = suppressImportedAuthoringSkillTemplates(
      await planPractices({
        root: adoption.root,
        scope: adoption.scope,
        scan,
        profile: loaded.manifest.profile,
        mode: 'adoption',
        manifest: loaded.manifest,
      }),
      imported,
    );
    const managedSkills = await planManagedSkillsFor(adoption.root, adoption.scope, {
      suppress: input.suppressManagedSkills,
      imported,
    });
    const gates = await planGatesFor(
      adoption.root,
      adoption.scope,
      scan,
      new Set(Object.keys(practicePlan.files)),
      { suppressUpdates: input.suppressGateUpdates === true },
    );
    // The authored manifest is authoritative: it is never part of the write
    // plan and `practicePlan.manifest` stays equal to what normalize loads.
    const { [manifestKey]: _authored, ...files } = practicePlan.files;
    return {
      sourceRoot,
      phase: adoption.phase,
      manifest: loaded.manifest,
      paths,
      sourcePlan: {
        files,
        directories: practicePlan.directories,
        manifest: loaded.manifest,
      },
      practicePlan,
      claudePlan,
      ...(managedSkills === undefined ? {} : { managedSkills }),
      ...(gates === undefined ? {} : { gates }),
      ...sourceExtras,
      diagnostics: [
        ...scan.diagnostics,
        ...practicePlan.diagnostics,
        ...(managedSkills?.diagnostics ?? []),
        ...(gates?.diagnostics ?? []),
        ...sourceProblems,
      ],
    };
  }

  await assertProjectHomeNotGlobal(adoption, input.home);
  const scan = await scanProject(adoption.root);
  if (sourceProblem !== undefined) {
    const plan = minimalSourcePlan(scan, adoption.scope);
    const paths = resolveProjectPaths(adoption.root, plan.manifest);
    return {
      sourceRoot,
      phase: adoption.phase,
      manifest: plan.manifest,
      paths,
      sourcePlan: plan,
      claudePlan: await importPlan(plan.manifest, paths),
      ...sourceExtras,
      diagnostics: [sourceProblem, ...scan.diagnostics, ...sourceProblems],
    };
  }
  const rawPracticePlan = await planPractices({
    root: adoption.root,
    scope: adoption.scope,
    scan,
    profile: 'generic',
    mode: 'adoption',
  });
  const manifest = rawPracticePlan.manifest ?? minimalSourcePlan(scan, adoption.scope).manifest;
  const paths = resolveProjectPaths(adoption.root, manifest);
  const claudePlan = await importPlan(manifest, paths);
  const imported = importedAuthoringSkillNames(claudePlan);
  const practicePlan = suppressImportedAuthoringSkillTemplates(rawPracticePlan, imported);
  const managedSkills = await planManagedSkillsFor(adoption.root, adoption.scope, {
    suppress: input.suppressManagedSkills,
    imported,
  });
  const gates = await planGatesFor(
    adoption.root,
    adoption.scope,
    scan,
    new Set(Object.keys(practicePlan.files)),
    { suppressUpdates: input.suppressGateUpdates === true },
  );
  return {
    sourceRoot,
    phase: adoption.phase,
    manifest,
    paths,
    sourcePlan: {
      files: practicePlan.files,
      directories: practicePlan.directories,
      manifest,
    },
    practicePlan,
    claudePlan,
    ...(managedSkills === undefined ? {} : { managedSkills }),
    ...(gates === undefined ? {} : { gates }),
    ...sourceExtras,
    diagnostics: [
      ...scan.diagnostics,
      ...practicePlan.diagnostics,
      ...(managedSkills?.diagnostics ?? []),
      ...(gates?.diagnostics ?? []),
      ...sourceProblems,
    ],
  };
}

function adoptionDiagnostic(error: DabError, file: string): Diagnostic {
  return {
    code: error.code,
    severity: 'error',
    message: error.message,
    file,
    ...(error.hint === undefined ? {} : { hint: error.hint }),
  };
}

/**
 * Real-path disjointness cannot compare a dangling symlink with its intended
 * target (`realpath` fails). Compare the direct link text as well so
 * `.agents -> .claude` or `.claude -> .agents` is rejected before the source
 * write creates the missing target.
 */
async function lexicalAlias(
  root: string,
  first: string,
  second: string,
): Promise<boolean> {
  const firstPath = join(root, first);
  const secondPath = join(root, second);
  for (const [linkPath, otherPath] of [
    [firstPath, secondPath],
    [secondPath, firstPath],
  ] as const) {
    const info = await lstatOrNull(linkPath);
    if (info?.isSymbolicLink() !== true) {
      continue;
    }
    const resolved = resolve(dirname(linkPath), await readlink(linkPath));
    if (
      resolved === otherPath
      || isPathInside(resolved, otherPath)
      || isPathInside(otherPath, resolved)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Init-style containment checks run before the first write. `plan.directories`
 * omits implicitly created parents (policies, adapters), so every planned file
 * is checked as well as the source tree itself.
 */
async function sourceWriteDiagnostics(
  root: string,
  plan: MinimalSourcePlan,
  agents: string,
): Promise<Diagnostic[]> {
  // An aliased `.agents`/`.claude` pair would route the minimal source writes
  // through the generated tree before the target preflight notices. Check the
  // tree identity first so a rejected layout writes nothing at all.
  try {
    await assertRealPathInsideRoot(root, '.claude');
    await assertRealPathsDisjoint(root, '.agents', '.claude');
    if (await lexicalAlias(root, '.agents', '.claude')) {
      throw new ConfigError(
        'authored and generated trees overlap: .agents and .claude',
        'path.overlap',
      );
    }
  } catch (error) {
    if (error instanceof DabError) {
      return [adoptionDiagnostic(error, '.agents')];
    }
    throw error;
  }
  for (const relativePath of [
    agents,
    ...plan.directories,
    ...Object.keys(plan.files),
  ]) {
    try {
      await assertRealPathInsideRoot(root, relativePath);
      await assertParentInsideRoot(root, relativePath);
    } catch (error) {
      if (error instanceof DabError) {
        return [adoptionDiagnostic(error, relativePath)];
      }
      throw error;
    }
  }
  return [];
}

/**
 * Applies the prepared adoption: minimal source writes first, then the Claude
 * imports/backups/symlinks under the same backup root. Callers may pass a
 * preparation with only one of the two plans to stage the writes around a
 * read-only target preflight; a source containment failure skips the imports
 * entirely so neither tree is touched.
 */
export async function applyNormalizeAdoption(
  prep: NormalizeAdoptionPreparation,
  options: { dryRun: boolean; backupRoot: string },
): Promise<{
  actions: string[];
  backups: string[];
  diagnostics: Diagnostic[];
  created: string[];
  skipped: string[];
  /** Absent when managed skills were not planned (global or init nested run). */
  managed?: ManagedSkillSummary;
  /** Absent for global scope, where no project gate artifacts exist. */
  gates?: NormalizeGateSummary;
}> {
  const root = prep.sourceRoot.root;
  const actions: string[] = [];
  const backups: string[] = [];
  const diagnostics: Diagnostic[] = [];
  const created: string[] = [];
  const skipped: string[] = [];
  const gatePaths = new Set(prep.gates?.states.map((state) => state.path) ?? []);

  if (prep.sourcePlan !== undefined) {
    const agents = toPosix(relative(root, prep.paths.agents));
    const sourceDiagnostics = await sourceWriteDiagnostics(root, prep.sourcePlan, agents);
    if (sourceDiagnostics.length > 0) {
      return {
        actions: [],
        backups: [],
        diagnostics: sourceDiagnostics,
        created: [],
        skipped: [],
      };
    }
    if (options.dryRun) {
      const planned = await planSourceWrites(root, prep.sourcePlan);
      created.push(...planned.create);
      skipped.push(...planned.skip);
    } else {
      const written = await writeSourceFiles(root, prep.sourcePlan);
      created.push(...written.created);
      skipped.push(...written.skipped);
    }
    // Gate files written by the practice/source plan are reported by the gate
    // actions below, so their plain create/skip lines are not duplicated.
    actions.push(
      ...created.filter((file) => !gatePaths.has(file)).map((file) => `create ${file}`),
      ...skipped.filter((file) => !gatePaths.has(file)).map((file) => `skip ${file}`),
    );
  }

  // Managed skill writes share the practice source phase: every blocking
  // preflight has already run, and the new skill content is visible to target
  // planning in this same normalization.
  let managed: ManagedSkillSummary | undefined;
  if (prep.managedSkills !== undefined) {
    // Apply (or revalidate on a dry run) first so the report never claims a
    // write that a concurrent change turned into a preserved file.
    const appliedManaged = await applyManagedSkillWrites(
      root,
      prep.managedSkills,
      { dryRun: options.dryRun },
    );
    managed = summarizeManagedSkills(prep.managedSkills, appliedManaged);
    actions.push(...managed.actions);
    diagnostics.push(...appliedManaged.diagnostics);
  }

  // Gate updates share the same source phase. Missing artifacts were already
  // created by the practice plan, so this writer only revalidates and applies
  // existing-artifact updates.
  let gates: NormalizeGateSummary | undefined;
  if (prep.gates !== undefined) {
    const appliedGates = await applyGateArtifacts(root, prep.gates.plan, {
      dryRun: options.dryRun,
    });
    gates = summarizeGates(prep.gates, {
      mode: options.dryRun ? 'dry-run' : 'apply',
      practiceCreated: new Set(created),
      practiceSkipped: new Set(skipped),
      applied: appliedGates,
    });
    actions.push(...gates.actions);
    // The summary carries plan, apply-time and practice-phase concurrent
    // diagnostics in one deduped list.
    diagnostics.push(...gates.diagnostics);
  }

  // A dry run never replaces .claude entries; the import plan itself is
  // reported through NormalizeResult.adoption.imports.
  if (prep.claudePlan !== undefined && !options.dryRun) {
    const applied = await applyClaudeAdoption({
      root,
      plan: prep.claudePlan,
      backupRoot: options.backupRoot,
    });
    actions.push(...applied.actions);
    backups.push(...applied.backups);
    diagnostics.push(...applied.diagnostics);
  }

  return {
    actions,
    backups,
    diagnostics,
    created,
    skipped,
    ...(managed === undefined ? {} : { managed }),
    ...(gates === undefined ? {} : { gates }),
  };
}
