import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import {
  applyGateArtifacts,
  GATE_RUNNER_PATH,
  GATE_SNAPSHOT_PATH,
  planGateArtifacts,
} from '../../src/init/gate-artifacts.ts';
import type { ScanResult } from '../../src/init/scanner.ts';
import type {
  GateCommandConfig,
  GateCommandName,
  GateConfig,
} from '../../src/model/gates.ts';
import { makeTempDir, removeTempDir } from '../helpers/tmp.ts';

const VERSION = '0.1.2';

let root: string;
let dabLog: string;

beforeEach(async () => {
  root = await makeTempDir('dab-gate-runner-');
  dabLog = join(root, 'dab.log');
});

afterEach(async () => {
  await removeTempDir(root);
});

function emptyScan(): ScanResult {
  return {
    projectName: 'demo',
    projectId: 'demo',
    language: 'generic',
    packageManager: 'none',
    commands: {},
    stacks: [],
    sourceDirs: [],
    hasAgentsMd: false,
    hasClaudeSettings: false,
    existingAgents: [],
    diagnostics: [],
  };
}

function xcodeScan(): ScanResult {
  return {
    ...emptyScan(),
    language: 'swift',
    stacks: [{
      id: 'ios-xcode',
      language: 'swift',
      platform: 'ios',
      commands: {},
      evidence: ['App.xcodeproj'],
      diagnostics: [],
    }],
  };
}

function logCommand(name: string, exitCode = 0): string {
  const suffix = exitCode === 0 ? '' : `; exit ${exitCode}`;
  return `echo ${name} >> "$DAB_LOG"${suffix}`;
}

function config(
  commands: Partial<Record<GateCommandName, GateCommandConfig>>,
  docs: GateConfig['gates']['docs'] = { mode: 'check' },
): GateConfig {
  return {
    version: 1,
    gates: {
      source: { mode: 'required' },
      code: { commands },
      docs,
    },
  };
}

async function write(relative: string, content: string, mode?: number): Promise<void> {
  const absolute = join(root, relative);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content, mode === undefined ? undefined : { mode });
  if (mode !== undefined) {
    await chmod(absolute, mode);
  }
}

async function install(gateConfig: GateConfig): Promise<void> {
  await write('.agents/gates.yaml', stringify(gateConfig, { lineWidth: 0 }));
  const planned = await planGateArtifacts({ root, scan: emptyScan(), version: VERSION });
  await applyGateArtifacts(root, planned, { dryRun: false });
}

async function installFromScan(scan: ScanResult): Promise<void> {
  const planned = await planGateArtifacts({ root, scan, version: VERSION });
  await applyGateArtifacts(root, planned, { dryRun: false });
}

