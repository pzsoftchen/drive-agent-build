#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatDiagnostics, hasErrors, type Diagnostic } from '../core/diagnostics.ts';
import { verifyDocBudgets } from './budgets.ts';
import { runDocSync } from './doc-sync.ts';
import { verifyMarkdownLinks } from './links.ts';
import { verifyAgentNotes } from './notes.ts';
import {
  listPairingGaps,
  verifyAllPairings,
  verifyPairingFile,
} from './pairing.ts';
import { verifyMarkdownWrap } from './wrap.ts';

interface Io {
  stdout: (value: string) => void;
  stderr: (value: string) => void;
}

function printDiagnostics(diagnostics: readonly Diagnostic[], io: Io, label: string): number {
  const text = formatDiagnostics(diagnostics);
  if (text.length > 0) {
    io.stdout(text);
  } else {
    io.stdout(`${label}: no issues found.\n`);
  }
  const errors = diagnostics.filter((item) => item.severity === 'error').length;
  const warnings = diagnostics.filter((item) => item.severity === 'warning').length;
  io.stdout(`Errors: ${errors}, warnings: ${warnings}\n`);
  return hasErrors(diagnostics) ? 1 : 0;
}

async function runPairing(root: string, args: string[], io: Io): Promise<number> {
  const write = args.includes('--write');
  const list = args.includes('--list');
  const files = args.filter((arg) => !arg.startsWith('-'));
  if (files.length > 1) {
    io.stderr('usage: verify-translation-pairing [--write] [--list] [file]\n');
    return 2;
  }

  if (list) {
    const gaps = await listPairingGaps(root);
    const lines: string[] = [];
    for (const file of gaps.missingTranslations) {
      lines.push(`missing translation: ${file}`);
    }
    for (const file of gaps.missingRecords) {
      lines.push(`missing record: ${file}`);
    }
    for (const file of gaps.orphanTranslations) {
      lines.push(`orphan translation: ${file}`);
    }
    for (const file of gaps.orphanRecords) {
      lines.push(`orphan record: ${file}`);
    }
    io.stdout(lines.length === 0 ? 'No pairing gaps.\n' : `${lines.join('\n')}\n`);
    return 0;
  }

  if (files.length === 1) {
    const file = files[0] ?? '';
    const diagnostics = await verifyPairingFile(root, file, { write });
    return printDiagnostics(diagnostics, io, 'translation pairing');
  }

  const report = await verifyAllPairings(root, { write });
  return printDiagnostics(report.diagnostics, io, 'translation pairing');
}

export async function main(argv: string[], io: Io = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
}): Promise<number> {
  const root = resolve(process.cwd());
  const [command, ...args] = argv;

  switch (command) {
    case 'pairing':
      return runPairing(root, args, io);
    case 'links':
      return printDiagnostics(await verifyMarkdownLinks(root), io, 'markdown links');
    case 'wrap':
      return printDiagnostics(await verifyMarkdownWrap(root), io, 'markdown wrap');
    case 'budgets':
      return printDiagnostics(await verifyDocBudgets(root), io, 'document budgets');
    case 'notes':
      return printDiagnostics(await verifyAgentNotes(root), io, 'agent notes');
    case 'all': {
      const result = await runDocSync(root);
      return printDiagnostics(result.diagnostics, io, 'doc sync');
    }
    default:
      io.stderr(
        'usage: verify-docs <pairing|links|wrap|budgets|notes|all> [--write] [--list] [file]\n',
      );
      return 2;
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
