import { ConfigError } from '../core/errors.ts';
import { parseYamlDocument } from '../core/yaml.ts';

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
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j] ?? 0;
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      previous[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + 1,
        diagonal + cost,
      );
      diagonal = above;
    }
  }
  return previous[right.length] ?? 0;
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
    if (distance < bestDistance) {
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
