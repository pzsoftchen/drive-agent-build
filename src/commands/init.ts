import { mkdir, readlink } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import type { CommandRunner } from '../core/command.ts';
import { runCommand } from '../core/command.ts';
import { formatDiagnostics, type Diagnostic } from '../core/diagnostics.ts';
import { ConfigError, DabError, UsageError, ValidationError } from '../core/errors.ts';
import { ExitCode } from '../core/exit-codes.ts';
import { ensureDir, lstatOrNull, readTextFile, writeFileAtomic } from '../core/fs-atomic.ts';
import { stableJson } from '../core/json.ts';
import { assertParentInsideRoot, toPosix } from '../core/paths.ts';
import {
  discoverProjections,
  renderClaudeMdShim,
} from '../adapter/claude-code/projection.ts';
import {
  loadProjectManifest,
  resolveProjectPaths,
} from '../model/project-manifest.ts';
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
  created: string[];
  skipped: string[];
  conflicts: Diagnostic[];
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
): InitResult {
  return {
    ok: false,
    exitCode: ExitCode.Validation,
    root,
    created: [],
    skipped: [],
    conflicts,
    diagnostics,
    normalize: null,
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

async function findInitConflicts(
  root: string,
  paths: ProjectPaths,
  manifest: ProjectManifest | undefined,
  targets: ReadonlyMap<string, string>,
): Promise<Diagnostic[]> {
  const conflicts: Diagnostic[] = [];

  if ((await lstatOrNull(join(root, 'CLAUDE.md'))) !== null) {
    conflicts.push(manifestConflict());
  }

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
  if (info === null) {
    await mkdir(root, { recursive: true });
  }
  return root;
}

function formatInit(result: InitResult): string {
  const lines = [`dab init ${result.root}`];
  if (result.created.length > 0) {
    lines.push('created:');
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
  const diagnostics = formatDiagnostics(result.diagnostics);
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
    await assertParentInsideRoot(root, '.claude/settings.json');
    await assertParentInsideRoot(root, '.agents/policies/project.yaml');
  } catch (error) {
    if (error instanceof DabError) {
      safety.push({
        code: error.code,
        severity: 'error',
        message: error.message,
        file: 'dab.yaml',
      });
      return blocked(root, [...scan.diagnostics, ...safety], safety);
    }
    throw error;
  }

  let existingProjections: Projection[] = [];
  if ((await lstatOrNull(paths.agents)) !== null) {
    const existing = await discoverProjections(root, paths);
    const errors = existing.diagnostics.filter((item) => item.severity === 'error');
    if (errors.length > 0) {
      return blocked(root, [...scan.diagnostics, ...existing.diagnostics], []);
    }
    existingProjections = existing.projections;
  }

  const targets = targetMap(existingProjections);
  const conflicts = await findInitConflicts(root, paths, existingManifest?.manifest, targets);
  if (conflicts.length > 0) {
    return blocked(root, [...scan.diagnostics, ...conflicts], conflicts);
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
    options.onProposal?.(formatProposal(scan, proposal));

    const proposalTargets = new Map<string, string>();
    for (const agent of proposal.agents) {
      proposalTargets.set(
        `.claude/agents/${agent.name}.md`,
        `.agents/agents/${agent.name}.md`,
      );
    }
    const aiConflicts = await findInitConflicts(
      root,
      paths,
      existingManifest?.manifest,
      proposalTargets,
    );
    if (aiConflicts.length > 0) {
      return blocked(root, [...scan.diagnostics, ...aiConflicts], aiConflicts);
    }

    const approved = await options.confirm('Apply this AI proposal? [y/N] ');
    if (!approved) {
      return {
        ok: true,
        exitCode: ExitCode.Ok,
        root,
        created: [],
        skipped: [],
        conflicts: [],
        diagnostics: scan.diagnostics,
        normalize: null,
        ai: { applied: false, proposal },
      };
    }
    aiApplied = true;
  }

  const created: string[] = [];
  const skipped: string[] = [];
  const files = templateFiles(scan, proposal?.agentsMdAddition);
  for (const file of Object.keys(files).sort()) {
    await writeIfMissing(root, file, files[file] ?? '', created, skipped);
  }
  for (const agent of proposal?.agents ?? []) {
    await writeIfMissing(
      root,
      `.agents/agents/${agent.name}.md`,
      renderAgentFromProposal(agent),
      created,
      skipped,
    );
  }
  await ensureDir(join(paths.agents, 'notes'));

  const normalize = await normalizeProject({ cwd: root });
  const diagnostics = [...scan.diagnostics, ...normalize.diagnostics];
  return {
    ok: normalize.ok,
    exitCode: normalize.exitCode,
    root,
    created,
    skipped,
    conflicts: [],
    diagnostics,
    normalize,
    ...(proposal === undefined ? {} : { ai: { applied: aiApplied, proposal } }),
  };
}

export async function runInit(options: InitOptions, io: InitIO): Promise<number> {
  try {
    const result = await initializeProject({
      ...options,
      onProposal: options.onProposal ?? (options.json === true ? undefined : io.stdout),
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
