import { compareStrings } from '../core/compare.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { ConfigError } from '../core/errors.ts';
import { parseYamlDocument } from '../core/yaml.ts';
import { DiagnosticCodes } from './diagnostics-codes.ts';

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  body: string;
  bodyStartLine: number;
}

export function unknownTopLevelFields(
  known: readonly string[],
  data: Record<string, unknown>,
): string[] {
  const allowed = new Set(known);
  return Object.keys(data).filter((key) => !allowed.has(key)).sort();
}

function editDistance(left: string, right: string): number {
  const matrix: number[][] = Array.from({ length: left.length + 1 }, (_, row) =>
    Array.from({ length: right.length + 1 }, (_, column) =>
      row === 0 ? column : column === 0 ? row : 0));
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      let value = Math.min(
        (matrix[i - 1]?.[j] ?? 0) + 1,
        (matrix[i]?.[j - 1] ?? 0) + 1,
        (matrix[i - 1]?.[j - 1] ?? 0) + cost,
      );
      if (
        i > 1
        && j > 1
        && left[i - 1] === right[j - 2]
        && left[i - 2] === right[j - 1]
      ) {
        value = Math.min(value, (matrix[i - 2]?.[j - 2] ?? 0) + 1);
      }
      const current = matrix[i];
      if (current !== undefined) {
        current[j] = value;
      }
    }
  }
  return matrix[left.length]?.[right.length] ?? 0;
}

export function nearestKnownField(
  field: string,
  known: readonly string[],
): string | undefined {
  const normalized = field.toLowerCase();
  const threshold = normalized.length <= 6 ? 1 : 2;
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of known) {
    const distance = editDistance(normalized, candidate.toLowerCase());
    if (
      distance < bestDistance
      || (distance === bestDistance && best !== undefined && compareStrings(candidate, best) < 0)
    ) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return bestDistance <= threshold ? best : undefined;
}

export function describeUnknownTopLevelFields(
  known: readonly string[],
  data: Record<string, unknown>,
): string[] {
  return unknownTopLevelFields(known, data).map((field) => {
    const suggestion = nearestKnownField(field, known);
    return suggestion === undefined ? field : `${field} (did you mean ${suggestion}?)`;
  });
}

const UNKNOWN_FRONTMATTER_CODES = {
  agent: DiagnosticCodes.agentUnknownFrontmatter,
  skill: DiagnosticCodes.skillUnknownFrontmatter,
  rule: DiagnosticCodes.ruleUnknownFrontmatter,
} as const;

export function unknownFrontmatterDiagnostic(
  kind: keyof typeof UNKNOWN_FRONTMATTER_CODES,
  name: string,
  known: readonly string[],
  data: Record<string, unknown>,
  file: string,
): Diagnostic | undefined {
  const unknown = describeUnknownTopLevelFields(known, data);
  if (unknown.length === 0) {
    return undefined;
  }
  return {
    code: UNKNOWN_FRONTMATTER_CODES[kind],
    severity: 'warning',
    message: `${kind} ${name} has unknown frontmatter field(s): ${unknown.join(', ')}`,
    file,
    line: 1,
    hint: 'Unknown top-level fields are preserved for Claude Code compatibility; remove them if they are typos.',
  };
}

export function parseFrontmatter(text: string, file: string): ParsedFrontmatter {
  const lines = text.split(/\r?\n/);
  if ((lines[0] ?? '').trim() !== '---') {
    return { data: {}, body: text, bodyStartLine: 1 };
  }

  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').trim();
    if (line === '---' || line === '...') {
      end = index;
      break;
    }
  }
  if (end === -1) {
    throw new ConfigError(
      `unclosed frontmatter in ${file}`,
      'config.frontmatter',
      { hint: 'Close the frontmatter block with a line containing only ---.' },
    );
  }

  const yamlText = lines.slice(1, end).join('\n');
  const document = parseYamlDocument(yamlText, file);
  const value = document.toJS() ?? {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(
      `frontmatter in ${file} must be a mapping`,
      'config.frontmatter',
    );
  }

  return {
    data: value as Record<string, unknown>,
    body: lines.slice(end + 1).join('\n'),
    bodyStartLine: end + 2,
  };
}
