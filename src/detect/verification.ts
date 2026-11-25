import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Diagnostic, DiagnosticSeverity } from '../core/diagnostics.ts';
import { readTextFile } from '../core/fs-atomic.ts';
import { loadGateConfig } from '../core/gate-config.ts';
import { resolveGateCommand } from '../core/gate-artifacts.ts';
import {
  GATE_CONFIG_PATH,
  GATE_RUNNER_PATH,
  GATE_SNAPSHOT_PATH,
  planGateArtifacts,
  type GateArtifactStatus,
} from '../init/gate-artifacts.ts';
import { selectGateStack } from '../init/gate-templates.ts';
import { GATE_COMMAND_NAMES, type GateConfig } from '../model/gates.ts';
import type { ScanResult } from '../init/scanner.ts';
import type { ChecklistEntry, ChecklistStatus } from './checklist.ts';

const NEXT_NORMALIZE = 'dab normalize';
const NEXT_EDIT_CONFIG = 'edit .agents/gates.yaml';
const NEXT_MANUAL_PATH = 'resolve the path conflict manually';
const CI_LABEL = 'CI';

type ArtifactKind = 'config' | 'runner' | 'snapshot';

interface ArtifactSpec {
  kind: ArtifactKind;
  path: string;
}

/** Artifact rows always render in this order for stable JSON and human output. */
const ARTIFACT_SPECS: readonly ArtifactSpec[] = [
  { kind: 'config', path: GATE_CONFIG_PATH },
  { kind: 'runner', path: GATE_RUNNER_PATH },
  { kind: 'snapshot', path: GATE_SNAPSHOT_PATH },
];

const ARTIFACT_BY_PATH = new Map(
  ARTIFACT_SPECS.map((spec) => [spec.path, spec] as const),
);

/**
 * Verification warnings that describe preserved or user-owned state instead
 * of a missing or stale DAB-managed artifact. `dab detect --strict` keeps them
 * informational; every other verification warning fails strict.
 */
export const VERIFICATION_NON_STRICT_WARNING_CODES: ReadonlySet<string> = new Set([
  'verification.runner-modified',
  'verification.runner-unversioned',
  'verification.runner-newer',
  'verification.snapshot-modified',
  'verification.snapshot-unversioned',
  'verification.snapshot-newer',
  'verification.ci-missing',
]);

/**
 * The gate loader reports `gate.*` codes for config parse/schema/read
 * failures. Detect reports them under the documented Verification group so no
 * authored-config error falls through to the generic Safety grouping.
 */
export function mapGateDiagnosticCode(code: string): string {
  return code.startsWith('gate.')
    ? `verification.${code.slice('gate.'.length)}`
    : code;
}

export interface VerificationCheckResult {
  entries: ChecklistEntry[];
  diagnostics: Diagnostic[];
}

interface ArtifactRow {
  status: ChecklistStatus;
  details: string[];
  next?: string;
  /** A plan diagnostic already describes this row. */
  fromDiagnostic: boolean;
}

const STATUS_RANK: Record<ChecklistStatus, number> = {
  importable: 0,
  ok: 1,
  missing: 2,
  warn: 2,
  error: 3,
};

function severityStatus(severity: DiagnosticSeverity): ChecklistStatus {
  switch (severity) {
    case 'error':
      return 'error';
    case 'warning':
      return 'warn';
    case 'info':
      return 'ok';
  }
}

function artifactNoun(kind: ArtifactKind): string {
  switch (kind) {
    case 'config':
      return 'gate configuration';
    case 'runner':
      return 'gate runner';
    case 'snapshot':
      return 'gate snapshot';
  }
}

function nextForCode(code: string): string | undefined {
  if (code === 'verification.artifact-path') {
    return NEXT_MANUAL_PATH;
  }
  if (code.endsWith('-missing') || code.endsWith('-stale')) {
    return NEXT_NORMALIZE;
  }
  if (
    code === 'verification.config-invalid'
    || code === 'verification.config-unreadable'
    || code === 'verification.config-yaml'
  ) {
    return NEXT_EDIT_CONFIG;
  }
  return undefined;
}

