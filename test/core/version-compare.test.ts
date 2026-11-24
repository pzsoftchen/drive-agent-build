import { describe, expect, it } from 'vitest';
import { compareVersions, parseVersion } from '../../src/core/version-compare.ts';

describe('parseVersion', () => {
  it('parses dotted numeric versions into comparable parts', () => {
    expect(parseVersion('0.1.2')).toEqual([0, 1, 2]);
    expect(parseVersion('9.9.9')).toEqual([9, 9, 9]);
    expect(parseVersion('0.1.2.0')).toEqual([0, 1, 2, 0]);
    expect(parseVersion('10')).toEqual([10]);
  });

  it('rejects versions that are not dotted numeric strings', () => {
    expect(parseVersion('v1.2.3')).toBeUndefined();
    expect(parseVersion('1.2.x')).toBeUndefined();
    expect(parseVersion('1..2')).toBeUndefined();
    expect(parseVersion('1.2.3-beta')).toBeUndefined();
    expect(parseVersion('')).toBeUndefined();
    expect(parseVersion(' 1.2.3')).toBeUndefined();
  });
});

describe('compareVersions', () => {
  it('orders versions numerically', () => {
    expect(compareVersions([0, 1, 2], [0, 1, 3])).toBeLessThan(0);
    expect(compareVersions([0, 2, 0], [0, 1, 9])).toBeGreaterThan(0);
    expect(compareVersions([9, 9, 9], [0, 1, 2])).toBeGreaterThan(0);
  });

  it('treats missing trailing components as zero', () => {
    expect(compareVersions([0, 1, 2], [0, 1, 2, 0])).toBe(0);
    expect(compareVersions([0, 1], [0, 1, 0, 0])).toBe(0);
  });
});
