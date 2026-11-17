import { join } from 'node:path';
import type { Diagnostic } from '../core/diagnostics.ts';
import { lstatOrNull, readTextFile } from '../core/fs-atomic.ts';
import {
  DOC_BUDGETS,
  OPTIONAL_BUDGETS,
  OPTIONAL_BUDGET_VALUES,
} from './config.ts';

function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return text.replace(/\n$/, '').split('\n').length;
}

export async function verifyDocBudgets(
  root: string,
  budgets: Record<string, number> = DOC_BUDGETS,
  optional: ReadonlySet<string> = OPTIONAL_BUDGETS,
  optionalValues: Record<string, number> = OPTIONAL_BUDGET_VALUES,
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const allBudgets: Record<string, number> = { ...budgets };
  for (const file of optional) {
    if (allBudgets[file] === undefined && optionalValues[file] !== undefined) {
      allBudgets[file] = optionalValues[file] as number;
    }
  }

  for (const file of Object.keys(allBudgets).sort()) {
    const limit = allBudgets[file];
    if (limit === undefined) {
      continue;
    }
    const info = await lstatOrNull(join(root, file));
    if (info === null) {
      if (!optional.has(file)) {
        diagnostics.push({
          code: 'doc.budget-missing',
          severity: 'error',
          message: 'required document is missing',
          file,
        });
      }
      continue;
    }
    if (!info.isFile()) {
      diagnostics.push({
        code: 'doc.budget',
        severity: 'error',
        message: 'document budget target is not a file',
        file,
      });
      continue;
    }
    const lines = countLines(await readTextFile(join(root, file)));
    if (lines > limit) {
      diagnostics.push({
        code: 'doc.budget',
        severity: 'error',
        message: `document has ${lines} lines; budget is ${limit}`,
        file,
        hint: 'Move detail into a more specific document instead of growing this one.',
      });
    }
  }

  return diagnostics;
}
