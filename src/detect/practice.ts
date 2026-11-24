import { dirname, join, resolve } from 'node:path';
import type { Diagnostic } from '../core/diagnostics.ts';
import { readTextFile } from '../core/fs-atomic.ts';
import { isPathInside } from '../core/paths.ts';
import { scanMarkdown, slugifyHeading } from '../docs/markdown.ts';
import {
  resolveDocsLanguage,
  type DocsLanguageResolution,
} from '../init/docs-language.ts';
import { AUTHORING_SKILL_NAMES, authoringPack } from '../init/practice-authoring.ts';
import { documentationPack } from '../init/practice-docs.ts';
import {
  planAuthoredScaffold,
  type AuthoredScaffoldPlan,
  type PracticePack,
} from '../init/practice.ts';
import {
  authoredDirectoryState,
  authoredFileProblem,
  practiceParentProblems,
  probeLstat,
  problemMessage,
} from '../core/practice-paths.ts';
import { scanProject, type ScanResult } from '../init/scanner.ts';
import type { Scope } from '../model/scope.ts';
import { validateSkillSource } from '../model/skills.ts';
import type { ProjectManifest, ProjectPaths } from '../model/types.ts';
import type { ChecklistEntry, ChecklistStatus } from './checklist.ts';

/** Documentation files owned by the documentation pack. */
export const PRACTICE_DOC_FILES = ['docs/AGENTS.md', 'docs/architecture.md'] as const;

const ARCHITECTURE_FILE = 'docs/architecture.md';
const PRACTICE_SKILL_ROOT = '.agents/skills';
const PRACTICE_SKILL_PREFIX = `${PRACTICE_SKILL_ROOT}/`;
const ARCHITECTURE_SKILL = 'dab-architecture-writing';
const DOC_SKILL = 'dab-doc-writing';
const NORMALIZE_NEXT = 'dab normalize';
const ARCHITECTURE_NEXT = `use ${ARCHITECTURE_SKILL}`;
const DOC_NEXT = `use ${DOC_SKILL}`;
const POLICY_NEXT = 'delete .agents/rules/docs-bilingual.md, then run dab normalize';
const MANUAL_PATH_NEXT = 'resolve the path conflict manually';
const MANUAL_SKILL_NEXT = 'review and merge the newer skill manually';
const LINK_NEXT = 'fix the link';

/**
 * Practice warnings that describe project policy or preserved user content.
 * They stay informational under `--strict`; every other practice warning fails.
 */
export const PRACTICE_NON_STRICT_WARNING_CODES: ReadonlySet<string> = new Set([
  'practice.docs-bilingual-policy',
  'practice.skill-unversioned',
]);

const SKILL_MARKER = /<!--\s*dab-skill:\s*([a-z0-9-]+)@([^\s>]+)\s*-->/;
const TODO_MARKER = /^[ \t]*TODO(?:\(owner\))?:/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING_LINE = /^ {0,3}#{1,6}\s/;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

const ARCHITECTURE_SECTIONS = [
  ['System purpose', '系统目的'],
  ['Composition', '组成'],
  ['Runtime flow', '运行时流程'],
  ['Module boundaries', '模块边界'],
  ['Extension points', '扩展点'],
  ['Invariants', '不变量'],
] as const;

export interface PracticeCheckResult {
  entries: ChecklistEntry[];
  diagnostics: Diagnostic[];
}

interface PracticePlanInput {
  root: string;
  scope: Scope;
  scan: ScanResult;
  manifest?: ProjectManifest;
  mode: 'adoption' | 'converge';
  version: string;
}

function isDocsPath(path: string): boolean {
  return (PRACTICE_DOC_FILES as readonly string[]).includes(path);
}

function isAuthoringSkillPath(path: string): boolean {
  return path.startsWith(PRACTICE_SKILL_PREFIX)
    && path.slice(PRACTICE_SKILL_PREFIX.length).startsWith('dab-');
}

export function isAuthoringSkillName(name: string): boolean {
  return (AUTHORING_SKILL_NAMES as readonly string[]).includes(name);
}

function skillDirectory(name: string): string {
  return `${PRACTICE_SKILL_ROOT}/${name}`;
}

