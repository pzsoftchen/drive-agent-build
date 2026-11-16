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
import { stableJson } from '../core/json.ts';
import {
  assertRealPathInsideRoot,
  assertRealPathsDisjoint,
} from '../core/paths.ts';
import { compilePolicy } from '../adapter/claude-code/policy-compile.ts';
import { discoverProjections } from '../adapter/claude-code/projection.ts';
import { renderSettings } from '../adapter/claude-code/settings.ts';
import { checkClaudeCode } from '../adapter/claude-code/version.ts';
import {
  checkAgentHookIds,
  checkAgentsMdState,
  checkHookSafety,
  checkMemory,
  checkProjections,
  checkSecrets,
  checkSettings,
  checkShim,
} from '../detect/checks.ts';
import { discoverAgents } from '../model/agents.ts';
import { discoverHooks } from '../model/hooks.ts';
import { loadPolicySources } from '../model/policy.ts';
import { loadProjectManifest, resolveProjectPaths } from '../model/project-manifest.ts';

export interface DetectOptions {
  cwd: string;
  json?: boolean;
  runner?: CommandRunner;
  platform?: NodeJS.Platform;
  home?: string;
  now?: Date;
}

export interface DetectResult {
  ok: boolean;
  exitCode: ExitCode;
  diagnostics: Diagnostic[];
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

function buildResult(diagnostics: readonly Diagnostic[]): DetectResult {
  const sorted = sortDiagnostics(dedupe(diagnostics));
  const backendError = sorted.some(
    (item) => item.code === 'backend.version' && item.severity === 'error',
  );
  const exitCode = backendError
    ? ExitCode.Backend
    : hasErrors(sorted)
      ? ExitCode.Validation
      : ExitCode.Ok;
  return {
    ok: exitCode === ExitCode.Ok,
    exitCode,
    diagnostics: sorted,
    summary: summarize(sorted),
  };
}

export async function detectProject(options: DetectOptions): Promise<DetectResult> {
  const root = resolve(options.cwd);
  const loaded = await loadProjectManifest(root);
  const paths = resolveProjectPaths(root, loaded.manifest);
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
      return buildResult(diagnostics);
    }
    throw error;
  }

  const backend = await checkClaudeCode(loaded.manifest.target.minVersion, options.runner);
  diagnostics.push(...backend.diagnostics);

  const discovered = await discoverProjections(root, paths);
  const agents = await discoverAgents(root, paths.agents);
  const hooks = await discoverHooks(root, paths.agents);
  diagnostics.push(...discovered.diagnostics);
  diagnostics.push(...agents.diagnostics);
  diagnostics.push(...hooks.diagnostics);
  diagnostics.push(...checkAgentHookIds(agents.items, hooks.items));

  const policies = await loadPolicySources(paths);
  const compiled = compilePolicy(policies.project, policies.adapter, hooks.items);
  diagnostics.push(...compiled.diagnostics);
  const expectedSettings = renderSettings(compiled.effective);

  diagnostics.push(...await checkSettings(root, paths, loaded.manifest, expectedSettings));
  diagnostics.push(...await checkShim(root, loaded.manifest, options.home));
  diagnostics.push(...await checkProjections(root, paths, discovered.projections, loaded.manifest));
  diagnostics.push(...await checkHookSafety(hooks.items));
  diagnostics.push(...await checkSecrets(root, paths));
  diagnostics.push(...await checkMemory(root, paths, options.now));
  diagnostics.push(...await checkAgentsMdState(root));

  if (loaded.manifest.generated === undefined) {
    diagnostics.push({
      code: 'generated.missing',
      severity: 'error',
      message: 'dab.yaml has no generated manifest',
      file: 'dab.yaml',
      hint: 'Run dab normalize to record generated outputs.',
    });
  }

  return buildResult(diagnostics);
}

function formatHuman(result: DetectResult): string {
  const lines = ['dab detect'];
  const diagnostics = formatDiagnostics(result.diagnostics);
  if (diagnostics.length > 0) {
    lines.push(diagnostics.trimEnd());
  } else {
    lines.push('No issues found.');
  }
  lines.push(
    `Errors: ${result.summary.errors}, warnings: ${result.summary.warnings}, info: ${result.summary.info}`,
  );
  return `${lines.join('\n')}\n`;
}

export async function runDetect(options: DetectOptions, io: DetectIO): Promise<number> {
  try {
    const result = await detectProject(options);
    if (options.json === true) {
      io.stdout(stableJson(result));
    } else {
      io.stdout(formatHuman(result));
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
