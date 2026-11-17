import type { TargetProvider } from '../model/types.ts';
import { claudeCodeAdapter } from './claude-code/adapter.ts';
import type { TargetAdapter } from './types.ts';

const adapters = new Map<TargetProvider, TargetAdapter>([
  ['claude-code', claudeCodeAdapter],
]);

export function getTargetAdapter(provider: TargetProvider): TargetAdapter | undefined {
  return adapters.get(provider);
}
