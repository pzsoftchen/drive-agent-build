import type { Stats } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { hasErrors, type Diagnostic } from '../core/diagnostics.ts';
import { DabError } from '../core/errors.ts';
import { assertParentInsideRoot, assertRelativePath } from '../core/paths.ts';
import { MIN_CLAUDE_CODE_VERSION } from '../core/version-check.ts';
import { ProjectManifestSchema } from '../model/schemas.ts';
import type { ProjectManifest } from '../model/types.ts';
import { minimalSourcePlan } from './adoption.ts';
import type { AiProposalAgent } from './ai-proposal.ts';
import { resolveDocsLanguage, type DocsLanguageResolution } from './docs-language.ts';
import { authoringPack } from './practice-authoring.ts';
import { documentationPack } from './practice-docs.ts';
import type { ScanResult } from './scanner.ts';
import { renderAgentFromProposal, templateFiles } from './templates.ts';

export type ResolvedProfile = 'generic' | 'feature';
export type ScaffoldMode = 'full' | 'adoption' | 'converge';

export interface AuthoredScaffoldInput {
  root: string;
  scope: 'project' | 'global';
  scan: ScanResult;
  profile: ResolvedProfile;
  mode: ScaffoldMode;
  manifest?: ProjectManifest;
  proposals?: { agentsMdAddition?: string; agents?: AiProposalAgent[] };
  version: string;
  env?: NodeJS.ProcessEnv;
}

export interface PracticeContext {
  root: string;
  scope: 'project' | 'global';
  scan: ScanResult;
  profile: ResolvedProfile;
  mode: ScaffoldMode;
  manifest?: ProjectManifest;
  proposals?: AuthoredScaffoldInput['proposals'];
  version: string;
  anchors: ReadonlySet<string>;
  docsLanguage: DocsLanguageResolution;
}

export interface PracticeTargetSet {
  paths: string[];
  /** Directories to create only when missing. Existing ones never hide child files. */
  directories?: string[];
  policySkipped?: string[];
  /**
   * Declared skill-directory parents. When one exists, it is skipped and every
   * declared file below it is excluded from the plan (the user owns the tree).
   */
  skipChildrenWhenExists?: string[];
}

export interface PracticePack {
  id: string;
  targets(context: PracticeContext): PracticeTargetSet | Promise<PracticeTargetSet>;
  files(context: PracticeContext): Record<string, string> | Promise<Record<string, string>>;
  directories?(context: PracticeContext): string[] | Promise<string[]>;
}

export interface AuthoredScaffoldPlan {
  profile: ResolvedProfile;
  mode: ScaffoldMode;
  files: Record<string, string>;
  directories: string[];
  skipped: string[];
  policySkipped: string[];
  diagnostics: Diagnostic[];
  manifest?: ProjectManifest;
  docsLanguage: DocsLanguageResolution;
}

const FULL_CORE_DIRECTORIES = ['.agents/notes'] as const;

function proposalFiles(
  proposals: AuthoredScaffoldInput['proposals'],
): Record<string, string> {
  const files: Record<string, string> = {};
  for (const agent of proposals?.agents ?? []) {
    files[`.agents/agents/${agent.name}.md`] = renderAgentFromProposal(agent);
  }
  return files;
}

/**
 * Root AGENTS.md is core-owned. Anchors contain existing paths plus planned
 * paths that are not policy-skipped, so the Documentation links only appear
 * when the docs exist or this plan creates them.
 */
function documentationAnchored(context: PracticeContext): boolean {
  return context.scope === 'project'
    && (context.anchors.has('docs/AGENTS.md') || context.anchors.has('docs/architecture.md'));
}

function fullCoreFiles(context: PracticeContext): Record<string, string> {
  return {
    ...templateFiles(context.scan, context.scope, context.proposals?.agentsMdAddition, {
      profile: context.profile,
      documentation: documentationAnchored(context),
    }),
    ...proposalFiles(context.proposals),
  };
}

function manifestFilePath(scope: 'project' | 'global'): string {
  return scope === 'global' ? '.agents/dab.yaml' : 'dab.yaml';
}

function adoptionCoreFiles(
  context: PracticeContext,
  files: Record<string, string>,
): Record<string, string> {
  if (context.manifest === undefined) {
    return files;
  }
  const { [manifestFilePath(context.scope)]: _authored, ...rest } = files;
  return rest;
}

function adoptionFiles(context: PracticeContext): Record<string, string> {
  return adoptionCoreFiles(context, minimalSourcePlan(context.scan, context.scope).files);
}

