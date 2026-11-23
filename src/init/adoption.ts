import { open, readlink, realpath, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import type { Diagnostic } from '../core/diagnostics.ts';
import { ConfigError, DabError } from '../core/errors.ts';
import { ensureDir, lstatOrNull } from '../core/fs-atomic.ts';
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
import { practiceParentProblems } from './practice-paths.ts';
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
    if ((await lstatOrNull(join(root, relativePath))) === null) {
      create.push(relativePath);
    } else {
      skip.push(relativePath);
    }
  }
  return { create, skip };
}

/**
 * Create a file only when it does not exist. `wx` makes the check and the
 * create one filesystem operation, so an authored file that appears between
 * planning and writing is never replaced.
 */
async function writeMissingFile(filePath: string, content: string): Promise<boolean> {
  await ensureDir(dirname(filePath));
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, 'wx', 0o644);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw error;
  }
  try {
    await handle.writeFile(content);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(filePath, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  return true;
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
    if (await writeMissingFile(join(root, relativePath), content)) {
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
 * A physical `.claude/skills/dab-*` entry is an import fact. When its `.agents`
 * source is still missing, the import plan owns that skill, so DAB must not
 * also plan its authoring template: two writers would race for one directory.
 * Existing `.agents` skill directories are already skipped by the planner and
 * keep the normal import rules (source wins, `.claude` is backed up).
 */
function suppressImportedAuthoringSkillTemplates(
  plan: AuthoredScaffoldPlan,
  claudePlan: ClaudeAdoptionPlan | undefined,
): AuthoredScaffoldPlan {
  if (claudePlan === undefined) {
    return plan;
  }
  const imported = new Set<string>();
  for (const entry of claudePlan.entries) {
    if (
      entry.kind === 'skill'
      && entry.writeSource
      && entry.target.startsWith('.agents/skills/dab-')
    ) {
      imported.add(entry.target);
    }
  }
  if (imported.size === 0) {
    return plan;
  }
  const suppressed = (path: string): boolean => {
    for (const target of imported) {
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

export async function prepareNormalizeAdoption(
  input: PrepareAdoptionInput,
): Promise<NormalizeAdoptionPreparation> {
  const adoption = await resolveAdoptionRoot({ cwd: input.cwd, home: input.home });
  const sourceRoot = sourceRootOf(adoption);
  const manifestKey = toPosix(relative(adoption.root, adoption.manifestPath));
  const hasManifest = (await lstatOrNull(adoption.manifestPath)) !== null;
  const importPlan = (manifest: ProjectManifest, paths: ProjectPaths) =>
    input.suppressImports === true
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
          diagnostics: [sourceProblem],
        };
      }
      const scan = await scanProject(adoption.root);
      const claudePlan = await importPlan(loaded.manifest, paths);
      const practicePlan = suppressImportedAuthoringSkillTemplates(
        await planPractices({
          root: adoption.root,
          scope: adoption.scope,
          scan,
          profile: loaded.manifest.profile,
          mode: 'converge',
          manifest: loaded.manifest,
        }),
        claudePlan,
      );
      return {
        sourceRoot,
        phase: adoption.phase,
        manifest: loaded.manifest,
        paths,
        practicePlan,
        claudePlan,
        diagnostics: [...scan.diagnostics, ...practicePlan.diagnostics],
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
        diagnostics: [sourceProblem, ...scan.diagnostics],
      };
    }
    const claudePlan = await importPlan(loaded.manifest, paths);
    const practicePlan = suppressImportedAuthoringSkillTemplates(
      await planPractices({
        root: adoption.root,
        scope: adoption.scope,
        scan,
        profile: loaded.manifest.profile,
        mode: 'adoption',
        manifest: loaded.manifest,
      }),
      claudePlan,
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
      diagnostics: [...scan.diagnostics, ...practicePlan.diagnostics],
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
      diagnostics: [sourceProblem, ...scan.diagnostics],
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
  const practicePlan = suppressImportedAuthoringSkillTemplates(rawPracticePlan, claudePlan);
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
    diagnostics: [...scan.diagnostics, ...practicePlan.diagnostics],
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
 * omits implicitly created parents (policies, adapters, memory), so every
 * planned file is checked as well as the source tree itself.
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
}> {
  const root = prep.sourceRoot.root;
  const actions: string[] = [];
  const backups: string[] = [];
  const diagnostics: Diagnostic[] = [];
  const created: string[] = [];
  const skipped: string[] = [];

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
    actions.push(
      ...created.map((file) => `create ${file}`),
      ...skipped.map((file) => `skip ${file}`),
    );
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

  return { actions, backups, diagnostics, created, skipped };
}
