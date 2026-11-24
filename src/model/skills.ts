import { readdir } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { compareStrings } from '../core/compare.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { lstatOrNull, readTextFile } from '../core/fs-atomic.ts';
import { toPosix } from '../core/paths.ts';
import { pathProblemFrom, problemMessage } from '../core/practice-paths.ts';
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

export interface SkillSourceResult {
  item?: SkillDefinition;
  diagnostics: Diagnostic[];
}

/**
 * One unreadable skill directory must not erase the sibling facts. The error is
 * governed per skill so discovery can continue and commands fail loudly on the
 * reported path instead of claiming the skill set is empty.
 */
function unreadableSkill(root: string, dir: string, error: unknown): Diagnostic {
  const file = toPosix(relative(root, dir));
  const problem = pathProblemFrom(error);
  return {
    code: DiagnosticCodes.skillUnreadable,
    severity: 'error',
    message: problem === undefined
      ? `skill directory cannot be read: ${file}`
      : `skill directory cannot be read: ${problemMessage(file, problem)}`,
    file,
    hint: 'Restore read and search permission for the skill directory; DAB never projects an unreadable skill.',
  };
}

async function parseSkillSource(root: string, dir: string): Promise<SkillSourceResult> {
  const diagnostics: Diagnostic[] = [];
  const skillFile = join(dir, 'SKILL.md');
  const file = toPosix(relative(root, skillFile));

  let skillInfo;
  try {
    skillInfo = await lstatOrNull(skillFile);
  } catch (error) {
    if (pathProblemFrom(error) === undefined) {
      throw error;
    }
    diagnostics.push(unreadableSkill(root, dir, error));
    return { diagnostics };
  }
  if (skillInfo === null) {
    diagnostics.push({
      code: DiagnosticCodes.skillMissing,
      severity: 'warning',
      message: `skill directory ${basename(dir)} has no SKILL.md`,
      file: toPosix(relative(root, dir)),
    });
    return { diagnostics };
  }

  let parsed;
  try {
    parsed = parseFrontmatter(await readTextFile(skillFile), file);
  } catch (error) {
    if (pathProblemFrom(error) !== undefined) {
      diagnostics.push(unreadableSkill(root, dir, error));
      return { diagnostics };
    }
    diagnostics.push({
      code: DiagnosticCodes.skillInvalidFrontmatter,
      severity: 'error',
      message: `invalid skill frontmatter: ${error instanceof Error ? error.message : String(error)}`,
      file,
      line: 1,
    });
    return { diagnostics };
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
    return { diagnostics };
  }

  const name = validated.data.name ?? basename(dir);
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
    return { diagnostics };
  }

  return {
    item: {
      dir: toPosix(relative(root, dir)),
      file,
      name,
      description: validated.data.description,
      frontmatter: parsed.data,
    },
    diagnostics,
  };
}

/**
 * Validate one skill directory for adoption. Returns an item only when the source
 * has no error diagnostics; warnings (such as unknown frontmatter) are preserved.
 */
export async function validateSkillSource(
  root: string,
  dir: string,
): Promise<SkillSourceResult> {
  const result = await parseSkillSource(root, dir);
  if (result.diagnostics.some((item) => item.severity === 'error')) {
    return { diagnostics: result.diagnostics };
  }
  return result;
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
    const dir = join(sourceDir, entry.name);
    let source: SkillSourceResult;
    try {
      source = await parseSkillSource(root, dir);
    } catch (error) {
      // Keep sibling skills when one directory cannot be read. The practice
      // parent check still owns an unreadable `.agents/skills` itself.
      if (pathProblemFrom(error) === undefined) {
        throw error;
      }
      diagnostics.push(unreadableSkill(root, dir, error));
      continue;
    }
    diagnostics.push(...source.diagnostics);
    if (source.item === undefined) {
      continue;
    }
    const existing = names.get(source.item.name);
    if (existing !== undefined) {
      diagnostics.push({
        code: DiagnosticCodes.skillDuplicateName,
        severity: 'error',
        message: `duplicate skill name ${source.item.name}`,
        file: source.item.file,
        hint: `The name is already used by ${existing}.`,
      });
    } else {
      names.set(source.item.name, source.item.file);
    }
    items.push(source.item);
  }

  return { items, diagnostics };
}
