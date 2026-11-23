import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AUTHORING_SKILL_NAMES,
  authoringPack,
  renderAuthoringSkill,
} from '../../src/init/practice-authoring.ts';
import {
  planAuthoredScaffold,
  type AuthoredScaffoldInput,
  type AuthoredScaffoldPlan,
} from '../../src/init/practice.ts';
import { scanProject, type ScanResult } from '../../src/init/scanner.ts';
import { validateSkillSource } from '../../src/model/skills.ts';
import { makeTempDir } from '../helpers/tmp.ts';

const dirs: string[] = [];
let root: string;
let scan: ScanResult;

const SKILL_SECTIONS = [
  '## When to use',
  '## Inputs',
  '## Workflow',
  '## Evidence and fact-check',
  '## TODO rules',
  '## Project commands',
  '## Verification',
] as const;

function skillFile(name: (typeof AUTHORING_SKILL_NAMES)[number]): string {
  return `.agents/skills/${name}/SKILL.md`;
}

function skillDir(name: (typeof AUTHORING_SKILL_NAMES)[number]): string {
  return `.agents/skills/${name}`;
}

async function planPack(
  overrides: Partial<AuthoredScaffoldInput> = {},
): Promise<AuthoredScaffoldPlan> {
  return planAuthoredScaffold(
    {
      root,
      scope: 'project',
      scan,
      profile: 'generic',
      mode: 'converge',
      version: '0.0.0',
      env: {},
      ...overrides,
    },
    [authoringPack],
  );
}

beforeEach(async () => {
  root = await makeTempDir('dab-practice-authoring-');
  dirs.push(root);
  scan = await scanProject(root);
});

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('renderAuthoringSkill', () => {
  it('renders schema-valid skills with a dab-skill version marker', async () => {
    const plan = await planPack({ mode: 'converge', version: '9.9.9' });
    for (const name of AUTHORING_SKILL_NAMES) {
      const file = skillFile(name);
      expect(plan.files[file]).toContain(`<!-- dab-skill: ${name}@9.9.9 -->`);
      const dir = join(root, '.agents/skills', name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'SKILL.md'), plan.files[file]!);
      const validated = await validateSkillSource(root, dir);
      expect(validated.item?.name).toBe(name);
      expect(validated.diagnostics).toEqual([]);
    }
  });

  it('requires evidence, TODO(owner), project commands and docs fallback', () => {
    const text = renderAuthoringSkill('dab-architecture-writing', '1.0.0');
    expect(text).toContain('TODO(owner): question');
    expect(text).toContain('root `AGENTS.md`');
    expect(text).toContain('`docs/AGENTS.md` exists');
    expect(text).toContain('package.json');
    expect(text).toContain('does not invent');
  });

  it('ships the same required sections and contract in every skill', () => {
    for (const name of AUTHORING_SKILL_NAMES) {
      const text = renderAuthoringSkill(name, '1.0.0');
      expect(text).toMatch(new RegExp(`^---\\nname: ${name}\\ndescription: .+\\n---\\n`));
      expect(text).toContain(`<!-- dab-skill: ${name}@1.0.0 -->`);
      for (const heading of SKILL_SECTIONS) {
        expect(text).toContain(heading);
      }
      expect(text).toContain('TODO(owner): question');
      expect(text).toContain('does not invent');
      expect(text).toContain('root `AGENTS.md`');
      expect(text).toContain('`docs/AGENTS.md` exists');
      expect(text).toContain('package.json');
    }
  });

  it('keeps commands generic instead of hardcoding a package manager or test framework', () => {
    for (const name of AUTHORING_SKILL_NAMES) {
      const text = renderAuthoringSkill(name, '1.0.0');
      expect(text).not.toMatch(/\b(?:npm|pnpm|yarn|bun)\b/);
      expect(text).not.toMatch(/\b(?:vitest|jest|mocha|pytest)\b/);
      expect(text).not.toMatch(/deepseek-harness|\bdsh\b/i);
    }
  });

  it('dab-doc-writing covers placement, fact-check, slop audit and single language', () => {
    const text = renderAuthoringSkill('dab-doc-writing', '1.0.0');
    expect(text).toContain('Placement');
    expect(text).toContain('one home');
    expect(text).toContain('Fact-check');
    expect(text).toContain('Slop audit');
    expect(text).toContain('single language');
    expect(text).not.toContain('.i18n.yaml');
    expect(text).not.toContain('.zh.md');
  });

  it('dab-architecture-writing covers inventory, composition, runtime and seams', () => {
    const text = renderAuthoringSkill('dab-architecture-writing', '1.0.0');
    expect(text).toContain('Top-level inventory');
    expect(text).toContain('Composition');
    expect(text).toContain('Runtime flow');
    expect(text).toContain('Seams');
    expect(text).toContain('current-state');
    expect(text).toContain('Link owners');
    expect(text).toContain('Fill TODOs');
  });

  it('dab-decision-notes covers statuses, consequences and supersession without archiving', () => {
    const text = renderAuthoringSkill('dab-decision-notes', '1.0.0');
    expect(text).toContain('When to write');
    expect(text).toContain('proposed');
    expect(text).toContain('implemented');
    expect(text).toContain('rejected');
    expect(text).toContain('Alternatives');
    expect(text).toContain('Consequences');
    expect(text).toContain('Verification');
    expect(text).toContain('supersession');
    expect(text).toContain('Do not archive');
    expect(text).not.toContain('.agents/notes/archived');
  });
});

