import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { CommandRunner } from '../core/command.ts';
import {
  formatDiagnostics,
  hasErrors,
  sortDiagnostics,
  type Diagnostic,
} from '../core/diagnostics.ts';
import { DabError } from '../core/errors.ts';
import { ExitCode } from '../core/exit-codes.ts';
import { contractJson } from '../core/json.ts';
import {
  assertRealPathInsideRoot,
  assertRealPathsDisjoint,
} from '../core/paths.ts';
import { assertSupportedPlatform } from '../core/platform.ts';
import { getTargetAdapter } from '../adapter/registry.ts';
import type {
  TargetDetectOutcome,
  TargetFactKind,
} from '../adapter/types.ts';
import {
  checkAgentHooks,
  checkAgentsMdState,
  checkHookSafety,
  checkInstructionEnvironment,
  checkMemory,
  checkSecrets,
} from '../detect/checks.ts';
import { discoverSourceFacts } from '../model/facts.ts';
import {
  getEnabledTargets,
  getGeneratedTarget,
  loadProjectManifest,
  resolveProjectPaths,
} from '../model/project-manifest.ts';
import { resolveSourceRoot } from '../model/scope.ts';
import type { TargetProvider } from '../model/types.ts';

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

function buildResult(
  diagnostics: readonly Diagnostic[],
  targets: TargetDetectOutcome[] = [],
  strict = false,
): DetectResult {
  const sorted = sortDiagnostics(dedupe(diagnostics));
  const backendError = sorted.some(
    (item) => item.code === 'backend.version' && item.severity === 'error',
  );
  const warningFailure = strict
    && sorted.some(
      (item) => item.severity === 'warning' && !ENVIRONMENT_WARNING_CODES.has(item.code),
    );
  const exitCode = backendError
    ? ExitCode.Backend
    : hasErrors(sorted) || warningFailure
      ? ExitCode.Validation
      : ExitCode.Ok;
  return {
    ok: exitCode === ExitCode.Ok,
    exitCode,
    diagnostics: sorted,
    targets,
    summary: summarize(sorted),
  };
}

export async function detectProject(options: DetectOptions): Promise<DetectResult> {
  assertSupportedPlatform(options.platform);
  const home = options.home ?? homedir();
  const sourceRoot = await resolveSourceRoot({ cwd: resolve(options.cwd), home });
  const root = sourceRoot.root;
  const loaded = await loadProjectManifest(root, { scope: sourceRoot.scope });
  const paths = resolveProjectPaths(root, loaded.manifest);
  const enabledTargets = getEnabledTargets(loaded.manifest);
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
      return buildResult(diagnostics, [], options.strict === true);
    }
    throw error;
  }

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

  return buildResult(diagnostics, targets, options.strict === true);
}

const TARGET_LABELS: Record<TargetProvider, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  dsh: 'dsh',
};

const STATUS_KIND_ORDER: readonly TargetFactKind[] = [
  'agent',
  'skill',
  'rule',
  'instructions',
  'policy',
  'hook',
];

function formatStatuses(targets: readonly TargetDetectOutcome[]): string[] {
  const lines: string[] = [];
  for (const target of targets) {
    const statuses = [...target.statuses].sort(
      (left, right) =>
        STATUS_KIND_ORDER.indexOf(left.kind) - STATUS_KIND_ORDER.indexOf(right.kind),
    );
    for (const status of statuses) {
      lines.push(
        `${status.kind} ${status.name}: ${TARGET_LABELS[target.provider]}=${status.status}`,
      );
    }
  }
  return lines;
}

function formatHuman(result: DetectResult): string {
  const lines = ['dab detect'];
  const diagnostics = formatDiagnostics(result.diagnostics);
  if (diagnostics.length > 0) {
    lines.push(diagnostics.trimEnd());
  } else {
    lines.push('No issues found.');
  }
  lines.push(...formatStatuses(result.targets));
  lines.push(
    `Errors: ${result.summary.errors}, warnings: ${result.summary.warnings}, info: ${result.summary.info}`,
  );
  return `${lines.join('\n')}\n`;
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
