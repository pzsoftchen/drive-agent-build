import type { PracticeContext, PracticePack, PracticeTargetSet } from './practice.ts';
import {
  AUTHORING_SKILL_NAMES,
  renderAuthoringSkill,
  type AuthoringSkillName,
} from './skill-templates.ts';

export { AUTHORING_SKILL_NAMES, renderAuthoringSkill };
export type { AuthoringSkillName };

function skillDirectory(name: AuthoringSkillName): string {
  return `.agents/skills/${name}`;
}

function skillFile(name: AuthoringSkillName): string {
  return `${skillDirectory(name)}/SKILL.md`;
}

function authoringTargets(context: PracticeContext): PracticeTargetSet {
  if (context.scope !== 'project') {
    return { paths: [] };
  }
  const directories = AUTHORING_SKILL_NAMES.map(skillDirectory);
  return {
    paths: AUTHORING_SKILL_NAMES.map(skillFile),
    directories,
    // An existing skill directory belongs to the user: skip it and every
    // declared file under it instead of adding or merging a SKILL.md.
    skipChildrenWhenExists: directories,
  };
}

export const authoringPack: PracticePack = {
  id: 'authoring',
  targets: authoringTargets,
  async files(context) {
    if (context.scope !== 'project') {
      return {};
    }
    const files: Record<string, string> = {};
    for (const name of AUTHORING_SKILL_NAMES) {
      files[skillFile(name)] = await renderAuthoringSkill(name, context.version);
    }
    return files;
  },
};
