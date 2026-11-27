import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parseGateRunnerMarker,
  parseGateSnapshot,
} from '../../src/core/gate-artifacts.ts';
import { lstatOrNull } from '../../src/core/fs-atomic.ts';
import { DAB_VERSION } from '../../src/core/version.ts';
import { verificationPack } from '../../src/init/practice-gates.ts';
import { renderGateStarter, XCODE_NEEDS } from '../../src/init/gate-templates.ts';
import { renderGateRunner } from '../../src/init/gate-runner-template.ts';
import {
  planAuthoredScaffold,
  type AuthoredScaffoldInput,
  type AuthoredScaffoldPlan,
  type PracticePack,
} from '../../src/init/practice.ts';
import { scanProject } from '../../src/init/scanner.ts';
import { makeTempDir } from '../helpers/tmp.ts';

const GATE_PATHS = [
  '.agents/gates.yaml',
  'scripts/dab-check.mjs',
  'scripts/dab-gates.json',
] as const;

let root: string;
const dirs: string[] = [];

beforeEach(async () => {
  root = await makeTempDir('dab-practice-gates-');
  dirs.push(root);
});

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await makeTempDir(prefix);
  dirs.push(dir);
  return dir;
}

async function nodeProject(target = root): Promise<void> {
  await writeFile(
    join(target, 'package.json'),
    JSON.stringify({
      name: 'node-app',
      scripts: { test: 'vitest run', build: 'tsc' },
    }),
  );
}

async function baseInput(
  overrides: Partial<AuthoredScaffoldInput> = {},
): Promise<AuthoredScaffoldInput> {
  return {
    root,
    scope: 'project',
    scan: await scanProject(root),
    profile: 'generic',
    mode: 'converge',
    version: '0.1.2',
    env: {},
    ...overrides,
  };
}

async function planGates(
  overrides: Partial<AuthoredScaffoldInput> = {},
): Promise<AuthoredScaffoldPlan> {
  return planAuthoredScaffold(await baseInput(overrides), [verificationPack]);
}

describe('verificationPack', () => {
  it('plans the starter, runner and snapshot for a Node project', async () => {
    await nodeProject();
    const scan = await scanProject(root);
    const plan = await planGates({ scan });

    expect(plan.diagnostics).toEqual([]);
    expect(Object.keys(plan.files).sort()).toEqual([...GATE_PATHS].sort());
    expect(plan.directories).toContain('scripts');
    expect(plan.files['.agents/gates.yaml']).toBe(renderGateStarter(scan));
    expect(plan.files['scripts/dab-check.mjs']).toBe(renderGateRunner('0.1.2'));

    const marker = parseGateRunnerMarker(plan.files['scripts/dab-check.mjs'] ?? '');
    expect(marker).toMatchObject({ version: '0.1.2' });

    const snapshot = parseGateSnapshot(plan.files['scripts/dab-gates.json'] ?? '');
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) {
      expect(snapshot.snapshot.generated.dabVersion).toBe('0.1.2');
      expect(snapshot.snapshot.gates.code.commands.test).toEqual({
        command: 'npm test',
        mode: 'required',
      });
    }
  });

  it('preserves an existing authored config and compiles the snapshot from it', async () => {
    await nodeProject();
    await mkdir(join(root, '.agents'), { recursive: true });
    const authored = `version: 1
gates:
  source:
    mode: required
  code:
    commands:
      test:
        command: custom-test
        mode: required
  docs:
    mode: check
`;
    await writeFile(join(root, '.agents/gates.yaml'), authored);

    const plan = await planGates();

    expect(plan.diagnostics).toEqual([]);
    expect(plan.files['.agents/gates.yaml']).toBeUndefined();
    expect(plan.skipped).toContain('.agents/gates.yaml');
    const snapshot = parseGateSnapshot(plan.files['scripts/dab-gates.json'] ?? '');
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) {
      // The authored config is authoritative: no scanner backfill appears.
      expect(snapshot.snapshot.gates.code.commands.test).toEqual({
        command: 'custom-test',
        mode: 'required',
      });
      expect(snapshot.snapshot.gates.code.commands.build).toBeUndefined();
    }
  });

  it('plans nothing in global scope', async () => {
    await nodeProject();

    const plan = await planGates({ scope: 'global' });

    expect(plan.files).toEqual({});
    expect(plan.directories).toEqual([]);
    expect(plan.diagnostics).toEqual([]);
  });

  it('marks an Xcode-only project as needs-config', async () => {
    await mkdir(join(root, 'App.xcodeproj'), { recursive: true });
    const scan = await scanProject(root);
    const plan = await planGates({ scan });

    expect(plan.diagnostics).toEqual([]);
    expect(plan.files['.agents/gates.yaml']).toContain(XCODE_NEEDS);
    const snapshot = parseGateSnapshot(plan.files['scripts/dab-gates.json'] ?? '');
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) {
      expect(snapshot.snapshot.gates.code.commands.test).toEqual({
        command: null,
        mode: 'required',
        needs: XCODE_NEEDS,
      });
    }
  });

  it('never plans content for an existing runner or snapshot', async () => {
    await nodeProject();
    await mkdir(join(root, 'scripts'), { recursive: true });
    const staleRunner = renderGateRunner('0.0.1');
    await writeFile(join(root, 'scripts/dab-check.mjs'), staleRunner);
    await writeFile(join(root, 'scripts/dab-gates.json'), 'authored snapshot\n');

    const plan = await planGates();

    expect(plan.files['scripts/dab-check.mjs']).toBeUndefined();
    expect(plan.files['scripts/dab-gates.json']).toBeUndefined();
    expect(plan.files['.agents/gates.yaml']).toBeDefined();
    expect(plan.skipped).toEqual(expect.arrayContaining([
      'scripts/dab-check.mjs',
      'scripts/dab-gates.json',
    ]));
    expect(plan.directories).toEqual([]);
  });

  it('allows scripts paths but rejects a scripts directory that escapes the root', async () => {
    const outside = await tempDir('dab-practice-gates-outside-');
    await symlink(outside, join(root, 'scripts'), 'dir');

    const plan = await planGates();

    expect(plan.diagnostics.some(
      (item) => item.severity === 'error' && item.file?.startsWith('scripts'),
    )).toBe(true);
    expect(plan.files).toEqual({});
    expect(await lstatOrNull(join(outside, 'dab-check.mjs'))).toBeNull();
  });

  it('rejects a declared path that escapes the root', async () => {
    const escapePack: PracticePack = {
      id: 'escape',
      targets: () => ({ paths: ['../escape.mjs'] }),
      files: () => ({ '../escape.mjs': 'escape\n' }),
    };

    const plan = await planAuthoredScaffold(await baseInput(), [escapePack]);

    expect(plan.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'path.escape',
        severity: 'error',
        file: '../escape.mjs',
      }),
    ]));
    expect(plan.files).toEqual({});
  });

  it('uses the running DAB version for the generated marker', async () => {
    await nodeProject();
    const scan = await scanProject(root);
    const plan = await planAuthoredScaffold(
      await baseInput({ scan, version: DAB_VERSION }),
      [verificationPack],
    );

    expect(parseGateRunnerMarker(plan.files['scripts/dab-check.mjs'] ?? '')?.version)
      .toBe(DAB_VERSION);
  });
});
