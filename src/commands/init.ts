import { mkdir, readlink } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import type { CommandRunner } from '../core/command.ts';
import { runCommand } from '../core/command.ts';
import { formatDiagnostics, type Diagnostic } from '../core/diagnostics.ts';
import { ConfigError, DabError, UsageError, ValidationError } from '../core/errors.ts';
import { ExitCode } from '../core/exit-codes.ts';
import { ensureDir, lstatOrNull, readTextFile, writeFileAtomic } from '../core/fs-atomic.ts';
import { stableJson } from '../core/json.ts';
import {
  assertParentInsideRoot,
  assertRealPathInsideRoot,
  assertRealPathsDisjoint,
} from '../core/paths.ts';
import { loadYamlDocument } from '../core/yaml.ts';
import {
  discoverProjections,
  renderClaudeMdShim,
} from '../adapter/claude-code/projection.ts';
import { checkAgentHookIds, checkHookSafety, checkSecrets } from '../detect/checks.ts';
import { discoverAgents } from '../model/agents.ts';
import { parseFrontmatter } from '../model/frontmatter.ts';
import { discoverHooks } from '../model/hooks.ts';
import { discoverMemory } from '../model/memory.ts';
import {
  loadProjectManifest,
  resolveProjectPaths,
} from '../model/project-manifest.ts';
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
  root: string,
  diagnostics: Diagnostic[],
  conflicts: Diagnostic[],
  dryRun = false,
): InitResult {
  return {
    ok: false,
    exitCode: ExitCode.Validation,
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
): Promise<Diagnostic[]> {
  const conflicts: Diagnostic[] = [];

  const settingsPath = join(paths.claude, 'settings.json');
  if (
    (await lstatOrNull(settingsPath)) !== null
    && manifest?.generated?.settings === undefined
  ) {
    conflicts.push({
      code: 'claude-settings.unmanaged',
      severity: 'error',
      message: 'existing .claude/settings.json is not DAB-managed',
      file: '.claude/settings.json',
      hint: 'Move it aside or merge it into .agents/, then rerun dab init.',
    });
  }

  const shimPath = join(paths.claude, 'CLAUDE.md');
  const shimInfo = await lstatOrNull(shimPath);
  if (shimInfo !== null) {
    const managed = manifest?.generated?.instructions !== undefined
      && manifest.generated.instructions !== null;
    const enabled = manifest?.target.claudeMdShim ?? true;
    const regularFile = shimInfo.isFile() && !shimInfo.isSymbolicLink();
    let allowed = managed && regularFile;
    if (!allowed && enabled && regularFile) {
      allowed = (await readTextFile(shimPath)) === renderClaudeMdShim();
    }
    if (!allowed) {
      conflicts.push({
        code: 'claude-md.unmanaged',
        severity: 'error',
        message: 'existing .claude/CLAUDE.md is not DAB-managed',
        file: '.claude/CLAUDE.md',
        hint: 'Move it aside before running dab init.',
      });
    }
  }

  for (const [target, source] of targets) {
    try {
      await assertRealPathInsideRoot(root, target);
      await assertParentInsideRoot(root, target);
    } catch (error) {
      if (error instanceof DabError) {
        conflicts.push({
          code: error.code,
          severity: 'error',
          message: error.message,
          file: target,
        });
        continue;
      }
      throw error;
    }

    const absolute = join(root, target);
    const info = await lstatOrNull(absolute);
    if (info === null) {
      continue;
    }
    const managed = manifest?.generated?.projections?.some(
      (projection) => projection.target === target,
    ) ?? false;
    if (info.isSymbolicLink()) {
      const raw = await readlink(absolute);
      const resolved = resolve(dirname(absolute), raw);
      if (resolved === resolve(root, source) || managed) {
        continue;
      }
      conflicts.push({
        code: 'projection.unmanaged',
        severity: 'error',
        message: 'existing projection is not DAB-managed',
        file: target,
      });
    } else {
      conflicts.push({
        code: 'projection.physical-copy',
        severity: 'error',
        message: 'existing projection target is a physical file or directory',
        file: target,
        hint: 'Move it aside before running dab init; DAB never overwrites unmanaged files.',
      });
    }
  }

  return conflicts;
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

async function resolveRoot(options: InitOptions): Promise<string> {
  const root = resolve(options.cwd, options.path ?? '.');
  const info = await lstatOrNull(root);
  if (info !== null && !info.isDirectory()) {
    throw new ConfigError(
      `init target is not a directory: ${root}`,
      'config.not-directory',
    );
  }
  if (info === null && options.dryRun !== true) {
    await mkdir(root, { recursive: true });
  }
  return root;
}

function formatInit(result: InitResult): string {
  const lines = [`dab init ${result.root}${result.dryRun ? ' (dry run)' : ''}`];
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

  const root = await resolveRoot(options);
  const scan: ScanResult = await scanProject(root);
  const manifestPath = join(root, 'dab.yaml');
  const existingManifest = (await lstatOrNull(manifestPath)) === null
    ? undefined
    : await loadProjectManifest(root);
  const paths: ProjectPaths = existingManifest === undefined
    ? {
      root,
      agents: join(root, '.agents'),
      claude: join(root, '.claude'),
      manifest: manifestPath,
    }
    : resolveProjectPaths(root, existingManifest.manifest);

  const safety: Diagnostic[] = [];
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
      safety.push({
        code: error.code,
        severity: 'error',
        message: error.message,
        file: 'dab.yaml',
      });
      return blocked(root, [...scan.diagnostics, ...safety], safety, options.dryRun === true);
    }
    throw error;
  }

  const authoredConflicts = await findAuthoredConflicts(root);
  const authored = await validateExistingAuthored(root, paths);
  const authoredErrors = [
    ...authoredConflicts,
    ...authored.filter((item) => item.severity === 'error'),
  ];
  if (authoredErrors.length > 0) {
    return blocked(
      root,
      [...scan.diagnostics, ...authoredErrors],
      authoredErrors,
      options.dryRun === true,
    );
  }

  let existingProjections: Projection[] = [];
  if ((await lstatOrNull(paths.agents)) !== null) {
    const existing = await discoverProjections(root, paths);
    const errors = existing.diagnostics.filter((item) => item.severity === 'error');
    if (errors.length > 0) {
      return blocked(
        root,
        [...scan.diagnostics, ...existing.diagnostics],
        errors,
        options.dryRun === true,
      );
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

  const files = templateFiles(scan, proposal?.agentsMdAddition);
  for (const agent of proposal?.agents ?? []) {
    files[`.agents/agents/${agent.name}.md`] = renderAgentFromProposal(agent);
  }

  const targets = targetMap(existingProjections);
  for (const agent of proposal?.agents ?? []) {
    targets.set(`.claude/agents/${agent.name}.md`, `.agents/agents/${agent.name}.md`);
  }
  const generatedConflicts = await findGeneratedConflicts(
    root,
    paths,
    existingManifest?.manifest,
    targets,
  );
  const pending = generatedConflicts.map(pendingDiagnostic);

  if (options.dryRun === true) {
    const preview = await planFileWrites(root, files);
    return {
      ok: true,
      exitCode: ExitCode.Ok,
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
    await writeIfMissing(root, file, files[file] ?? '', created, skipped);
  }
  await ensureDir(join(paths.agents, 'notes'));

  if (pending.length > 0) {
    return {
      ok: true,
      exitCode: ExitCode.Ok,
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
    ...(options.runner === undefined ? {} : { runner: options.runner }),
  });
  const diagnostics = [...scan.diagnostics, ...normalize.diagnostics];
  return {
    ok: normalize.ok,
    exitCode: normalize.exitCode,
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