function hintForCode(code: string): string | undefined {
  if (code.endsWith('-missing')) {
    return 'Run dab normalize to create the missing gate artifact.';
  }
  if (code.endsWith('-stale')) {
    return 'Run dab normalize to refresh the unmodified generated artifact.';
  }
  if (
    code.endsWith('-modified')
    || code.endsWith('-unversioned')
    || code.endsWith('-newer')
  ) {
    return 'Review the file manually; dab normalize preserves modified, unversioned and newer artifacts.';
  }
  if (code === 'verification.artifact-path') {
    return 'Resolve the path conflict manually; DAB never writes through it.';
  }
  if (code.startsWith('verification.config-') || code === 'verification.starter-invalid') {
    return 'Fix .agents/gates.yaml; DAB never overwrites the authored file.';
  }
  return undefined;
}

function stateCode(kind: ArtifactKind, status: GateArtifactStatus): string | undefined {
  switch (status) {
    case 'current':
      return undefined;
    case 'missing':
      return `verification.${kind}-missing`;
    case 'stale':
      return kind === 'config'
        ? 'verification.config-invalid'
        : `verification.${kind}-stale`;
    case 'modified':
      return kind === 'config'
        ? 'verification.config-invalid'
        : `verification.${kind}-modified`;
    case 'unversioned':
      return kind === 'config'
        ? 'verification.config-invalid'
        : `verification.${kind}-unversioned`;
    case 'newer':
      return kind === 'config'
        ? 'verification.config-invalid'
        : `verification.${kind}-newer`;
  }
}

function stateMessage(
  spec: ArtifactSpec,
  status: GateArtifactStatus,
  version: string,
): string {
  const path = spec.path;
  const noun = artifactNoun(spec.kind);
  switch (status) {
    case 'current':
      return spec.kind === 'config' ? 'version 1' : `version ${version}`;
    case 'missing':
      return `${noun} is missing: ${path}`;
    case 'stale':
      return spec.kind === 'snapshot'
        ? `gate snapshot is stale and does not match ${GATE_CONFIG_PATH}`
        : `${noun} is older than DAB ${version}`;
    case 'modified':
      return `${noun} was modified and is preserved: ${path}`;
    case 'unversioned':
      return `${noun} has no managed marker and is preserved: ${path}`;
    case 'newer':
      return `${noun} was generated by a newer DAB and is preserved: ${path}`;
  }
}

function mergeRow(
  rows: Map<string, ArtifactRow>,
  path: string,
  status: ChecklistStatus,
  detail: string | undefined,
  next: string | undefined,
  fromDiagnostic: boolean,
): void {
  const current = rows.get(path);
  if (current === undefined) {
    rows.set(path, {
      status,
      details: detail === undefined ? [] : [detail],
      ...(next === undefined ? {} : { next }),
      fromDiagnostic,
    });
    return;
  }
  if (STATUS_RANK[status] > STATUS_RANK[current.status]) {
    current.status = status;
  }
  if (detail !== undefined && !current.details.includes(detail)) {
    current.details.push(detail);
  }
  if (current.next === undefined && next !== undefined) {
    current.next = next;
  }
  if (fromDiagnostic) {
    current.fromDiagnostic = true;
  }
}

const CI_FILE_CANDIDATES = [
  '.gitlab-ci.yml',
  '.gitlab-ci.yaml',
  'Jenkinsfile',
  '.travis.yml',
  'azure-pipelines.yml',
  'azure-pipelines.yaml',
  'bitbucket-pipelines.yml',
  '.drone.yml',
  'appveyor.yml',
  '.circleci/config.yml',
  '.buildkite/pipeline.yml',
  '.woodpecker.yml',
] as const;

