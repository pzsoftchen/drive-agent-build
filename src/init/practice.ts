import type { Stats } from 'node:fs';
import { join } from 'node:path';
import { hasErrors, type Diagnostic } from '../core/diagnostics.ts';
import { DabError } from '../core/errors.ts';
import { assertParentInsideRoot, assertRelativePath } from '../core/paths.ts';
import { MIN_CLAUDE_CODE_VERSION } from '../core/version-check.ts';
import { ProjectManifestSchema } from '../model/schemas.ts';
import type { ProjectManifest } from '../model/types.ts';
import type { AiProposalAgent } from './ai-proposal.ts';
import { resolveDocsLanguage, type DocsLanguageResolution } from './docs-language.ts';
import { minimalSourcePlan } from './minimal-source.ts';
import { authoringPack } from './practice-authoring.ts';
import { verificationPack } from './practice-gates.ts';
import { documentationPack } from './practice-docs.ts';
import {
  authoredDirectoryState,
  authoredFileProblem,
  pathProblemFrom,
  probeLstat,
  problemMessage,
} from '../core/practice-paths.ts';
import type { ScanResult } from './scanner.ts';
import { renderAgentFromProposal, renderAgentsMd, templateFiles, type DocumentationLinks } from './templates.ts';

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
  /** Declared targets the project policy skips; never validated or rendered. */
  policySkipped: ReadonlySet<string>;
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

const DOCS_AGENTS = 'docs/AGENTS.md';
const DOCS_ARCHITECTURE = 'docs/architecture.md';

/**
 * Root AGENTS.md is core-owned. Anchors contain existing paths plus planned
 * paths that are not policy-skipped, so each Documentation link only appears
 * when that doc exists or this plan creates it. A declared policy skip means
 * the project owns its docs, so no Documentation section is rendered at all.
 */
function documentationLinks(context: PracticeContext): DocumentationLinks | undefined {
  if (context.scope !== 'project') {
    return undefined;
  }
  return {
    agents: !context.policySkipped.has(DOCS_AGENTS) && context.anchors.has(DOCS_AGENTS),
    architecture: !context.policySkipped.has(DOCS_ARCHITECTURE)
      && context.anchors.has(DOCS_ARCHITECTURE),
  };
}