function skillFile(name: string): string {
  return `${skillDirectory(name)}/SKILL.md`;
}

function skillNameFromPath(path: string): string {
  const [name = path] = path.slice(PRACTICE_SKILL_PREFIX.length).split('/');
  return name;
}

function languageDetail(language: DocsLanguageResolution): string {
  return `Language: ${language.value} (source: ${language.source})`;
}

function docsDetail(language: DocsLanguageResolution, extra?: string): string {
  return extra === undefined
    ? languageDetail(language)
    : `${languageDetail(language)}; ${extra}`;
}

/**
 * Run the shared authored planner with only the practice packs. The planner is
 * read-only; detect never plans core scaffolding or Claude target output.
 */
async function planPractice(
  input: PracticePlanInput,
  packs: readonly PracticePack[],
): Promise<AuthoredScaffoldPlan> {
  return planAuthoredScaffold({
    root: input.root,
    scope: input.scope,
    scan: input.scan,
    profile: input.manifest?.profile ?? 'generic',
    mode: input.mode,
    version: input.version,
    env: process.env,
    ...(input.manifest === undefined ? {} : { manifest: input.manifest }),
  }, packs);
}

function practiceLanguage(
  root: string,
  manifest: ProjectManifest | undefined,
): Promise<DocsLanguageResolution> {
  return resolveDocsLanguage({
    root,
    configured: manifest?.docs.language ?? 'auto',
    env: process.env,
  });
}

function addParentProblem(
  collector: PracticeCollector,
  language: DocsLanguageResolution,
  group: 'docs' | 'skills',
  problem: { path: string; message: string },
): void {
  const docs = group === 'docs';
  collector.addDiagnostic({
    code: docs ? 'practice.docs-path' : 'practice.skill-path',
    severity: 'error',
    message: problem.message,
    file: problem.path,
    hint: 'Resolve the path conflict manually; DAB never writes through it.',
  });
  collector.addEntry({
    group: docs ? 'Documentation' : 'Skills',
    label: problem.path,
    status: 'error',
    detail: docs ? docsDetail(language, problem.message) : problem.message,
    next: MANUAL_PATH_NEXT,
  });
}

class PracticeCollector {
  readonly entries: ChecklistEntry[] = [];
  readonly diagnostics: Diagnostic[] = [];
  private readonly seen = new Set<string>();

  addDiagnostic(diagnostic: Diagnostic): void {
    this.diagnostics.push(diagnostic);
  }

  addEntry(entry: ChecklistEntry): void {
    const key = [
      entry.group,
      entry.label,
      entry.status,
      entry.detail ?? '',
      entry.next ?? '',
    ].join('\0');
    if (this.seen.has(key)) {
      return;
    }
    this.seen.add(key);
    this.entries.push(entry);
  }
}

function conflictCode(path: string): 'practice.docs-path' | 'practice.skill-path' | undefined {
  if (isDocsPath(path)) {
    return 'practice.docs-path';
  }
  if (isAuthoringSkillPath(path)) {
    return 'practice.skill-path';
  }
  return undefined;
}

/**
 * The planner reports declared practice path conflicts as `path.conflict`.
 * Detect maps only pack-owned paths into the practice path codes and leaves
 * unrelated diagnostics untouched.
 */
function reportPlanConflicts(
  plan: AuthoredScaffoldPlan,
  collector: PracticeCollector,
): Set<string> {
  const conflicted = new Set<string>();
  for (const item of plan.diagnostics) {
    const file = item.file;
    const code = file === undefined ? undefined : conflictCode(file);
    if (file === undefined || code === undefined) {
      collector.addDiagnostic(item);
      continue;
    }
    conflicted.add(file);
    const diagnostic: Diagnostic = {
      code,
      severity: 'error',
      message: item.message,
      file,
      ...(item.line === undefined ? {} : { line: item.line }),
      hint: 'Resolve the path conflict manually; DAB never writes through it.',
    };
    collector.addDiagnostic(diagnostic);
    collector.addEntry({
      group: code === 'practice.docs-path' ? 'Documentation' : 'Skills',
      label: code === 'practice.docs-path' ? file : skillNameFromPath(file),
      status: 'error',
      detail: code === 'practice.docs-path'
        ? docsDetail(plan.docsLanguage, item.message)
        : item.message,
      next: MANUAL_PATH_NEXT,
    });
  }
  return conflicted;
}

