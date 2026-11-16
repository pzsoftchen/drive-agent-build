import { describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import {
  assertRelativePath,
  isPathInside,
  relativeLink,
  resolveInside,
  toPosix,
} from '../../src/core/paths.ts';

describe('path safety', () => {
  it('normalizes accepted relative paths', () => {
    expect(assertRelativePath('docs/./a.md', 'doc')).toBe('docs/a.md');
    expect(assertRelativePath('docs\\a.md', 'doc')).toBe('docs/a.md');
  });

  it.each(['../x', '/absolute', 'C:\\absolute', 'a\u0000b', '~/.ssh/config', ''])(
    'rejects unsafe relative path %s',
    (value) => {
      expect(() => assertRelativePath(value, 'doc')).toThrow();
    },
  );

  it('resolves paths inside the project and rejects escapes', () => {
    const root = resolve('/tmp/project');
    expect(resolveInside(root, 'docs/a.md')).toBe(join(root, 'docs', 'a.md'));
    expect(() => resolveInside(root, '../outside')).toThrow();
  });

  it('checks containment with path boundaries', () => {
    expect(isPathInside('/tmp/project', '/tmp/project/docs/a.md')).toBe(true);
    expect(isPathInside('/tmp/project', '/tmp/projectile/a.md')).toBe(false);
    expect(isPathInside('/tmp/project', '/tmp/project')).toBe(true);
  });

  it('creates posix relative link targets', () => {
    const target = join('/tmp/project', '.claude', 'agents', 'reviewer.md');
    const source = join('/tmp/project', '.agents', 'agents', 'reviewer.md');
    expect(relativeLink(target, source)).toBe('../../.agents/agents/reviewer.md');
    expect(toPosix('a\\b/c')).toBe('a/b/c');
  });
});
