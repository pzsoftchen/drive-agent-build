import { discoverAgents } from './agents.ts';
import { discoverHooks } from './hooks.ts';
import { loadPolicySources, type LoadedPolicySources } from './policy.ts';
import { discoverRules } from './rules.ts';
import { discoverSkills } from './skills.ts';
import type {
  AgentDefinition,
  DiscoveryResult,
  LoadedHook,
  ProjectPaths,
  RuleDefinition,
  SkillDefinition,
} from './types.ts';

export interface SourceFacts {
  agents: DiscoveryResult<AgentDefinition>;
  skills: DiscoveryResult<SkillDefinition>;
  rules: DiscoveryResult<RuleDefinition>;
  hooks: DiscoveryResult<LoadedHook>;
  policies: LoadedPolicySources;
}

export async function discoverSourceFacts(
  root: string,
  paths: ProjectPaths,
): Promise<SourceFacts> {
  const [agents, skills, rules, hooks] = await Promise.all([
    discoverAgents(root, paths.agents),
    discoverSkills(root, paths.agents),
    discoverRules(root, paths.agents),
    discoverHooks(root, paths.agents),
  ]);
  const policies = await loadPolicySources(paths);
  return { agents, skills, rules, hooks, policies };
}