type SkillFileState =
  | { kind: 'missing' }
  | { kind: 'invalid'; diagnostics: Diagnostic[] }
  | { kind: 'present'; text: string }
  | { kind: 'conflict'; message: string };

async function skillFileState(
  root: string,
  name: string,
  directory: string,
): Promise<SkillFileState> {
  const file = skillFile(name);
  const absolute = join(root, file);
  const problem = await authoredFileProblem(root, file);
  if (problem !== undefined) {
    return { kind: 'conflict', message: problem };
  }
  if ((await probeLstat(absolute)).info === null) {
    return { kind: 'missing' };
  }

  // Existing skill discovery owns invalid frontmatter and unknown fields. The
  // practice check must not add a second entry for the same broken skill.
  const validated = await validateSkillSource(root, directory);
  if (validated.diagnostics.some((item) => item.severity === 'error')) {
    return { kind: 'invalid', diagnostics: validated.diagnostics };
  }

  try {
    return { kind: 'present', text: await readTextFile(absolute) };
  } catch (error) {
    return {
      kind: 'conflict',
      message: `skill file cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function parseVersion(value: string): number[] | undefined {
  if (!/^\d+(?:\.\d+)*$/.test(value)) {
    return undefined;
  }
  return value.split('.').map((part) => Number(part));
}

function compareVersions(left: readonly number[], right: readonly number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function stripInlineCode(line: string): string {
  return line.replace(/(`+)(.*?)\1/g, (full: string) => ' '.repeat(full.length));
}

/**
 * Finds line-start `TODO:` or `TODO(owner):` markers outside fenced code and
 * inline code. Mid-line layout notes in generated docs are not markers.
 */
export function todoMarkerLines(text: string): number[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const markers: number[] = [];
  let fence: { marker: string; length: number } | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const opening = FENCE_OPEN.exec(line);
    if (opening !== null) {
      const marker = opening[1] ?? '';
      if (fence === undefined) {
        fence = { marker: marker[0] ?? '`', length: marker.length };
      } else if (
        (marker[0] ?? '') === fence.marker
        && marker.length >= fence.length
        && (opening[2] ?? '').trim().length === 0
      ) {
        fence = undefined;
      }
      continue;
    }
    if (fence !== undefined) {
      continue;
    }
    if (TODO_MARKER.test(stripInlineCode(line))) {
      markers.push(index + 1);
    }
  }
  return markers;
}

function headingExists(text: string, anchor: string): boolean {
  const slug = slugifyHeading(anchor);
  return scanMarkdown(text).headings.some(
    (heading) => slugifyHeading(heading.text) === slug,
  );
}

async function linkDiagnostics(
  root: string,
  file: string,
  text: string,
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const absolute = join(root, file);
  const linkError = (line: number, message: string): Diagnostic => ({
    code: 'practice.docs-link',
    severity: 'error',
    message,
    file,
    line,
    hint: 'Fix the link target; detect only scans the documentation pack files.',
  });

  for (const link of scanMarkdown(text).links) {
    if (link.external) {
      continue;
    }
    if (link.anchorOnly) {
      if (!headingExists(text, link.target.slice(1))) {
        diagnostics.push(linkError(link.line, `same-file anchor does not exist: ${link.target}`));
      }
      continue;
    }
    const [base = '', ...anchorParts] = link.target.split('#');
    const anchor = anchorParts.join('#');
    if (base.startsWith('/') || base.startsWith('~')) {
      diagnostics.push(linkError(link.line, `absolute links are not allowed: ${link.target}`));
      continue;
    }
    const target = resolve(dirname(absolute), base);
    if (!isPathInside(root, target)) {
      diagnostics.push(linkError(link.line, `link escapes the repository: ${link.target}`));
      continue;
    }
    // A path whose parent is a regular file raises ENOTDIR rather than ENOENT.
    // It is a broken link, not an internal error.
    const targetState = await probeLstat(target);
    if (targetState.problem !== undefined) {
      diagnostics.push(
        linkError(link.line, `link target cannot be resolved (${targetState.problem}): ${link.target}`),
      );
      continue;
    }
    if (targetState.info === null) {
      diagnostics.push(linkError(link.line, `link target does not exist: ${link.target}`));
      continue;
    }
    if (anchor.length === 0 || !target.endsWith('.md')) {
      continue;
    }
    try {
      if (!headingExists(await readTextFile(target), anchor)) {
        diagnostics.push(linkError(link.line, `link anchor does not exist: ${link.target}`));
      }
    } catch {
      // An unreadable target is already reported by the missing/unreadable file.
    }
  }
  return diagnostics;
}

