import { describe, expect, it } from 'vitest';
import { assertSupportedPlatform } from '../../src/core/platform.ts';

describe('assertSupportedPlatform', () => {
  it('rejects Windows in v0.1', () => {
    let caught: unknown;
    try {
      assertSupportedPlatform('win32');
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: 'platform.unsupported',
      message: expect.stringContaining('Windows is not supported'),
    });
  });

  it('accepts macOS and Linux', () => {
    expect(() => assertSupportedPlatform('darwin')).not.toThrow();
    expect(() => assertSupportedPlatform('linux')).not.toThrow();
  });
});
