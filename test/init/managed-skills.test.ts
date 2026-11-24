import { mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lstatOrNull, writeFileAtomic } from '../../src/core/fs-atomic.ts';
import { parseSkillMarker } from '../../src/core/skill-marker.ts';
import {
  applyManagedSkillWrites,
  managedSkillFile,
  planManagedSkills,
  type ManagedSkillPlan,
} from '../../src/init/managed-skills.ts';
import {
  AUTHORING_SKILL_NAMES,
  loadAuthoringSkillTemplate,
  renderAuthoringSkill,
  type AuthoringSkillName,
} from '../../src/init/skill-templates.ts';
import { makeTempDir, removeTempDir } from '../helpers/tmp.ts';

const VERSION = '0.1.2';
const OLD_VERSION = '0.1.1';
const NAME = 'dab-doc-writing';
const FILE = '.agents/skills/dab-doc-writing/SKILL.md';

let root: string;

beforeEach(async () => {
  root = await makeTempDir('dab-managed-skills-');
});

afterEach(async () => {
  await removeTempDir(root);
});

async function writeSkill(name: AuthoringSkillName, content: string): Promise<void> {
  await writeFileAtomic(join(root, managedSkillFile(name)), content);
}

async function readSkill(name: AuthoringSkillName): Promise<string> {
  return readFile(join(root, managedSkillFile(name)), 'utf8');
}

function planOne(name: AuthoringSkillName = NAME): Promise<ManagedSkillPlan> {
  return planManagedSkills({ root, version: VERSION, names: [name] });
}

/** Render a skill and drop the sha256 so it parses as a legacy marker. */
async function legacySkill(
  name: AuthoringSkillName,
  version = OLD_VERSION,
): Promise<string> {
  return (await renderAuthoringSkill(name, version)).replace(/ sha256=[0-9a-f]{64}/, '');
}

describe('planManagedSkills', () => {
  it('plans a create for a missing skill without writing it', async () => {
    const plan = await planOne();

    expect(plan.states).toEqual([{ name: NAME, file: FILE, status: 'missing' }]);
    expect(plan.writes).toEqual([
      { name: NAME, file: FILE, content: await renderAuthoringSkill(NAME, VERSION) },
    ]);
    expect(plan.diagnostics).toEqual([]);
    expect(await lstatOrNull(join(root, FILE))).toBeNull();
  });

  it('reports the current rendered template as current', async () => {
    const rendered = await renderAuthoringSkill(NAME, VERSION);
    await writeSkill(NAME, rendered);

    const plan = await planOne();
    const marker = parseSkillMarker(rendered);

    expect(plan.states).toEqual([
      { name: NAME, file: FILE, status: 'current', version: VERSION, hash: marker?.sha256 },
    ]);
    expect(plan.writes).toEqual([]);
    expect(plan.diagnostics).toEqual([]);
  });

  it('reports an older version with a matching hash as stale and plans an update', async () => {
    const older = await renderAuthoringSkill(NAME, OLD_VERSION);
    await writeSkill(NAME, older);

    const plan = await planOne();

    expect(plan.states).toEqual([
      {
        name: NAME,
        file: FILE,
        status: 'stale',
        version: OLD_VERSION,
        hash: parseSkillMarker(older)?.sha256,
      },
    ]);
    expect(plan.writes).toEqual([
      { name: NAME, file: FILE, content: await renderAuthoringSkill(NAME, VERSION) },
    ]);
    expect(plan.diagnostics).toEqual([]);
  });

  it('reports an edited body as modified and preserves it', async () => {
    const rendered = await renderAuthoringSkill(NAME, VERSION);
    await writeSkill(NAME, `${rendered}\nLocal note.\n`);

    const plan = await planOne();

    expect(plan.states).toEqual([
      {
        name: NAME,
        file: FILE,
        status: 'modified',
        version: VERSION,
        hash: parseSkillMarker(rendered)?.sha256,
      },
    ]);
    expect(plan.writes).toEqual([]);
    expect(plan.diagnostics).toHaveLength(1);
    expect(plan.diagnostics[0]).toMatchObject({
      code: 'practice.skill-modified',
      severity: 'warning',
      file: FILE,
    });
    expect(plan.diagnostics[0]?.message).toContain(NAME);
  });

  it('migrates a legacy marker when the body equals the current template', async () => {
    const legacy = await legacySkill(NAME);
    await writeSkill(NAME, legacy);
    expect(parseSkillMarker(legacy)).toEqual({ name: NAME, version: OLD_VERSION });
    expect(legacy.replace(/^[ \t]*<!-- dab-skill:[^\n]*-->\r?\n/m, '')).toBe(
      await loadAuthoringSkillTemplate(NAME),
    );

    const plan = await planOne();

    expect(plan.states).toEqual([
      { name: NAME, file: FILE, status: 'legacy', version: OLD_VERSION },
    ]);
    expect(plan.writes).toEqual([
      { name: NAME, file: FILE, content: await renderAuthoringSkill(NAME, VERSION) },
    ]);
    expect(plan.diagnostics).toHaveLength(1);
    expect(plan.diagnostics[0]).toMatchObject({
      code: 'practice.skill-legacy',
      severity: 'info',
      file: FILE,
    });
  });

  it('preserves a legacy marker whose body differs from the current template', async () => {
    await writeSkill(NAME, `${await legacySkill(NAME)}\nLocal note.\n`);

    const plan = await planOne();

    expect(plan.states).toEqual([
      { name: NAME, file: FILE, status: 'legacy', version: OLD_VERSION },
    ]);
    expect(plan.writes).toEqual([]);
    expect(plan.diagnostics).toHaveLength(1);
    expect(plan.diagnostics[0]).toMatchObject({
      code: 'practice.skill-legacy',
      severity: 'warning',
      file: FILE,
    });
  });

  it('reports a skill without a marker as unversioned and preserves it', async () => {
    await writeSkill(NAME, await loadAuthoringSkillTemplate(NAME));

    const plan = await planOne();

    expect(plan.states).toEqual([{ name: NAME, file: FILE, status: 'unversioned' }]);
    expect(plan.writes).toEqual([]);
    expect(plan.diagnostics).toHaveLength(1);
    expect(plan.diagnostics[0]).toMatchObject({
      code: 'practice.skill-unversioned',
      severity: 'warning',
      file: FILE,
    });
  });

  it('treats a marker for another skill name as unversioned', async () => {
    await writeSkill(NAME, await renderAuthoringSkill('dab-architecture-writing', VERSION));

    const plan = await planOne();

    expect(plan.states[0]?.status).toBe('unversioned');
    expect(plan.writes).toEqual([]);
  });

  it('checks all authoring skills unless names narrow the set', async () => {
    const only = await planManagedSkills({ root, version: VERSION, names: [NAME] });
    expect(only.states.map((state) => state.name)).toEqual([NAME]);

    const all = await planManagedSkills({ root, version: VERSION });
    expect(all.states.map((state) => state.name)).toEqual([...AUTHORING_SKILL_NAMES]);
  });

  it('reports a path conflict as a blocking error without planning a write', async () => {
    await mkdir(join(root, FILE), { recursive: true });

    const plan = await planOne();

    expect(plan.states).toEqual([]);
    expect(plan.writes).toEqual([]);
    expect(plan.diagnostics).toHaveLength(1);
    expect(plan.diagnostics[0]).toMatchObject({
      code: 'practice.skill-path',
      severity: 'error',
      file: FILE,
    });
  });
});

