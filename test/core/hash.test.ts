import { describe, expect, it } from 'vitest';
import { sha256 } from '../../src/core/hash.ts';

describe('sha256', () => {
  it('hashes strings with the standard algorithm', () => {
    expect(sha256('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('distinguishes buffer content', () => {
    expect(sha256(Buffer.from('abc'))).not.toBe(sha256('abd'));
  });
});