async function fakeDab(exitCode = 0): Promise<string> {
  const path = join(root, 'fake-dab.sh');
  await writeFile(
    path,
    `#!/bin/sh\necho "source $@" >> "$DAB_LOG"\nexit ${exitCode}\n`,
  );
  await chmod(path, 0o755);
  return path;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runRunner(
  args: string[] = [],
  env: Record<string, string> = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [join(root, GATE_RUNNER_PATH), ...args],
      {
        cwd: root,
        env: { ...process.env, DAB_LOG: dabLog, ...env },
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function logLines(): Promise<string[]> {
  try {
    return (await readFile(dabLog, 'utf8')).trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

async function patchSnapshot(
  mutate: (snapshot: Record<string, unknown>) => void,
): Promise<void> {
  const snapshot = JSON.parse(await readFile(join(root, GATE_SNAPSHOT_PATH), 'utf8')) as
    Record<string, unknown>;
  mutate(snapshot);
  await write(GATE_SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
}

describe('generated gate runner', () => {
  it('runs the source gate first and all code gates despite one failure', async () => {
    await install(config({
      test: { command: logCommand('test'), mode: 'required' },
      typecheck: { command: logCommand('typecheck', 1), mode: 'required' },
      lint: { command: logCommand('lint', 1), mode: 'advisory' },
      build: { command: logCommand('build'), mode: 'advisory' },
    }));
    const dab = await fakeDab(0);

    const result = await runRunner([], { DAB_BIN: dab });

    expect(result.code).toBe(1);
    expect(await logLines()).toEqual([
      'source detect --strict',
      'test',
      'typecheck',
      'lint',
      'build',
    ]);
    expect(result.stdout).toContain('GATE source PASS');
    expect(result.stdout).toContain('GATE code.typecheck FAIL');
    expect(result.stdout).toContain('GATE code.lint WARN');
    expect(result.stdout).toContain('GATE code.build PASS');
  });

  it('fails with exit 1 when the required source gate fails', async () => {
    await install(config({ test: { command: logCommand('test'), mode: 'required' } }));
    const dab = await fakeDab(1);

    const result = await runRunner([], { DAB_BIN: dab });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('GATE source FAIL');
    expect(await logLines()).toContain('test');
  });

  it('escalates advisory failures only under --strict', async () => {
    await install(config({
      test: { command: logCommand('test'), mode: 'required' },
      lint: { command: logCommand('lint', 1), mode: 'advisory' },
    }));
    const dab = await fakeDab(0);

    const relaxed = await runRunner([], { DAB_BIN: dab });
    expect(relaxed.code).toBe(0);
    expect(relaxed.stdout).toContain('GATE code.lint WARN');

    const strict = await runRunner(['--strict'], { DAB_BIN: dab });
    expect(strict.code).toBe(1);
  });

  it('reports CONFIG and exit 2 when the snapshot is missing, after running source', async () => {
    await install(config({ test: { command: logCommand('test'), mode: 'required' } }));
    await rm(join(root, GATE_SNAPSHOT_PATH));
    const dab = await fakeDab(0);

    const result = await runRunner([], { DAB_BIN: dab });

    expect(result.code).toBe(2);
    expect(result.stdout).toContain('CONFIG');
    expect(await logLines()).toEqual(['source detect --strict']);
  });

  it('reports CONFIG and exit 2 when the snapshot hash does not match', async () => {
    await install(config({ test: { command: logCommand('test'), mode: 'required' } }));
    await patchSnapshot((snapshot) => {
      const gates = snapshot.gates as {
        code: { commands: { test: { command: string } } };
      };
      gates.code.commands.test.command = logCommand('tampered');
    });
    const dab = await fakeDab(0);

    const result = await runRunner([], { DAB_BIN: dab });

    expect(result.code).toBe(2);
    expect(result.stdout).toContain('CONFIG');
    expect(await logLines()).toEqual(['source detect --strict']);
  });

  it('always runs the source gate even when the snapshot tries to disable it', async () => {
    await install(config({ test: { command: logCommand('test'), mode: 'required' } }));
    await patchSnapshot((snapshot) => {
      const gates = snapshot.gates as { source: { mode: string } };
      gates.source.mode = 'off';
    });
    const dab = await fakeDab(0);

    const result = await runRunner([], { DAB_BIN: dab });

    expect(result.code).toBe(2);
    expect(result.stdout).toContain('CONFIG');
    expect(await logLines()).toEqual(['source detect --strict']);
  });

  it('reports CONFIG and exit 2 for an unresolved required command', async () => {
    await install(config({
      test: {
        command: null,
        mode: 'required',
        needs: 'Configure the Xcode scheme and destination in .agents/gates.yaml.',
      },
    }));
    const dab = await fakeDab(0);

    const result = await runRunner([], { DAB_BIN: dab });

    expect(result.code).toBe(2);
    expect(result.stdout).toContain('GATE code.test CONFIG');
    expect(result.stdout).toContain('scheme');
    expect(await logLines()).toEqual(['source detect --strict']);
  });

  it('reports CONFIG for a generated Xcode needs-config project', async () => {
    await installFromScan(xcodeScan());
    const dab = await fakeDab(0);

    const result = await runRunner([], { DAB_BIN: dab });

    expect(result.code).toBe(2);
    expect(result.stdout).toContain('CONFIG');
    expect(result.stdout).toContain('scheme');
  });

  it('skips commands whose mode is off without running them', async () => {
    await install(config({
      test: { command: logCommand('test'), mode: 'off' },
    }));
    const dab = await fakeDab(0);

    const result = await runRunner([], { DAB_BIN: dab });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('GATE code.test SKIP');
    expect(await logLines()).toEqual(['source detect --strict']);
  });

  it('runs a configured docs command', async () => {
    await install(
      config({ test: { command: logCommand('test'), mode: 'required' } }, {
        mode: 'required',
        command: logCommand('docs'),
      }),
    );
    const dab = await fakeDab(0);

    const result = await runRunner([], { DAB_BIN: dab });

    expect(result.code).toBe(0);
    expect(await logLines()).toEqual(['source detect --strict', 'test', 'docs']);
    expect(result.stdout).toContain('GATE docs PASS');
  });

  it('reports a missing docs command as SKIP, not a failure', async () => {
    await install(config({ test: { command: logCommand('test'), mode: 'required' } }));
    const dab = await fakeDab(0);

    const result = await runRunner([], { DAB_BIN: dab });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('GATE docs SKIP');
  });

  it('outputs the design JSON contract with lowercase statuses', async () => {
    await install(config({
      test: { command: logCommand('test'), mode: 'required' },
      typecheck: { command: logCommand('typecheck', 1), mode: 'required' },
      lint: { command: logCommand('lint', 1), mode: 'advisory' },
    }));
    const dab = await fakeDab(0);

    const result = await runRunner(['--json'], { DAB_BIN: dab });

    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stdout) as {
      schemaVersion: number;
      ok: boolean;
      gates: Array<{
        id: string;
        status: string;
        required: boolean;
        command: string | null;
        exitCode: number | null;
        durationMs: number;
      }>;
    };

    expect(payload.schemaVersion).toBe(1);
    expect(payload.ok).toBe(false);
    expect(Object.keys(payload).sort()).toEqual(['gates', 'ok', 'schemaVersion']);
    expect(payload.gates[0]).toMatchObject({
      id: 'source',
      status: 'pass',
      required: true,
      exitCode: 0,
    });
    expect(payload.gates[0]?.command).toContain('detect --strict');
    expect(payload.gates.find((item) => item.id === 'code.test')).toEqual({
      id: 'code.test',
      status: 'pass',
      required: true,
      command: logCommand('test'),
      exitCode: 0,
      durationMs: expect.any(Number),
    });
    expect(payload.gates.find((item) => item.id === 'code.typecheck')).toMatchObject({
      status: 'fail',
      required: true,
      exitCode: 1,
    });
    expect(payload.gates.find((item) => item.id === 'code.lint')).toMatchObject({
      status: 'warn',
      required: false,
      exitCode: 1,
    });
    expect(payload.gates.find((item) => item.id === 'docs')).toEqual({
      id: 'docs',
      status: 'skip',
      required: false,
      command: null,
      exitCode: null,
      durationMs: expect.any(Number),
    });
    for (const item of payload.gates) {
      expect(typeof item.durationMs).toBe('number');
      expect(item.status).toBe(item.status.toLowerCase());
    }
  });

  it('exits 2 for an unresolved advisory command as well', async () => {
    await install(config({
      test: { command: logCommand('test'), mode: 'required' },
      lint: { command: null, mode: 'advisory' },
    }));
    const dab = await fakeDab(0);

    const result = await runRunner([], { DAB_BIN: dab });

    expect(result.code).toBe(2);
    expect(result.stdout).toContain('GATE code.lint CONFIG');
    expect(await logLines()).toEqual(['source detect --strict', 'test']);
  });

  it('skips a required docs gate that has no command', async () => {
    await install(
      config(
        { test: { command: logCommand('test'), mode: 'required' } },
        { mode: 'required' },
      ),
    );
    const dab = await fakeDab(0);

    const result = await runRunner([], { DAB_BIN: dab });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('GATE docs SKIP');
    expect(await logLines()).toEqual(['source detect --strict', 'test']);
  });

  it('rejects unknown flags with exit 2', async () => {
    await install(config({ test: { command: logCommand('test'), mode: 'required' } }));
    const dab = await fakeDab(0);

    const result = await runRunner(['--bogus'], { DAB_BIN: dab });

    expect(result.code).toBe(2);
  });

  it('reports source ERROR and exit 2 when DAB cannot be resolved', async () => {
    await install(config({ test: { command: logCommand('test'), mode: 'required' } }));
    const emptyBin = join(root, 'empty-bin');
    await mkdir(emptyBin, { recursive: true });

    const result = await runRunner([], { DAB_BIN: '', PATH: emptyBin });

    expect(result.code).toBe(2);
    expect(result.stdout).toContain('GATE source ERROR');
  });
});
