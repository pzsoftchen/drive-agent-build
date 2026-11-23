import { realpath } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { Diagnostic } from '../core/diagnostics.ts';
import { DabError } from '../core/errors.ts';
import { lstatOrNull } from '../core/fs-atomic.ts';
import { toPosix } from '../core/paths.ts';
import { DAB_VERSION } from '../core/version.ts';
import {
  planClaudeAdoption,
  type ClaudeAdoptionEntry,
  type ClaudeAdoptionPlan,
} from '../adapter/claude-code/adoption.ts';
import {
  minimalSourcePlan,
  resolveAdoptionRoot,
  type AdoptionPhase,
  type AdoptionRoot,
} from '../init/adoption.ts';
import { scanProject } from '../init/scanner.ts';
import { loadProjectManifest, resolveProjectPaths } from '../model/project-manifest.ts';
import type { ProjectManifest, ProjectPaths } from '../model/types.ts';
import type { SourceRoot } from '../model/scope.ts';
import { checkInstructionEnvironment, checkSecrets } from './checks.ts';
import type { ChecklistEntry } from './checklist.ts';
import { preflightPractice } from './practice.ts';

export interface PreflightResult {
  sourceRoot: SourceRoot;
  phase: AdoptionPhase;
  entries: ChecklistEntry[];
  diagnostics: Diagnostic[];
  /** Manifest profile, or `not initialized` before a valid manifest exists. */
  profile?: string;
}

const HOME_COLLISION_MESSAGE =
  'refusing to adopt project source at $HOME while ~/.agents is the global source root';
const HOME_COLLISION_HINT = 'Run dab normalize from inside ~/.agents to adopt global scope.';

