import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Diagnostic } from '../core/diagnostics.ts';
import { DabError } from '../core/errors.ts';
import {
  lstatOrNull,
  readTextFile,
  writeFileAtomic,
  writeFileIfAbsent,
} from '../core/fs-atomic.ts';
import {
  compileGateSnapshot,
  hashGateRunnerBody,
  parseGateRunnerMarker,
  parseGateSnapshot,
} from '../core/gate-artifacts.ts';
import { assertParentInsideRoot, assertRelativePath } from '../core/paths.ts';
import {
  authoredFileProblem,
  problemMessage,
  probeLstat,
} from '../core/practice-paths.ts';
import { GATE_CONFIG_PATH, loadGateConfig } from '../core/gate-config.ts';
import { GateConfigSchema, type GateConfig } from '../model/gates.ts';
import { renderGateStarter } from './gate-templates.ts';
import { renderGateRunner } from './gate-runner-template.ts';
import type { ScanResult } from './scanner.ts';

export { GATE_CONFIG_PATH };

export const GATE_RUNNER_PATH = 'scripts/dab-check.mjs';
export const GATE_SNAPSHOT_PATH = 'scripts/dab-gates.json';

const MANAGED_PATHS = new Set([GATE_CONFIG_PATH, GATE_RUNNER_PATH, GATE_SNAPSHOT_PATH]);

export const GATE_ARTIFACT_DIAGNOSTIC_CODES = {
  path: 'verification.artifact-path',
  concurrentChange: 'verification.artifact-concurrent-change',
  runnerModified: 'verification.runner-modified',
  runnerUnversioned: 'verification.runner-unversioned',
  snapshotModified: 'verification.snapshot-modified',
  snapshotUnversioned: 'verification.snapshot-unversioned',
} as const;

export type GateArtifactStatus =
  | 'missing'
  | 'current'
  | 'stale'
  | 'modified'
  | 'unversioned';

export interface GateArtifactPlan {
  files: Record<string, string>;
  actions: Array<{ path: string; kind: 'create' | 'update' | 'skip'; reason?: string }>;
  diagnostics: Diagnostic[];
  states: Array<{ path: string; status: GateArtifactStatus }>;
}

export interface GateArtifactApplyResult {
  created: string[];
  updated: string[];
  skipped: string[];
  diagnostics: Diagnostic[];
}

function pathError(file: string, message: string): Diagnostic {
  return {
    code: GATE_ARTIFACT_DIAGNOSTIC_CODES.path,
    severity: 'error',
    message: `gate artifact path cannot be managed: ${message}`,
    file,
    hint: 'Resolve the path conflict manually; DAB never writes through it.',
  };
}

function runnerModifiedWarning(reason: string): Diagnostic {
  return {
    code: GATE_ARTIFACT_DIAGNOSTIC_CODES.runnerModified,
    severity: 'warning',
    message: `generated gate runner no longer matches its marker hash and is preserved: ${reason}`,
    file: GATE_RUNNER_PATH,
    hint: 'Review the runner manually; DAB only updates unmodified copies.',
  };
}

function runnerUnversionedWarning(reason: string): Diagnostic {
  return {
    code: GATE_ARTIFACT_DIAGNOSTIC_CODES.runnerUnversioned,
    severity: 'warning',
    message: `generated gate runner has no dab-gate-runner marker and is preserved: ${reason}`,
    file: GATE_RUNNER_PATH,
    hint: 'Confirm the runner content manually; DAB preserves files without a managed marker.',
  };
}

function snapshotModifiedWarning(reason: string): Diagnostic {
  return {
    code: GATE_ARTIFACT_DIAGNOSTIC_CODES.snapshotModified,
    severity: 'warning',
    message: `generated gate snapshot no longer matches its generated hash and is preserved: ${reason}`,
    file: GATE_SNAPSHOT_PATH,
    hint: 'Review the snapshot manually or restore it with dab normalize; DAB never overwrites a modified snapshot.',
  };
}

function snapshotUnversionedWarning(reason: string): Diagnostic {
  return {
    code: GATE_ARTIFACT_DIAGNOSTIC_CODES.snapshotUnversioned,
    severity: 'warning',
    message: `generated gate snapshot has no recognizable generated metadata and is preserved: ${reason}`,
    file: GATE_SNAPSHOT_PATH,
    hint: 'Confirm the snapshot content manually; DAB preserves files without generated metadata.',
  };
}