describe('applyManagedSkillWrites', () => {
  it('writes nothing on a dry run', async () => {
    const missing = await planOne();
    expect(await applyManagedSkillWrites(root, missing, { dryRun: true })).toEqual({
      created: [FILE],
      updated: [],
      migrated: [],
      skipped: [],
    });
    expect(await lstatOrNull(join(root, FILE))).toBeNull();

    const older = await renderAuthoringSkill(NAME, OLD_VERSION);
    await writeSkill(NAME, older);
    const stale = await planOne();
    expect(await applyManagedSkillWrites(root, stale, { dryRun: true })).toEqual({
      created: [],
      updated: [FILE],
      migrated: [],
      skipped: [],
    });
    expect(await readSkill(NAME)).toBe(older);
  });

  it('creates missing skills atomically', async () => {
    const plan = await planOne();

    const result = await applyManagedSkillWrites(root, plan, { dryRun: false });

    expect(result).toEqual({ created: [FILE], updated: [], migrated: [], skipped: [] });
    expect(await readSkill(NAME)).toBe(await renderAuthoringSkill(NAME, VERSION));
    // Atomic replacement leaves no temp file behind in the skill directory.
    expect(await readdir(dirname(join(root, FILE)))).toEqual(['SKILL.md']);
  });

  it('updates stale skills atomically', async () => {
    await writeSkill(NAME, await renderAuthoringSkill(NAME, OLD_VERSION));
    const plan = await planOne();

    const result = await applyManagedSkillWrites(root, plan, { dryRun: false });

    expect(result).toEqual({ created: [], updated: [FILE], migrated: [], skipped: [] });
    expect(await readSkill(NAME)).toBe(await renderAuthoringSkill(NAME, VERSION));
    expect(await readdir(dirname(join(root, FILE)))).toEqual(['SKILL.md']);
  });

  it('migrates a matching legacy skill to the current marker', async () => {
    await writeSkill(NAME, await legacySkill(NAME));
    const plan = await planOne();

    const result = await applyManagedSkillWrites(root, plan, { dryRun: false });

    expect(result).toEqual({ created: [], updated: [], migrated: [FILE], skipped: [] });
    expect(await readSkill(NAME)).toBe(await renderAuthoringSkill(NAME, VERSION));
  });

  it('never overwrites a modified skill', async () => {
    const edited = `${await renderAuthoringSkill(NAME, VERSION)}\nLocal note.\n`;
    await writeSkill(NAME, edited);
    const plan = await planOne();

    const result = await applyManagedSkillWrites(root, plan, { dryRun: false });

    expect(result).toEqual({ created: [], updated: [], migrated: [], skipped: [FILE] });
    expect(await readSkill(NAME)).toBe(edited);
  });

  it('skips current skills', async () => {
    await writeSkill(NAME, await renderAuthoringSkill(NAME, VERSION));
    const plan = await planOne();

    const result = await applyManagedSkillWrites(root, plan, { dryRun: false });

    expect(result).toEqual({ created: [], updated: [], migrated: [], skipped: [FILE] });
  });

  it('fails loud when a managed state has no planned write', async () => {
    const plan: ManagedSkillPlan = {
      states: [{ name: NAME, file: FILE, status: 'stale', version: OLD_VERSION }],
      writes: [],
      diagnostics: [],
    };

    await expect(applyManagedSkillWrites(root, plan, { dryRun: true })).rejects.toThrow(
      /stale/i,
    );
  });

  it('fails loud when a write targets a state that is never written', async () => {
    const plan: ManagedSkillPlan = {
      states: [{ name: NAME, file: FILE, status: 'modified', version: VERSION }],
      writes: [{ name: NAME, file: FILE, content: 'ignored' }],
      diagnostics: [],
    };

    await expect(applyManagedSkillWrites(root, plan, { dryRun: true })).rejects.toThrow(
      /modified/i,
    );
  });
});