interface EmptySection {
  section: string;
  line: number;
}

/**
 * Fixed architecture sections that carry project evidence. Project facts and
 * Verification are excluded because the skeleton or command list owns them.
 */
function emptyArchitectureSections(text: string): EmptySection[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const headings = scanMarkdown(normalized).headings;
  const empty: EmptySection[] = [];

  headings.forEach((heading, index) => {
    const fixed = ARCHITECTURE_SECTIONS.find(
      ([english, chinese]) => heading.text === english || heading.text === chinese,
    );
    if (fixed === undefined) {
      return;
    }
    const next = headings.slice(index + 1).find((item) => item.level <= heading.level);
    const end = next === undefined ? lines.length : next.line - 1;
    const body = lines
      .slice(heading.line, end)
      .join('\n')
      .replace(HTML_COMMENT, '');
    const meaningful = body
      .split('\n')
      .filter((line) => line.trim().length > 0 && !HEADING_LINE.test(line));
    if (meaningful.length === 0) {
      empty.push({ section: heading.text, line: heading.line });
    }
  });

  return empty;
}

function addDocsMissing(
  collector: PracticeCollector,
  language: DocsLanguageResolution,
  file: string,
  next: string | undefined,
  reportDiagnostic = true,
): void {
  if (reportDiagnostic) {
    collector.addDiagnostic({
      code: 'practice.docs-missing',
      severity: 'warning',
      message: `documentation file is missing: ${file}`,
      file,
      hint: 'Run dab normalize to create the missing documentation skeleton.',
    });
  }
  collector.addEntry({
    group: 'Documentation',
    label: file,
    status: 'missing',
    detail: languageDetail(language),
    ...(next === undefined ? {} : { next }),
  });
}

function addDocsPath(
  collector: PracticeCollector,
  language: DocsLanguageResolution,
  file: string,
  message: string,
  next: string | undefined,
): void {
  collector.addDiagnostic({
    code: 'practice.docs-path',
    severity: 'error',
    message,
    file,
    hint: 'Resolve the path conflict manually; DAB never writes through it.',
  });
  collector.addEntry({
    group: 'Documentation',
    label: file,
    status: 'error',
    detail: docsDetail(language, message),
    ...(next === undefined ? {} : { next }),
  });
}

function addPolicySkip(
  collector: PracticeCollector,
  language: DocsLanguageResolution,
  file: string,
  next: string | undefined,
): void {
  collector.addDiagnostic({
    code: 'practice.docs-bilingual-policy',
    severity: 'warning',
    message: `project bilingual rule skips single-language documentation: ${file}`,
    file,
    hint: 'Remove .agents/rules/docs-bilingual.md to let DAB scaffold single-language docs.',
  });
  collector.addEntry({
    group: 'Documentation',
    label: file,
    status: 'warn',
    detail: docsDetail(language, 'skipped by .agents/rules/docs-bilingual.md'),
    ...(next === undefined ? {} : { next }),
  });
}

function addSkillMissing(
  collector: PracticeCollector,
  name: string,
  next: string | undefined,
  reportDiagnostic = true,
): void {
  if (reportDiagnostic) {
    collector.addDiagnostic({
      code: 'practice.skill-missing',
      severity: 'warning',
      message: `authoring skill is missing: ${name}`,
      file: skillFile(name),
      hint: 'Run dab normalize to create the missing authoring skill.',
    });
  }
  collector.addEntry({
    group: 'Skills',
    label: name,
    status: 'missing',
    ...(next === undefined ? {} : { next }),
  });
}

