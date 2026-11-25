import { isAuthoredPathProblem } from '../core/practice-paths.ts';
import { discoverAgents } from './agents.ts';
import { discoverHooks } from './hooks.ts';
import { loadCommonPolicy } from './policy.ts';
import { discoverRules } from './rules.ts';
import { discoverSkills } from './skills.ts';
import type {
  AgentDefinition,
  DiscoveryResult,
  LoadedHook,
  PolicySpec,
  ProjectPaths,
  RuleDefinition,
  SkillDefinition,
} from './types.ts';

export interface CommonFacts {
  agents: DiscoveryResult<AgentDefinition>;
  skills: DiscoveryResult<SkillDefinition>;
  rules: DiscoveryResult<RuleDefinition>;
  hooks: DiscoveryResult<LoadedHook>;
  policy: PolicySpec;
  policyPath: string;
}

/**
 * A regular file, denied access or link loop at the exact `.agents/rules` or
 * `.agents/skills` parent makes discovery raise. The practice checks report
 * that parent as a governed path error, so the affected fact set stays empty
 * instead of failing the whole command. Nested errors are not suppressed:
 * skill discovery isolates them per directory and reports `skill.unreadable`,
 * so one broken skill never empties every skill fact.
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

export async function discoverCommonFacts(
  root: string,
  paths: ProjectPaths,
): Promise<CommonFacts> {
  const [agents, skills, rules, hooks] = await Promise.all([
    discoverOrEmpty(root, () => discoverAgents(root, paths.agents)),
    discoverOrEmpty(root, () => discoverSkills(root, paths.agents)),
    discoverOrEmpty(root, () => discoverRules(root, paths.agents)),
    discoverOrEmpty(root, () => discoverHooks(root, paths.agents)),
  ]);
  const policy = await loadCommonPolicy(paths);
  return {
    agents,
    skills,
    rules,
    hooks,
    policy: policy.policy,
    policyPath: policy.path,
  };
}
