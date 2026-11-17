import { describe, expect, it } from 'vitest';
import { compareSemVer, isVersionAtLeast, parseSemVer } from '../../src/core/semver.ts';

describe('semver', () => {
  it('parses a version from Claude Code output', () => {
    expect(parseSemVer('2.1.325 (Claude Code)')).toMatchObject({
      major: 2,
      minor: 1,
      patch: 325,
    });
    expect(parseSemVer('v2.1.277')).toMatchObject({ major: 2, minor: 1, patch: 277 });
  });

  it('rejects incomplete or non-version strings', () => {
    expect(parseSemVer('2.1')).toBeNull();
    expect(parseSemVer('Claude Code')).toBeNull();
  });

  it('compares versions numerically', () => {
    const older = parseSemVer('2.1.100');
    const newer = parseSemVer('2.1.325');
    expect(older).not.toBeNull();
    expect(newer).not.toBeNull();
    if (older === null || newer === null) {
      throw new Error('expected versions');
    }
    expect(compareSemVer(older, newer)).toBeLessThan(0);
    expect(compareSemVer(newer, older)).toBeGreaterThan(0);
    expect(compareSemVer(newer, newer)).toBe(0);
  });

  it('checks the minimum version', () => {
    expect(isVersionAtLeast('2.1.325', '2.1.277')).toBe(true);
    expect(isVersionAtLeast('2.1.100', '2.1.277')).toBe(false);
    expect(isVersionAtLeast('not-a-version', '2.1.277')).toBe(false);
  });
});
