import { compareStrings } from '../../core/compare.ts';
import { stableJson } from '../../core/json.ts';
import type { EffectiveHook, EffectivePolicy } from './policy-compile.ts';

export interface ClaudeSettingsObject {
  $schema: string;
  permissions: {
    allow: string[];
    ask: string[];
    defaultMode: string;
    deny: string[];
    disableBypassPermissionsMode: 'disable';
  };
  hooks?: Record<
    string,
    Array<{
      matcher?: string;
      hooks: Array<{ type: 'command'; command: string; timeout: number }>;
    }>
  >;
}

function groupProjectHooks(hooks: readonly EffectiveHook[]): ClaudeSettingsObject['hooks'] {
  const events = new Map<string, Map<string, EffectiveHook[]>>();
  for (const hook of hooks) {
    if (hook.scope !== 'project') {
      continue;
    }
    const matcher = hook.matcher ?? '';
    const byMatcher = events.get(hook.event) ?? new Map<string, EffectiveHook[]>();
    const group = byMatcher.get(matcher) ?? [];
    group.push(hook);
    byMatcher.set(matcher, group);
    events.set(hook.event, byMatcher);
  }

  if (events.size === 0) {
    return undefined;
  }

  const output: NonNullable<ClaudeSettingsObject['hooks']> = {};
  for (const event of [...events.keys()].sort()) {
    const byMatcher = events.get(event);
    if (byMatcher === undefined) {
      continue;
    }
    output[event] = [...byMatcher.keys()]
      .sort()
      .map((matcher) => {
        const group = [...(byMatcher.get(matcher) ?? [])].sort((left, right) =>
          left.order - right.order || compareStrings(left.id, right.id));
        return {
          ...(matcher.length === 0 ? {} : { matcher }),
          hooks: group.map((hook) => ({
            type: 'command' as const,
            command: hook.command,
            timeout: hook.timeout,
          })),
        };
      });
  }
  return output;
}

export function renderSettingsObject(effective: EffectivePolicy): ClaudeSettingsObject {
  const hooks = groupProjectHooks(effective.hooks);
  return {
    $schema: 'https://json.schemastore.org/claude-code-settings.json',
    permissions: {
      allow: [...effective.permissions.allow].sort(),
      ask: [...effective.permissions.ask].sort(),
      defaultMode: effective.defaultMode,
      deny: [...effective.permissions.deny].sort(),
      disableBypassPermissionsMode: 'disable',
    },
    ...(hooks === undefined ? {} : { hooks }),
  };
}

export function renderSettings(effective: EffectivePolicy): string {
  return stableJson(renderSettingsObject(effective));
}
