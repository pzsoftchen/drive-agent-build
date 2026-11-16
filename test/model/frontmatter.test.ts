import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/core/errors.ts';
import { parseFrontmatter } from '../../src/model/frontmatter.ts';

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
