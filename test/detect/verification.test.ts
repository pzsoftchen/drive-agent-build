import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  VERIFICATION_NON_STRICT_WARNING_CODES,
  inspectVerification,
  mapGateDiagnosticCode,
} from '../../src/detect/verification.ts';
import { lstatOrNull } from '../../src/core/fs-atomic.ts';
import { compileGateSnapshot } from '../../src/core/gate-artifacts.ts';
import { DAB_VERSION } from '../../src/core/version.ts';
import {
  GATE_CONFIG_PATH,
  GATE_RUNNER_PATH,
  GATE_SNAPSHOT_PATH,
  applyGateArtifacts,
  planGateArtifacts,
} from '../../src/init/gate-artifacts.ts';
import { renderGateRunner } from '../../src/init/gate-runner-template.ts';
import {
  MAVEN_GRADLE_NEEDS,
  XCODE_NEEDS,
} from '../../src/init/gate-templates.ts';
import type { ScanResult } from '../../src/init/scanner.ts';
import type { Diagnostic } from '../../src/core/diagnostics.ts';
import { makeTempDir, removeTempDir } from '../helpers/tmp.ts';

const VERSION = DAB_VERSION;
const CI_PATH = '.github/workflows/ci.yml';

let root: string;

beforeEach(async () => {
  root = await makeTempDir('dab-detect-verification-');
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

function ambiguousJavaScan(): ScanResult {
  const commands = { test: './mvnw test' };
  return {
    projectName: 'demo',
    projectId: 'demo',
    language: 'java',
    packageManager: 'none',
    commands: {},
    stacks: [
      {
        id: 'java-maven',
        language: 'java',
        commands,
        evidence: ['pom.xml'],
        diagnostics: [],
      },
      {
        id: 'java-gradle',
        language: 'java',
        commands: { test: './gradlew test' },
        evidence: ['build.gradle'],
        diagnostics: [],
      },
    ],
    sourceDirs: ['src/main/java'],
    hasAgentsMd: false,
    hasClaudeSettings: false,
    existingAgents: [],
    diagnostics: [],
  };
}

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

function bareConfig(commands: string): string {
  return `version: 1
gates:
  source:
    mode: required
  code:
    commands:
${commands}
  docs:
    mode: check
`;
}

const NODE_CONFIG = bareConfig(`      test:
        command: pnpm test
        mode: required
      typecheck:
        command: pnpm typecheck
        mode: required
      lint:
        command: pnpm lint
        mode: advisory
      build:
        command: pnpm build
        mode: advisory`);

const EMPTY_COMMANDS_CONFIG = `version: 1
gates:
  source:
    mode: required
  code:
    commands: {}
  docs:
    mode: check
`;

async function wireCi(path = CI_PATH): Promise<void> {
  await write(
    path,
    'gate:\n  script:\n    - node scripts/dab-check.mjs --strict\n',
  );
}

/** Create current gate artifacts; `config` defaults to the scanner starter. */
async function scaffold(scan: ScanResult, config?: string): Promise<void> {
  if (config !== undefined) {
    await write(GATE_CONFIG_PATH, config);
  }
  const planned = await planGateArtifacts({ root, scan, version: VERSION });
  expect(planned.diagnostics).toEqual([]);
  const applied = await applyGateArtifacts(root, planned, { dryRun: false });
  expect(applied.diagnostics).toEqual([]);
}

function inspect(scan: ScanResult) {
  return inspectVerification({ root, scan, version: VERSION });
}

function rows(
  result: Awaited<ReturnType<typeof inspect>>,
  label: string,
) {
  return result.entries.filter(
    (entry) => entry.group === 'Verification' && entry.label === label,
  );
}

function strictWouldFail(result: { diagnostics: Diagnostic[] }): boolean {
  return result.diagnostics.some(
    (item) => item.severity === 'error'
      || (item.severity === 'warning'
        && !VERIFICATION_NON_STRICT_WARNING_CODES.has(item.code)),
  );
}

function codes(result: { diagnostics: Diagnostic[] }): string[] {
  return result.diagnostics.map((item) => item.code);
}

describe('inspectVerification', () => {
  it('reports current config, runner, snapshot and commands as OK', async () => {
    await scaffold(nodeScan(), NODE_CONFIG);
    await wireCi();

    const result = await inspect(nodeScan());

    expect(result.diagnostics).toEqual([]);
    expect(rows(result, GATE_CONFIG_PATH)).toEqual([
      expect.objectContaining({ status: 'ok' }),
    ]);
    expect(rows(result, GATE_RUNNER_PATH)).toEqual([
      expect.objectContaining({ status: 'ok', detail: `version ${VERSION}` }),
    ]);
    expect(rows(result, GATE_SNAPSHOT_PATH)).toEqual([
      expect.objectContaining({ status: 'ok' }),
    ]);
    expect(rows(result, 'code.test')).toEqual([
      expect.objectContaining({ status: 'ok', detail: 'pnpm test' }),
    ]);
    expect(rows(result, 'CI')).toEqual([
      expect.objectContaining({ status: 'ok', detail: CI_PATH }),
    ]);
    expect(strictWouldFail(result)).toBe(false);
  });

  it('warns for missing config, runner and snapshot without writing', async () => {
    const result = await inspect(emptyScan());

    expect(codes(result)).toEqual(expect.arrayContaining([
      'verification.config-missing',
      'verification.runner-missing',
      'verification.snapshot-missing',
    ]));
    for (const code of [
      'verification.config-missing',
      'verification.runner-missing',
      'verification.snapshot-missing',
    ]) {
      expect(result.diagnostics.find((item) => item.code === code)).toMatchObject({
        severity: 'warning',
        hint: expect.stringContaining('dab normalize'),
      });
      expect(VERIFICATION_NON_STRICT_WARNING_CODES.has(code)).toBe(false);
    }
    expect(rows(result, GATE_CONFIG_PATH)).toEqual([
      expect.objectContaining({ status: 'missing', next: 'dab normalize' }),
    ]);
    expect(rows(result, GATE_RUNNER_PATH)).toEqual([
      expect.objectContaining({ status: 'missing', next: 'dab normalize' }),
    ]);
    expect(rows(result, GATE_SNAPSHOT_PATH)).toEqual([
      expect.objectContaining({ status: 'missing', next: 'dab normalize' }),
    ]);
    expect(strictWouldFail(result)).toBe(true);

    expect(await exists(GATE_CONFIG_PATH)).toBe(false);
    expect(await exists(GATE_RUNNER_PATH)).toBe(false);
    expect(await exists(GATE_SNAPSHOT_PATH)).toBe(false);
  });

  it('reports runner and snapshot states when only the config is missing', async () => {
    await scaffold(nodeScan(), NODE_CONFIG);
    await wireCi();
    await rm(join(root, GATE_CONFIG_PATH));

    const result = await inspect(nodeScan());

    expect(codes(result)).toEqual(['verification.config-missing']);
    expect(rows(result, GATE_CONFIG_PATH)).toEqual([
      expect.objectContaining({ status: 'missing', next: 'dab normalize' }),
    ]);
    expect(rows(result, GATE_RUNNER_PATH)[0]?.status).toBe('ok');
    expect(rows(result, GATE_SNAPSHOT_PATH)[0]?.status).toBe('ok');
    expect(await exists(GATE_CONFIG_PATH)).toBe(false);
  });

  it('warns for a stale unmodified runner and snapshot as strict failures', async () => {
    await scaffold(nodeScan(), NODE_CONFIG);
    await wireCi();
    await write(GATE_RUNNER_PATH, renderGateRunner('0.0.1'));

    const staleRunner = await inspect(nodeScan());

    expect(staleRunner.diagnostics).toContainEqual(expect.objectContaining({
      code: 'verification.runner-stale',
      severity: 'warning',
      file: GATE_RUNNER_PATH,
    }));
    expect(rows(staleRunner, GATE_RUNNER_PATH)).toEqual([
      expect.objectContaining({ status: 'warn', next: 'dab normalize' }),
    ]);
    expect(VERIFICATION_NON_STRICT_WARNING_CODES.has('verification.runner-stale')).toBe(false);
    expect(strictWouldFail(staleRunner)).toBe(true);

    await write(GATE_CONFIG_PATH, NODE_CONFIG.replace('mode: check', 'mode: advisory'));
    const staleSnapshot = await inspect(nodeScan());

    expect(staleSnapshot.diagnostics).toContainEqual(expect.objectContaining({
      code: 'verification.snapshot-stale',
      severity: 'warning',
      file: GATE_SNAPSHOT_PATH,
    }));
    expect(rows(staleSnapshot, GATE_SNAPSHOT_PATH)).toEqual([
      expect.objectContaining({ status: 'warn', next: 'dab normalize' }),
    ]);
    expect(VERIFICATION_NON_STRICT_WARNING_CODES.has('verification.snapshot-stale')).toBe(false);
    expect(strictWouldFail(staleSnapshot)).toBe(true);
  });

  it('keeps modified runner and snapshot warnings non-strict with no next action', async () => {
    await scaffold(nodeScan(), NODE_CONFIG);
    await wireCi();
    await write(GATE_RUNNER_PATH, `${await read(GATE_RUNNER_PATH)}// local edit\n`);
    const snapshot = JSON.parse(await read(GATE_SNAPSHOT_PATH)) as {
      gates: { code: { commands: { test: { mode: string } } } };
    };
    snapshot.gates.code.commands.test.mode = 'advisory';
    await write(GATE_SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);

    const result = await inspect(nodeScan());

    expect(codes(result)).toEqual(expect.arrayContaining([
      'verification.runner-modified',
      'verification.snapshot-modified',
    ]));
    for (const code of ['verification.runner-modified', 'verification.snapshot-modified']) {
      expect(result.diagnostics.find((item) => item.code === code)).toMatchObject({
        severity: 'warning',
      });
      expect(VERIFICATION_NON_STRICT_WARNING_CODES.has(code)).toBe(true);
    }
    expect(rows(result, GATE_RUNNER_PATH)).toEqual([
      expect.objectContaining({ status: 'warn' }),
    ]);
    expect(rows(result, GATE_SNAPSHOT_PATH)).toEqual([
      expect.objectContaining({ status: 'warn' }),
    ]);
    expect(rows(result, GATE_RUNNER_PATH)[0]?.next).toBeUndefined();
    expect(rows(result, GATE_SNAPSHOT_PATH)[0]?.next).toBeUndefined();
    expect(strictWouldFail(result)).toBe(false);
  });

  it('keeps unversioned runner and snapshot warnings non-strict', async () => {
    await scaffold(nodeScan(), NODE_CONFIG);
    await wireCi();
    await write(GATE_RUNNER_PATH, '// user runner\n');
    await write(GATE_SNAPSHOT_PATH, '{}\n');

    const result = await inspect(nodeScan());

    expect(codes(result)).toEqual(expect.arrayContaining([
      'verification.runner-unversioned',
      'verification.snapshot-unversioned',
    ]));
    for (const code of [
      'verification.runner-unversioned',
      'verification.snapshot-unversioned',
    ]) {
      expect(VERIFICATION_NON_STRICT_WARNING_CODES.has(code)).toBe(true);
    }
    expect(strictWouldFail(result)).toBe(false);
  });

  it('keeps newer runner and snapshot warnings non-strict', async () => {
    await scaffold(nodeScan(), NODE_CONFIG);
    await wireCi();
    await write(GATE_RUNNER_PATH, renderGateRunner('9.9.9'));
    await write(
      GATE_SNAPSHOT_PATH,
      compileGateSnapshot({
        version: 1,
        gates: {
          source: { mode: 'required' },
          code: { commands: { test: { command: 'pnpm test', mode: 'required' } } },
          docs: { mode: 'check' },
        },
      }, nodeScan(), '9.9.9').content,
    );

    const result = await inspect(nodeScan());

    expect(codes(result)).toEqual(expect.arrayContaining([
      'verification.runner-newer',
      'verification.snapshot-newer',
    ]));
    for (const code of ['verification.runner-newer', 'verification.snapshot-newer']) {
      expect(result.diagnostics.find((item) => item.code === code)).toMatchObject({
        severity: 'warning',
      });
      expect(VERIFICATION_NON_STRICT_WARNING_CODES.has(code)).toBe(true);
    }
    expect(strictWouldFail(result)).toBe(false);
  });

  it('warns and fails strict for Xcode needs-config commands', async () => {
    await scaffold(xcodeScan());
    await wireCi();

    const result = await inspect(xcodeScan());
    const needs = result.diagnostics.find(
      (item) => item.code === 'verification.command-needs-config',
    );

    expect(needs).toMatchObject({
      severity: 'warning',
      file: GATE_CONFIG_PATH,
    });
    expect(needs?.message).toContain(XCODE_NEEDS);
    expect(rows(result, 'code.test')).toEqual([
      expect.objectContaining({
        status: 'warn',
        detail: XCODE_NEEDS,
        next: 'edit .agents/gates.yaml',
      }),
    ]);
    expect(VERIFICATION_NON_STRICT_WARNING_CODES.has('verification.command-needs-config'))
      .toBe(false);
    expect(strictWouldFail(result)).toBe(true);
  });

  it('errors when detected commands are not wired into the config', async () => {
    await scaffold(nodeScan(), EMPTY_COMMANDS_CONFIG);
    await wireCi();

    const result = await inspect(nodeScan());

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'verification.command-missing',
      severity: 'error',
      file: GATE_CONFIG_PATH,
    }));
    expect(rows(result, 'code')).toEqual([
      expect.objectContaining({
        status: 'error',
        next: 'edit .agents/gates.yaml',
      }),
    ]);
    expect(strictWouldFail(result)).toBe(true);
  });

  it('warns needs-config for an empty config when the scanner needs configuration', async () => {
    await scaffold(xcodeScan(), EMPTY_COMMANDS_CONFIG);
    await wireCi();

    const xcode = await inspect(xcodeScan());
    const xcodeNeeds = xcode.diagnostics.find(
      (item) => item.code === 'verification.command-needs-config',
    );

    expect(xcodeNeeds).toMatchObject({
      severity: 'warning',
      file: GATE_CONFIG_PATH,
    });
    expect(xcodeNeeds?.message).toContain(XCODE_NEEDS);
    expect(rows(xcode, 'code.test')).toEqual([
      expect.objectContaining({
        status: 'warn',
        detail: XCODE_NEEDS,
        next: 'edit .agents/gates.yaml',
      }),
    ]);
    expect(VERIFICATION_NON_STRICT_WARNING_CODES.has('verification.command-needs-config'))
      .toBe(false);
    expect(strictWouldFail(xcode)).toBe(true);

    const ambiguous = await inspect(ambiguousJavaScan());
    const ambiguousNeeds = ambiguous.diagnostics.find(
      (item) => item.code === 'verification.command-needs-config',
    );

    expect(ambiguousNeeds?.message).toContain(MAVEN_GRADLE_NEEDS);
    expect(rows(ambiguous, 'code.test')).toEqual([
      expect.objectContaining({
        status: 'warn',
        detail: MAVEN_GRADLE_NEEDS,
        next: 'edit .agents/gates.yaml',
      }),
    ]);
    expect(strictWouldFail(ambiguous)).toBe(true);
  });

  it('errors for dropped scanner-required commands but honors mode off waivers', async () => {
    await scaffold(nodeScan(), bareConfig(`      lint:
        command: pnpm lint
        mode: advisory
      build:
        command: pnpm build
        mode: advisory`));
    await wireCi();

    const dropped = await inspect(nodeScan());
    const missing = dropped.diagnostics.filter(
      (item) => item.code === 'verification.command-missing',
    );

    expect(missing).toHaveLength(2);
    expect(missing[0]).toMatchObject({ severity: 'error', file: GATE_CONFIG_PATH });
    expect(missing[0]?.message).toContain('test');
    expect(missing[1]?.message).toContain('typecheck');
    expect(rows(dropped, 'code.test')).toEqual([
      expect.objectContaining({ status: 'error', next: 'edit .agents/gates.yaml' }),
    ]);
    expect(rows(dropped, 'code.typecheck')).toEqual([
      expect.objectContaining({ status: 'error', next: 'edit .agents/gates.yaml' }),
    ]);
    expect(strictWouldFail(dropped)).toBe(true);

    await write(GATE_CONFIG_PATH, bareConfig(`      test:
        command: null
        mode: off
      typecheck:
        command: pnpm typecheck
        mode: off`));
    await scaffold(nodeScan());
    const waived = await inspect(nodeScan());

    expect(codes(waived)).not.toContain('verification.command-missing');
    expect(codes(waived)).not.toContain('verification.command-needs-config');
    expect(rows(waived, 'code.test')).toEqual([
      expect.objectContaining({ status: 'ok' }),
    ]);
    expect(rows(waived, 'code.test')[0]?.detail).toContain('SKIP');
    expect(rows(waived, 'code.typecheck')[0]?.detail).toContain('SKIP');
    expect(strictWouldFail(waived)).toBe(false);
  });

  it('warns non-strict when no code commands exist or are detected', async () => {
    await scaffold(emptyScan(), EMPTY_COMMANDS_CONFIG);
    await wireCi();

    const result = await inspect(emptyScan());

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'verification.commands-empty',
      severity: 'warning',
      file: GATE_CONFIG_PATH,
    }));
    expect(rows(result, 'code')).toEqual([
      expect.objectContaining({ status: 'warn' }),
    ]);
    expect(VERIFICATION_NON_STRICT_WARNING_CODES.has('verification.commands-empty')).toBe(true);
    expect(strictWouldFail(result)).toBe(false);
  });

  it('warns for missing CI without failing strict and accepts non-GitHub CI', async () => {
    await scaffold(nodeScan(), NODE_CONFIG);

    const missing = await inspect(nodeScan());

    expect(codes(missing)).toContain('verification.ci-missing');
    expect(missing.diagnostics.find((item) => item.code === 'verification.ci-missing'))
      .toMatchObject({ severity: 'warning' });
    expect(rows(missing, 'CI')).toEqual([
      expect.objectContaining({ status: 'warn' }),
    ]);
    expect(rows(missing, 'CI')[0]?.next).toBeUndefined();
    expect(VERIFICATION_NON_STRICT_WARNING_CODES.has('verification.ci-missing')).toBe(true);
    expect(strictWouldFail(missing)).toBe(false);

    await wireCi('.gitlab-ci.yml');
    const wired = await inspect(nodeScan());

    expect(codes(wired)).not.toContain('verification.ci-missing');
    expect(rows(wired, 'CI')).toEqual([
      expect.objectContaining({ status: 'ok', detail: '.gitlab-ci.yml' }),
    ]);
  });

  it('keeps exactly one row per artifact path', async () => {
    await scaffold(nodeScan(), NODE_CONFIG);
    await wireCi();
    await write(GATE_RUNNER_PATH, `${await read(GATE_RUNNER_PATH)}// local edit\n`);

    const result = await inspect(nodeScan());
    const labels = result.entries
      .filter((entry) => entry.group === 'Verification')
      .map((entry) => entry.label);

    expect(labels.filter((label) => label === GATE_RUNNER_PATH)).toHaveLength(1);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('maps loader config codes into the Verification group instead of hiding them', async () => {
    expect(mapGateDiagnosticCode('gate.config-invalid'))
      .toBe('verification.config-invalid');
    expect(mapGateDiagnosticCode('gate.config-unreadable'))
      .toBe('verification.config-unreadable');
    expect(mapGateDiagnosticCode('gate.config-yaml'))
      .toBe('verification.config-yaml');
    expect(mapGateDiagnosticCode('verification.runner-modified'))
      .toBe('verification.runner-modified');

    await write(GATE_CONFIG_PATH, 'version: 2\nscope: project\n');
    const invalid = await inspect(emptyScan());

    expect(codes(invalid)).toContain('verification.config-invalid');
    expect(codes(invalid).some((code) => code.startsWith('gate.'))).toBe(false);
    expect(rows(invalid, GATE_CONFIG_PATH)).toEqual([
      expect.objectContaining({ status: 'error' }),
    ]);

    await write(GATE_CONFIG_PATH, 'version: [1\n');
    const broken = await inspect(emptyScan());

    expect(codes(broken)).toContain('verification.config-yaml');
    expect(strictWouldFail(broken)).toBe(true);
  });

  it('reports an artifact path conflict as an error', async () => {
    await mkdir(join(root, GATE_CONFIG_PATH), { recursive: true });

    const result = await inspect(emptyScan());

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'verification.artifact-path',
      severity: 'error',
      file: GATE_CONFIG_PATH,
    }));
    expect(rows(result, GATE_CONFIG_PATH)).toEqual([
      expect.objectContaining({ status: 'error' }),
    ]);
    expect(strictWouldFail(result)).toBe(true);
  });

  it('surfaces scanner diagnostics instead of hiding a corrupted package.json', async () => {
    const scan = nodeScan();
    scan.diagnostics = [{
      code: 'scan.package-json',
      severity: 'warning',
      message: 'package.json is not valid JSON',
      file: 'package.json',
    }];

    const result = await inspectVerification({ root, scan, version: VERSION });

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'scan.package-json',
      severity: 'warning',
      file: 'package.json',
    }));
  });
});