function addSkillPath(
  collector: PracticeCollector,
  name: string,
  file: string,
  message: string,
): void {
  collector.addDiagnostic({
    code: 'practice.skill-path',
    severity: 'error',
    message,
    file,
    hint: 'Resolve the path conflict manually; DAB never writes through it.',
  });
  collector.addEntry({
    group: 'Skills',
    label: name,
    status: 'error',
    detail: message,
    next: MANUAL_PATH_NEXT,
  });
}

function addSkillUnversioned(collector: PracticeCollector, name: string): void {
  collector.addDiagnostic({
    code: 'practice.skill-unversioned',
    severity: 'warning',
    message: `authoring skill has no dab-skill version marker: ${name}`,
    file: skillFile(name),
    hint: 'DAB preserves authored skills without a version marker; no next action is required.',
  });
  collector.addEntry({
    group: 'Skills',
    label: name,
    status: 'warn',
    detail: 'authored skill without a version marker is preserved',
  });
}

function addSkillStale(
  collector: PracticeCollector,
  name: string,
  markerVersion: string,
  currentVersion: string,
): void {
  collector.addDiagnostic({
    code: 'practice.skill-stale',
    severity: 'warning',
    message: `authoring skill version ${markerVersion} is older than ${currentVersion}`,
    file: skillFile(name),
    hint: 'Review and merge the newer skill text manually; DAB never overwrites authored skills.',
  });
  collector.addEntry({
    group: 'Skills',
    label: name,
    status: 'warn',
    detail: `version ${markerVersion} is older than ${currentVersion}`,
    next: MANUAL_SKILL_NEXT,
  });
}

function addSkillFileProblem(
  collector: PracticeCollector,
  name: string,
  message: string,
): void {
  addSkillPath(collector, name, skillFile(name), message);
}

/**
 * Read-only practice checks for an initialized project. Docs and authoring
 * skills are inspected through the same packs normalize uses; only the two
 * documentation files are parsed for links, TODO markers and empty sections.
 */
