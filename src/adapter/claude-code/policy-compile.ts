import type { Diagnostic } from '../../core/diagnostics.ts';
import { assertRelativePath } from '../../core/paths.ts';
import type {
  AgentDefinition,
  ClaudeCodePolicy,
  LoadedHook,
  PolicySpec,
} from '../../model/types.ts';
import {
  buildHookCommand,
  buildManagedHookCommands,
  hookMatcher,
  isManagedAgentHookCommand,
  mapHookEvent,
  unmanagedAgentHookDiagnostic,
} from './hooks.ts';

export interface EffectiveHook {
  id: string;
  event: string;
  matcher?: string;
  command: string;
  timeout: number;
  order: number;
  source: string;
  scope: 'project' | 'agent';
}

export interface EffectivePolicy {
  provider: 'claude-code';
  defaultMode: string;
  permissions: {
    allow: string[];
    ask: string[];
    deny: string[];
    disableBypassPermissionsMode: 'disable';
  };
  hooks: EffectiveHook[];
  sources: string[];
  limitations: string[];
}

export interface CompileResult {
  effective: EffectivePolicy;
  diagnostics: Diagnostic[];
}

const PROJECT_SOURCE = '.agents/policies/project.yaml';
const ADAPTER_SOURCE = '.agents/adapters/claude-code.yaml';
const ALLOWED_MODES = new Set(['default', 'plan', 'acceptEdits']);
const RULE_PATTERN = /^[A-Za-z][A-Za-z0-9_:-]*(?:\(.+\))?$/;

const LIMITATIONS = [
  'Bash can read and write files without matching Read or Edit path rules.',
  'An agent permissionMode is advisory when the parent session runs in a broader mode.',
  'Project settings cannot force auto memory on or off; personal memory remains machine-local.',
  'WebFetch and WebSearch deny rules do not stop network access through shell commands.',
];

function mapPath(path: string, tool: string, diagnostics: Diagnostic[]): string | undefined {
  try {
    return `${tool}(./${assertRelativePath(path, 'policy path')})`;
  } catch (error) {
    diagnostics.push({
      code: 'policy.invalid-rule',
      severity: 'error',
      message: `invalid policy path: ${error instanceof Error ? error.message : String(error)}`,
      file: PROJECT_SOURCE,
    });
    return undefined;
  }
}

function mapExecute(command: string, diagnostics: Diagnostic[]): string | undefined {
  if (command.includes('\0') || command.trim().length === 0) {
    diagnostics.push({
      code: 'policy.invalid-rule',
      severity: 'error',
      message: `invalid execute rule: ${command}`,
      file: PROJECT_SOURCE,
    });
    return undefined;
  }
  return `Bash(${command.trim()}:*)`;
}

function mapCapability(capability: 'web' | 'web-search' | 'notebook'): string {
  switch (capability) {
    case 'web':
      return 'WebFetch';
    case 'web-search':
      return 'WebSearch';
    case 'notebook':
      return 'NotebookEdit';
  }
}

function addRule(
  target: Map<string, string>,
  rule: string,
  source: string,
  diagnostics: Diagnostic[],
): void {
  if (!RULE_PATTERN.test(rule)) {
    diagnostics.push({
      code: 'policy.invalid-rule',
      severity: 'error',
      message: `invalid Claude Code permission rule: ${rule}`,
      file: source,
    });
    return;
  }
  const previous = target.get(rule);
  target.set(rule, previous === undefined ? source : `${previous}, ${source}`);
}

