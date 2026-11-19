import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/core/errors.ts';
import {
  describeUnknownTopLevelFields,
  nearestKnownField,
  parseFrontmatter,
} from '../../src/model/frontmatter.ts';

describe('frontmatter', () => {
  it('parses YAML frontmatter and preserves the body', () => {
    const parsed = parseFrontmatter(
      ['---', 'name: reviewer', 'description: Reviews changes.', '---', '', 'Body line.'].join('\n'),
      'reviewer.md',
    );

    expect(parsed.data).toEqual({ name: 'reviewer', description: 'Reviews changes.' });
    expect(parsed.body).toBe('\nBody line.');
    expect(parsed.bodyStartLine).toBe(5);
  });

  it('returns an empty object when frontmatter is absent', () => {
    const parsed = parseFrontmatter('Just a body.\n', 'plain.md');
    expect(parsed.data).toEqual({});
    expect(parsed.body).toBe('Just a body.\n');
    expect(parsed.bodyStartLine).toBe(1);
  });

  it('rejects unclosed frontmatter', () => {
    expect(() => parseFrontmatter('---\nname: broken\n', 'broken.md')).toThrow(ConfigError);
    expect(() => parseFrontmatter('---\nname: broken\n', 'broken.md')).toThrow(/frontmatter/i);
  });

  it('rejects non-object frontmatter', () => {
    expect(() => parseFrontmatter('---\n- one\n- two\n---\nbody\n', 'list.md')).toThrow(
      ConfigError,
    );
  });
});

describe('unknown frontmatter fields', () => {
  const known = ['name', 'description', 'tools', 'disallowedTools', 'permissionMode'];

  it('suggests the closest known field for likely typos', () => {
    expect(nearestKnownField('toolz', known)).toBe('tools');
    expect(nearestKnownField('disallowedTool', known)).toBe('disallowedTools');
    expect(nearestKnownField('permissionmode', known)).toBe('permissionMode');
    expect(nearestKnownField('futureField', known)).toBeUndefined();
  });

  it('handles transposed letters and deterministic ties', () => {
    expect(nearestKnownField('nmae', known)).toBe('name');
    expect(nearestKnownField('modle', ['model', 'tools'])).toBe('model');
    expect(nearestKnownField('tooks', ['tools', 'hooks'])).toBe('hooks');
    expect(nearestKnownField('tooks', ['hooks', 'tools'])).toBe('hooks');
  });

  it('formats unknown fields with a did-you-mean hint', () => {
    expect(
      describeUnknownTopLevelFields(known, { name: 'demo', toolz: 'Read', futureField: true }),
    ).toEqual(['futureField', 'toolz (did you mean tools?)']);
  });
});