export async function checkPracticePackages(
  root: string,
  scope: Scope,
  manifest: ProjectManifest,
  paths: ProjectPaths,
  version: string,
): Promise<PracticeCheckResult> {
  // The packs own `.agents/skills/dab-*` targets, not the manifest `paths`
  // values, so detect follows the pack layout to stay aligned with normalize.
  void paths;
  if (scope !== 'project') {
    return { entries: [], diagnostics: [] };
  }

  const scan = await scanProject(root);
  const problems = await practiceParentProblems(root);
  const packs: PracticePack[] = [];
  if (problems.docs === undefined) {
    packs.push(documentationPack);
  }
  if (problems.skills === undefined) {
    packs.push(authoringPack);
  }
  const plan = packs.length === 0
    ? undefined
    : await planPractice({ root, scope, scan, manifest, mode: 'converge', version }, packs);
  const collector = new PracticeCollector();
  const conflicted = plan === undefined ? new Set<string>() : reportPlanConflicts(plan, collector);
  const language = plan?.docsLanguage ?? await practiceLanguage(root, manifest);
  const policySkipped = new Set(plan?.policySkipped ?? []);
  if (problems.docs !== undefined) {
    addParentProblem(collector, language, 'docs', problems.docs);
  }
  if (problems.skills !== undefined) {
    addParentProblem(collector, language, 'skills', problems.skills);
  }

  for (const file of problems.docs === undefined ? PRACTICE_DOC_FILES : []) {
    if (conflicted.has(file)) {
      continue;
    }
    const state = await probeLstat(join(root, file));
    if (state.problem !== undefined) {
      addDocsPath(collector, language, file, problemMessage(file, state.problem), MANUAL_PATH_NEXT);
      continue;
    }
    if (state.info === null) {
      if (policySkipped.has(file)) {
        addPolicySkip(collector, language, file, POLICY_NEXT);
      } else {
        addDocsMissing(collector, language, file, NORMALIZE_NEXT);
      }
      continue;
    }

    const problem = await authoredFileProblem(root, file);
    if (problem !== undefined) {
      addDocsPath(collector, language, file, problem, MANUAL_PATH_NEXT);
      continue;
    }

    let text: string;
    try {
      text = await readTextFile(join(root, file));
    } catch (error) {
      addDocsPath(
        collector,
        language,
        file,
        `documentation file cannot be read: ${error instanceof Error ? error.message : String(error)}`,
        MANUAL_PATH_NEXT,
      );
      continue;
    }

    let status: ChecklistStatus = 'ok';
    for (const diagnostic of await linkDiagnostics(root, file, text)) {
      collector.addDiagnostic(diagnostic);
      collector.addEntry({
        group: 'Documentation',
        label: file,
        status: 'error',
        detail: docsDetail(language, diagnostic.message),
        next: LINK_NEXT,
      });
      status = 'error';
    }

    const todoLines = todoMarkerLines(text);
    for (const line of todoLines) {
      collector.addDiagnostic({
        code: 'practice.docs-todo',
        severity: 'warning',
        message: 'documentation TODO marker remains',
        file,
        line,
        hint: 'Use the authoring skill for this document to replace the TODO with evidence.',
      });
    }
    if (todoLines.length > 0) {
      collector.addEntry({
        group: 'Documentation',
        label: file,
        status: 'warn',
        detail: docsDetail(language, `TODO markers at line ${todoLines.join(', ')}`),
        next: file === ARCHITECTURE_FILE ? ARCHITECTURE_NEXT : DOC_NEXT,
      });
      if (status !== 'error') {
        status = 'warn';
      }
    }

    if (file === ARCHITECTURE_FILE) {
      const empty = emptyArchitectureSections(text);
      for (const section of empty) {
        collector.addDiagnostic({
          code: 'practice.docs-empty',
          severity: 'warning',
          message: `architecture section is empty: ${section.section}`,
          file,
          line: section.line,
          hint: 'Use the dab-architecture-writing skill to fill the section with evidence.',
        });
      }
      if (empty.length > 0) {
        collector.addEntry({
          group: 'Documentation',
          label: file,
          status: 'warn',
          detail: docsDetail(
            language,
            `empty sections: ${empty.map((item) => item.section).join(', ')}`,
          ),
          next: ARCHITECTURE_NEXT,
        });
        if (status !== 'error') {
          status = 'warn';
        }
      }
    }

    if (status === 'ok') {
      collector.addEntry({
        group: 'Documentation',
        label: file,
        status: 'ok',
        detail: languageDetail(language),
      });
    }
  }

  for (const name of problems.skills === undefined ? AUTHORING_SKILL_NAMES : []) {
    const directory = skillDirectory(name);
    if (conflicted.has(directory) || conflicted.has(skillFile(name))) {
      continue;
    }
    const state = await authoredDirectoryState(root, directory);
    if (state.kind === 'missing') {
      addSkillMissing(collector, name, NORMALIZE_NEXT);
      continue;
    }
    if (state.kind === 'conflict') {
      addSkillPath(collector, name, directory, state.message);
      continue;
    }

    const fileState = await skillFileState(root, name, state.absolute);
    if (fileState.kind === 'missing') {
      // Existing skill discovery reports a skill directory without SKILL.md.
      continue;
    }
    if (fileState.kind === 'invalid') {
      // Existing skill discovery owns the invalid frontmatter error.
      continue;
    }
    if (fileState.kind === 'conflict') {
      addSkillFileProblem(collector, name, fileState.message);
      continue;
    }

    const marker = SKILL_MARKER.exec(fileState.text);
    if (marker === null || marker[1] !== name) {
      addSkillUnversioned(collector, name);
      continue;
    }
    const markerVersion = marker[2] ?? '';
    const found = parseVersion(markerVersion);
    const current = parseVersion(version);
    if (found === undefined) {
      addSkillUnversioned(collector, name);
      continue;
    }
    if (current !== undefined && compareVersions(found, current) < 0) {
      addSkillStale(collector, name, markerVersion, version);
      continue;
    }
    collector.addEntry({
      group: 'Skills',
      label: name,
      status: 'ok',
      detail: `version ${markerVersion}`,
    });
  }

  return { entries: collector.entries, diagnostics: collector.diagnostics };
}