describe('authoringPack', () => {
  it('plans the three skill directories and files in project scope', async () => {
    const plan = await planPack({ mode: 'converge' });
    expect(Object.keys(plan.files).sort()).toEqual(AUTHORING_SKILL_NAMES.map(skillFile).sort());
    expect([...plan.directories].sort()).toEqual(AUTHORING_SKILL_NAMES.map(skillDir).sort());
    expect(plan.skipped).toEqual([]);
    expect(plan.diagnostics).toEqual([]);
  });

  it('does not let the broad .agents/skills directory suppress missing skills', async () => {
    await mkdir(join(root, '.agents/skills'), { recursive: true });
    const plan = await planPack({ mode: 'converge' });
    expect(plan.skipped).toEqual([]);
    for (const name of AUTHORING_SKILL_NAMES) {
      expect(plan.files).toHaveProperty(skillFile(name));
      expect(plan.directories).toContain(skillDir(name));
    }
  });

  it('skips an existing skill directory instead of adding SKILL.md', async () => {
    await mkdir(join(root, '.agents/skills/dab-doc-writing'), { recursive: true });
    await writeFile(join(root, '.agents/skills/dab-doc-writing/README.md'), 'user owned');
    const plan = await planPack({ mode: 'converge' });
    expect(plan.files).not.toHaveProperty(skillFile('dab-doc-writing'));
    expect(plan.skipped).toContain(skillDir('dab-doc-writing'));
    expect(plan.files).toHaveProperty(skillFile('dab-architecture-writing'));
    expect(plan.files).toHaveProperty(skillFile('dab-decision-notes'));
    await expect(
      readFile(join(root, '.agents/skills/dab-doc-writing/README.md'), 'utf8'),
    ).resolves.toBe('user owned');
  });

  it('leaves an invalid existing SKILL.md to skill discovery without overwriting it', async () => {
    const dir = join(root, '.agents/skills/dab-doc-writing');
    await mkdir(dir, { recursive: true });
    const invalid = '# not a skill\n';
    await writeFile(join(dir, 'SKILL.md'), invalid);
    const plan = await planPack({ mode: 'converge' });
    expect(plan.files).not.toHaveProperty(skillFile('dab-doc-writing'));
    expect(plan.skipped).toContain(skillDir('dab-doc-writing'));
    expect(plan.diagnostics).toEqual([]);
    const validated = await validateSkillSource(root, dir);
    expect(validated.item).toBeUndefined();
    expect(validated.diagnostics.map((item) => item.code)).toContain('skill.invalid-frontmatter');
    await expect(readFile(join(dir, 'SKILL.md'), 'utf8')).resolves.toBe(invalid);
  });

  it('reports a file at a skill directory path as a path-type error', async () => {
    await mkdir(join(root, '.agents/skills'), { recursive: true });
    await writeFile(join(root, '.agents/skills/dab-doc-writing'), 'not a directory');
    const plan = await planPack({ mode: 'converge' });
    const conflict = plan.diagnostics.find(
      (item) => item.severity === 'error' && item.file === skillDir('dab-doc-writing'),
    );
    expect(conflict?.code).toBe('path.conflict');
    expect(plan.files).toEqual({});
    expect(plan.directories).not.toContain(skillDir('dab-doc-writing'));
  });

  it('plans no targets in global scope', async () => {
    const plan = await planPack({ scope: 'global', mode: 'full' });
    expect(plan.files).toEqual({});
    expect(plan.directories).toEqual([]);
    expect(plan.skipped).toEqual([]);
    expect(plan.policySkipped).toEqual([]);
    expect(plan.diagnostics).toEqual([]);
  });
});
