import { describe, expect, it } from 'vitest';
import {
  compileGateSnapshot,
  hashGateRunnerBody,
  normalizeGateCommand,
  parseGateRunnerMarker,
  parseGateSnapshot,
} from '../../src/core/gate-artifacts.ts';
import { sha256 } from '../../src/core/hash.ts';
import { renderGateRunner } from '../../src/init/gate-runner-template.ts';
import type { GateConfig } from '../../src/model/gates.ts';
import type { ScanResult } from '../../src/init/scanner.ts';

const VERSION = '0.1.2';

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

function config(
  commands: GateConfig['gates']['code']['commands'],
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

describe('compileGateSnapshot', () => {
  it('produces the same hash and content across config key order', () => {
    const first = config({
      lint: { command: 'pnpm lint', mode: 'advisory' },
      test: { command: 'pnpm test', mode: 'required' },
    });
    const second: GateConfig = {
      version: 1,
      gates: {
        code: {
          commands: {
            test: { command: 'pnpm test', mode: 'required' },
            lint: { command: 'pnpm lint', mode: 'advisory' },
          },
        },
        docs: { mode: 'check' },
        source: { mode: 'required' },
      },
    };

    const left = compileGateSnapshot(first, nodeScan(), VERSION);
    const right = compileGateSnapshot(second, nodeScan(), VERSION);

    expect(left.hash).toBe(right.hash);
    expect(left.content).toBe(right.content);
    expect(left.snapshot.generated.sha256).toBe(left.hash);
    expect(left.hash).toBe(sha256(JSON.stringify(left.snapshot.gates)));
    expect(Object.keys(left.snapshot.gates.code.commands)).toEqual(['test', 'lint']);
  });

  it('normalizes structured xcodebuild config into a single test command', () => {
    const result = compileGateSnapshot(
      config({
        test: {
          xcodebuild: {
            workspace: 'App.xcworkspace',
            scheme: 'App',
            destination: 'platform=iOS Simulator,name=iPhone 16',
            configuration: 'Release',
          },
          mode: 'required',
        },
      }),
      nodeScan(),
      VERSION,
    );

    expect(result.snapshot.gates.code.commands.test).toEqual({
      command:
        'xcodebuild test -workspace App.xcworkspace -scheme App '
        + '-destination "platform=iOS Simulator,name=iPhone 16" -configuration Release',
      mode: 'required',
    });
  });

  it('keeps command null and needs so the runner can report CONFIG', () => {
    const needs = 'Configure the Xcode scheme and destination in .agents/gates.yaml.';
    const result = compileGateSnapshot(
      config({ test: { command: null, mode: 'required', needs } }),
      nodeScan(),
      VERSION,
    );

    expect(result.snapshot.gates.code.commands.test).toEqual({
      command: null,
      mode: 'required',
      needs,
    });
    expect(result.content).toContain('"command": null');
    expect(result.content).toContain(needs);
  });

  it('treats the authored config as authoritative and never backfills scanner commands', () => {
    const result = compileGateSnapshot(
      config({ test: { command: 'custom test', mode: 'required' } }),
      nodeScan(),
      VERSION,
    );

    expect(Object.keys(result.snapshot.gates.code.commands)).toEqual(['test']);
    expect(result.content).not.toContain('pnpm typecheck');
    expect(result.content).not.toContain('pnpm lint');
  });

  it('changes only generated metadata when the DAB version changes', () => {
    const current = compileGateSnapshot(
      config({ test: { command: 'pnpm test', mode: 'required' } }),
      nodeScan(),
      '0.1.2',
    );
    const next = compileGateSnapshot(
      config({ test: { command: 'pnpm test', mode: 'required' } }),
      nodeScan(),
      '9.9.9',
    );

    expect(next.hash).toBe(current.hash);
    expect(next.snapshot.generated).toEqual({ dabVersion: '9.9.9', sha256: current.hash });
  });
});

describe('normalizeGateCommand', () => {
  it('uses Windows wrappers on win32', () => {
    expect(normalizeGateCommand('./gradlew test', 'win32')).toBe('gradlew.bat test');
    expect(normalizeGateCommand('./mvnw -DskipTests compile', 'win32'))
      .toBe('mvnw.cmd -DskipTests compile');
    expect(normalizeGateCommand('./gradlew', 'win32')).toBe('gradlew.bat');
  });

  it('leaves POSIX commands untouched', () => {
    expect(normalizeGateCommand('./gradlew test', 'darwin')).toBe('./gradlew test');
    expect(normalizeGateCommand('./mvnw test', 'linux')).toBe('./mvnw test');
  });

  it('only rewrites a leading wrapper token', () => {
    expect(normalizeGateCommand('echo ./gradlew test', 'win32'))
      .toBe('echo ./gradlew test');
    expect(normalizeGateCommand('./gradlew.bat test', 'win32'))
      .toBe('./gradlew.bat test');
  });
});

describe('parseGateSnapshot', () => {
  it('accepts a compiled snapshot', () => {
    const { content } = compileGateSnapshot(
      config({ test: { command: 'pnpm test', mode: 'required' } }),
      nodeScan(),
      VERSION,
    );

    const parsed = parseGateSnapshot(content);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.snapshot.gates.code.commands.test?.command).toBe('pnpm test');
      expect(parsed.snapshot.generated.dabVersion).toBe(VERSION);
    }
  });

  it('classifies invalid JSON as unversioned', () => {
    expect(parseGateSnapshot('{')).toMatchObject({ ok: false, kind: 'unversioned' });
    expect(parseGateSnapshot('[]')).toMatchObject({ ok: false, kind: 'unversioned' });
  });

  it('classifies a changed gates object as modified', () => {
    const { snapshot } = compileGateSnapshot(
      config({ test: { command: 'pnpm test', mode: 'required' } }),
      nodeScan(),
      VERSION,
    );
    snapshot.gates.code.commands.test = { command: 'pnpm test --watch', mode: 'required' };

    expect(parseGateSnapshot(JSON.stringify(snapshot))).toMatchObject({
      ok: false,
      kind: 'modified',
    });
  });
});

describe('gate runner marker', () => {
  it('records the version and a hash of the runner body', () => {
    const text = renderGateRunner(VERSION);
    const marker = parseGateRunnerMarker(text);

    expect(text.startsWith(`// dab-gate-runner: ${VERSION} sha256=`)).toBe(true);
    expect(marker?.version).toBe(VERSION);
    expect(marker?.sha256).toBe(hashGateRunnerBody(text));
  });

  it('keeps the body hash stable across DAB versions', () => {
    const older = renderGateRunner('0.0.1');
    const current = renderGateRunner('0.1.2');

    expect(hashGateRunnerBody(older)).toBe(hashGateRunnerBody(current));
    expect(older).not.toBe(current);
  });
});
