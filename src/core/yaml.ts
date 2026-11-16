import { parseDocument, type Document } from 'yaml';
import { ConfigError } from './errors.ts';
import { readTextFile, writeFileAtomic } from './fs-atomic.ts';

export function parseYamlDocument(text: string, file: string): Document.Parsed {
  const document = parseDocument(text, { prettyErrors: true });
  if (document.errors.length > 0) {
    const first = document.errors[0];
    const line = first?.linePos?.[0]?.line;
    throw new ConfigError(
      `invalid YAML in ${file}: ${first?.message ?? 'parse error'}`,
      'config.yaml',
      {
        details: line === undefined ? undefined : { line },
        hint: 'Fix the YAML syntax before running DAB again.',
      },
    );
  }
  return document;
}

export async function loadYamlDocument(file: string): Promise<Document.Parsed> {
  const text = await readTextFile(file);
  return parseYamlDocument(text, file);
}

export async function saveYamlDocument(file: string, document: Document): Promise<void> {
  const text = document.toString({ lineWidth: 0 });
  await writeFileAtomic(file, text.endsWith('\n') ? text : `${text}\n`);
}
