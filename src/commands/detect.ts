import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import type { CommandRunner } from '../core/command.ts';
import {
  hasErrors,
  sortDiagnostics,
  type Diagnostic,
} from '../core/diagnostics.ts';
import { DabError } from '../core/errors.ts';
import { ExitCode } from '../core/exit-codes.ts';
import { contractJson } from '../core/json.ts';
import {
  probeLstat,
  sourceParentDiagnostic,
  sourceParentProblems,
} from '../core/practice-paths.ts';
import { DAB_VERSION } from '../core/version.ts';
import {
  assertRealPathInsideRoot,
  assertRealPathsDisjoint,
  toPosix,
} from '../core/paths.ts';
import { assertSupportedPlatform } from '../core/platform.ts';
import { getTargetAdapter } from '../adapter/registry.ts';
import {
  planClaudeAdoption,
  type ClaudeAdoptionEntry,
} from '../adapter/claude-code/adoption.ts';
import type {
  TargetDetectOutcome,
  TargetFactKind,
  TargetFactStatus,
} from '../adapter/types.ts';
import {
  checkAgentHooks,
  checkAgentsMdState,
  checkHookSafety,
  checkInstructionEnvironment,
  checkMemory,
  checkSecrets,
} from '../detect/checks.ts';
import {
  buildChecklist,
  formatChecklist,
  type ChecklistEntry,
  type ChecklistStatus,
} from '../detect/checklist.ts';
import {
  checkPracticePackages,
  isAuthoringSkillName,
  PRACTICE_NON_STRICT_WARNING_CODES,
} from '../detect/practice.ts';
import { preflightProject, type PreflightResult } from '../detect/preflight.ts';
import { resolveAdoptionRoot, type AdoptionPhase } from '../init/adoption.ts';
import { discoverSourceFacts } from '../model/facts.ts';
import {
  getEnabledTargets,
  getGeneratedTarget,
  loadProjectManifest,
  resolveProjectPaths,
} from '../model/project-manifest.ts';
import type { Scope, SourceRoot } from '../model/scope.ts';
import type { ProjectPaths } from '../model/types.ts';

export interface DetectOptions {
  cwd: string;
  json?: boolean;
  strict?: boolean;
  runner?: CommandRunner;
  platform?: NodeJS.Platform;
  home?: string;
  now?: Date;
}

export interface DetectResult {
  ok: boolean;
  exitCode: ExitCode;
  diagnostics: Diagnostic[];
  targets: TargetDetectOutcome[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
  };
  scope: Scope;
  root: string;
  phase: AdoptionPhase;
  checklist: ChecklistEntry[];
  score: { ok: number; total: number; percent: number };
  nextActions: string[];
  profile?: string;
}

export interface DetectIO {
  stdout: (value: string) => void;
  stderr: (value: string) => void;
}

function summarize(diagnostics: readonly Diagnostic[]): DetectResult['summary'] {
  return {
    errors: diagnostics.filter((item) => item.severity === 'error').length,
    warnings: diagnostics.filter((item) => item.severity === 'warning').length,
    info: diagnostics.filter((item) => item.severity === 'info').length,
  };
}

