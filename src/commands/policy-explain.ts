import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { CommandRunner } from '../core/command.ts';
import {
  formatDiagnostics,
  hasErrors,
  sortDiagnostics,
  type Diagnostic,
} from '../core/diagnostics.ts';
import { ConfigError, DabError, UsageError, ValidationError } from '../core/errors.ts';
import { ExitCode } from '../core/exit-codes.ts';
import { contractJson } from '../core/json.ts';
import {
  assertRealPathInsideRoot,
  assertRealPathsDisjoint,
} from '../core/paths.ts';
import { assertSupportedPlatform } from '../core/platform.ts';
import { sourceParentProblems } from '../core/practice-paths.ts';
import { readClaudeVersion } from '../core/version-check.ts';
import { getTargetAdapter } from '../adapter/registry.ts';
import { parseClaudeTargetOptions } from '../adapter/claude-code/options.ts';
import { compilePolicy, type EffectivePolicy } from '../adapter/claude-code/policy-compile.ts';
import { checkAgentHooks } from '../detect/checks.ts';
import { discoverAgents } from '../model/agents.ts';
import { discoverHooks } from '../model/hooks.ts';
import { loadClaudeCodePolicy, loadCommonPolicy } from '../model/policy.ts';
import {
  getEnabledTargets,
  getTarget,
  loadProjectManifest,
  resolveProjectPaths,
} from '../model/project-manifest.ts';
import { resolveSourceRoot } from '../model/scope.ts';
import type {
  AgentDefinition,
  ProjectManifest,
  TargetConfig,
  TargetProvider,
} from '../model/types.ts';

export interface PolicyExplainOptions {
  cwd: string;
  home?: string;
  agent?: string;
  target?: TargetProvider;
  json?: boolean;
  runner?: CommandRunner;
  platform?: NodeJS.Platform;
}

export interface PolicyExplainIO {
  stdout: (value: string) => void;
  stderr: (value: string) => void;
}

export interface AgentPolicyView {
  name: string;
  description: string;
  tools: string[];
  toolsMode: 'all' | 'none' | 'list';
  toolsExplicit: boolean;
  disallowedTools: string[];
  effectiveTools: string[];
  effectiveToolsExcluded: string[];
  permissionMode?: string;
  memory?: string;
  hooks: AgentDefinition['hooks'];
}

export interface PolicyExplainResult {
  ok: boolean;
  exitCode: ExitCode;
  target: TargetProvider;
  effective: EffectivePolicy;
  agent?: AgentPolicyView;
  runtime: {
    installed: boolean;
    version?: string;
    compatible: boolean;
    minimum: string;
  };
  diagnostics: Diagnostic[];
}

function agentView(agent: AgentDefinition): AgentPolicyView {
  const disallowed = agent.disallowedTools;
  let effectiveTools: string[];
  let effectiveToolsExcluded: string[];
  switch (agent.toolsSpec.mode) {
    case 'all':
      effectiveTools = ['*'];
      effectiveToolsExcluded = [...disallowed];
      break;
    case 'none':
      effectiveTools = [];
      effectiveToolsExcluded = [];
      break;
    case 'list': {
      const denied = new Set(disallowed);
      effectiveTools = agent.toolsSpec.tools.filter((tool) => !denied.has(tool));
      effectiveToolsExcluded = agent.toolsSpec.tools.filter((tool) => denied.has(tool));
      break;
    }
  }
  return {
    name: agent.name,
    description: agent.description,
    tools: agent.tools,
    toolsMode: agent.toolsSpec.mode,
    toolsExplicit: agent.toolsSpec.mode === 'all' ? agent.toolsSpec.explicit : false,
    disallowedTools: disallowed,
    effectiveTools,
    effectiveToolsExcluded,
    ...(agent.permissionMode === undefined ? {} : { permissionMode: agent.permissionMode }),
    ...(agent.memory === undefined ? {} : { memory: agent.memory }),
    hooks: agent.hooks,
  };
}