function concurrentChangeWarning(file: string): Diagnostic {
  return {
    code: GATE_ARTIFACT_DIAGNOSTIC_CODES.concurrentChange,
    severity: 'warning',
    message: `gate artifact changed after planning and is preserved: ${file}`,
    file,
    hint: 'Re-run dab normalize after reviewing the current file; DAB never overwrites a concurrent edit.',
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Generated artifacts must be regular files. A symlink would be replaced by an
 * atomic rename, silently unlinking the user's target, so it is a blocking
 * conflict. A missing path only needs a safe parent.
 */
async function generatedFileProblem(
  root: string,
  file: string,
): Promise<string | undefined> {
  const absolute = join(root, file);
  const state = await probeLstat(absolute);
  if (state.problem !== undefined) {
    return problemMessage(file, state.problem);
  }
  try {
    await assertParentInsideRoot(root, file);
  } catch (error) {
    if (error instanceof DabError) {
      return error.message;
    }
    throw error;
  }
  if (state.info === null) {
    return undefined;
  }
  if (!state.info.isFile()) {
    return `${file} is not a regular file`;
  }
  return undefined;
}

function blockedPlan(
  states: GateArtifactPlan['states'],
  actions: GateArtifactPlan['actions'],
  diagnostics: Diagnostic[],
): GateArtifactPlan {
  return { files: {}, actions, diagnostics, states };
}

function starterConfig(starter: string): GateConfig {
  return GateConfigSchema.parse(parseYaml(starter));
}

/**
 * Inspect `.agents/gates.yaml`, the generated runner and the generated
 * snapshot, then plan only DAB-owned writes.
 *
 * - A missing config gets the scanner starter exactly once; an existing config
 *   is authoritative and is never rewritten or backfilled.
 * - A missing runner/snapshot is created.
 * - An unmodified older runner/snapshot is updated.
 * - A modified or unrecognized artifact is preserved with a warning.
 * - Any blocking diagnostic produces a plan with no contents to write.
 */
export async function planGateArtifacts(input: {
  root: string;
  scan: ScanResult;
  version: string;
}): Promise<GateArtifactPlan> {
  const { root, scan, version } = input;
  const states: GateArtifactPlan['states'] = [];
  const actions: GateArtifactPlan['actions'] = [];
  const diagnostics: Diagnostic[] = [];
  const files: Record<string, string> = {};

  const configProblem = await authoredFileProblem(root, GATE_CONFIG_PATH);
  if (configProblem !== undefined) {
    diagnostics.push(pathError(GATE_CONFIG_PATH, configProblem));
    states.push({ path: GATE_CONFIG_PATH, status: 'unversioned' });
    actions.push({ path: GATE_CONFIG_PATH, kind: 'skip', reason: 'path conflict' });
    return blockedPlan(states, actions, diagnostics);
  }

  const loaded = await loadGateConfig(root);
  if (loaded.diagnostics.length > 0 || (loaded.exists && loaded.config === undefined)) {
    if (loaded.diagnostics.length === 0) {
      diagnostics.push({
        code: 'gate.config-invalid',
        severity: 'error',
        message: `${GATE_CONFIG_PATH} cannot be loaded`,
        file: GATE_CONFIG_PATH,
        hint: 'Fix the authored gate configuration; DAB never overwrites .agents/gates.yaml.',
      });
    } else {
      diagnostics.push(...loaded.diagnostics);
    }
    states.push({ path: GATE_CONFIG_PATH, status: 'unversioned' });
    actions.push({
      path: GATE_CONFIG_PATH,
      kind: 'skip',
      reason: 'invalid authored configuration',
    });
    return blockedPlan(states, actions, diagnostics);
  }

  let config: GateConfig;
  if (loaded.config !== undefined) {
    config = loaded.config;
    states.push({ path: GATE_CONFIG_PATH, status: 'current' });
    actions.push({
      path: GATE_CONFIG_PATH,
      kind: 'skip',
      reason: 'authored configuration is never overwritten',
    });
  } else {
    const starter = renderGateStarter(scan);
    try {
      config = starterConfig(starter);
    } catch (error) {
      diagnostics.push({
        code: 'gate.starter-invalid',
        severity: 'error',
        message: `generated gate starter is invalid: ${errorText(error)}`,
        file: GATE_CONFIG_PATH,
        hint: 'Report this as a DAB bug; scanner defaults must always produce a valid starter.',
      });
      states.push({ path: GATE_CONFIG_PATH, status: 'unversioned' });
      actions.push({
        path: GATE_CONFIG_PATH,
        kind: 'skip',
        reason: 'invalid generated starter',
      });
      return blockedPlan(states, actions, diagnostics);
    }
    states.push({ path: GATE_CONFIG_PATH, status: 'missing' });
    actions.push({ path: GATE_CONFIG_PATH, kind: 'create' });
    files[GATE_CONFIG_PATH] = starter;
  }

  const runnerContent = renderGateRunner(version);
  const runnerProblem = await generatedFileProblem(root, GATE_RUNNER_PATH);
  if (runnerProblem !== undefined) {
    diagnostics.push(pathError(GATE_RUNNER_PATH, runnerProblem));
    states.push({ path: GATE_RUNNER_PATH, status: 'unversioned' });
    actions.push({ path: GATE_RUNNER_PATH, kind: 'skip', reason: 'path conflict' });
  } else if ((await lstatOrNull(join(root, GATE_RUNNER_PATH))) === null) {
    states.push({ path: GATE_RUNNER_PATH, status: 'missing' });
    actions.push({ path: GATE_RUNNER_PATH, kind: 'create' });
    files[GATE_RUNNER_PATH] = runnerContent;
  } else {
    let text: string | undefined;
    try {
      text = await readTextFile(join(root, GATE_RUNNER_PATH));
    } catch (error) {
      // A read failure cannot prove the file is unmodified, so preserve it.
      diagnostics.push(pathError(
        GATE_RUNNER_PATH,
        `gate runner cannot be read: ${errorText(error)}`,
      ));
      states.push({ path: GATE_RUNNER_PATH, status: 'unversioned' });
      actions.push({ path: GATE_RUNNER_PATH, kind: 'skip', reason: 'unreadable' });
    }
    if (text !== undefined) {
      const marker = parseGateRunnerMarker(text);
      if (marker === undefined) {
        states.push({ path: GATE_RUNNER_PATH, status: 'unversioned' });
        actions.push({
          path: GATE_RUNNER_PATH,
          kind: 'skip',
          reason: 'no managed marker',
        });
        diagnostics.push(runnerUnversionedWarning('marker missing'));
      } else if (hashGateRunnerBody(text) !== marker.sha256) {
        states.push({ path: GATE_RUNNER_PATH, status: 'modified' });
        actions.push({
          path: GATE_RUNNER_PATH,
          kind: 'skip',
          reason: 'content differs from marker hash',
        });
        diagnostics.push(runnerModifiedWarning('content differs from marker hash'));
      } else if (text === runnerContent) {
        states.push({ path: GATE_RUNNER_PATH, status: 'current' });
        actions.push({ path: GATE_RUNNER_PATH, kind: 'skip', reason: 'up to date' });
      } else {
        states.push({ path: GATE_RUNNER_PATH, status: 'stale' });
        actions.push({ path: GATE_RUNNER_PATH, kind: 'update' });
        files[GATE_RUNNER_PATH] = runnerContent;
      }
    }
  }

  const compiled = compileGateSnapshot(config, scan, version);
  const snapshotProblem = await generatedFileProblem(root, GATE_SNAPSHOT_PATH);
  if (snapshotProblem !== undefined) {
    diagnostics.push(pathError(GATE_SNAPSHOT_PATH, snapshotProblem));
    states.push({ path: GATE_SNAPSHOT_PATH, status: 'unversioned' });
    actions.push({ path: GATE_SNAPSHOT_PATH, kind: 'skip', reason: 'path conflict' });
  } else if ((await lstatOrNull(join(root, GATE_SNAPSHOT_PATH))) === null) {
    states.push({ path: GATE_SNAPSHOT_PATH, status: 'missing' });
    actions.push({ path: GATE_SNAPSHOT_PATH, kind: 'create' });
    files[GATE_SNAPSHOT_PATH] = compiled.content;
  } else {
    let text: string | undefined;
    try {
      text = await readTextFile(join(root, GATE_SNAPSHOT_PATH));
    } catch (error) {
      diagnostics.push(pathError(
        GATE_SNAPSHOT_PATH,
        `gate snapshot cannot be read: ${errorText(error)}`,
      ));
      states.push({ path: GATE_SNAPSHOT_PATH, status: 'unversioned' });
      actions.push({ path: GATE_SNAPSHOT_PATH, kind: 'skip', reason: 'unreadable' });
    }
    if (text !== undefined) {
      const parsed = parseGateSnapshot(text);
      if (!parsed.ok) {
        if (parsed.kind === 'modified') {
          states.push({ path: GATE_SNAPSHOT_PATH, status: 'modified' });
          actions.push({
            path: GATE_SNAPSHOT_PATH,
            kind: 'skip',
            reason: 'content differs from generated hash',
          });
          diagnostics.push(snapshotModifiedWarning(parsed.reason));
        } else {
          states.push({ path: GATE_SNAPSHOT_PATH, status: 'unversioned' });
          actions.push({
            path: GATE_SNAPSHOT_PATH,
            kind: 'skip',
            reason: 'no generated metadata',
          });
          diagnostics.push(snapshotUnversionedWarning(parsed.reason));
        }
      } else if (text === compiled.content) {
        states.push({ path: GATE_SNAPSHOT_PATH, status: 'current' });
        actions.push({ path: GATE_SNAPSHOT_PATH, kind: 'skip', reason: 'up to date' });
      } else {
        states.push({ path: GATE_SNAPSHOT_PATH, status: 'stale' });
        actions.push({ path: GATE_SNAPSHOT_PATH, kind: 'update' });
        files[GATE_SNAPSHOT_PATH] = compiled.content;
      }
    }
  }

  if (diagnostics.some((item) => item.severity === 'error')) {
    for (const action of actions) {
      if (action.kind !== 'skip') {
        action.kind = 'skip';
        action.reason = 'blocked by an error diagnostic';
      }
    }
    return { files: {}, actions, diagnostics, states };
  }
  return { files, actions, diagnostics, states };
}

/**
 * Apply a plan with atomic writes. Create targets are exclusive, and update
 * targets are revalidated as unmodified managed artifacts first, so a file
 * edited after planning is preserved with a warning. A dry run revalidates but
 * performs no writes. A plan with a blocking diagnostic writes nothing.
 */
export async function applyGateArtifacts(
  root: string,
  plan: GateArtifactPlan,
  options: { dryRun: boolean },
): Promise<GateArtifactApplyResult> {
  const diagnostics = [...plan.diagnostics];
  const result: GateArtifactApplyResult = {
    created: [],
    updated: [],
    skipped: [],
    diagnostics,
  };

  const actions = new Map<string, GateArtifactPlan['actions'][number]>();
  for (const action of plan.actions) {
    if (actions.has(action.path)) {
      throw new Error(`gate artifact plan has duplicate actions: ${action.path}`);
    }
    assertRelativePath(action.path, 'gate artifact path');
    if (!MANAGED_PATHS.has(action.path)) {
      throw new Error(`gate artifact plan references an unmanaged path: ${action.path}`);
    }
    actions.set(action.path, action);
  }
  for (const file of Object.keys(plan.files)) {
    if (!actions.has(file)) {
      throw new Error(`gate artifact plan has content without an action: ${file}`);
    }
  }

  if (plan.diagnostics.some((item) => item.severity === 'error')) {
    for (const action of plan.actions) {
      result.skipped.push(action.path);
    }
    return result;
  }

  const concurrent = (file: string): void => {
    result.skipped.push(file);
    diagnostics.push(concurrentChangeWarning(file));
  };

  for (const action of plan.actions) {
    if (action.kind === 'skip') {
      result.skipped.push(action.path);
      continue;
    }
    const content = plan.files[action.path];
    if (content === undefined) {
      throw new Error(`gate artifact plan is missing content for ${action.path}`);
    }
    if (action.kind === 'update' && action.path === GATE_CONFIG_PATH) {
      throw new Error('authored gate configuration is never updated');
    }

    try {
      await assertParentInsideRoot(root, action.path);
    } catch (error) {
      if (error instanceof DabError) {
        diagnostics.push(pathError(action.path, error.message));
        result.skipped.push(action.path);
        continue;
      }
      throw error;
    }

    const absolute = join(root, action.path);
    if (action.kind === 'create') {
      if ((await lstatOrNull(absolute)) !== null) {
        concurrent(action.path);
        continue;
      }
      if (!options.dryRun) {
        const created = await writeFileIfAbsent(absolute, content);
        if (!created) {
          concurrent(action.path);
          continue;
        }
      }
      result.created.push(action.path);
      continue;
    }

    let unmodified = false;
    try {
      const text = await readTextFile(absolute);
      if (action.path === GATE_RUNNER_PATH) {
        const marker = parseGateRunnerMarker(text);
        unmodified = marker !== undefined && hashGateRunnerBody(text) === marker.sha256;
      } else {
        unmodified = parseGateSnapshot(text).ok;
      }
    } catch {
      unmodified = false;
    }
    if (!unmodified) {
      concurrent(action.path);
      continue;
    }
    if (!options.dryRun) {
      await writeFileAtomic(absolute, content);
    }
    result.updated.push(action.path);
  }

  return result;
}
