import type { Stats } from 'node:fs';
import { readlink, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import type { CommandRunner } from '../core/command.ts';
import { runCommand } from '../core/command.ts';
import { formatDiagnostics, type Diagnostic } from '../core/diagnostics.ts';
import { ConfigError, DabError, UsageError, ValidationError } from '../core/errors.ts';
import { ExitCode } from '../core/exit-codes.ts';
import { ensureDir, lstatOrNull, writeFileAtomic } from '../core/fs-atomic.ts';
import { stableJson } from '../core/json.ts';
import {
  assertParentInsideRoot,
  assertRealPathInsideRoot,
  assertRealPathsDisjoint,
} from '../core/paths.ts';
import { loadYamlDocument } from '../core/yaml.ts';
import {
  inspectInstructionTarget,
  type InstructionMode,
} from '../adapter/claude-code/instructions.ts';
import { parseClaudeTargetOptions } from '../adapter/claude-code/options.ts';
import { discoverProjections } from '../adapter/claude-code/projection.ts';
import { checkAgentHookIds, checkHookSafety, checkSecrets } from '../detect/checks.ts';
import { discoverAgents } from '../model/agents.ts';
import { parseFrontmatter } from '../model/frontmatter.ts';
import { discoverHooks } from '../model/hooks.ts';
import { discoverMemory } from '../model/memory.ts';
import {
  getGeneratedTarget,
  getTarget,
  loadProjectManifest,
  resolveProjectPaths,
} from '../model/project-manifest.ts';
import { assertInitRoot, type Scope } from '../model/scope.ts';
import {
  AgentFrontmatterSchema,
  ClaudeCodePolicySchema,
  PolicySpecSchema,
} from '../model/schemas.ts';
import type { ProjectManifest, ProjectPaths, Projection } from '../model/types.ts';
import {
  formatProposal,
  requestAiProposal,
  type AiProposal,
} from '../init/ai-proposal.ts';
import { scanProject, type ScanResult } from '../init/scanner.ts';
import {
  renderAgentFromProposal,
  templateFiles,
  TEMPLATE_PROJECTIONS,
} from '../init/templates.ts';
import { normalizeProject, type NormalizeResult } from './normalize.ts';

export interface InitOptions {
  cwd: string;
  home?: string;
  path?: string;
  profile?: 'feature';
  ai?: boolean;
  dryRun?: boolean;
  json?: boolean;
  confirm?: (question: string) => Promise<boolean>;
  runner?: CommandRunner;
  platform?: NodeJS.Platform;
  onProposal?: (text: string) => void;
}

export interface InitResult {
  ok: boolean;
  exitCode: ExitCode;
  scope: Scope;
  root: string;
  dryRun: boolean;
  created: string[];
  skipped: string[];
  conflicts: Diagnostic[];
  pending: Diagnostic[];
  diagnostics: Diagnostic[];
  normalize: NormalizeResult | null;
  ai?: {
    applied: boolean;
    proposal?: AiProposal;
  };
}

export interface InitIO {
  stdout: (value: string) => void;
  stderr: (value: string) => void;
}

function blocked(
  scope: Scope,
  root: string,
  diagnostics: Diagnostic[],
  conflicts: Diagnostic[],
  dryRun = false,
): InitResult {
  return {
    ok: false,
    exitCode: ExitCode.Validation,
    scope,
    root,
    dryRun,
    created: [],
    skipped: [],
    conflicts,
    pending: [],
    diagnostics,
    normalize: null,
  };
}

function pendingDiagnostic(item: Diagnostic): Diagnostic {
  return {
    ...item,
    severity: 'warning',
    hint: [item.hint, 'Run dab normalize --dry-run, then dab normalize --fix.']
      .filter((value): value is string => value !== undefined && value.length > 0)
      .join(' '),
  };
}

function manifestConflict(): Diagnostic {
  return {
    code: 'claude-md.unmanaged',
    severity: 'error',
    message: 'root CLAUDE.md is user-owned and blocks DAB instructions',
    file: 'CLAUDE.md',
    hint: 'Merge its content into AGENTS.md and remove the file before running dab init.',
  };
}

async function findAuthoredConflicts(root: string): Promise<Diagnostic[]> {
  const conflicts: Diagnostic[] = [];
  if ((await lstatOrNull(join(root, 'CLAUDE.md'))) !== null) {
    conflicts.push(manifestConflict());
  }
  return conflicts;
}

async function findGeneratedConflicts(
  root: string,
  paths: ProjectPaths,
  manifest: ProjectManifest | undefined,
  targets: ReadonlyMap<string, string>,
): Promise<{ pending: Diagnostic[]; fatal: Diagnostic[] }> {
  const pending: Diagnostic[] = [];
  const fatal: Diagnostic[] = [];
  const generated = manifest === undefined
    ? undefined
    : getGeneratedTarget(manifest, 'claude-code');
  const claudeTarget = manifest === undefined ? undefined : getTarget(manifest, 'claude-code');
  if (manifest !== undefined && claudeTarget === undefined) {
    throw new ConfigError('manifest has no claude-code target', 'target.claude-missing');
  }
  const mode: InstructionMode = claudeTarget === undefined
    ? 'symlink'
    : parseClaudeTargetOptions(claudeTarget).instructions;

  // User-level settings under $HOME/.claude are never managed in global scope.
  if (paths.scope !== 'global') {
    const settingsPath = join(paths.claude, 'settings.json');
    const settingsManaged = generated?.settings !== undefined && generated.settings !== null;
    if ((await lstatOrNull(settingsPath)) !== null && !settingsManaged) {
      pending.push({
        code: 'claude-settings.unmanaged',
        severity: 'error',
        message: 'existing .claude/settings.json is not DAB-managed',
        file: '.claude/settings.json',
        hint: 'Normalize can back it up and replace it after review.',
      });
    }
  }

  const instructionConflict = await inspectInstructionTarget(root, paths, mode, generated);
  if (instructionConflict !== undefined) {
    pending.push(instructionConflict);
  }

  for (const [target, source] of targets) {
    try {
      await assertRealPathInsideRoot(root, target);
      await assertParentInsideRoot(root, target);
    } catch (error) {
      if (error instanceof DabError) {
        const diagnostic: Diagnostic = {
          code: error.code,
          severity: 'error',
          message: error.message,
          file: target,
          ...(error.hint === undefined ? {} : { hint: error.hint }),
        };
        if (error.code === 'path.symlink-escape' || error.code === 'path.escape') {
          fatal.push(diagnostic);
        } else {
          pending.push(diagnostic);
        }
        continue;
      }
      throw error;
    }

    const absolute = join(root, target);
    const info = await lstatOrNull(absolute);
    if (info === null) {
      continue;
    }
    const managed = generated?.projections.some(
      (projection) => projection.target === target,
    ) ?? false;
    if (info.isSymbolicLink()) {
      const raw = await readlink(absolute);
      const resolved = resolve(dirname(absolute), raw);
      if (resolved === resolve(root, source) || managed) {
        continue;
      }
      pending.push({
        code: 'projection.unmanaged',
        severity: 'error',
        message: 'existing projection is not DAB-managed',
        file: target,
      });
    } else {
      pending.push({
        code: 'projection.physical-copy',
        severity: 'error',
        message: 'existing projection target is a physical file or directory',
        file: target,
      });
    }
  }

  return { pending, fatal };
}

async function validateExistingAuthored(
  root: string,
  paths: ProjectPaths,
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const policyFiles = [
    {
      absolute: join(paths.agents, 'policies/project.yaml'),
      relative: '.agents/policies/project.yaml',
      schema: PolicySpecSchema,
    },
    {
      absolute: join(paths.agents, 'adapters/claude-code.yaml'),
      relative: '.agents/adapters/claude-code.yaml',
      schema: ClaudeCodePolicySchema,
    },
  ] as const;

  for (const file of policyFiles) {
    if ((await lstatOrNull(file.absolute)) === null) {
      continue;
    }
    try {
      await assertRealPathInsideRoot(root, file.relative);
    } catch (error) {
      diagnostics.push({
        code: error instanceof DabError ? error.code : 'policy.invalid',
        severity: 'error',
        message: error instanceof Error ? error.message : String(error),
        file: file.relative,
      });
      continue;
    }
    try {
      const document = await loadYamlDocument(file.absolute);
      const parsed = file.schema.safeParse(document.toJS());
      if (!parsed.success) {
        diagnostics.push({
          code: 'policy.invalid',
          severity: 'error',
          message: `invalid ${file.relative}`,
          file: file.relative,
        });
      }
    } catch (error) {
      diagnostics.push({
        code: 'policy.invalid',
        severity: 'error',
        message: `invalid ${file.relative}: ${error instanceof Error ? error.message : String(error)}`,
        file: file.relative,
      });
    }
  }

  const agents = await discoverAgents(root, paths.agents);
  const hooks = await discoverHooks(root, paths.agents);
  diagnostics.push(...agents.diagnostics.filter((item) => item.severity === 'error'));
  diagnostics.push(...hooks.diagnostics.filter((item) => item.severity === 'error'));
  diagnostics.push(...checkAgentHookIds(agents.items, hooks.items));
  diagnostics.push(...await checkHookSafety(hooks.items));

  const memory = await discoverMemory(root, paths.agents);
  diagnostics.push(...memory.diagnostics.filter((item) => item.severity === 'error'));
  diagnostics.push(...await checkSecrets(root, paths));
  return diagnostics;
}

async function writeIfMissing(
  root: string,
  relativePath: string,
  content: string,
  created: string[],
  skipped: string[],
): Promise<void> {
  const absolute = join(root, relativePath);
  if ((await lstatOrNull(absolute)) !== null) {
    skipped.push(relativePath);
    return;
  }
  await assertParentInsideRoot(root, relativePath);
  await writeFileAtomic(absolute, content);
  created.push(relativePath);
}

async function planFileWrites(
  root: string,
  files: Readonly<Record<string, string>>,
): Promise<{ created: string[]; skipped: string[] }> {
  const created: string[] = [];
  const skipped: string[] = [];
  for (const relativePath of Object.keys(files).sort()) {
    if ((await lstatOrNull(join(root, relativePath))) === null) {
      created.push(relativePath);
    } else {
      skipped.push(relativePath);
    }
  }
  return { created, skipped };
}

function targetMap(existing: readonly Projection[]): Map<string, string> {
  const targets = new Map<string, string>();
  for (const projection of existing) {
    targets.set(projection.target, projection.source);
  }
  for (const projection of TEMPLATE_PROJECTIONS) {
    if (!targets.has(projection.target)) {
      targets.set(projection.target, projection.source);
    }
  }
  return targets;
}

async function statOrNull(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

interface InitTarget {
  /** Raw absolute init path, used for reporting and file layout. */
  root: string;
  /**
   * Path used to resolve the scope. For a symlinked init root this is its
   * canonical target, so the nested-source guard cannot be bypassed by
   * pointing a symlink into an existing source tree.
   */
  scopePath: string;
}

async function resolveInitRoot(options: InitOptions): Promise<InitTarget> {
  const root = resolve(options.cwd, options.path ?? '.');
  const info = await lstatOrNull(root);
  if (info === null) {
    return { root, scopePath: root };
  }
  if (!info.isSymbolicLink()) {
    if (!info.isDirectory()) {
      throw new ConfigError(
        `init target is not a directory: ${root}`,
        'config.not-directory',
      );
    }
    return { root, scopePath: root };
  }
  // A symlinked source root is supported; it must resolve to a directory. Scope
  // must be validated on the canonical target, never on the lexical link path.
  const target = await statOrNull(root);
  if (target === null || !target.isDirectory()) {
    throw new ConfigError(
      `init target is not a directory: ${root}`,
      'config.not-directory',
    );
  }
  return { root, scopePath: await realpath(root) };
}

async function resolveInitScope(initRoot: string, home: string): Promise<Scope> {
  try {
    return await assertInitRoot({ root: initRoot, home });
  } catch (error) {
    if (error instanceof DabError && error.code === 'config.source-root-nested') {
      // `dab init` reports a refused nested target as a validation failure while
      // preserving the source-root diagnostic code.
      throw new ValidationError(error.message, error.code, {
        ...(error.hint === undefined ? {} : { hint: error.hint }),
      });
    }
    throw error;
  }
}

interface InitLayout {
  scopeRoot: string;
  manifestPath: string;
}

function resolveInitLayout(initRoot: string, scope: Scope, home: string): InitLayout {
  if (scope === 'global') {
    // Global init targets the canonical $HOME/.agents source root; its generated
    // projections live under $HOME, never next to an alias path.
    return {
      scopeRoot: home,
      manifestPath: join(initRoot, 'dab.yaml'),
    };
  }
  return {
    scopeRoot: initRoot,
    manifestPath: join(initRoot, 'dab.yaml'),
  };
}

function formatInit(result: InitResult): string {
  const lines = [
    `dab init ${result.root} scope=${result.scope}${result.dryRun ? ' (dry run)' : ''}`,
  ];
  if (result.created.length > 0) {
    lines.push(result.dryRun ? 'would create:' : 'created:');
    for (const file of result.created) {
      lines.push(`  ${file}`);
    }
  }
  if (result.skipped.length > 0) {
    lines.push('skipped (already present):');
    for (const file of result.skipped) {
      lines.push(`  ${file}`);
    }
  }
  if (result.ai !== undefined) {
    lines.push(`AI proposal: ${result.ai.applied ? 'applied' : 'declined'}`);
  }
  if (result.normalize !== null) {
    lines.push(`normalize: ${result.normalize.ok ? 'ok' : 'failed'}`);
  }
  if (result.pending.length > 0) {
    lines.push('pending generated conflicts:');
    for (const item of result.pending) {
      lines.push(`  ${item.file ?? '-'} ${item.code} ${item.message}`);
    }
    lines.push('next: dab normalize --dry-run');
    lines.push('next: dab normalize --fix');
  }
  const pendingKeys = new Set(
    result.pending.map((item) => `${item.code}|${item.file ?? ''}|${item.line ?? ''}`),
  );
  const diagnostics = formatDiagnostics(
    result.diagnostics.filter(
      (item) => !pendingKeys.has(`${item.code}|${item.file ?? ''}|${item.line ?? ''}`),
    ),
  );
  if (diagnostics.length > 0) {
    lines.push(diagnostics.trimEnd());
  }
  lines.push(result.ok ? 'OK' : 'FAILED');
  return `${lines.join('\n')}\n`;
}

export async function initializeProject(options: InitOptions): Promise<InitResult> {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    throw new ValidationError(
      'Windows is not supported in v0.1',
      'platform.unsupported',
      { hint: 'Use macOS or Linux. Windows junction support is planned for a later release.' },
    );
  }
  if (options.profile !== undefined && options.profile !== 'feature') {
    throw new UsageError(
      `unsupported profile: ${options.profile}; v0.1 supports: feature`,
      'usage.invalid-profile',
    );
  }

  if (options.ai === true && options.dryRun === true) {
    throw new UsageError(
      '--ai cannot be combined with --dry-run',
      'usage.ai-dry-run',
      { hint: 'Run dab init --dry-run for a preview, then dab init --ai interactively.' },
    );
  }

  const home = resolve(options.home ?? homedir());
  const dryRun = options.dryRun === true;
  const initTarget = await resolveInitRoot(options);
  const root = initTarget.root;
  const scope = await resolveInitScope(initTarget.scopePath, home);
  const layout = resolveInitLayout(root, scope, home);
  if (!dryRun) {
    await ensureDir(root);
  }

  const scan: ScanResult = await scanProject(root);
  const existingManifest = (await lstatOrNull(layout.manifestPath)) === null
    ? undefined
    : await loadProjectManifest(layout.scopeRoot, { scope });
  const manifest: ProjectManifest = existingManifest?.manifest ?? {
    version: 2,
    scope,
    project: { id: scan.projectId, name: scan.projectName },
    profile: 'feature',
    targets: [{
      provider: 'claude-code',
      enabled: true,
      options: { minVersion: '2.1.277', instructions: 'symlink' },
    }],
    paths: { agents: '.agents', claude: '.claude' },
  };
  const paths: ProjectPaths = resolveProjectPaths(layout.scopeRoot, manifest);

  const safety: Diagnostic[] = [];
  try {
    await assertRealPathInsideRoot(layout.scopeRoot, '.claude');
    await assertRealPathInsideRoot(layout.scopeRoot, '.agents');
    await assertRealPathsDisjoint(layout.scopeRoot, '.agents', '.claude');
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
      await assertRealPathInsideRoot(layout.scopeRoot, directory);
    }
  } catch (error) {
    if (error instanceof DabError) {
      safety.push({
        code: error.code,
        severity: 'error',
        message: error.message,
        file: scope === 'global' ? '.agents/dab.yaml' : 'dab.yaml',
      });
      return blocked(scope, root, [...scan.diagnostics, ...safety], safety, dryRun);
    }
    throw error;
  }

  const authoredConflicts = await findAuthoredConflicts(layout.scopeRoot);
  const authored = await validateExistingAuthored(layout.scopeRoot, paths);
  const authoredErrors = [
    ...authoredConflicts,
    ...authored.filter((item) => item.severity === 'error'),
  ];
  if (authoredErrors.length > 0) {
    return blocked(scope, root, [...scan.diagnostics, ...authoredErrors], authoredErrors, dryRun);
  }

  let existingProjections: Projection[] = [];
  if ((await lstatOrNull(paths.agents)) !== null) {
    const existing = await discoverProjections(layout.scopeRoot, paths);
    const errors = existing.diagnostics.filter((item) => item.severity === 'error');
    if (errors.length > 0) {
      return blocked(scope, root, [...scan.diagnostics, ...existing.diagnostics], errors, dryRun);
    }
    existingProjections = existing.projections;
  }

  let proposal: AiProposal | undefined;
  let aiApplied = false;
  if (options.ai === true) {
    if (options.confirm === undefined) {
      throw new UsageError(
        'AI init requires interactive confirmation',
        'init.ai-confirmation-required',
        { hint: 'Run dab init --ai in a terminal, or run dab init without --ai.' },
      );
    }
    proposal = await requestAiProposal(scan, options.runner ?? runCommand, root);
    for (const agent of proposal.agents) {
      const rendered = renderAgentFromProposal(agent);
      try {
        const parsed = parseFrontmatter(rendered, `.agents/agents/${agent.name}.md`);
        const validated = AgentFrontmatterSchema.safeParse(parsed.data);
        if (!validated.success) {
          throw new Error('frontmatter does not match the agent schema');
        }
      } catch (error) {
        throw new ConfigError(
          `AI proposal agent ${agent.name} is not a valid agent definition: ${error instanceof Error ? error.message : String(error)}`,
          'ai.invalid-proposal',
          { hint: 'Retry dab init --ai; the proposal must serialize to valid agent frontmatter.' },
        );
      }
    }
    options.onProposal?.(formatProposal(scan, proposal));

    const approved = await options.confirm('Apply this AI proposal? [y/N] ');
    if (!approved) {
      return {
        ok: true,
        exitCode: ExitCode.Ok,
        scope,
        root,
        dryRun: false,
        created: [],
        skipped: [],
        conflicts: [],
        pending: [],
        diagnostics: scan.diagnostics,
        normalize: null,
        ai: { applied: false, proposal },
      };
    }
    aiApplied = true;
  }

  const files = templateFiles(scan, scope, proposal?.agentsMdAddition);
  for (const agent of proposal?.agents ?? []) {
    files[`.agents/agents/${agent.name}.md`] = renderAgentFromProposal(agent);
  }

  const targets = targetMap(existingProjections);
  for (const agent of proposal?.agents ?? []) {
    targets.set(`.claude/agents/${agent.name}.md`, `.agents/agents/${agent.name}.md`);
  }
  const generated = await findGeneratedConflicts(
    layout.scopeRoot,
    paths,
    existingManifest?.manifest,
    targets,
  );
  if (generated.fatal.length > 0) {
    return blocked(scope, root, [...scan.diagnostics, ...generated.fatal], generated.fatal, dryRun);
  }
  const pending = generated.pending.map(pendingDiagnostic);

  if (dryRun) {
    const preview = await planFileWrites(layout.scopeRoot, files);
    return {
      ok: true,
      exitCode: ExitCode.Ok,
      scope,
      root,
      dryRun: true,
      created: preview.created,
      skipped: preview.skipped,
      conflicts: [],
      pending,
      diagnostics: [...scan.diagnostics, ...pending],
      normalize: null,
      ...(proposal === undefined ? {} : { ai: { applied: false, proposal } }),
    };
  }

  const created: string[] = [];
  const skipped: string[] = [];
  for (const file of Object.keys(files).sort()) {
    await writeIfMissing(layout.scopeRoot, file, files[file] ?? '', created, skipped);
  }
  await ensureDir(join(paths.agents, 'notes'));

  if (pending.length > 0) {
    return {
      ok: true,
      exitCode: ExitCode.Ok,
      scope,
      root,
      dryRun: false,
      created,
      skipped,
      conflicts: [],
      pending,
      diagnostics: [...scan.diagnostics, ...pending],
      normalize: null,
      ...(proposal === undefined ? {} : { ai: { applied: aiApplied, proposal } }),
    };
  }

  const normalize = await normalizeProject({
    cwd: root,
    home,
    ...(options.runner === undefined ? {} : { runner: options.runner }),
  });
  const diagnostics = [...scan.diagnostics, ...normalize.diagnostics];
  return {
    ok: normalize.ok,
    exitCode: normalize.exitCode,
    scope,
    root,
    dryRun: false,
    created,
    skipped,
    conflicts: [],
    pending: [],
    diagnostics,
    normalize,
    ...(proposal === undefined ? {} : { ai: { applied: aiApplied, proposal } }),
  };
}

export async function runInit(options: InitOptions, io: InitIO): Promise<number> {
  try {
    const result = await initializeProject({
      ...options,
      onProposal: options.onProposal
        ?? (options.json === true ? (text: string) => io.stderr(text) : io.stdout),
    });
    if (options.json === true) {
      io.stdout(stableJson(result));
    } else if (result.ok) {
      io.stdout(formatInit(result));
    } else {
      io.stderr(formatInit(result));
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
