import { readdir } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import type { Diagnostic } from '../core/diagnostics.ts';
import { readTextFile } from '../core/fs-atomic.ts';
import { assertRelativePath, toPosix } from '../core/paths.ts';
import { DiagnosticCodes } from './diagnostics-codes.ts';
import { parseFrontmatter } from './frontmatter.ts';
import { RuleFrontmatterSchema } from './schemas.ts';
import type { DiscoveryResult, RuleDefinition } from './types.ts';

function zodMessage(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path.length === 0 ? issue.message : `${path}: ${issue.message}`;
    })
    .join('; ');
}

function normalizePaths(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  const values = typeof value === 'string' ? value.split(',') : value;
  return values.map((item) => item.trim()).filter((item) => item.length > 0);
}

export async function discoverRules(
  root: string,
  agentsDir: string,
): Promise<DiscoveryResult<RuleDefinition>> {
  const sourceDir = join(agentsDir, 'rules');
  let entries;
  try {
    entries = await readdir(sourceDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { items: [], diagnostics: [] };
    }
    throw error;
  }

  const items: RuleDefinition[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      continue;
    }
    const absolute = join(sourceDir, entry.name);
    const file = toPosix(relative(root, absolute));
    let parsed;
    try {
      parsed = parseFrontmatter(await readTextFile(absolute), file);
    } catch (error) {
      diagnostics.push({
        code: DiagnosticCodes.ruleInvalidFrontmatter,
        severity: 'error',
        message: `invalid rule frontmatter: ${error instanceof Error ? error.message : String(error)}`,
        file,
        line: 1,
      });
      continue;
    }

    const validated = RuleFrontmatterSchema.safeParse(parsed.data);
    if (!validated.success) {
      diagnostics.push({
        code: DiagnosticCodes.ruleInvalidFrontmatter,
        severity: 'error',
        message: `invalid rule frontmatter: ${zodMessage(validated.error)}`,
        file,
        line: 1,
      });
      continue;
    }

    let paths: string[];
    try {
      paths = normalizePaths(validated.data.paths).map((value) => assertRelativePath(value, 'rule path'));
    } catch (error) {
      diagnostics.push({
        code: DiagnosticCodes.ruleInvalidFrontmatter,
        severity: 'error',
        message: `invalid rule path: ${error instanceof Error ? error.message : String(error)}`,
        file,
        line: 1,
      });
      continue;
    }

    items.push({
      file,
      name: basename(entry.name, '.md'),
      paths,
      body: parsed.body,
    });
  }

  return { items, diagnostics };
}