/**
 * Read-only practice entries for an uninitialized or partial project. The
 * planner runs in adoption mode with the same packs normalize would use; a
 * valid manifest supplies its profile and docs language, otherwise detect
 * displays the default generic + auto view without suggesting writes.
 */
export async function preflightPractice(input: {
  root: string;
  scope: Scope;
  scan: ScanResult;
  manifest?: ProjectManifest;
  /** An authored manifest exists but cannot be parsed. */
  suppressNext: boolean;
  version: string;
}): Promise<PracticeCheckResult> {
  if (input.scope !== 'project') {
    return { entries: [], diagnostics: [] };
  }

  const problems = await practiceParentProblems(input.root);
  const packs: PracticePack[] = [];
  if (problems.docs === undefined) {
    packs.push(documentationPack);
  }
  if (problems.skills === undefined) {
    packs.push(authoringPack);
  }
  const plan = packs.length === 0
    ? undefined
    : await planPractice({
      root: input.root,
      scope: input.scope,
      scan: input.scan,
      mode: 'adoption',
      version: input.version,
      ...(input.manifest === undefined ? {} : { manifest: input.manifest }),
    }, packs);
  const collector = new PracticeCollector();
  const conflicted = plan === undefined ? new Set<string>() : reportPlanConflicts(plan, collector);
  const language = plan?.docsLanguage ?? await practiceLanguage(input.root, input.manifest);
  const policySkipped = new Set(plan?.policySkipped ?? []);
  if (problems.docs !== undefined) {
    addParentProblem(collector, language, 'docs', problems.docs);
  }
  if (problems.skills !== undefined) {
    addParentProblem(collector, language, 'skills', problems.skills);
  }
  const next = input.suppressNext ? undefined : NORMALIZE_NEXT;

  for (const file of problems.docs === undefined ? PRACTICE_DOC_FILES : []) {
    if (conflicted.has(file)) {
      continue;
    }
    const state = await probeLstat(join(input.root, file));
    if (state.problem !== undefined) {
      addDocsPath(collector, language, file, problemMessage(file, state.problem), MANUAL_PATH_NEXT);
      continue;
    }
    if (state.info !== null) {
      collector.addEntry({
        group: 'Documentation',
        label: file,
        status: 'ok',
        detail: languageDetail(language),
      });
      continue;
    }
    if (policySkipped.has(file)) {
      addPolicySkip(
        collector,
        language,
        file,
        input.suppressNext ? undefined : POLICY_NEXT,
      );
      continue;
    }
    // Preflight is an informational view: missing entries do not produce
    // diagnostics until a normalized project is actually checked.
    addDocsMissing(collector, language, file, next, false);
  }

  for (const name of problems.skills === undefined ? AUTHORING_SKILL_NAMES : []) {
    const directory = skillDirectory(name);
    if (conflicted.has(directory) || conflicted.has(skillFile(name))) {
      continue;
    }
    const state = await authoredDirectoryState(input.root, directory);
    if (state.kind === 'missing') {
      addSkillMissing(collector, name, next, false);
      continue;
    }
    if (state.kind === 'conflict') {
      addSkillPath(collector, name, directory, state.message);
      continue;
    }
    const fileState = await skillFileState(input.root, name, state.absolute);
    if (fileState.kind === 'conflict') {
      addSkillFileProblem(collector, name, fileState.message);
      continue;
    }
    if (fileState.kind === 'invalid') {
      // Preflight does not run source discovery, so it reports the invalid
      // source itself instead of claiming the directory is preserved.
      for (const diagnostic of fileState.diagnostics) {
        collector.addDiagnostic(diagnostic);
      }
      continue;
    }
    if (fileState.kind === 'missing') {
      collector.addEntry({
        group: 'Skills',
        label: name,
        status: 'warn',
        detail: 'skill directory has no SKILL.md',
      });
      continue;
    }
    collector.addEntry({
      group: 'Skills',
      label: name,
      status: 'ok',
      detail: 'authored skill directory is preserved',
    });
  }

  return { entries: collector.entries, diagnostics: collector.diagnostics };
}
