import { compareStrings } from '../core/compare.ts';
import type { AdoptionPhase } from '../init/adoption.ts';
import type { Scope } from '../model/scope.ts';

export type ChecklistStatus = 'ok' | 'missing' | 'warn' | 'error' | 'importable';

export interface ChecklistEntry {
  group: string;
  label: string;
  status: ChecklistStatus;
  detail?: string;
  file?: string;
  next?: string;
}

export interface Checklist {
  scope: Scope;
  root: string;
  profile?: string;
  phase: AdoptionPhase;
  entries: ChecklistEntry[];
  score: { ok: number; total: number; percent: number };
  nextActions: string[];
}

export interface ChecklistInput {
  scope: Scope;
  root: string;
  profile?: string;
  phase: AdoptionPhase;
  entries: ChecklistEntry[];
}

/**
 * Canonical group order for human output. Groups missing from this list are
 * ordered after the known groups by their literal name so custom/future
 * groups still render deterministically.
 */
const GROUP_ORDER: readonly string[] = [
  'Instructions',
  'Documentation',
  'Agents',
  'Skills',
  'Rules',
  'Policy',
  'Hooks',
  'Memory',
  'Notes',
  'Generated target',
  'Safety',
];

const STATUS_LABELS: Record<ChecklistStatus, string> = {
  ok: 'OK',
  missing: 'MISSING',
  warn: 'WARN',
  error: 'ERROR',
  importable: 'IMPORTABLE',
};

function groupRank(group: string): number {
  const index = GROUP_ORDER.indexOf(group);
  return index === -1 ? GROUP_ORDER.length : index;
}

function compareEntries(left: ChecklistEntry, right: ChecklistEntry): number {
  const rank = groupRank(left.group) - groupRank(right.group);
  if (rank !== 0) {
    return rank;
  }
  if (left.group !== right.group) {
    return compareStrings(left.group, right.group);
  }
  // Sorting is stable, so entries keep their relative order inside a group.
  return 0;
}

function entryKey(entry: ChecklistEntry): string {
  return JSON.stringify([
    entry.group,
    entry.label,
    entry.status,
    entry.detail ?? null,
    entry.file ?? null,
    entry.next ?? null,
  ]);
}

/**
 * Collapses rows that describe the same fact. Discovery and adoption planning
 * can both report the same broken authored skill, and each diagnostic maps to
 * a row; identical rows are duplicates while distinct rows stay. The first
 * occurrence keeps its position, and diagnostics are not affected.
 */
function dedupeEntries(entries: readonly ChecklistEntry[]): ChecklistEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = entryKey(entry);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * Builds a read-only detect checklist. The score counts only `ok` entries;
 * every other status (including `importable`) is not OK. Next actions are the
 * distinct `next` values of non-OK entries in rendered order.
 */
export function buildChecklist(input: ChecklistInput): Checklist {
  const entries = dedupeEntries(input.entries).sort(compareEntries);
  const total = entries.length;
  const ok = entries.filter((entry) => entry.status === 'ok').length;
  const percent = total === 0 ? 0 : Math.round((ok / total) * 100);

  const nextActions: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.status === 'ok' || entry.next === undefined || seen.has(entry.next)) {
      continue;
    }
    seen.add(entry.next);
    nextActions.push(entry.next);
  }

  return {
    scope: input.scope,
    root: input.root,
    ...(input.profile === undefined ? {} : { profile: input.profile }),
    phase: input.phase,
    entries,
    score: { ok, total, percent },
    nextActions,
  };
}

function formatEntry(entry: ChecklistEntry): string {
  let line = `  [${STATUS_LABELS[entry.status]}] ${entry.label}`;
  if (entry.detail !== undefined) {
    line += ` (${entry.detail})`;
  }
  if (entry.file !== undefined) {
    line += ` [${entry.file}]`;
  }
  if (entry.next !== undefined) {
    line += ` -> ${entry.next}`;
  }
  return line;
}

/**
 * Renders the human checklist. The result ends with a newline so callers can
 * pass it straight to stdout.
 */
export function formatChecklist(checklist: Checklist): string {
  const lines = [
    `Scope: ${checklist.scope}`,
    `Root: ${checklist.root}`,
  ];
  if (checklist.profile !== undefined) {
    lines.push(`Profile: ${checklist.profile}`);
  }

  let group: string | undefined;
  for (const entry of checklist.entries) {
    if (entry.group !== group) {
      lines.push('', entry.group);
      group = entry.group;
    }
    lines.push(formatEntry(entry));
  }

  lines.push('', `score: ${checklist.score.ok}/${checklist.score.total} (${checklist.score.percent}%)`);
  for (const action of checklist.nextActions) {
    lines.push(`next: ${action}`);
  }
  return `${lines.join('\n')}\n`;
}
