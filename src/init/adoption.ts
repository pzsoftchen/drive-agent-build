import { open, realpath, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import type { Diagnostic } from '../core/diagnostics.ts';
import { ConfigError, DabError } from '../core/errors.ts';
import { ensureDir, lstatOrNull } from '../core/fs-atomic.ts';
import {
  assertParentInsideRoot,
  assertRealPathInsideRoot,
  toPosix,
} from '../core/paths.ts';
import { MIN_CLAUDE_CODE_VERSION } from '../core/version-check.ts';
import {
  applyClaudeAdoption,
  planClaudeAdoption,
  type ClaudeAdoptionEntry,
  type ClaudeAdoptionPlan,
} from '../adapter/claude-code/adoption.ts';
import { loadProjectManifest, resolveProjectPaths } from '../model/project-manifest.ts';
import { ProjectManifestSchema } from '../model/schemas.ts';
import { resolveScopeMarker, type Scope, type SourceRoot } from '../model/scope.ts';
import type { ProjectManifest, ProjectPaths } from '../model/types.ts';
import { scanProject, type ScanResult } from './scanner.ts';
import {
  renderAgentsMd,
  renderClaudeCodePolicy,
  renderDabYaml,
  renderMemoryIndex,
  renderProjectPolicy,
} from './templates.ts';

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

export interface MinimalSourcePlan {
  files: Record<string, string>;
  directories: string[];
  manifest: ProjectManifest;
}

const MINIMAL_DIRECTORIES = [
  '.agents/agents',
  '.agents/skills',
  '.agents/notes',
  '.agents/rules',
  '.agents/hooks',
] as const;

function minimalManifest(scan: ScanResult, scope: Scope): ProjectManifest {
  return ProjectManifestSchema.parse({
    version: 2,
    scope,
    project: { id: scan.projectId, name: scan.projectName },
    profile: 'feature',
    targets: [{
      provider: 'claude-code',
      enabled: true,
      options: {
        minVersion: MIN_CLAUDE_CODE_VERSION,
        instructions: 'symlink',
      },
    }],
    paths: { agents: '.agents', claude: '.claude' },
  });
}

export function minimalSourcePlan(scan: ScanResult, scope: Scope): MinimalSourcePlan {
  const agentsMd = scope === 'global' ? '.agents/AGENTS.md' : 'AGENTS.md';
  const manifest = scope === 'global' ? '.agents/dab.yaml' : 'dab.yaml';
  return {
    files: {
      [agentsMd]: renderAgentsMd(scan),
      [manifest]: renderDabYaml(scan, scope),
      '.agents/policies/project.yaml': renderProjectPolicy(),
      '.agents/adapters/claude-code.yaml': renderClaudeCodePolicy(),
      '.agents/memory/INDEX.md': renderMemoryIndex(),
    },
    directories: [...MINIMAL_DIRECTORIES],
    manifest: minimalManifest(scan, scope),
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
  claudePlan?: ClaudeAdoptionPlan;
  diagnostics: Diagnostic[];
}

export interface NormalizeAdoptionResult {
  phase: AdoptionPhase;
  sourcePlan?: MinimalSourcePlan;
  sourceActions: string[];
  imports?: ClaudeAdoptionEntry[];
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

export async function prepareNormalizeAdoption(input: {
  cwd: string;
  home: string;
  now?: Date;
}): Promise<NormalizeAdoptionPreparation> {
  const adoption = await resolveAdoptionRoot({ cwd: input.cwd, home: input.home });
  const sourceRoot = sourceRootOf(adoption);
  const manifestKey = toPosix(relative(adoption.root, adoption.manifestPath));
  const hasManifest = (await lstatOrNull(adoption.manifestPath)) !== null;

  if (hasManifest && !adoption.manifestValid) {
    // Re-run the loader so callers receive the exact ConfigError (invalid
    // manifest, scope mismatch, unsupported paths) and nothing is overwritten.
    await loadProjectManifest(adoption.root, { scope: adoption.scope });
    throw new ConfigError(`invalid ${manifestKey}`, 'config.invalid');
  }

  if (hasManifest) {
    const loaded = await loadProjectManifest(adoption.root, { scope: adoption.scope });
    const paths = resolveProjectPaths(adoption.root, loaded.manifest);
    if (adoption.phase === 'initialized') {
      return {
        sourceRoot,
        phase: adoption.phase,
        manifest: loaded.manifest,
        paths,
        claudePlan: await planImports(adoption, loaded.manifest, paths),
        diagnostics: [],
      };
    }
    await assertProjectHomeNotGlobal(adoption, input.home);
    const scan = await scanProject(adoption.root);
    const plan = minimalSourcePlan(scan, adoption.scope);
    // The authored manifest is authoritative: it is never part of the write
    // plan and `plan.manifest` stays equal to what normalize loads afterwards.
    const { [manifestKey]: _authored, ...files } = plan.files;
    return {
      sourceRoot,
      phase: adoption.phase,
      manifest: loaded.manifest,
      paths,
      sourcePlan: { ...plan, files, manifest: loaded.manifest },
      claudePlan: await planImports(adoption, loaded.manifest, paths),
      diagnostics: scan.diagnostics,
    };
  }

  await assertProjectHomeNotGlobal(adoption, input.home);
  const scan = await scanProject(adoption.root);
  const sourcePlan = minimalSourcePlan(scan, adoption.scope);
  const paths = resolveProjectPaths(adoption.root, sourcePlan.manifest);
  return {
    sourceRoot,
    phase: adoption.phase,
    manifest: sourcePlan.manifest,
    paths,
    sourcePlan,
    claudePlan: await planImports(adoption, sourcePlan.manifest, paths),
    diagnostics: scan.diagnostics,
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
 * Init-style containment checks run before the first write. `plan.directories`
 * omits implicitly created parents (policies, adapters, memory), so every
 * planned file is checked as well as the source tree itself.
 */
async function sourceWriteDiagnostics(
  root: string,
  plan: MinimalSourcePlan,
  agents: string,
): Promise<Diagnostic[]> {
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
): Promise<{ actions: string[]; backups: string[]; diagnostics: Diagnostic[] }> {
  const root = prep.sourceRoot.root;
  const actions: string[] = [];
  const backups: string[] = [];
  const diagnostics: Diagnostic[] = [];

  if (prep.sourcePlan !== undefined) {
    const agents = toPosix(relative(root, prep.paths.agents));
    const sourceDiagnostics = await sourceWriteDiagnostics(root, prep.sourcePlan, agents);
    if (sourceDiagnostics.length > 0) {
      return { actions: [], backups: [], diagnostics: sourceDiagnostics };
    }
    let created: string[];
    let skipped: string[];
    if (options.dryRun) {
      const planned = await planSourceWrites(root, prep.sourcePlan);
      created = planned.create;
      skipped = planned.skip;
    } else {
      const written = await writeSourceFiles(root, prep.sourcePlan);
      created = written.created;
      skipped = written.skipped;
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

  return { actions, backups, diagnostics };
}