function sourceRootOf(adoption: AdoptionRoot): SourceRoot {
  return {
    scope: adoption.scope,
    root: adoption.root,
    sourceRoot: adoption.sourceRoot,
    manifest: adoption.manifestPath,
    instructions: adoption.instructionsPath,
  };
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

function relativePath(root: string, absolute: string): string {
  return toPosix(relative(root, absolute));
}

/**
 * A project fallback can resolve to `$HOME` (for example a dotfiles git repo).
 * `$HOME/.agents` is the global source root in that case, so a project
 * checklist must not suggest writes that would convert the global source into
 * a project. Mirrors the normalize adoption guard.
 */
async function projectHomeCollision(
  adoption: AdoptionRoot,
  home: string,
): Promise<Diagnostic | undefined> {
  if (adoption.scope !== 'project' || adoption.phase === 'initialized') {
    return undefined;
  }
  if ((await lstatOrNull(join(home, '.agents'))) === null) {
    return undefined;
  }
  if (await canonicalPath(adoption.root) !== await canonicalPath(home)) {
    return undefined;
  }
  return {
    code: 'config.source-root-nested',
    severity: 'error',
    message: HOME_COLLISION_MESSAGE,
    file: relativePath(adoption.root, adoption.manifestPath),
    hint: HOME_COLLISION_HINT,
  };
}

async function exists(root: string, path: string): Promise<boolean> {
  return (await lstatOrNull(join(root, path))) !== null;
}

async function existenceEntry(input: {
  root: string;
  path: string;
  group: string;
  next?: string;
}): Promise<ChecklistEntry> {
  const present = await exists(input.root, input.path);
  if (present) {
    return { group: input.group, label: input.path, status: 'ok' };
  }
  return {
    group: input.group,
    label: input.path,
    status: 'missing',
    ...(input.next === undefined ? {} : { next: input.next }),
  };
}

function importEntry(
  entry: ClaudeAdoptionEntry,
  group: string,
  next: string | undefined,
): ChecklistEntry {
  return {
    group,
    label: entry.source,
    status: 'importable',
    detail: entry.target,
    ...(next === undefined ? {} : { next }),
  };
}

function errorDiagnostic(error: DabError, file: string): Diagnostic {
  return {
    code: error.code,
    severity: 'error',
    message: error.message,
    file,
    ...(error.hint === undefined ? {} : { hint: error.hint }),
  };
}

async function plannedEntries(input: {
  root: string;
  scope: SourceRoot['scope'];
  paths: ProjectPaths;
  manifestPath: string;
  hasManifest: boolean;
  manifestValid: boolean;
  claudePlan: ClaudeAdoptionPlan;
}): Promise<ChecklistEntry[]> {
  const { root, scope, paths, claudePlan } = input;
  const agents = relativePath(root, paths.agents);
  // An authored manifest that cannot be parsed must be fixed before normalize
  // can run, so a blocked preflight does not suggest the adoption command.
  const next = input.hasManifest && !input.manifestValid ? undefined : 'dab normalize';
  const entries: ChecklistEntry[] = [
    await existenceEntry({
      root,
      path: relativePath(root, paths.instructions),
      group: 'Instructions',
      ...(next === undefined ? {} : { next }),
    }),
    await existenceEntry({
      root,
      path: `${agents}/agents/`,
      group: 'Agents',
      ...(next === undefined ? {} : { next }),
    }),
    ...claudePlan.entries
      .filter((entry) => entry.kind === 'agent')
      .map((entry) => importEntry(
        entry,
        'Agents',
        next === undefined ? undefined : 'dab normalize --dry-run',
      )),
    await existenceEntry({
      root,
      path: `${agents}/skills/`,
      group: 'Skills',
      ...(next === undefined ? {} : { next }),
    }),
    ...claudePlan.entries
      .filter((entry) => entry.kind === 'skill')
      .map((entry) => importEntry(
        entry,
        'Skills',
        next === undefined ? undefined : 'dab normalize --dry-run',
      )),
    await existenceEntry({
      root,
      path: `${agents}/rules/`,
      group: 'Rules',
      ...(next === undefined ? {} : { next }),
    }),
    await existenceEntry({
      root,
      path: `${agents}/policies/project.yaml`,
      group: 'Policy',
      ...(next === undefined ? {} : { next }),
    }),
    await existenceEntry({
      root,
      path: `${agents}/adapters/claude-code.yaml`,
      group: 'Policy',
      ...(next === undefined ? {} : { next }),
    }),
    await existenceEntry({
      root,
      path: `${agents}/hooks/`,
      group: 'Hooks',
      ...(next === undefined ? {} : { next }),
    }),
    await existenceEntry({
      root,
      path: `${agents}/memory/INDEX.md`,
      group: 'Memory',
      ...(next === undefined ? {} : { next }),
    }),
    await existenceEntry({
      root,
      path: `${agents}/notes/`,
      group: 'Notes',
      ...(next === undefined ? {} : { next }),
    }),
  ];

  if (!input.hasManifest) {
    entries.push({
      group: 'Generated target',
      label: input.manifestPath,
      status: 'missing',
      ...(next === undefined ? {} : { next }),
    });
  } else if (input.manifestValid) {
    entries.push({ group: 'Generated target', label: input.manifestPath, status: 'ok' });
  }
  // An authored but invalid manifest is reported by its diagnostic entry.

  // Global settings are user-owned and never generated by DAB.
  if (scope === 'project') {
    const settings = relativePath(root, join(paths.claude, 'settings.json'));
    entries.push(await exists(root, settings)
      ? {
        group: 'Generated target',
        label: settings,
        status: 'warn',
        detail: 'existing settings are not managed until normalize',
      }
      : {
        group: 'Generated target',
        label: settings,
        status: 'missing',
        ...(next === undefined ? {} : { next }),
      });
  }

  return entries;
}

/**
 * Read-only preflight for uninitialized and partial scopes. Builds the same
 * minimal source plan normalize would adopt and a dry-run Claude import plan;
 * it never writes to `.agents`, `.claude`, `$HOME`, settings or `.gitignore`.
 */
export async function preflightProject(
  input: { cwd: string; home: string },
): Promise<PreflightResult> {
  const home = resolve(input.home);
  const adoption = await resolveAdoptionRoot({ cwd: input.cwd, home });
  const sourceRoot = sourceRootOf(adoption);
  const collision = await projectHomeCollision(adoption, home);
  if (collision !== undefined) {
    return {
      sourceRoot,
      phase: adoption.phase,
      entries: [{
        group: 'Safety',
        label: 'source root',
        status: 'error',
        detail: HOME_COLLISION_MESSAGE,
        file: relativePath(adoption.root, adoption.manifestPath),
      }],
      diagnostics: [collision],
      profile: 'not initialized',
    };
  }

  const scan = await scanProject(adoption.root);
  const sourcePlan = minimalSourcePlan(scan, adoption.scope);
  const manifestPath = relativePath(adoption.root, adoption.manifestPath);
  const hasManifest = await exists(adoption.root, manifestPath);
  const diagnostics: Diagnostic[] = [...scan.diagnostics];

  let manifest = sourcePlan.manifest;
  let manifestValid = false;
  let validManifest: ProjectManifest | undefined;
  if (hasManifest) {
    try {
      const loaded = await loadProjectManifest(adoption.root, { scope: adoption.scope });
      manifest = loaded.manifest;
      manifestValid = true;
      validManifest = loaded.manifest;
    } catch (error) {
      if (!(error instanceof DabError)) {
        throw error;
      }
      diagnostics.push(errorDiagnostic(error, manifestPath));
    }
  }

  const paths = resolveProjectPaths(adoption.root, manifest);
  const claudePlan = await planClaudeAdoption({
    root: adoption.root,
    scope: adoption.scope,
    agentsRoot: paths.agents,
    claudeRoot: paths.claude,
    manifest,
  });
  diagnostics.push(...claudePlan.diagnostics);
  diagnostics.push(
    ...await checkInstructionEnvironment(adoption.root, home, adoption.scope),
  );
  diagnostics.push(...await checkSecrets(adoption.root, paths));

  const entries = await plannedEntries({
    root: adoption.root,
    scope: adoption.scope,
    paths,
    manifestPath,
    hasManifest,
    manifestValid,
    claudePlan,
  });

  const practice = await preflightPractice({
    root: adoption.root,
    scope: adoption.scope,
    scan,
    // An authored manifest that cannot be parsed must be fixed first; a scope
    // without a manifest can still adopt through `dab normalize`.
    suppressNext: hasManifest && !manifestValid,
    version: DAB_VERSION,
    ...(validManifest === undefined ? {} : { manifest: validManifest }),
  });
  diagnostics.push(...practice.diagnostics);
  entries.push(...practice.entries);

  return {
    sourceRoot,
    phase: adoption.phase,
    entries,
    diagnostics,
    profile: manifestValid ? manifest.profile : 'not initialized',
  };
}
