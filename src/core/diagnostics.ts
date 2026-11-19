import { compareStrings } from './compare.ts';

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  file?: string;
  line?: number;
  hint?: string;
}

const severityRank: Record<DiagnosticSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

export function sortDiagnostics(items: readonly Diagnostic[]): Diagnostic[] {
  return [...items].sort((left, right) => {
    const severity = severityRank[left.severity] - severityRank[right.severity];
    if (severity !== 0) {
      return severity;
    }
    const file = compareStrings(left.file ?? '', right.file ?? '');
    if (file !== 0) {
      return file;
    }
    const line = (left.line ?? 0) - (right.line ?? 0);
    if (line !== 0) {
      return line;
    }
    return compareStrings(left.code, right.code);
  });
}

export function hasErrors(items: readonly Diagnostic[]): boolean {
  return items.some((item) => item.severity === 'error');
}

export function withFixWarning(item: Diagnostic): Diagnostic {
  return {
    ...item,
    severity: 'warning',
    hint: 'Resolved with --fix; the original was backed up under .dab/backups/.',
  };
}

export function formatDiagnostics(items: readonly Diagnostic[]): string {
  if (items.length === 0) {
    return '';
  }
  const lines = sortDiagnostics(items).map((item) => {
    const location = item.file === undefined
      ? '-'
      : `${item.file}${item.line === undefined ? '' : `:${item.line}`}`;
    const head = `${item.severity.toUpperCase().padEnd(7)} ${location} ${item.code} ${item.message}`;
    return item.hint === undefined ? head : `${head}\n        hint: ${item.hint}`;
  });
  return `${lines.join('\n')}\n`;
}