const WORKFLOW_DIR = '.github/workflows';
const RUNNER_REFERENCE = 'dab-check';

async function fileReferencesRunner(root: string, relative: string): Promise<boolean> {
  try {
    return (await readTextFile(join(root, relative))).includes(RUNNER_REFERENCE);
  } catch {
    // CI wiring is advisory: an unreadable provider file simply does not
    // prove the runner is wired. The missing report stays a warning.
    return false;
  }
}

/**
 * Find a CI provider file that invokes the generated runner. The check is
 * provider-neutral: GitHub Actions is one candidate among several, and no CI
 * file is required or generated.
 */
async function findCiWiring(root: string): Promise<string | undefined> {
  for (const file of CI_FILE_CANDIDATES) {
    if (await fileReferencesRunner(root, file)) {
      return file;
    }
  }

  let names: string[];
  try {
    names = (await readdir(join(root, WORKFLOW_DIR), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    names = [];
  }
  for (const name of names) {
    const relative = `${WORKFLOW_DIR}/${name}`;
    if (await fileReferencesRunner(root, relative)) {
      return relative;
    }
  }
  return undefined;
}

function commandEntries(
  config: GateConfig,
  scan: ScanResult,
  diagnostics: Diagnostic[],
): ChecklistEntry[] {
  const entries: ChecklistEntry[] = [];
  const commands = config.gates.code.commands;
  const configured = GATE_COMMAND_NAMES.filter((name) => commands[name] !== undefined);

  if (configured.length === 0) {
    const selection = selectGateStack(scan);
    const detected = selection.kind === 'commands' ? selection.commands : {};
    const detectedNames = GATE_COMMAND_NAMES.filter(
      (name) => (detected[name] ?? '').trim().length > 0,
    );
    if (detectedNames.length === 0) {
      // An empty command set is allowed only when the scanner found nothing to
      // run, and it is still reported instead of passing silently.
      entries.push({
        group: 'Verification',
        label: 'code',
        status: 'warn',
        detail: 'no code commands detected; add test/build commands to .agents/gates.yaml',
      });
      return entries;
    }
    const message =
      `no code commands are configured; scanner-detected commands are not wired: ${
        detectedNames.join(', ')
      }`;
    diagnostics.push({
      code: 'verification.command-missing',
      severity: 'error',
      message,
      file: GATE_CONFIG_PATH,
      hint: 'Add the detected commands to .agents/gates.yaml; detect never treats a missing required command as a pass.',
    });
    entries.push({
      group: 'Verification',
      label: 'code',
      status: 'error',
      detail: message,
      next: NEXT_EDIT_CONFIG,
    });
    return entries;
  }

  for (const name of GATE_COMMAND_NAMES) {
    const command = commands[name];
    if (command === undefined) {
      continue;
    }
    if (command.command === null) {
      const detail = command.needs ?? 'command requires project configuration';
      diagnostics.push({
        code: 'verification.command-needs-config',
        severity: 'warning',
        message: `gate command ${name} requires project configuration: ${detail}`,
        file: GATE_CONFIG_PATH,
        hint: 'Edit .agents/gates.yaml with a command, Xcode scheme/destination, or Fastlane command, then run dab normalize.',
      });
      entries.push({
        group: 'Verification',
        label: `code.${name}`,
        status: 'warn',
        detail,
        next: NEXT_EDIT_CONFIG,
      });
      continue;
    }
    const resolved = resolveGateCommand(command).command ?? 'configured';
    entries.push({
      group: 'Verification',
      label: `code.${name}`,
      status: 'ok',
      detail: resolved,
    });
  }
  return entries;
}

/**
 * Read-only inspection of `.agents/gates.yaml`, the generated runner and the
 * generated snapshot for the project-scope Verification checklist group.
 *
 * Artifact states and hashes come from `planGateArtifacts`, so detect,
 * init/normalize and the runner agree on what "modified", "stale" and "newer"
 * mean. Detect only reads: the plan is never applied, and `source` is not
 * executed here.
 */
export async function inspectVerification(input: {
  root: string;
  scan: ScanResult;
  version: string;
}): Promise<VerificationCheckResult> {
  const plan = await planGateArtifacts({
    root: input.root,
    scan: input.scan,
    version: input.version,
  });
  const diagnostics: Diagnostic[] = [];
  const rows = new Map<string, ArtifactRow>();
  const extraEntries: ChecklistEntry[] = [];

  for (const item of plan.diagnostics) {
    const diagnostic: Diagnostic = {
      ...item,
      code: mapGateDiagnosticCode(item.code),
    };
    diagnostics.push(diagnostic);
    const spec = diagnostic.file === undefined
      ? undefined
      : ARTIFACT_BY_PATH.get(diagnostic.file);
    if (spec === undefined) {
      // Do not hide a plan diagnostic that points outside the managed gate
      // artifacts; it still belongs to the Verification group.
      extraEntries.push({
        group: 'Verification',
        label: diagnostic.file ?? diagnostic.code,
        status: severityStatus(diagnostic.severity),
        detail: diagnostic.message,
      });
      continue;
    }
    mergeRow(
      rows,
      spec.path,
      severityStatus(diagnostic.severity),
      diagnostic.message,
      nextForCode(diagnostic.code),
      true,
    );
  }

  const states = new Map(plan.states.map((state) => [state.path, state.status] as const));
  for (const spec of ARTIFACT_SPECS) {
    const existing = rows.get(spec.path);
    if (existing?.fromDiagnostic === true) {
      continue;
    }
    // The plan always emits one state per artifact; a missing state means the
    // intended artifact was not inspected, so report it as missing.
    const status = states.get(spec.path) ?? 'missing';
    const code = stateCode(spec.kind, status);
    if (code === undefined) {
      mergeRow(
        rows,
        spec.path,
        'ok',
        stateMessage(spec, status, input.version),
        undefined,
        false,
      );
      continue;
    }
    const severity: DiagnosticSeverity = code === 'verification.config-invalid'
      ? 'error'
      : 'warning';
    const message = stateMessage(spec, status, input.version);
    diagnostics.push({
      code,
      severity,
      message,
      file: spec.path,
      ...(hintForCode(code) === undefined ? {} : { hint: hintForCode(code) }),
    });
    mergeRow(
      rows,
      spec.path,
      status === 'missing' ? 'missing' : severityStatus(severity),
      message,
      nextForCode(code),
      false,
    );
  }

  const loaded = await loadGateConfig(input.root);
  const commandRows = loaded.config === undefined
    ? []
    : commandEntries(loaded.config, input.scan, diagnostics);

  const ciFile = await findCiWiring(input.root);
  let ciEntry: ChecklistEntry;
  if (ciFile === undefined) {
    diagnostics.push({
      code: 'verification.ci-missing',
      severity: 'warning',
      message: 'no CI workflow calls scripts/dab-check.mjs',
      hint: 'Add `node scripts/dab-check.mjs --strict` to the project CI provider; DAB does not generate CI files.',
    });
    ciEntry = {
      group: 'Verification',
      label: CI_LABEL,
      status: 'warn',
      detail: 'no CI call to scripts/dab-check.mjs',
    };
  } else {
    ciEntry = {
      group: 'Verification',
      label: CI_LABEL,
      status: 'ok',
      detail: ciFile,
    };
  }

  const entries: ChecklistEntry[] = [];
  for (const spec of ARTIFACT_SPECS) {
    const row = rows.get(spec.path);
    if (row === undefined) {
      continue;
    }
    entries.push({
      group: 'Verification',
      label: spec.path,
      status: row.status,
      ...(row.details.length === 0 ? {} : { detail: row.details.join('; ') }),
      ...(row.next === undefined ? {} : { next: row.next }),
    });
  }
  entries.push(...extraEntries, ...commandRows, ciEntry);

  return { entries, diagnostics };
}
