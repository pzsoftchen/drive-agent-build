import { hasErrors, sortDiagnostics, type Diagnostic } from '../core/diagnostics.ts';
import { verifyDocBudgets } from './budgets.ts';
import { verifyMarkdownLinks } from './links.ts';
import { verifyAgentNotes } from './notes.ts';
import { verifyAllPairings } from './pairing.ts';
import { verifyMarkdownWrap } from './wrap.ts';

export interface DocSyncOptions {
  budgets?: Record<string, number>;
  optionalBudgets?: ReadonlySet<string>;
}

export interface DocSyncResult {
  ok: boolean;
  diagnostics: Diagnostic[];
}

function dedupe(items: readonly Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = [item.code, item.severity, item.file ?? '', item.line ?? '', item.message].join('|');
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export async function runDocSync(
  root: string,
  options: DocSyncOptions = {},
): Promise<DocSyncResult> {
  const pairing = await verifyAllPairings(root);
  const diagnostics = [
    ...pairing.diagnostics,
    ...await verifyMarkdownLinks(root),
    ...await verifyMarkdownWrap(root),
    ...await verifyDocBudgets(root, options.budgets, options.optionalBudgets),
    ...await verifyAgentNotes(root),
  ];
  const sorted = sortDiagnostics(dedupe(diagnostics));
  return {
    ok: !hasErrors(sorted),
    diagnostics: sorted,
  };
}
