import { describe, expect, it } from 'vitest';
import { stableJson } from '../../src/core/json.ts';

describe('stableJson', () => {
  it('sorts object keys recursively while preserving array order', () => {
    const output = stableJson({
      z: 1,
      a: { y: 2, b: 3 },
      list: [{ d: 4, c: 5 }],
    });

    expect(output).toBe(
      '{\n  "a": {\n    "b": 3,\n    "y": 2\n  },\n  "list": [\n    {\n      "c": 5,\n      "d": 4\n    }\n  ],\n  "z": 1\n}\n',
    );
  });

  it('always ends with a single newline', () => {
    expect(stableJson({ ok: true }).endsWith('\n')).toBe(true);
    expect(stableJson({ ok: true }).endsWith('\n\n')).toBe(false);
  });
});
