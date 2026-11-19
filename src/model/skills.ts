import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { compareStrings } from '../core/compare.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { lstatOrNull, readTextFile } from '../core/fs-atomic.ts';
import { toPosix } from '../core/paths.ts';
import { DiagnosticCodes } from './diagnostics-codes.ts';
import { parseFrontmatter, unknownFrontmatterDiagnostic } from './frontmatter.ts';
import { KEBAB_CASE, SkillFrontmatterSchema } from './schemas.ts';
import type { DiscoveryResult, SkillDefinition } from './types.ts';

const SKILL_FRONTMATTER_FIELDS = Object.keys(SkillFrontmatterSchema.shape);

function zodMessage(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path.length === 0 ? issue.message : `${path}: ${issue.message}`;
    })
    .join('; ');
}

export async function discoverSkills(
  root: string,
  agentsDir: string,
): Promise<DiscoveryResult<SkillDefinition>> {
  const sourceDir = join(agentsDir, 'skills');
  let entries;
  try {
    entries = await readdir(sourceDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { items: [], diagnostics: [] };
    }
    throw error;
  }

  const items: SkillDefinition[] = [];
  const diagnostics: Diagnostic[] = [];
  const names = new Map<string, string>();

  for (const entry of entries.sort((left, right) => compareStrings(left.name, right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }
    const skillFile = join(sourceDir, entry.name, 'SKILL.md');
    const file = toPosix(relative(root, skillFile));
    if ((await lstatOrNull(skillFile)) === null) {
      diagnostics.push({
        code: DiagnosticCodes.skillMissing,
        severity: 'warning',
        message: `skill directory ${entry.name} has no SKILL.md`,
        file: toPosix(relative(root, join(sourceDir, entry.name))),
      });
      continue;
    }

    let parsed;
    try {
      parsed = parseFrontmatter(await readTextFile(skillFile), file);
    } catch (error) {
      diagnostics.push({
        code: DiagnosticCodes.skillInvalidFrontmatter,
        severity: 'error',
        message: `invalid skill frontmatter: ${error instanceof Error ? error.message : String(error)}`,
        file,
        line: 1,
      });
      continue;
    }

    const validated = SkillFrontmatterSchema.safeParse(parsed.data);
    if (!validated.success) {
      diagnostics.push({
        code: DiagnosticCodes.skillInvalidFrontmatter,
        severity: 'error',
        message: `invalid skill frontmatter: ${zodMessage(validated.error)}`,
        file,
        line: 1,
      });
      continue;
    }

    const name = validated.data.name ?? entry.name;
    const unknown = unknownFrontmatterDiagnostic(
      'skill',
      name,
      SKILL_FRONTMATTER_FIELDS,
      parsed.data,
      file,
    );
    if (unknown !== undefined) {
      diagnostics.push(unknown);
    }
    if (!KEBAB_CASE.test(name)) {
      diagnostics.push({
        code: DiagnosticCodes.skillInvalidFrontmatter,
        severity: 'error',
        message: `skill name must be kebab-case: ${name}`,
        file,
        line: 1,
      });
      continue;
    }

    const existing = names.get(name);
    if (existing !== undefined) {
      diagnostics.push({
        code: DiagnosticCodes.skillDuplicateName,
        severity: 'error',
        message: `duplicate skill name ${name}`,
        file,
        hint: `The name is already used by ${existing}.`,
      });
    } else {
      names.set(name, file);
    }

    items.push({
      dir: toPosix(relative(root, join(sourceDir, entry.name))),
      file,
      name,
      description: validated.data.description,
      frontmatter: parsed.data,
    });
  }

  return { items, diagnostics };
}
