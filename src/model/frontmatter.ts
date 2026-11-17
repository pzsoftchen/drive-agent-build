import { ConfigError } from '../core/errors.ts';
import { parseYamlDocument } from '../core/yaml.ts';

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  body: string;
  bodyStartLine: number;
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
