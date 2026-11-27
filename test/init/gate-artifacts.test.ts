import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  compileGateSnapshot,
  hashGateRunnerBody,
  parseGateSnapshot,
  parseGateRunnerMarker,
} from '../../src/core/gate-artifacts.ts';
import { lstatOrNull } from '../../src/core/fs-atomic.ts';
import { renderGateStarter } from '../../src/init/gate-templates.ts';
import {
  applyGateArtifacts,
  GATE_RUNNER_PATH,
  GATE_SNAPSHOT_PATH,
  planGateArtifacts,
} from '../../src/init/gate-artifacts.ts';
import { renderGateRunner } from '../../src/init/gate-runner-template.ts';
import type { ScanResult } from '../../src/init/scanner.ts';
import type { GateConfig } from '../../src/model/gates.ts';
import { makeTempDir, removeTempDir } from '../helpers/tmp.ts';

const VERSION = '0.1.2';
const CONFIG_PATH = '.agents/gates.yaml';

const VALID_CONFIG = `version: 1
gates:
  source:
    mode: required
  code:
    commands:
      test:
        command: pnpm test
        mode: required
  docs:
    mode: check
`;

const VALID_GATE_CONFIG: GateConfig = {
  version: 1,
  gates: {
    source: { mode: 'required' },
    code: { commands: { test: { command: 'pnpm test', mode: 'required' } } },
    docs: { mode: 'check' },
  },
};

let root: string;

beforeEach(async () => {
  root = await makeTempDir('dab-gate-artifacts-');
});

afterEach(async () => {
  await removeTempDir(root);
});

