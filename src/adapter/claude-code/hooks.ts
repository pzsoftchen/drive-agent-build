import type { Diagnostic } from '../../core/diagnostics.ts';
import { assertRelativePath, joinPosix } from '../../core/paths.ts';
import { DiagnosticCodes } from '../../model/diagnostics-codes.ts';
import { NEUTRAL_HOOK_EVENTS } from '../../model/schemas.ts';
import type { AgentHookDefinition, LoadedHook } from '../../model/types.ts';

export type NeutralHookEvent = (typeof NEUTRAL_HOOK_EVENTS)[number];

const HOOK_EVENT_MAP: Record<NeutralHookEvent, string> = {
  session_start: 'SessionStart',
  session_end: 'SessionEnd',
  pre_tool: 'PreToolUse',
  post_tool: 'PostToolUse',
  post_edit: 'PostToolUse',
  user_prompt: 'UserPromptSubmit',
  agent_stop: 'Stop',
  subagent_stop: 'SubagentStop',
  pre_compact: 'PreCompact',
  notification: 'Notification',
};

export function mapHookEvent(event: NeutralHookEvent): string {
  return HOOK_EVENT_MAP[event];
}

export function hookMatcher(hook: LoadedHook): string | undefined {
  if (hook.spec.event === 'post_edit' && hook.spec.matcher === undefined) {
    return 'Edit|Write|MultiEdit';
  }
  return hook.spec.matcher;
}

export function buildHookCommand(hook: LoadedHook): string {
  const dir = assertRelativePath(hook.dir, 'hook directory');
  const entry = assertRelativePath(hook.spec.entry, 'hook entry');
  const path = joinPosix(dir, entry);
  const commandPath = `\${CLAUDE_PROJECT_DIR}/${path}`;
  if (hook.spec.runner === 'exec') {
    return JSON.stringify(commandPath);
  }
  return `node ${JSON.stringify(commandPath)}`;
}

export function buildManagedHookCommands(hooks: readonly LoadedHook[]): Set<string> {
  const commands = new Set<string>();
  for (const hook of hooks) {
    try {
      commands.add(buildHookCommand(hook));
    } catch {
      // Invalid project hook paths are reported by the hook discovery checks.
    }
  }
  return commands;
}

export function isManagedAgentHookCommand(
  command: string,
  managedCommands: ReadonlySet<string>,
): boolean {
  return managedCommands.has(command.trim());
}

export function unmanagedAgentHookDiagnostic(
  agentName: string,
  hook: AgentHookDefinition,
): Diagnostic {
  return {
    code: DiagnosticCodes.hookAgentUnmanaged,
    severity: 'error',
    message: `agent ${agentName} hook ${hook.id} must invoke a managed .agents/hooks entry`,
    file: hook.source,
    hint: 'Move the command into .agents/hooks/<id>/ and reference its generated command.',
  };
}