function projectRules(policy: PolicySpec, diagnostics: Diagnostic[]): {
  allow: Map<string, string>;
  ask: Map<string, string>;
  deny: Map<string, string>;
} {
  const allow = new Map<string, string>();
  const ask = new Map<string, string>();
  const deny = new Map<string, string>();

  for (const path of policy.read.deny) {
    const rule = mapPath(path, 'Read', diagnostics);
    if (rule !== undefined) {
      addRule(deny, rule, PROJECT_SOURCE, diagnostics);
    }
  }
  for (const path of policy.write.deny) {
    for (const tool of ['Edit', 'Write'] as const) {
      const rule = mapPath(path, tool, diagnostics);
      if (rule !== undefined) {
        addRule(deny, rule, PROJECT_SOURCE, diagnostics);
      }
    }
  }
  for (const command of policy.execute.deny) {
    const rule = mapExecute(command, diagnostics);
    if (rule !== undefined) {
      addRule(deny, rule, PROJECT_SOURCE, diagnostics);
    }
  }
  for (const command of policy.execute.ask) {
    const rule = mapExecute(command, diagnostics);
    if (rule !== undefined) {
      addRule(ask, rule, PROJECT_SOURCE, diagnostics);
    }
  }
  for (const capability of policy.capabilities.deny) {
    addRule(deny, mapCapability(capability), PROJECT_SOURCE, diagnostics);
  }

  return { allow, ask, deny };
}

function adapterRules(policy: ClaudeCodePolicy, diagnostics: Diagnostic[]): {
  allow: Map<string, string>;
  ask: Map<string, string>;
  deny: Map<string, string>;
} {
  const allow = new Map<string, string>();
  const ask = new Map<string, string>();
  const deny = new Map<string, string>();
  for (const rule of policy.permissions.allow) {
    addRule(allow, rule, ADAPTER_SOURCE, diagnostics);
  }
  for (const rule of policy.permissions.ask) {
    addRule(ask, rule, ADAPTER_SOURCE, diagnostics);
  }
  for (const rule of policy.permissions.deny) {
    addRule(deny, rule, ADAPTER_SOURCE, diagnostics);
  }
  return { allow, ask, deny };
}

function mergeRules(
  ...maps: Array<Map<string, string>>
): Map<string, string> {
  const output = new Map<string, string>();
  for (const map of maps) {
    for (const [rule, source] of map) {
      const previous = output.get(rule);
      output.set(rule, previous === undefined ? source : `${previous}, ${source}`);
    }
  }
  return output;
}

function sortedRules(map: Map<string, string>): string[] {
  return [...map.keys()].sort();
}

function effectiveProjectHooks(
  hooks: LoadedHook[],
  diagnostics: Diagnostic[],
): EffectiveHook[] {
  const output: EffectiveHook[] = [];
  const ids = new Set<string>();

  for (const hook of hooks) {
    if (ids.has(hook.spec.id)) {
      diagnostics.push({
        code: 'hook.duplicate-id',
        severity: 'error',
        message: `duplicate hook id ${hook.spec.id}`,
        file: hook.metadataPath,
      });
      continue;
    }
    try {
      assertRelativePath(hook.dir, 'hook directory');
      assertRelativePath(hook.spec.entry, 'hook entry');
    } catch (error) {
      diagnostics.push({
        code: 'hook.entry',
        severity: 'error',
        message: `invalid hook entry: ${error instanceof Error ? error.message : String(error)}`,
        file: hook.metadataPath,
      });
      continue;
    }

    ids.add(hook.spec.id);
    const matcher = hookMatcher(hook);
    output.push({
      id: hook.spec.id,
      event: mapHookEvent(hook.spec.event),
      ...(matcher === undefined ? {} : { matcher }),
      command: buildHookCommand(hook),
      timeout: hook.spec.timeout,
      order: hook.spec.order,
      source: hook.metadataPath,
      scope: 'project',
    });
  }

  return output.sort((left, right) =>
    left.order - right.order || left.id.localeCompare(right.id));
}

function effectiveAgentHooks(
  agent: AgentDefinition | undefined,
  projectHookIds: Set<string>,
  managedCommands: ReadonlySet<string>,
  diagnostics: Diagnostic[],
): EffectiveHook[] {
  if (agent === undefined) {
    return [];
  }
  const output: EffectiveHook[] = [];
  const ids = new Set<string>();
  agent.hooks.forEach((hook, index) => {
    if (projectHookIds.has(hook.id) || ids.has(hook.id)) {
      diagnostics.push({
        code: 'hook.duplicate-id',
        severity: 'error',
        message: `agent ${agent.name} reuses hook id ${hook.id}`,
        file: hook.source,
      });
      return;
    }
    if (hook.command.trim().length === 0) {
      diagnostics.push({
        code: 'hook.invalid',
        severity: 'error',
        message: `agent ${agent.name} hook ${hook.id} has an empty command`,
        file: hook.source,
      });
      return;
    }
    if (!isManagedAgentHookCommand(hook.command, managedCommands)) {
      diagnostics.push(unmanagedAgentHookDiagnostic(agent.name, hook));
      return;
    }
    ids.add(hook.id);
    output.push({
      id: hook.id,
      event: hook.event,
      ...(hook.matcher === undefined ? {} : { matcher: hook.matcher }),
      command: hook.command,
      timeout: hook.timeout ?? 600,
      order: 1000 + index,
      source: hook.source,
      scope: 'agent',
    });
  });
  return output;
}

