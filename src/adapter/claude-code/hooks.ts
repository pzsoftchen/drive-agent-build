import { assertRelativePath, joinPosix } from '../../core/paths.ts';
import { NEUTRAL_HOOK_EVENTS } from '../../model/schemas.ts';
import type { LoadedHook } from '../../model/types.ts';

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
  if (hook.spec.runner === 'exec') {
    return `"\${CLAUDE_PROJECT_DIR}/${path}"`;
  }
  return `node "\${CLAUDE_PROJECT_DIR}/${path}"`;
}