function dedupe(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((item) => {
    const key = [item.code, item.severity, item.file ?? '', item.line ?? '', item.message].join('|');
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function backendDiagnostic(installed: boolean, compatible: boolean, minimum: string): Diagnostic | undefined {
  if (!installed) {
    return {
      code: 'backend.missing',
      severity: 'warning',
      message: 'Claude Code is not installed or is not on PATH',
      hint: `Runtime compatibility is unknown; policy explain does not require Claude Code >= ${minimum}.`,
    };
  }
  if (!compatible) {
    return {
      code: 'backend.version',
      severity: 'error',
      message: `Claude Code is older than required ${minimum}`,
      hint: 'Upgrade Claude Code; DAB will not modify your global installation.',
    };
  }
  return undefined;
}

function selectTarget(
  manifest: ProjectManifest,
  explicit: TargetProvider | undefined,
): TargetConfig {
  if (explicit !== undefined) {
    const target = getTarget(manifest, explicit);
    if (target === undefined) {
      throw new ConfigError('target is not configured', 'target.not-configured', {
        hint: 'Add the target to dab.yaml or omit --target to use the first enabled target.',
      });
    }
    return target;
  }

  const target = getEnabledTargets(manifest)[0];
  if (target === undefined) {
    throw new ConfigError('manifest has no enabled targets', 'target.none', {
      hint: 'Enable at least one target or omit it from the manifest.',
    });
  }
  return target;
}

export async function explainPolicy(options: PolicyExplainOptions): Promise<PolicyExplainResult> {
  assertSupportedPlatform(options.platform);
  const home = options.home ?? homedir();
  const sourceRoot = await resolveSourceRoot({ cwd: resolve(options.cwd), home });
  const root = sourceRoot.root;
  const loaded = await loadProjectManifest(root, { scope: sourceRoot.scope });
  const paths = resolveProjectPaths(root, loaded.manifest);
  const target = selectTarget(loaded.manifest, options.target);
  if (getTargetAdapter(target.provider) === undefined) {
    throw new ConfigError(
      `no adapter is available for target ${target.provider}`,
      'target.unsupported',
      { hint: 'Remove or disable the target until its adapter is implemented.' },
    );
  }
  const claudeOptions = parseClaudeTargetOptions(target);
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
      '.claude/agents',
      '.claude/skills',
      '.claude/rules',
    ]) {
      await assertRealPathInsideRoot(root, directory);
    }
  } catch (error) {
    if (error instanceof DabError) {
      throw new ValidationError(error.message, error.code, { hint: error.hint });
    }
    throw error;
  }
  // Discovery below reads these parents directly; report a governed path
  // conflict instead of failing with an internal ENOTDIR/EACCES error.
  const [sourceProblem] = await sourceParentProblems(root);
  if (sourceProblem !== undefined) {
    throw new ValidationError(sourceProblem.message, 'path.conflict', {
      hint: 'Resolve the path conflict manually; DAB never writes through it.',
    });
  }
  const commonPolicy = await loadCommonPolicy(paths);
  const claudePolicy = await loadClaudeCodePolicy(paths);
  const hooks = await discoverHooks(root, paths.agents);
  const diagnostics: Diagnostic[] = [...hooks.diagnostics];

  let agent: AgentDefinition | undefined;
  if (options.agent !== undefined) {
    const agents = await discoverAgents(root, paths.agents);
    diagnostics.push(...agents.diagnostics);
    agent = agents.items.find((item) => item.name === options.agent);
    if (agent === undefined) {
      throw new UsageError(
        `unknown agent: ${options.agent}`,
        'usage.unknown-agent',
        { hint: 'Run dab policy explain without --agent to inspect the project policy.' },
      );
    }
    diagnostics.push(...checkAgentHooks([agent], hooks.items));
  }

  const compiled = compilePolicy(
    commonPolicy.policy,
    claudePolicy.policy,
    hooks.items,
    agent,
  );
  diagnostics.push(...compiled.diagnostics);
  if (paths.scope === 'global') {
    compiled.effective.limitations.push('global settings are not managed in this phase');
  }

  const runtimeInfo = await readClaudeVersion(options.runner, claudeOptions.minVersion);
  const runtimeDiagnostic = backendDiagnostic(
    runtimeInfo.installed,
    runtimeInfo.compatible,
    runtimeInfo.minimum,
  );
  if (runtimeDiagnostic !== undefined) {
    diagnostics.push(runtimeDiagnostic);
  }

  const sorted = sortDiagnostics(dedupe(diagnostics));
  const backendError = runtimeInfo.installed && !runtimeInfo.compatible;
  const exitCode = backendError
    ? ExitCode.Backend
    : hasErrors(sorted)
      ? ExitCode.Validation
      : ExitCode.Ok;

  return {
    ok: exitCode === ExitCode.Ok,
    exitCode,
    target: target.provider,
    effective: compiled.effective,
    ...(agent === undefined ? {} : { agent: agentView(agent) }),
    runtime: {
      installed: runtimeInfo.installed,
      ...(runtimeInfo.version === undefined ? {} : { version: runtimeInfo.version }),
      compatible: runtimeInfo.compatible,
      minimum: runtimeInfo.minimum,
    },
    diagnostics: sorted,
  };
}

