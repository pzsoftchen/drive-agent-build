import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AUTHORING_SKILL_NAMES } from '../../src/init/practice-authoring.ts';
import {
  hashSkillBody,
  insertSkillMarker,
  loadAuthoringSkillTemplate,
  parseSkillMarker,
  renderAuthoringSkill,
  stripMarker,
} from '../../src/init/skill-templates.ts';

const root = process.cwd();

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('loadAuthoringSkillTemplate', () => {
  it('loads each canonical skill from the package skills directory', async () => {
    for (const name of AUTHORING_SKILL_NAMES) {
      const text = await loadAuthoringSkillTemplate(name);
      expect(text).toContain(`name: ${name}`);
      expect(text).not.toContain('<!-- dab-skill:');
    }
  });

  it('returns exactly the file shipped under skills/', async () => {
    for (const name of AUTHORING_SKILL_NAMES) {
      const shipped = await readFile(join(root, 'skills', name, 'SKILL.md'), 'utf8');
      expect(await loadAuthoringSkillTemplate(name)).toBe(shipped);
    }
  });

  it('keeps frontmatter first and the body sections intact', async () => {
    const text = await loadAuthoringSkillTemplate('dab-doc-writing');
    expect(text.startsWith('---\nname: dab-doc-writing\n')).toBe(true);
    expect(text).toContain('\n---\n# Documentation writing\n');
    expect(text.endsWith('\n')).toBe(true);
  });
});

describe('renderAuthoringSkill', () => {
  it('renders a marker with version and a stable sha256', async () => {
    const text = await renderAuthoringSkill('dab-doc-writing', '9.9.9');
    expect(text).toContain('<!-- dab-skill: dab-doc-writing@9.9.9 sha256=');
    const body = stripMarker(text);
    expect(hashSkillBody(body)).toBe(
      hashSkillBody(await loadAuthoringSkillTemplate('dab-doc-writing')),
    );
  });

  it('inserts the marker after frontmatter and round-trips to the template', async () => {
    const template = await loadAuthoringSkillTemplate('dab-architecture-writing');
    const rendered = await renderAuthoringSkill('dab-architecture-writing', '1.2.3');
    const marker = parseSkillMarker(rendered);

    expect(marker).toEqual({
      name: 'dab-architecture-writing',
      version: '1.2.3',
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(rendered).toContain(
      `---\n<!-- dab-skill: dab-architecture-writing@1.2.3 sha256=${marker?.sha256} -->\n# Architecture writing\n`,
    );
    expect(stripMarker(rendered)).toBe(template);
    expect(hashSkillBody(rendered)).toBe(marker?.sha256);
  });

  it('hashes the marker-stripped body independently of the version', async () => {
    const older = await renderAuthoringSkill('dab-decision-notes', '0.0.1');
    const newer = await renderAuthoringSkill('dab-decision-notes', '2.0.0');
    expect(stripMarker(older)).toBe(stripMarker(newer));
    expect(parseSkillMarker(older)?.sha256).toBe(parseSkillMarker(newer)?.sha256);
  });

  it('hashes the template text exactly with SHA-256', async () => {
    const template = await loadAuthoringSkillTemplate('dab-doc-writing');
    expect(hashSkillBody(template)).toBe(sha256(template));
    expect(hashSkillBody(`<!-- dab-skill: dab-doc-writing@1.0.0 -->\n${template}`)).toBe(
      sha256(template),
    );
  });
});

describe('skill marker parsing', () => {
  it('parses a legacy marker without a hash and strips its line', () => {
    const text =
      '---\nname: dab-doc-writing\ndescription: d\n---\n'
      + '<!-- dab-skill: dab-doc-writing@0.1.1 -->\n# Body\n';
    expect(parseSkillMarker(text)).toEqual({ name: 'dab-doc-writing', version: '0.1.1' });
    expect(stripMarker(text)).toBe('---\nname: dab-doc-writing\ndescription: d\n---\n# Body\n');
    expect(parseSkillMarker('# no marker\n')).toBeUndefined();
    expect(stripMarker('# no marker\n')).toBe('# no marker\n');
  });

  it('fails loud when the template has no frontmatter closing line', () => {
    expect(() =>
      insertSkillMarker('# no frontmatter\n', {
        name: 'dab-doc-writing',
        version: '1.0.0',
        sha256: 'a'.repeat(64),
      }),
    ).toThrow(/frontmatter/i);
  });
});
