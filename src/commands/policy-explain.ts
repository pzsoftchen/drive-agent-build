import { resolve } from 'node:path';
import type { CommandRunner } from '../core/command.ts';
import {
  formatDiagnostics,
  hasErrors,
  sortDiagnostics,
  type Diagnostic,
} from '../core/diagnostics.ts';
import { DabError, UsageError } from '../core/errors.ts';
import { ExitCode } from '../core/exit-codes.ts';
import { stableJson } from '../core/json.ts';
import { readClaudeVersion } from '../core/version-check.ts';
import { compilePolicy, type EffectivePolicy } from '../adapter/claude-code/policy-compile.ts';
import { discoverAgents } from '../model/agents.ts';
import { discoverHooks } from '../model/hooks.ts';
import { loadPolicySources } from '../model/policy.ts';
import { loadProjectManifest, resolveProjectPaths } from '../model/project-manifest.ts';
import type { AgentDefinition } from '../model/types.ts';

export interface PolicyExplainOptions {
  cwd: string;
  agent?: string;
  json?: boolean;
  runner?: CommandRunner;
}

export interface PolicyExplainIO {
  stdout: (value: string) => void;
  stderr: (value: string) => void;
}

export interface AgentPolicyView {
  name: string;
  description: string;
  tools: string[];
  disallowedTools: string[];
  effectiveTools: string[];
  permissionMode?: string;
  memory?: string;
  hooks: AgentDefinition['hooks'];
}

export interface PolicyExplainResult {
  ok: boolean;
  exitCode: ExitCode;
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
  const effectiveTools = agent.tools.length === 0
    ? ['*']
    : agent.tools.filter((tool) => !agent.disallowedTools.includes(tool));
  return {
    name: agent.name,
    description: agent.description,
    tools: agent.tools,
    disallowedTools: agent.disallowedTools,
    effectiveTools,
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

export async function explainPolicy(options: PolicyExplainOptions): Promise<PolicyExplainResult> {
  const root = resolve(options.cwd);
  const loaded = await loadProjectManifest(root);
  const paths = resolveProjectPaths(root, loaded.manifest);
  const policies = await loadPolicySources(paths);
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
  }

  const compiled = compilePolicy(
    policies.project,
    policies.adapter,
    hooks.items,
    agent,
  );
  diagnostics.push(...compiled.diagnostics);

  const runtimeInfo = await readClaudeVersion(options.runner, loaded.manifest.target.minVersion);
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
    lines.push(`Agent: ${result.agent.name}`);
    lines.push(`  description: ${result.agent.description}`);
    lines.push(`  tools: ${result.agent.tools.length === 0 ? 'all' : result.agent.tools.join(', ')}`);
    lines.push(`  disallowedTools: ${result.agent.disallowedTools.join(', ') || '(none)'}`);
    lines.push(`  effectiveTools: ${result.agent.effectiveTools.join(', ')}`);
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