async function write(relative: string, content: string): Promise<void> {
  const absolute = join(root, relative);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

async function read(relative: string): Promise<string> {
  return readFile(join(root, relative), 'utf8');
}

async function exists(relative: string): Promise<boolean> {
  return (await lstatOrNull(join(root, relative))) !== null;
}

function nodeScan(): ScanResult {
  return {
    projectName: 'demo',
    projectId: 'demo',
    language: 'typescript',
    packageManager: 'pnpm',
    commands: {
      test: 'pnpm test',
      typecheck: 'pnpm typecheck',
      lint: 'pnpm lint',
      build: 'pnpm build',
    },
    stacks: [{
      id: 'node',
      language: 'typescript',
      commands: {
        test: 'pnpm test',
        typecheck: 'pnpm typecheck',
        lint: 'pnpm lint',
        build: 'pnpm build',
      },
      evidence: ['package.json'],
      diagnostics: [],
    }],
    sourceDirs: ['src'],
    hasAgentsMd: false,
    hasClaudeSettings: false,
    existingAgents: [],
    diagnostics: [],
  };
}

function xcodeScan(): ScanResult {
  return {
    projectName: 'demo',
    projectId: 'demo',
    language: 'swift',
    packageManager: 'none',
    commands: {},
    stacks: [{
      id: 'ios-xcode',
      language: 'swift',
      platform: 'ios',
      commands: {},
      evidence: ['App.xcodeproj'],
      diagnostics: [],
    }],
    sourceDirs: ['App'],
    hasAgentsMd: false,
    hasClaudeSettings: false,
    existingAgents: [],
    diagnostics: [],
  };
}

function plan(scan: ScanResult = nodeScan()) {
  return planGateArtifacts({ root, scan, version: VERSION });
}

async function applyPlan(dryRun = false) {
  const planned = await plan();
  const applied = await applyGateArtifacts(root, planned, { dryRun });
  return { planned, applied };
}

const ALL_PATHS = [CONFIG_PATH, GATE_RUNNER_PATH, GATE_SNAPSHOT_PATH];

describe('planGateArtifacts', () => {
  it('creates the config starter, runner and snapshot when all are missing', async () => {
    const planned = await plan();

    expect(planned.diagnostics).toEqual([]);
    expect(planned.states).toEqual([
      { path: CONFIG_PATH, status: 'missing' },
      { path: GATE_RUNNER_PATH, status: 'missing' },
      { path: GATE_SNAPSHOT_PATH, status: 'missing' },
    ]);
    expect(planned.actions).toEqual([
      { path: CONFIG_PATH, kind: 'create' },
      { path: GATE_RUNNER_PATH, kind: 'create' },
      { path: GATE_SNAPSHOT_PATH, kind: 'create' },
    ]);
    expect(Object.keys(planned.files).sort()).toEqual([...ALL_PATHS].sort());
    expect(planned.files[CONFIG_PATH]).toBe(renderGateStarter(nodeScan()));
    expect(planned.files[GATE_RUNNER_PATH]).not.toContain('pnpm test');

    const applied = await applyGateArtifacts(root, planned, { dryRun: false });

    expect(applied.created.sort()).toEqual([...ALL_PATHS].sort());
    expect(applied.updated).toEqual([]);
    expect(await read(CONFIG_PATH)).toBe(renderGateStarter(nodeScan()));

    const parsed = parseGateSnapshot(await read(GATE_SNAPSHOT_PATH));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.snapshot.gates.code.commands.test).toEqual({
        command: 'pnpm test',
        mode: 'required',
      });
      expect(parsed.snapshot.generated.sha256).toHaveLength(64);
    }

    const runner = await read(GATE_RUNNER_PATH);
    expect(parseGateRunnerMarker(runner)).toMatchObject({ version: VERSION });
    expect(parseGateRunnerMarker(runner)?.sha256).toBe(hashGateRunnerBody(runner));
  });

  it('exposes only the authored config, never the generated starter', async () => {
    const missing = await plan();
    expect(missing.config).toBeUndefined();

    await write(CONFIG_PATH, VALID_CONFIG);
    const existing = await plan();
    expect(existing.config).toEqual(VALID_GATE_CONFIG);

    await write(CONFIG_PATH, 'version: [2\n');
    const invalid = await plan();
    expect(invalid.config).toBeUndefined();
  });

  it('reports current artifacts and plans no writes for an up-to-date project', async () => {
    await applyPlan();

    const planned = await plan();

    expect(planned.states.map((state) => state.status))
      .toEqual(['current', 'current', 'current']);
    expect(planned.actions.map((action) => action.kind)).toEqual(['skip', 'skip', 'skip']);
    expect(planned.files).toEqual({});
    expect(planned.diagnostics).toEqual([]);

    const applied = await applyGateArtifacts(root, planned, { dryRun: false });

    expect(applied.created).toEqual([]);
    expect(applied.updated).toEqual([]);
    expect(applied.skipped.sort()).toEqual([...ALL_PATHS].sort());
  });

  it('updates a stale but unmodified runner', async () => {
    await write(CONFIG_PATH, VALID_CONFIG);
    await write(GATE_RUNNER_PATH, renderGateRunner('0.0.9'));

    const planned = await plan();
    const snapshotPlan = planned.actions.find((item) => item.path === GATE_SNAPSHOT_PATH);

    expect(planned.states.find((state) => state.path === GATE_RUNNER_PATH)?.status)
      .toBe('stale');
    expect(planned.actions.find((item) => item.path === GATE_RUNNER_PATH))
      .toMatchObject({ kind: 'update' });
    expect(planned.files[GATE_RUNNER_PATH]).toBe(renderGateRunner(VERSION));
    expect(snapshotPlan?.kind).toBe('create');

    const applied = await applyGateArtifacts(root, planned, { dryRun: false });

    expect(applied.updated).toEqual([GATE_RUNNER_PATH]);
    expect(applied.created).toEqual([GATE_SNAPSHOT_PATH]);
    expect(await read(GATE_RUNNER_PATH)).toBe(renderGateRunner(VERSION));
  });

  it('updates a stale snapshot generated by an older DAB', async () => {
    await write(CONFIG_PATH, VALID_CONFIG);
    const older = compileGateSnapshot(VALID_GATE_CONFIG, nodeScan(), '0.0.9');
    await write(GATE_SNAPSHOT_PATH, older.content);

    const planned = await plan();

    expect(planned.states.find((state) => state.path === GATE_SNAPSHOT_PATH)?.status)
      .toBe('stale');
    expect(planned.actions.find((item) => item.path === GATE_SNAPSHOT_PATH))
      .toMatchObject({ kind: 'update' });
    expect(planned.files[GATE_SNAPSHOT_PATH])
      .toBe(compileGateSnapshot(VALID_GATE_CONFIG, nodeScan(), VERSION).content);

    const applied = await applyGateArtifacts(root, planned, { dryRun: false });

    expect(applied.updated).toEqual([GATE_SNAPSHOT_PATH]);
    const parsed = parseGateSnapshot(await read(GATE_SNAPSHOT_PATH));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.snapshot.generated.dabVersion).toBe(VERSION);
    }
  });

  it('preserves a runner generated by a newer DAB', async () => {
    await write(CONFIG_PATH, VALID_CONFIG);
    const newerRunner = renderGateRunner('9.9.9');
    await write(GATE_RUNNER_PATH, newerRunner);

    const planned = await plan();

    expect(planned.states.find((state) => state.path === GATE_RUNNER_PATH)?.status)
      .toBe('newer');
    expect(planned.diagnostics).toContainEqual(expect.objectContaining({
      code: 'verification.runner-newer',
      severity: 'warning',
      file: GATE_RUNNER_PATH,
    }));
    expect(planned.files[GATE_RUNNER_PATH]).toBeUndefined();
    expect(planned.actions.find((item) => item.path === GATE_RUNNER_PATH)?.kind)
      .toBe('skip');

    const applied = await applyGateArtifacts(root, planned, { dryRun: false });

    expect(applied.updated).toEqual([]);
    expect(await read(GATE_RUNNER_PATH)).toBe(newerRunner);
  });

  it('preserves a runner whose version cannot be compared', async () => {
    await write(CONFIG_PATH, VALID_CONFIG);
    const unparseable = renderGateRunner('nightly');
    await write(GATE_RUNNER_PATH, unparseable);

    const planned = await plan();

    expect(planned.states.find((state) => state.path === GATE_RUNNER_PATH)?.status)
      .toBe('newer');
    expect(planned.diagnostics).toContainEqual(expect.objectContaining({
      code: 'verification.runner-newer',
      severity: 'warning',
    }));
    expect(planned.diagnostics[0]?.message).toContain('cannot be compared');
    expect(planned.files[GATE_RUNNER_PATH]).toBeUndefined();
  });

  it('preserves a snapshot generated by a newer DAB', async () => {
    await write(CONFIG_PATH, VALID_CONFIG);
    const newer = compileGateSnapshot(VALID_GATE_CONFIG, nodeScan(), '9.9.9');
    await write(GATE_SNAPSHOT_PATH, newer.content);

    const planned = await plan();

    expect(planned.states.find((state) => state.path === GATE_SNAPSHOT_PATH)?.status)
      .toBe('newer');
    expect(planned.diagnostics).toContainEqual(expect.objectContaining({
      code: 'verification.snapshot-newer',
      severity: 'warning',
      file: GATE_SNAPSHOT_PATH,
    }));
    expect(planned.files[GATE_SNAPSHOT_PATH]).toBeUndefined();

    const applied = await applyGateArtifacts(root, planned, { dryRun: false });

    expect(applied.updated).toEqual([]);
    expect(await read(GATE_SNAPSHOT_PATH)).toBe(newer.content);
  });

  it('preserves a snapshot whose version cannot be compared', async () => {
    await write(CONFIG_PATH, VALID_CONFIG);
    const unparseable = compileGateSnapshot(VALID_GATE_CONFIG, nodeScan(), 'nightly');
    await write(GATE_SNAPSHOT_PATH, unparseable.content);

    const planned = await plan();

    expect(planned.states.find((state) => state.path === GATE_SNAPSHOT_PATH)?.status)
      .toBe('newer');
    expect(planned.diagnostics).toContainEqual(expect.objectContaining({
      code: 'verification.snapshot-newer',
      severity: 'warning',
    }));
    expect(planned.diagnostics[0]?.message).toContain('cannot be compared');
    expect(planned.files[GATE_SNAPSHOT_PATH]).toBeUndefined();
  });

  it('still inspects generated artifact states when the config is invalid', async () => {
    await applyPlan();
    await write(GATE_RUNNER_PATH, renderGateRunner('0.0.9'));
    await write(CONFIG_PATH, 'version: [2\n');

    const planned = await plan();

    expect(planned.states).toEqual([
      { path: CONFIG_PATH, status: 'unversioned' },
      { path: GATE_RUNNER_PATH, status: 'stale' },
      { path: GATE_SNAPSHOT_PATH, status: 'current' },
    ]);
    expect(planned.actions.map((item) => item.kind)).toEqual(['skip', 'skip', 'skip']);
    expect(planned.files).toEqual({});
    expect(planned.diagnostics.some((item) => item.severity === 'error')).toBe(true);

    const applied = await applyGateArtifacts(root, planned, { dryRun: false });

    expect(applied.created).toEqual([]);
    expect(applied.updated).toEqual([]);
    expect(await read(GATE_RUNNER_PATH)).toBe(renderGateRunner('0.0.9'));
  });

  it('inspects missing artifacts without creating them when the config is invalid', async () => {
    await write(CONFIG_PATH, 'version: [2\n');

    const planned = await plan();

    expect(planned.states).toEqual([
      { path: CONFIG_PATH, status: 'unversioned' },
      { path: GATE_RUNNER_PATH, status: 'missing' },
      { path: GATE_SNAPSHOT_PATH, status: 'missing' },
    ]);
    expect(planned.actions.map((item) => item.kind)).toEqual(['skip', 'skip', 'skip']);
    expect(planned.files).toEqual({});
    expect(await exists(GATE_RUNNER_PATH)).toBe(false);
    expect(await exists(GATE_SNAPSHOT_PATH)).toBe(false);
  });

  it('preserves a runner that appeared after planning with a warning', async () => {
    const planned = await plan();
    const appeared = renderGateRunner('0.0.9');
    await write(GATE_RUNNER_PATH, appeared);

    const applied = await applyGateArtifacts(root, planned, { dryRun: false });

    expect(applied.created).not.toContain(GATE_RUNNER_PATH);
    expect(applied.skipped).toContain(GATE_RUNNER_PATH);
    expect(applied.diagnostics).toContainEqual(expect.objectContaining({
      code: 'verification.artifact-concurrent-change',
      severity: 'warning',
      file: GATE_RUNNER_PATH,
    }));
    expect(await read(GATE_RUNNER_PATH)).toBe(appeared);
  });

  it('preserves a snapshot modified after planning with a warning', async () => {
    await write(CONFIG_PATH, VALID_CONFIG);
    const older = compileGateSnapshot(VALID_GATE_CONFIG, nodeScan(), '0.0.9');
    await write(GATE_SNAPSHOT_PATH, older.content);
    const planned = await plan();
    expect(planned.actions.find((item) => item.path === GATE_SNAPSHOT_PATH))
      .toMatchObject({ kind: 'update' });

    const edited = '{}\n';
    await write(GATE_SNAPSHOT_PATH, edited);

    const applied = await applyGateArtifacts(root, planned, { dryRun: false });

    expect(applied.updated).not.toContain(GATE_SNAPSHOT_PATH);
    expect(applied.skipped).toContain(GATE_SNAPSHOT_PATH);
    expect(applied.diagnostics).toContainEqual(expect.objectContaining({
      code: 'verification.artifact-concurrent-change',
      severity: 'warning',
      file: GATE_SNAPSHOT_PATH,
    }));
    expect(await read(GATE_SNAPSHOT_PATH)).toBe(edited);
  });

  it('preserves a modified runner and snapshot with warnings', async () => {
    await applyPlan();
    const dirtyRunner = `${await read(GATE_RUNNER_PATH)}// local edit\n`;
    await write(GATE_RUNNER_PATH, dirtyRunner);

    const snapshot = JSON.parse(await read(GATE_SNAPSHOT_PATH)) as {
      gates: { code: { commands: { test: { mode: string } } } };
    };
    snapshot.gates.code.commands.test.mode = 'advisory';
    const dirtySnapshot = `${JSON.stringify(snapshot, null, 2)}\n`;
    await write(GATE_SNAPSHOT_PATH, dirtySnapshot);

    const planned = await plan();

    expect(planned.states.find((state) => state.path === GATE_RUNNER_PATH)?.status)
      .toBe('modified');
    expect(planned.states.find((state) => state.path === GATE_SNAPSHOT_PATH)?.status)
      .toBe('modified');
    expect(planned.diagnostics.map((item) => item.code).sort()).toEqual([
      'verification.runner-modified',
      'verification.snapshot-modified',
    ]);
    expect(planned.files).toEqual({});
    expect(planned.actions.filter((item) => item.path !== CONFIG_PATH).map((item) => item.kind))
      .toEqual(['skip', 'skip']);

    const applied = await applyGateArtifacts(root, planned, { dryRun: false });

    expect(applied.created).toEqual([]);
    expect(applied.updated).toEqual([]);
    expect(await read(GATE_RUNNER_PATH)).toBe(dirtyRunner);
    expect(await read(GATE_SNAPSHOT_PATH)).toBe(dirtySnapshot);
  });

  it('preserves an unversioned snapshot with a warning', async () => {
    await write(CONFIG_PATH, VALID_CONFIG);
    await write(GATE_SNAPSHOT_PATH, '{}\n');

    const planned = await plan();

    expect(planned.states.find((state) => state.path === GATE_SNAPSHOT_PATH)?.status)
      .toBe('unversioned');
    expect(planned.diagnostics).toContainEqual(expect.objectContaining({
      code: 'verification.snapshot-unversioned',
      severity: 'warning',
      file: GATE_SNAPSHOT_PATH,
    }));
    expect(planned.files[GATE_SNAPSHOT_PATH]).toBeUndefined();

    await applyGateArtifacts(root, planned, { dryRun: false });

    expect(await read(GATE_SNAPSHOT_PATH)).toBe('{}\n');
  });

  it('treats invalid authored config as blocking and writes nothing', async () => {
    await write(CONFIG_PATH, 'version: [2\n');

    const planned = await plan();

    expect(planned.diagnostics.some((item) => item.severity === 'error')).toBe(true);
    expect(planned.files).toEqual({});

    const applied = await applyGateArtifacts(root, planned, { dryRun: false });

    expect(applied.created).toEqual([]);
    expect(applied.updated).toEqual([]);
    expect(applied.diagnostics.some((item) => item.severity === 'error')).toBe(true);
    expect(await exists(GATE_RUNNER_PATH)).toBe(false);
    expect(await exists(GATE_SNAPSHOT_PATH)).toBe(false);
  });

  it('does not write anything during a dry run', async () => {
    const planned = await plan();

    const applied = await applyGateArtifacts(root, planned, { dryRun: true });

    expect(applied.created.sort()).toEqual([...ALL_PATHS].sort());
    expect(await exists(CONFIG_PATH)).toBe(false);
    expect(await exists(GATE_RUNNER_PATH)).toBe(false);
    expect(await exists(GATE_SNAPSHOT_PATH)).toBe(false);
  });

  it('never overwrites an existing authored config', async () => {
    await write(CONFIG_PATH, VALID_CONFIG);

    const planned = await plan();
    expect(planned.states.find((state) => state.path === CONFIG_PATH)?.status)
      .toBe('current');
    expect(planned.actions.find((item) => item.path === CONFIG_PATH))
      .toMatchObject({ kind: 'skip' });

    await applyGateArtifacts(root, planned, { dryRun: false });

    expect(await read(CONFIG_PATH)).toBe(VALID_CONFIG);
  });

  it('compiles the snapshot from an existing config instead of scanner defaults', async () => {
    await write(CONFIG_PATH, VALID_CONFIG);

    const planned = await plan();
    const parsed = parseGateSnapshot(planned.files[GATE_SNAPSHOT_PATH] ?? '');

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(Object.keys(parsed.snapshot.gates.code.commands)).toEqual(['test']);
    }
    expect(planned.files[GATE_SNAPSHOT_PATH]).not.toContain('pnpm typecheck');
    expect(planned.files[GATE_SNAPSHOT_PATH]).not.toContain('pnpm lint');
  });

  it('keeps an Xcode needs-config command unresolved in the snapshot', async () => {
    const planned = await planGateArtifacts({
      root,
      scan: xcodeScan(),
      version: VERSION,
    });

    expect(planned.files[CONFIG_PATH]).toContain('command: null');
    const parsed = parseGateSnapshot(planned.files[GATE_SNAPSHOT_PATH] ?? '');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.snapshot.gates.code.commands.test?.command).toBeNull();
      expect(parsed.snapshot.gates.code.commands.test?.mode).toBe('required');
      expect(parsed.snapshot.gates.code.commands.test?.needs).toContain('scheme');
      expect(parsed.snapshot.gates.code.commands.test?.needs).toContain('destination');
    }
  });
});