export function compilePolicy(
  project: PolicySpec,
  adapter: ClaudeCodePolicy,
  hooks: LoadedHook[],
  agent?: AgentDefinition,
): CompileResult {
  const diagnostics: Diagnostic[] = [];

  if (!ALLOWED_MODES.has(project.defaultMode)) {
    diagnostics.push({
      code: 'policy.invalid-mode',
      severity: 'error',
      message: `project defaultMode is not allowed: ${project.defaultMode}`,
      file: PROJECT_SOURCE,
      hint: 'Project settings may use default, plan or acceptEdits only.',
    });
  }

  if (agent?.memory === 'project') {
    diagnostics.push({
      code: 'agent.memory-project',
      severity: 'error',
      message: `agent ${agent.name} uses memory: project`,
      file: agent.file,
      hint: 'Use memory: user or memory: local; shared knowledge belongs in .agents/memory/.',
    });
  }
  if (agent?.permissionMode === 'auto' || agent?.permissionMode === 'bypassPermissions') {
    diagnostics.push({
      code: 'agent.permission-mode',
      severity: 'error',
      message: `agent ${agent.name} uses unsupported permissionMode: ${agent.permissionMode}`,
      file: agent.file,
    });
  }

  const fromProject = projectRules(project, diagnostics);
  const fromAdapter = adapterRules(adapter, diagnostics);
  const allow = mergeRules(fromProject.allow, fromAdapter.allow);
  const ask = mergeRules(fromProject.ask, fromAdapter.ask);
  const deny = mergeRules(fromProject.deny, fromAdapter.deny);

  for (const [rule, allowSource] of allow) {
    const denySource = deny.get(rule);
    if (denySource !== undefined) {
      diagnostics.push({
        code: 'policy.conflict',
        severity: 'error',
        message: `rule ${rule} is both denied (${denySource}) and allowed (${allowSource})`,
        file: ADAPTER_SOURCE,
      });
    }
  }
  for (const [rule, askSource] of ask) {
    const denySource = deny.get(rule);
    if (denySource !== undefined) {
      diagnostics.push({
        code: 'policy.conflict',
        severity: 'error',
        message: `rule ${rule} is both denied (${denySource}) and asked (${askSource})`,
        file: ADAPTER_SOURCE,
      });
    }
  }

  const projectHooks = effectiveProjectHooks(hooks, diagnostics);
  const projectHookIds = new Set(projectHooks.map((hook) => hook.id));
  const managedCommands = buildManagedHookCommands(hooks);
  const agentHooks = effectiveAgentHooks(agent, projectHookIds, managedCommands, diagnostics);
  const effectiveHooks = [...projectHooks, ...agentHooks].sort((left, right) =>
    left.order - right.order || left.id.localeCompare(right.id));

  const sources = [
    PROJECT_SOURCE,
    ADAPTER_SOURCE,
    ...hooks.map((hook) => hook.metadataPath),
    ...(agent === undefined ? [] : [agent.file]),
  ].sort();

  return {
    effective: {
      provider: 'claude-code',
      defaultMode: project.defaultMode,
      permissions: {
        allow: sortedRules(allow),
        ask: sortedRules(ask),
        deny: sortedRules(deny),
        disableBypassPermissionsMode: 'disable',
      },
      hooks: effectiveHooks,
      sources: [...new Set(sources)],
      limitations: [...LIMITATIONS],
    },
    diagnostics,
  };
}

