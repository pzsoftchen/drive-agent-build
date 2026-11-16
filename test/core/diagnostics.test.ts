import { describe, expect, it } from 'vitest';
import {
  formatDiagnostics,
  hasErrors,
  sortDiagnostics,
  type Diagnostic,
} from '../../src/core/diagnostics.ts';

function diagnostic(overrides: Partial<Diagnostic>): Diagnostic {
  return {
    code: 'test.code',
    severity: 'info',
    message: 'message',
    ...overrides,
  };
}

describe('diagnostics', () => {
  it('sorts errors before warnings before info, then by file and line', () => {
    const sorted = sortDiagnostics([
      diagnostic({ code: 'i', severity: 'info' }),
      diagnostic({ code: 'w2', severity: 'warning', file: 'b.md', line: 2 }),
      diagnostic({ code: 'e2', severity: 'error', file: 'b.md', line: 3 }),
      diagnostic({ code: 'w1', severity: 'warning', file: 'a.md', line: 1 }),
      diagnostic({ code: 'e1', severity: 'error', file: 'a.md', line: 9 }),
    ]);

    expect(sorted.map((item) => item.code)).toEqual(['e1', 'e2', 'w1', 'w2', 'i']);
  });

  it('reports whether any error exists', () => {
    expect(hasErrors([diagnostic({ severity: 'warning' })])).toBe(false);
    expect(hasErrors([diagnostic({ severity: 'error' })])).toBe(true);
  });

  it('renders a readable line with file, line and hint', () => {
    const text = formatDiagnostics([
      diagnostic({
        code: 'DAB-X',
        severity: 'error',
        file: 'AGENTS.md',
        line: 12,
        message: 'bad thing',
        hint: 'fix it',
      }),
    ]);

    expect(text).toContain('ERROR');
    expect(text).toContain('AGENTS.md:12');
    expect(text).toContain('DAB-X');
    expect(text).toContain('bad thing');
    expect(text).toContain('fix it');
  });
});