export const corePack: PracticePack = {
  id: 'core',
  targets(context) {
    if (context.mode === 'full') {
      return {
        paths: Object.keys(fullCoreFiles(context)),
        directories: [...FULL_CORE_DIRECTORIES],
      };
    }
    if (context.mode === 'adoption') {
      return {
        paths: Object.keys(adoptionFiles(context)),
        directories: minimalSourcePlan(context.scan, context.scope).directories,
      };
    }
    return { paths: [] };
  },
  files(context) {
    if (context.mode === 'full') {
      return fullCoreFiles(context);
    }
    if (context.mode === 'adoption') {
      return adoptionFiles(context);
    }
    return {};
  },
};

/**
 * Production pack registry. Callers pass this list explicitly so a new pack can
 * never be silently omitted by the planner's core-only default.
 */
export const PRACTICE_PACKS: readonly PracticePack[] = [
  corePack,
  documentationPack,
  authoringPack,
];

function templateManifest(input: AuthoredScaffoldInput): ProjectManifest | undefined {
  if (input.mode === 'converge') {
    return undefined;
  }
  if (input.mode === 'adoption') {
    return minimalSourcePlan(input.scan, input.scope).manifest;
  }
  return ProjectManifestSchema.parse({
    version: 2,
    scope: input.scope,
    project: { id: input.scan.projectId, name: input.scan.projectName },
    profile: input.profile,
    docs: { language: 'auto' },
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

function errorDiagnostic(error: DabError, file: string): Diagnostic {
  return {
    code: error.code,
    severity: 'error',
    message: error.message,
    file,
    ...(error.hint === undefined ? {} : { hint: error.hint }),
  };
}

function pathConflict(file: string, message: string): Diagnostic {
  return {
    code: 'path.conflict',
    severity: 'error',
    message,
    file,
    hint: 'Rename or remove the conflicting path; DAB never overwrites authored files.',
  };
}

function normalizeDeclared(
  raw: string,
  kind: 'target' | 'directory' | 'policy skip',
  diagnostics: Diagnostic[],
): string | undefined {
  let normalized: string;
  try {
    normalized = assertRelativePath(raw, `practice ${kind}`);
  } catch (error) {
    if (error instanceof DabError) {
      diagnostics.push(errorDiagnostic(error, raw));
      return undefined;
    }
    throw error;
  }
  if (normalized === '.claude' || normalized.startsWith('.claude/')) {
    diagnostics.push(
      pathConflict(normalized, `authored planner never touches generated paths: ${normalized}`),
    );
    return undefined;
  }
  return normalized;
}

type StatResult =
  | { ok: true; info: Stats | null }
  | { ok: false; message: string };

async function statTarget(root: string, relativePath: string): Promise<StatResult> {
  try {
    return { ok: true, info: await lstat(join(root, relativePath)) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { ok: true, info: null };
    }
    if (code === 'ENOTDIR') {
      return { ok: false, message: 'a parent component is not a directory' };
    }
    throw error;
  }
}

function isUnder(path: string, directory: string): boolean {
  return path.startsWith(`${directory}/`);
}

function isUnderAny(path: string, directories: ReadonlySet<string>): boolean {
  for (const directory of directories) {
    if (isUnder(path, directory)) {
      return true;
    }
  }
  return false;
}

function normalizedArgument(value: string): string {
  return assertRelativePath(value, 'practice path');
}

interface BlockedReporting {
  directories: string[];
  skipped: string[];
  policySkipped: string[];
}

function blockedPlan(
  input: AuthoredScaffoldInput,
  docsLanguage: DocsLanguageResolution,
  manifest: ProjectManifest | undefined,
  diagnostics: Diagnostic[],
  reporting: BlockedReporting,
): AuthoredScaffoldPlan {
  return {
    profile: input.profile,
    mode: input.mode,
    // The plan is blocked before files() runs, so no content is planned. The
    // reporting lists stay populated for dry-run/blocked output consumers.
    files: {},
    directories: reporting.directories,
    skipped: reporting.skipped,
    policySkipped: reporting.policySkipped,
    diagnostics,
    ...(manifest === undefined ? {} : { manifest }),
    docsLanguage,
  };
}

/**
 * Plan authored (`.agents/` and project docs) files without writing anything.
 * The only reads are language detection samples and filesystem metadata.
 *
 * Packs are supplied by the caller so tests and the future docs/authoring
 * packs can compose an exact plan. Production callers use the core pack only
 * until the pack registry grows.
 */
export async function planAuthoredScaffold(
  input: AuthoredScaffoldInput,
  packs: readonly PracticePack[] = [corePack],
): Promise<AuthoredScaffoldPlan> {
  const docsLanguage = await resolveDocsLanguage({
    root: input.root,
    configured: input.manifest?.docs.language ?? 'auto',
    env: input.env ?? process.env,
  });
  const manifest = input.manifest ?? templateManifest(input);
  const baseContext: PracticeContext = {
    root: input.root,
    scope: input.scope,
    scan: input.scan,
    profile: input.profile,
    mode: input.mode,
    version: input.version,
    anchors: new Set<string>(),
    docsLanguage,
    ...(input.manifest === undefined ? {} : { manifest: input.manifest }),
    ...(input.proposals === undefined ? {} : { proposals: input.proposals }),
  };

  const diagnostics: Diagnostic[] = [];
  const invalid = new Set<string>();

  const candidateFiles: string[] = [];
  const candidateFileSet = new Set<string>();
  const declaredDirectories: string[] = [];
  const declaredDirectorySet = new Set<string>();
  const skipChildren: string[] = [];
  const skipChildrenSet = new Set<string>();
  const policySkipped: string[] = [];
  const policySkippedSet = new Set<string>();

  function addUnique(list: string[], seen: Set<string>, value: string): void {
    if (!seen.has(value)) {
      seen.add(value);
      list.push(value);
    }
  }

  for (const pack of packs) {
    const targets = await pack.targets(baseContext);
    for (const raw of targets.paths) {
      const path = normalizeDeclared(raw, 'target', diagnostics);
      if (path !== undefined) {
        addUnique(candidateFiles, candidateFileSet, path);
      }
    }
    for (const raw of targets.directories ?? []) {
      const path = normalizeDeclared(raw, 'directory', diagnostics);
      if (path !== undefined) {
        addUnique(declaredDirectories, declaredDirectorySet, path);
      }
    }
    for (const raw of targets.policySkipped ?? []) {
      const path = normalizeDeclared(raw, 'policy skip', diagnostics);
      if (path !== undefined) {
        addUnique(policySkipped, policySkippedSet, path);
      }
    }
    for (const raw of targets.skipChildrenWhenExists ?? []) {
      const path = normalizeDeclared(raw, 'directory', diagnostics);
      if (path !== undefined) {
        addUnique(skipChildren, skipChildrenSet, path);
      }
    }
  }

  for (const path of candidateFiles) {
    if (declaredDirectorySet.has(path) || skipChildrenSet.has(path)) {
      diagnostics.push(
        pathConflict(path, `practice path is declared as both a file and a directory: ${path}`),
      );
      invalid.add(path);
    }
  }

  // User-owned skill directories win only for the paths their pack marks as
  // skipChildrenWhenExists. Other declared directories never hide children.
  const skipStats = new Map<string, Stats | null>();
  const existingSkipDirectories = new Set<string>();
  const skipped: string[] = [];
  const skippedSet = new Set<string>();
  const existing = new Set<string>();

  function addSkipped(path: string): void {
    if (!skippedSet.has(path)) {
      skippedSet.add(path);
      skipped.push(path);
    }
  }

  for (const directory of skipChildren) {
    if (invalid.has(directory)) {
      continue;
    }
    const result = await statTarget(input.root, directory);
    if (!result.ok) {
      diagnostics.push(pathConflict(directory, `${directory}: ${result.message}`));
      invalid.add(directory);
      continue;
    }
    skipStats.set(directory, result.info);
    if (result.info === null) {
      continue;
    }
    if (!result.info.isDirectory() && !result.info.isSymbolicLink()) {
      diagnostics.push(
        pathConflict(directory, `practice directory target is not a directory: ${directory}`),
      );
      invalid.add(directory);
      continue;
    }
    existing.add(directory);
    existingSkipDirectories.add(directory);
    addSkipped(directory);
  }

  const checkedParents = new Set<string>();
  async function checkParents(paths: Iterable<string>): Promise<void> {
    for (const path of paths) {
      if (invalid.has(path) || checkedParents.has(path)) {
        continue;
      }
      if (isUnderAny(path, existingSkipDirectories)) {
        continue;
      }
      checkedParents.add(path);
      try {
        await assertParentInsideRoot(input.root, path);
      } catch (error) {
        if (error instanceof DabError) {
          diagnostics.push(errorDiagnostic(error, path));
          invalid.add(path);
        } else {
          throw error;
        }
      }
    }
  }

  await checkParents(candidateFiles);
  await checkParents(declaredDirectories);

  const plannedDirectories: string[] = [];
  const processedDirectories = new Set<string>();
  for (const directory of declaredDirectories) {
    if (invalid.has(directory) || processedDirectories.has(directory)) {
      continue;
    }
    processedDirectories.add(directory);
    if (existingSkipDirectories.has(directory)) {
      continue;
    }
    if (isUnderAny(directory, existingSkipDirectories)) {
      continue;
    }
    const cached = skipStats.get(directory);
    const result = cached === undefined
      ? await statTarget(input.root, directory)
      : { ok: true as const, info: cached };
    if (!result.ok) {
      diagnostics.push(pathConflict(directory, `${directory}: ${result.message}`));
      invalid.add(directory);
      continue;
    }
    if (result.info === null) {
      plannedDirectories.push(directory);
      continue;
    }
    if (!result.info.isDirectory() && !result.info.isSymbolicLink()) {
      diagnostics.push(
        pathConflict(directory, `practice directory target is not a directory: ${directory}`),
      );
      invalid.add(directory);
      continue;
    }
    existing.add(directory);
    addSkipped(directory);
  }

  const plannedFiles: string[] = [];
  const plannedFileSet = new Set<string>();
  for (const path of candidateFiles) {
    if (invalid.has(path) || isUnderAny(path, existingSkipDirectories)) {
      continue;
    }
    const result = await statTarget(input.root, path);
    if (!result.ok) {
      diagnostics.push(pathConflict(path, `${path}: ${result.message}`));
      invalid.add(path);
      continue;
    }
    if (result.info === null) {
      plannedFiles.push(path);
      plannedFileSet.add(path);
      continue;
    }
    if (result.info.isDirectory()) {
      diagnostics.push(
        pathConflict(path, `practice file target is a directory: ${path}`),
      );
      invalid.add(path);
      continue;
    }
    existing.add(path);
    addSkipped(path);
  }

  const directories = plannedDirectories.filter(
    (directory) => !policySkippedSet.has(directory),
  );

  if (hasErrors(diagnostics)) {
    return blockedPlan(input, docsLanguage, manifest, diagnostics, {
      directories,
      skipped,
      policySkipped,
    });
  }

  const anchors = new Set<string>(existing);
  for (const path of plannedFiles) {
    if (!policySkippedSet.has(path)) {
      anchors.add(path);
    }
  }
  for (const directory of plannedDirectories) {
    if (!policySkippedSet.has(directory)) {
      anchors.add(directory);
    }
  }

  const finalContext: PracticeContext = { ...baseContext, anchors };

  const files: Record<string, string> = {};
  for (const pack of packs) {
    const contents = await pack.files(finalContext);
    for (const [rawKey, content] of Object.entries(contents)) {
      let key: string;
      try {
        key = normalizedArgument(rawKey);
      } catch {
        // Generated content for an undeclared or invalid path is never planned.
        continue;
      }
      if (!plannedFileSet.has(key) || policySkippedSet.has(key)) {
        continue;
      }
      files[key] = content;
    }
  }

  const seenDirectories = new Set<string>(declaredDirectorySet);
  for (const directory of skipChildren) {
    seenDirectories.add(directory);
  }
  for (const pack of packs) {
    const extra = await pack.directories?.(finalContext);
    for (const raw of extra ?? []) {
      const directory = normalizeDeclared(raw, 'directory', diagnostics);
      if (directory === undefined || seenDirectories.has(directory)) {
        continue;
      }
      seenDirectories.add(directory);
      if (invalid.has(directory) || policySkippedSet.has(directory)) {
        continue;
      }
      if (isUnderAny(directory, existingSkipDirectories)) {
        continue;
      }
      if (!checkedParents.has(directory)) {
        checkedParents.add(directory);
        try {
          await assertParentInsideRoot(input.root, directory);
        } catch (error) {
          if (error instanceof DabError) {
            diagnostics.push(errorDiagnostic(error, directory));
            invalid.add(directory);
            continue;
          }
          throw error;
        }
      }
      const result = await statTarget(input.root, directory);
      if (!result.ok) {
        diagnostics.push(pathConflict(directory, `${directory}: ${result.message}`));
        invalid.add(directory);
        continue;
      }
      if (result.info === null) {
        directories.push(directory);
        continue;
      }
      if (!result.info.isDirectory() && !result.info.isSymbolicLink()) {
        diagnostics.push(
          pathConflict(directory, `practice directory target is not a directory: ${directory}`),
        );
        invalid.add(directory);
      }
    }
  }

  if (hasErrors(diagnostics)) {
    return blockedPlan(input, docsLanguage, manifest, diagnostics, {
      directories,
      skipped,
      policySkipped,
    });
  }

  return {
    profile: input.profile,
    mode: input.mode,
    files,
    directories,
    skipped,
    policySkipped,
    diagnostics,
    ...(manifest === undefined ? {} : { manifest }),
    docsLanguage,
  };
}
