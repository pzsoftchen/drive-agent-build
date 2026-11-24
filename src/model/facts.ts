import { isAuthoredPathProblem } from '../core/practice-paths.ts';
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

/**
 * A regular file at `.agents/rules` or `.agents/skills` makes discovery raise
 * ENOTDIR. The practice checks report that parent as a governed path error, so
 * the affected fact set stays empty instead of failing the whole command.
 */
async function discoverOrEmpty<T>(
  root: string,
  run: () => Promise<DiscoveryResult<T>>,
): Promise<DiscoveryResult<T>> {
  try {
    return await run();
  } catch (error) {
    if (isAuthoredPathProblem(error, root)) {
      return { items: [], diagnostics: [] };
    }
    throw error;
  }
}

export async function discoverSourceFacts(
  root: string,
  paths: ProjectPaths,
): Promise<SourceFacts> {
  const [agents, skills, rules, hooks] = await Promise.all([
    discoverOrEmpty(root, () => discoverAgents(root, paths.agents)),
    discoverOrEmpty(root, () => discoverSkills(root, paths.agents)),
    discoverOrEmpty(root, () => discoverRules(root, paths.agents)),
    discoverOrEmpty(root, () => discoverHooks(root, paths.agents)),
  ]);
  const policies = await loadPolicySources(paths);
  return { agents, skills, rules, hooks, policies };
}