function dedupe(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((item) => {
    const key = [
      item.code,
      item.severity,
      item.file ?? '',
      item.line ?? '',
      item.message,
    ].join('|');
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

const ENVIRONMENT_WARNING_CODES = new Set(['backend.missing']);

const GROUP_BY_KIND: Record<TargetFactKind, string> = {
  instructions: 'Instructions',
  agent: 'Agents',
  skill: 'Skills',
  rule: 'Rules',
  policy: 'Policy',
  hook: 'Hooks',
};

const INSTRUCTION_OUTPUT = '.claude/CLAUDE.md';

const SAFETY_CODE_PREFIXES = ['secret.', 'path.', 'scan.', 'backend.'] as const;

const CODE_GROUP_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['claude-md.', 'Instructions'],
  ['agents-md.', 'Instructions'],
  ['agent.', 'Agents'],
  ['skill.', 'Skills'],
  ['rule.', 'Rules'],
  ['policy.', 'Policy'],
  ['hook.', 'Hooks'],
  ['memory.', 'Memory'],
  ['generated.', 'Generated target'],
  ['claude-settings.', 'Generated target'],
  ['target.', 'Generated target'],
  ['config.', 'Generated target'],
];

/**
 * Codes that already have a dedicated checklist entry built by the phase
 * pipeline; mapping them again would duplicate the same problem.
 */
const REPRESENTED_CODES = new Set(['agents-md.missing', 'config.source-root-nested']);

function groupForFile(file: string): string | undefined {
  if (
    file === 'AGENTS.md'
    || file === '.agents/AGENTS.md'
    || file === 'CLAUDE.md'
    || file === 'CLAUDE.local.md'
    || file === INSTRUCTION_OUTPUT
  ) {
    return 'Instructions';
  }
  if (file === 'dab.yaml' || file === '.agents/dab.yaml' || file === '.claude/settings.json') {
    return 'Generated target';
  }
  for (const [prefix, group] of [
    ['.agents/agents/', 'Agents'],
    ['.claude/agents/', 'Agents'],
    ['.agents/skills/', 'Skills'],
    ['.claude/skills/', 'Skills'],
    ['.agents/rules/', 'Rules'],
    ['.claude/rules/', 'Rules'],
    ['.agents/policies/', 'Policy'],
    ['.agents/adapters/', 'Policy'],
    ['.agents/hooks/', 'Hooks'],
    ['.agents/memory/', 'Memory'],
    ['.agents/notes/', 'Notes'],
  ] as const) {
    if (file.startsWith(prefix)) {
      return group;
    }
    if (file === prefix.slice(0, -1)) {
      return group;
    }
  }
  return undefined;
}

function diagnosticGroup(diagnostic: Diagnostic): string {
  if (SAFETY_CODE_PREFIXES.some((prefix) => diagnostic.code.startsWith(prefix))) {
    // A path conflict on a recognized authored path belongs to that path's
    // group; other safety diagnostics stay under Safety.
    if (diagnostic.code === 'path.conflict' && diagnostic.file !== undefined) {
      const byFile = groupForFile(diagnostic.file);
      if (byFile !== undefined) {
        return byFile;
      }
    }
    return 'Safety';
  }
  if (diagnostic.file !== undefined) {
    const byFile = groupForFile(diagnostic.file);
    if (byFile !== undefined) {
      return byFile;
    }
  }
  for (const [prefix, group] of CODE_GROUP_PREFIXES) {
    if (diagnostic.code.startsWith(prefix)) {
      return group;
    }
  }
  return 'Safety';
}

function diagnosticStatus(diagnostic: Diagnostic): ChecklistStatus {
  switch (diagnostic.severity) {
    case 'error':
      return 'error';
    case 'warning':
      return 'warn';
    case 'info':
      return 'ok';
  }
}

function nextFromHint(hint: string | undefined): string | undefined {
  if (hint === undefined) {
    return undefined;
  }
  if (hint.includes('dab normalize')) {
    return 'dab normalize';
  }
  if (hint.includes('dab init')) {
    return 'dab init';
  }
  if (/\bnormalize\b/.test(hint)) {
    return 'dab normalize';
  }
  return undefined;
}

function diagnosticEntries(diagnostics: readonly Diagnostic[]): ChecklistEntry[] {
  return diagnostics
    // Practice diagnostics are represented by the practice entries built from
    // the same check results. Mapping them again would duplicate the report.
    .filter((item) => !REPRESENTED_CODES.has(item.code) && !item.code.startsWith('practice.'))
    .map((diagnostic) => {
      const next = nextFromHint(diagnostic.hint);
      return {
        group: diagnosticGroup(diagnostic),
        label: diagnostic.file ?? diagnostic.code,
        status: diagnosticStatus(diagnostic),
        detail: diagnostic.message,
        ...(next === undefined ? {} : { next }),
      };
    });
}

function statusEntry(
  status: TargetFactStatus,
  diagnostics: readonly Diagnostic[],
): ChecklistEntry {
  const group = GROUP_BY_KIND[status.kind];
  const label = status.kind === 'instructions' ? INSTRUCTION_OUTPUT : status.name;
  const entry = {
    group,
    label,
    ...(status.detail === undefined ? {} : { detail: status.detail }),
  };
  switch (status.status) {
    case 'native':
    case 'mapped':
    case 'generated': {
      if (status.kind === 'instructions') {
        const related = diagnostics.filter(
          (item) => item.file === INSTRUCTION_OUTPUT && item.severity !== 'info',
        );
        if (related.some((item) => item.severity === 'error')) {
          return { ...entry, status: 'error' };
        }
        if (related.length > 0) {
          return { ...entry, status: 'warn' };
        }
      }
      return { ...entry, status: 'ok' };
    }
    case 'unsupported':
      return { ...entry, status: 'warn' };
    case 'not-applicable':
      return { ...entry, status: 'ok' };
    case 'missing':
      return { ...entry, status: 'missing', next: 'dab normalize' };
  }
}

function importEntry(entry: ClaudeAdoptionEntry): ChecklistEntry {
  return {
    group: entry.kind === 'agent' ? 'Agents' : 'Skills',
    label: entry.source,
    status: 'importable',
    detail: entry.target,
    next: 'dab normalize',
  };
}

async function exists(root: string, path: string): Promise<boolean> {
  // A file at a parent path raises ENOTDIR instead of ENOENT; the source-parent
  // probe reports that layout, so the inventory treats it as absent.
  return (await probeLstat(join(root, path))).info !== null;
}

function relativePath(root: string, absolute: string): string {
  return toPosix(relative(root, absolute));
}

/**
 * Positively reports authored sources that exist. Missing sources are left to
 * their owning diagnostics so the health entry is not duplicated.
 */
async function inventoryEntries(
  root: string,
  paths: ProjectPaths,
  diagnostics: readonly Diagnostic[],
): Promise<ChecklistEntry[]> {
  const entries: ChecklistEntry[] = [];
  const instructions = relativePath(root, paths.instructions);
  entries.push(await exists(root, instructions)
    ? { group: 'Instructions', label: instructions, status: 'ok' }
    : { group: 'Instructions', label: instructions, status: 'missing', next: 'dab init' });

  const memoryIndex = relativePath(root, join(paths.agents, 'memory/INDEX.md'));
  if (await exists(root, memoryIndex)) {
    entries.push({ group: 'Memory', label: memoryIndex, status: 'ok' });
  }

  const notes = `${relativePath(root, join(paths.agents, 'notes'))}/`;
  if (await exists(root, notes)) {
    entries.push({ group: 'Notes', label: notes, status: 'ok' });
  }

  if (paths.scope === 'project') {
    const settings = relativePath(root, join(paths.claude, 'settings.json'));
    const problem = diagnostics.some(
      (item) => item.file === settings && item.severity !== 'info',
    );
    if (!problem && await exists(root, settings)) {
      entries.push({ group: 'Generated target', label: settings, status: 'ok' });
    }
  }
  return entries;
}

function assembleResult(input: {
  diagnostics: readonly Diagnostic[];
  targets: TargetDetectOutcome[];
  scope: Scope;
  root: string;
  phase: AdoptionPhase;
  profile?: string;
  entries: ChecklistEntry[];
  exitCode: ExitCode;
}): DetectResult {
  const diagnostics = sortDiagnostics(dedupe(input.diagnostics));
  const checklist = buildChecklist({
    scope: input.scope,
    root: input.root,
    phase: input.phase,
    ...(input.profile === undefined ? {} : { profile: input.profile }),
    entries: input.entries,
  });
  return {
    ok: input.exitCode === ExitCode.Ok,
    exitCode: input.exitCode,
    diagnostics,
    targets: input.targets,
    summary: summarize(diagnostics),
    scope: input.scope,
    root: input.root,
    phase: input.phase,
    checklist: checklist.entries,
    score: checklist.score,
    nextActions: checklist.nextActions,
    ...(input.profile === undefined ? {} : { profile: input.profile }),
  };
}

function buildResult(input: {
  diagnostics: readonly Diagnostic[];
  targets?: TargetDetectOutcome[];
  scope: Scope;
  root: string;
  phase: AdoptionPhase;
  profile?: string;
  entries: ChecklistEntry[];
  strict?: boolean;
}): DetectResult {
  const diagnostics = sortDiagnostics(dedupe(input.diagnostics));
  const backendError = diagnostics.some(
    (item) => item.code === 'backend.version' && item.severity === 'error',
  );
  const warningFailure = input.strict === true
    && diagnostics.some(
      (item) => item.severity === 'warning'
        && !ENVIRONMENT_WARNING_CODES.has(item.code)
        && !PRACTICE_NON_STRICT_WARNING_CODES.has(item.code),
    );
  const exitCode = backendError
    ? ExitCode.Backend
    : hasErrors(diagnostics) || warningFailure
      ? ExitCode.Validation
      : ExitCode.Ok;
  return assembleResult({
    diagnostics,
    targets: input.targets ?? [],
    scope: input.scope,
    root: input.root,
    phase: input.phase,
    ...(input.profile === undefined ? {} : { profile: input.profile }),
    entries: input.entries,
    exitCode,
  });
}

function preflightResult(preflight: PreflightResult): DetectResult {
  return assembleResult({
    diagnostics: preflight.diagnostics,
    targets: [],
    scope: preflight.sourceRoot.scope,
    root: preflight.sourceRoot.root,
    phase: preflight.phase,
    ...(preflight.profile === undefined ? {} : { profile: preflight.profile }),
    entries: [
      ...preflight.entries,
      ...diagnosticEntries(preflight.diagnostics),
    ],
    // Uninitialized and partial scopes keep the former config-error exit code.
    exitCode: ExitCode.Usage,
  });
}

export async function detectProject(options: DetectOptions): Promise<DetectResult> {
  assertSupportedPlatform(options.platform);
  const home = resolve(options.home ?? homedir());
  const cwd = resolve(options.cwd);
  // Adoption resolves the phase before any manifest is required, so a missing
  // or partial source root becomes a read-only checklist instead of an error.
  const adoption = await resolveAdoptionRoot({ cwd, home });

  if (adoption.phase !== 'initialized') {
    return preflightResult(await preflightProject({ cwd, home }));
  }

  const sourceRoot: SourceRoot = {
    scope: adoption.scope,
    root: adoption.root,
    sourceRoot: adoption.sourceRoot,
    manifest: adoption.manifestPath,
    instructions: adoption.instructionsPath,
  };
  const root = sourceRoot.root;
  const loaded = await loadProjectManifest(root, { scope: sourceRoot.scope });
  const paths = resolveProjectPaths(root, loaded.manifest);
  const enabledTargets = getEnabledTargets(loaded.manifest);
  const profile = loaded.manifest.profile;
  const diagnostics: Diagnostic[] = [];

  try {
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
  } catch (error) {
    if (error instanceof DabError) {
      diagnostics.push({
        code: error.code,
        severity: 'error',
        message: error.message,
        file: 'dab.yaml',
      });
      return buildResult({
        diagnostics,
        targets: [],
        scope: sourceRoot.scope,
        root,
        phase: adoption.phase,
        profile,
        entries: [
          ...await inventoryEntries(root, paths, diagnostics),
          ...diagnosticEntries(diagnostics),
        ],
        strict: options.strict === true,
      });
    }
    throw error;
  }

  // Discovery reads `.agents/agents`, `.agents/hooks`, `.agents/memory`,
  // `.agents/policies` and `.agents/adapters` directly. A regular file or
  // denied access at any of them is a governed path conflict, not an internal
  // error, and the command fails before discovery runs.
  const sourceProblems = (await sourceParentProblems(root)).map(sourceParentDiagnostic);
  if (sourceProblems.length > 0) {
    diagnostics.push(...sourceProblems);
    // `path.conflict` normally groups under Safety; for a broken source parent
    // the owning group is clearer and matches the preflight checklist.
    const sourceFiles = new Set(
      sourceProblems.flatMap((item) => (item.file === undefined ? [] : [item.file])),
    );
    return buildResult({
      diagnostics,
      targets: [],
      scope: sourceRoot.scope,
      root,
      phase: adoption.phase,
      profile,
      entries: [
        ...await inventoryEntries(root, paths, diagnostics),
        ...sourceProblems.map((item) => ({
          group: item.file === undefined ? 'Safety' : groupForFile(item.file) ?? 'Safety',
          label: item.file ?? item.code,
          status: 'error' as const,
          detail: item.message,
        })),
        ...diagnosticEntries(
          diagnostics.filter(
            (item) => item.file === undefined || !sourceFiles.has(item.file),
          ),
        ),
      ],
      strict: options.strict === true,
    });
  }

  // Practice entries own the Documentation group and the dab-* authoring skill
  // entries in Skills. They run after the source-root safety checks so detect
  // never plans through an escaping or disjoint authored tree.
  const practice = await checkPracticePackages(
    root,
    sourceRoot.scope,
    loaded.manifest,
    paths,
    DAB_VERSION,
  );
  diagnostics.push(...practice.diagnostics);

  // Imports run on every normalize, including initialized scopes. Detect runs
  // the same read-only plan so an importable physical entry is reported as
  // [IMPORTABLE] instead of as an unmanaged or physical-copy projection.
  const importPlan = await planClaudeAdoption({
    root,
    scope: sourceRoot.scope,
    agentsRoot: paths.agents,
    claudeRoot: paths.claude,
    manifest: loaded.manifest,
  });
  diagnostics.push(...importPlan.diagnostics);
  const importedTargets = importPlan.entries.map((entry) => entry.source);

  const facts = await discoverSourceFacts(root, paths);
  diagnostics.push(
    ...facts.agents.diagnostics,
    ...facts.skills.diagnostics,
    ...facts.rules.diagnostics,
    ...facts.hooks.diagnostics,
  );
  diagnostics.push(...checkAgentHooks(facts.agents.items, facts.hooks.items));

  diagnostics.push(...await checkInstructionEnvironment(root, home, sourceRoot.scope));
  diagnostics.push(...await checkHookSafety(facts.hooks.items));
  diagnostics.push(...await checkSecrets(root, paths));
  diagnostics.push(...await checkMemory(root, paths, options.now));
  diagnostics.push(...await checkAgentsMdState(root, paths));

  const targets: TargetDetectOutcome[] = [];
  if (enabledTargets.length === 0) {
    diagnostics.push({
      code: 'target.none',
      severity: 'error',
      file: 'dab.yaml',
      message: 'manifest has no enabled targets',
      hint: 'Enable at least one target or omit it from the manifest.',
    });
  }
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
    const outcome = await adapter.detect({
      paths,
      manifest: loaded.manifest,
      target,
      facts,
      importedTargets,
      ...(options.runner === undefined ? {} : { runner: options.runner }),
    });
    diagnostics.push(...outcome.diagnostics);
    targets.push(outcome);
  }

  for (const target of enabledTargets) {
    if (getGeneratedTarget(loaded.manifest, target.provider) === undefined) {
      diagnostics.push({
        code: 'generated.missing',
        severity: 'error',
        message: `dab.yaml has no generated record for target ${target.provider}`,
        file: 'dab.yaml',
        hint: 'Run dab normalize to record generated outputs.',
      });
    }
  }

  return buildResult({
    diagnostics,
    targets,
    scope: sourceRoot.scope,
    root,
    phase: adoption.phase,
    profile,
    entries: [
      ...await inventoryEntries(root, paths, diagnostics),
      ...practice.entries,
      ...importPlan.entries.map((entry) => importEntry(entry)),
      ...targets.flatMap((outcome) =>
        outcome.statuses
          // The practice entries above report dab-* authoring skills with
          // their version state; the target status would duplicate the label.
          .filter((status) => !(
            sourceRoot.scope === 'project'
            && status.kind === 'skill'
            && isAuthoringSkillName(status.name)
          ))
          .map((status) => statusEntry(status, diagnostics))),
      ...diagnosticEntries(diagnostics),
    ],
    strict: options.strict === true,
  });
}

function formatHuman(result: DetectResult): string {
  const checklist = buildChecklist({
    scope: result.scope,
    root: result.root,
    phase: result.phase,
    ...(result.profile === undefined ? {} : { profile: result.profile }),
    entries: result.checklist,
  });
  return `dab detect\n${formatChecklist(checklist)}`;
}

export async function runDetect(options: DetectOptions, io: DetectIO): Promise<number> {
  try {
    const result = await detectProject(options);
    if (options.json === true) {
      io.stdout(contractJson(result));
    } else {
      io.stdout(formatHuman(result));
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