function listOrNone(values: readonly string[], indent = '    '): string {
  if (values.length === 0) {
    return `${indent}(none)`;
  }
  return values.map((value) => `${indent}- ${value}`).join('\n');
}

function formatHuman(result: PolicyExplainResult): string {
  const lines: string[] = ['dab policy explain'];
  lines.push(`Target: ${result.target}`);
  lines.push(`Provider: ${result.effective.provider}`);
  const runtime = result.runtime.installed
    ? `${result.runtime.version ?? 'unknown'} (${result.runtime.compatible ? 'compatible' : 'incompatible'}, minimum ${result.runtime.minimum})`
    : `not installed (minimum ${result.runtime.minimum})`;
  lines.push(`Runtime: ${runtime}`);
  lines.push(`Default mode: ${result.effective.defaultMode}`);
  lines.push('Permissions:');
  lines.push('  deny:');
  lines.push(listOrNone(result.effective.permissions.deny));
  lines.push('  ask:');
  lines.push(listOrNone(result.effective.permissions.ask));
  lines.push('  allow:');
  lines.push(listOrNone(result.effective.permissions.allow));

  lines.push('Hooks (execution order):');
  if (result.effective.hooks.length === 0) {
    lines.push('  (none)');
  } else {
    result.effective.hooks.forEach((hook, index) => {
      lines.push(
        `  ${index + 1}. ${hook.id} [${hook.event}]${hook.matcher === undefined ? '' : ` matcher=${hook.matcher}`} scope=${hook.scope}`,
      );
      lines.push(`     ${hook.command}`);
    });
  }

  lines.push('Sources:');
  lines.push(listOrNone(result.effective.sources, '  '));

  if (result.agent !== undefined) {
    const toolsLabel = result.agent.toolsMode === 'all'
      ? 'all'
      : result.agent.toolsMode === 'none'
        ? 'none'
        : result.agent.tools.join(', ');
    const effectiveLabel = result.agent.toolsMode === 'all'
      ? result.agent.effectiveToolsExcluded.length === 0
        ? '*'
        : `* except ${result.agent.effectiveToolsExcluded.join(', ')}`
      : result.agent.effectiveTools.length === 0
        ? '(none)'
        : result.agent.effectiveTools.join(', ');
    lines.push(`Agent: ${result.agent.name}`);
    lines.push(`  description: ${result.agent.description}`);
    lines.push(`  tools: ${toolsLabel}`);
    lines.push(`  disallowedTools: ${result.agent.disallowedTools.join(', ') || '(none)'}`);
    lines.push(`  effectiveTools: ${effectiveLabel}`);
    lines.push(`  permissionMode: ${result.agent.permissionMode ?? '(default)'}`);
    lines.push(`  memory: ${result.agent.memory ?? '(default)'}`);
    lines.push(`  hooks: ${result.agent.hooks.length === 0 ? '(none)' : result.agent.hooks.map((hook) => hook.id).join(', ')}`);
  }

  lines.push('Limitations:');
  lines.push(listOrNone(result.effective.limitations, '  '));
  const diagnostics = formatDiagnostics(result.diagnostics);
  if (diagnostics.length > 0) {
    lines.push(diagnostics.trimEnd());
  }
  return `${lines.join('\n')}\n`;
}

export async function runPolicyExplain(
  options: PolicyExplainOptions,
  io: PolicyExplainIO,
): Promise<number> {
  try {
    const result = await explainPolicy(options);
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
