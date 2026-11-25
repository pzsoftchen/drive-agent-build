import { join, relative } from 'node:path';
import { compareStrings } from '../../src/core/compare.ts';
import { readTextFile } from '../../src/core/fs-atomic.ts';
import { sha256 } from '../../src/core/hash.ts';
import { toPosix } from '../../src/core/paths.ts';
import type { CommonFacts } from '../../src/model/facts.ts';
import { parseFrontmatter } from '../../src/model/frontmatter.ts';
import type { HookSpec, PolicySpec, ProjectPaths } from '../../src/model/types.ts';

export interface NeutralAgentFact {
  name: string;
  description: string;
  body: string;
}

export interface NeutralSkillFact {
  name: string;
  description: string;
  body: string;
}

export interface NeutralRuleFact {
  name: string;
  paths: string[];
  body: string;
}

export interface NeutralView {
  instructions: {
    path: string;
    sha256: string;
    text: string;
  };
  agents: NeutralAgentFact[];
  skills: NeutralSkillFact[];
  rules: NeutralRuleFact[];
  hooks: HookSpec[];
  policy: PolicySpec;
}

/**
 * A test-only consumer that understands only the common fact contract.
 * It deliberately projects explicit fields instead of spreading parsed
 * definitions, so provider-specific frontmatter cannot leak into the view.
 */
export async function neutralView(
  root: string,
  paths: ProjectPaths,
  facts: CommonFacts,
): Promise<NeutralView> {
  const instructionsText = await readTextFile(paths.instructions);
  const agents = facts.agents.items
    .map((item): NeutralAgentFact => ({
      name: item.name,
      description: item.description,
      body: item.body,
    }))
    .sort((left, right) => compareStrings(left.name, right.name));

  const skills = await Promise.all(facts.skills.items.map(async (item): Promise<NeutralSkillFact> => {
    const text = await readTextFile(join(root, item.file));
    const parsed = parseFrontmatter(text, item.file);
    return {
      name: item.name,
      description: item.description,
      body: parsed.body,
    };
  }));
  skills.sort((left, right) => compareStrings(left.name, right.name));

  const rules = facts.rules.items
    .map((item): NeutralRuleFact => ({
      name: item.name,
      paths: [...item.paths],
      body: item.body,
    }))
    .sort((left, right) => compareStrings(left.name, right.name));

  const hooks = facts.hooks.items
    .map((item): HookSpec => ({ ...item.spec }))
    .sort((left, right) => compareStrings(left.id, right.id));

  return {
    instructions: {
      path: toPosix(relative(root, paths.instructions)),
      sha256: sha256(instructionsText),
      text: instructionsText,
    },
    agents,
    skills,
    rules,
    hooks,
    policy: facts.policy,
  };
}