function fullCoreFiles(context: PracticeContext): Record<string, string> {
  const documentation = documentationLinks(context);
  return {
    ...templateFiles(context.scan, context.scope, context.proposals?.agentsMdAddition, {
      profile: context.profile,
      ...(documentation === undefined ? {} : { documentation }),
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
  const plan = minimalSourcePlan(context.scan, context.scope);
  const files = adoptionCoreFiles(context, plan.files);
  const agentsMd = context.scope === 'global' ? '.agents/AGENTS.md' : 'AGENTS.md';
  const documentation = documentationLinks(context);
  if (files[agentsMd] !== undefined && documentation !== undefined) {
    files[agentsMd] = renderAgentsMd(context.scan, undefined, { documentation });
  }
  return files;
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
  verificationPack,
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
  const result = await probeLstat(join(root, relativePath));
  if (result.problem !== undefined) {
    return { ok: false, message: problemMessage(relativePath, result.problem) };
  }
  return { ok: true, info: result.info };
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
 * The only reads are language detection samples, metadata probes and the
 * readability check for existing targets.
 *
 * Packs are supplied by the caller so tests can compose an exact plan;
 * production callers pass the explicit `PRACTICE_PACKS` registry.
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
    policySkipped: new Set<string>(),
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
    const state = await authoredDirectoryState(input.root, directory);
    if (state.kind === 'conflict') {
      diagnostics.push(pathConflict(directory, state.message));
      invalid.add(directory);
      continue;
    }
    if (state.kind === 'missing') {
      continue;
    }
    existing.add(directory);
    existingSkipDirectories.add(directory);
    addSkipped(directory);
  }

  const checkedParents = new Set<string>();
  async function checkParents(paths: Iterable<string>): Promise<void> {
    for (const path of paths) {
      if (
        invalid.has(path)
        || checkedParents.has(path)
        || policySkippedSet.has(path)
      ) {
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
          continue;
        }
        const problem = pathProblemFrom(error);
        if (problem === undefined) {
          throw error;
        }
        diagnostics.push(pathConflict(path, problemMessage(path, problem)));
        invalid.add(path);
      }
    }
  }

  await checkParents(candidateFiles);
  await checkParents(declaredDirectories);

  const plannedDirectories: string[] = [];
  const processedDirectories = new Set<string>();
  for (const directory of declaredDirectories) {
    if (
      invalid.has(directory)
      || processedDirectories.has(directory)
      || policySkippedSet.has(directory)
    ) {
      continue;
    }
    processedDirectories.add(directory);
    if (existingSkipDirectories.has(directory)) {
      continue;
    }
    if (isUnderAny(directory, existingSkipDirectories)) {
      continue;
    }
    const state = await authoredDirectoryState(input.root, directory);
    if (state.kind === 'conflict') {
      diagnostics.push(pathConflict(directory, state.message));
      invalid.add(directory);
      continue;
    }
    if (state.kind === 'missing') {
      plannedDirectories.push(directory);
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
    if (policySkippedSet.has(path)) {
      // Policy-skipped targets are never validated or written. An existing
      // authored path is preserved as skipped; a missing one is reported as a
      // policy skip. Path-state errors are ignored so a dangling or unreadable
      // docs path cannot block unrelated skills and targets.
      if ((await probeLstat(join(input.root, path))).info !== null) {
        addSkipped(path);
      }
      continue;
    }
    const result = await statTarget(input.root, path);
    if (!result.ok) {
      diagnostics.push(pathConflict(path, result.message));
      invalid.add(path);
      continue;
    }
    if (result.info === null) {
      plannedFiles.push(path);
      plannedFileSet.add(path);
      continue;
    }
    const problem = await authoredFileProblem(input.root, path);
    if (problem !== undefined) {
      diagnostics.push(pathConflict(path, problem));
      invalid.add(path);
      continue;
    }
    existing.add(path);
    addSkipped(path);
  }

  const directories = plannedDirectories.filter(
    (directory) => !policySkippedSet.has(directory),
  );
  // Existing policy-skipped docs are preserved (skipped); only a missing
  // target is a policy skip, so the two lists stay disjoint.
  const reportedPolicySkipped = policySkipped.filter((path) => !skippedSet.has(path));

  if (hasErrors(diagnostics)) {
    return blockedPlan(input, docsLanguage, manifest, diagnostics, {
      directories,
      skipped,
      policySkipped: reportedPolicySkipped,
    });
  }

  // Core AGENTS.md is not a target in converge mode, but pack templates link
  // it when present. Anchor an existing file without planning or writing it;
  // absence keeps templates on the plain inline form.
  const coreAgents = input.scope === 'global' ? '.agents/AGENTS.md' : 'AGENTS.md';
  if ((await probeLstat(join(input.root, coreAgents))).info !== null) {
    existing.add(coreAgents);
  }

  const anchors = new Set<string>();
  for (const path of existing) {
    if (!policySkippedSet.has(path)) {
      anchors.add(path);
    }
  }
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

  const finalContext: PracticeContext = {
    ...baseContext,
    anchors,
    policySkipped: new Set(policySkippedSet),
  };

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
          const problem = pathProblemFrom(error);
          if (problem === undefined) {
            throw error;
          }
          diagnostics.push(pathConflict(directory, problemMessage(directory, problem)));
          invalid.add(directory);
          continue;
        }
      }
      const state = await authoredDirectoryState(input.root, directory);
      if (state.kind === 'conflict') {
        diagnostics.push(pathConflict(directory, state.message));
        invalid.add(directory);
        continue;
      }
      if (state.kind === 'missing') {
        directories.push(directory);
      }
    }
  }

  if (hasErrors(diagnostics)) {
    return blockedPlan(input, docsLanguage, manifest, diagnostics, {
      directories,
      skipped,
      policySkipped: reportedPolicySkipped,
    });
  }

  return {
    profile: input.profile,
    mode: input.mode,
    files,
    directories,
    skipped,
    policySkipped: reportedPolicySkipped,
    diagnostics,
    ...(manifest === undefined ? {} : { manifest }),
    docsLanguage,
  };
}
