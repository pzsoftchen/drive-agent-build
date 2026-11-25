import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { GateConfigSchema, type GateConfig } from '../../src/model/gates.ts';
import { renderGateStarter, selectGateStack } from '../../src/init/gate-templates.ts';
import { scanProject, type ScanResult } from '../../src/init/scanner.ts';
import { makeTempDir } from '../helpers/tmp.ts';

const dirs: string[] = [];

async function scanFixture(
  files: Record<string, string> = {},
  directories: string[] = [],
): Promise<ScanResult> {
  const root = await makeTempDir('dab-gate-template-');
  dirs.push(root);
  for (const directory of directories) {
    await mkdir(join(root, directory), { recursive: true });
  }
  for (const [file, content] of Object.entries(files)) {
    const path = join(root, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  return scanProject(root);
}

function nodeFixture(): Promise<ScanResult> {
  return scanFixture({
    'package.json': JSON.stringify({
      name: 'node-app',
      scripts: {
        test: 'vitest run',
        typecheck: 'tsc --noEmit',
        lint: 'eslint .',
        build: 'tsc',
      },
    }),
    'pnpm-lock.yaml': '',
    'tsconfig.json': '{}',
  });
}

function androidFixture(): Promise<ScanResult> {
  return scanFixture({
    'settings.gradle.kts': 'rootProject.name = "demo"\n',
    'build.gradle.kts': 'plugins { id("com.android.application") }\n',
    'gradlew': '#!/bin/sh\n',
  });
}

function xcodeFixture(): Promise<ScanResult> {
  return scanFixture({}, ['App.xcodeproj']);
}

function swiftpmWithXcodeFixture(): Promise<ScanResult> {
  return scanFixture(
    {
      'Package.swift': '// swift-tools-version:6.0\n',
      '.swiftlint.yml': 'disabled_rules: []\n',
    },
    ['App.xcodeproj'],
  );
}

function legacyNodeWithMavenFixture(): Promise<ScanResult> {
  return scanFixture({
    'package.json': JSON.stringify({
      name: 'mixed-app',
      scripts: { test: 'vitest run' },
    }),
    'pnpm-lock.yaml': '',
    'pom.xml': '<project />\n',
  });
}

function mavenGradleFixture(): Promise<ScanResult> {
  return scanFixture({
    'pom.xml': '<project />\n',
    'build.gradle': 'plugins { id "java" }\n',
  });
}

function goFixture(): Promise<ScanResult> {
  return scanFixture({ 'go.mod': 'module example.com/demo\n' });
}

function emptyFixture(): Promise<ScanResult> {
  return scanFixture();
}

function parseStarter(starter: string): GateConfig {
  return GateConfigSchema.parse(parse(starter));
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('selectGateStack', () => {
  it('prefers a new stack over legacy primary commands', async () => {
    const scan = await legacyNodeWithMavenFixture();

    expect(scan.language).toBe('javascript');
    expect(scan.commands.test).toBe('pnpm test');
    expect(selectGateStack(scan)).toMatchObject({
      kind: 'commands',
      stackId: 'java-maven',
      commands: { test: 'mvn test' },
    });
  });

  it('keeps SwiftPM commands when Xcode evidence also exists', async () => {
    const scan = await swiftpmWithXcodeFixture();

    expect(selectGateStack(scan)).toMatchObject({
      kind: 'commands',
      stackId: 'ios-swiftpm',
      commands: { test: 'swift test' },
    });
  });

  it('returns needs-config for Xcode without SwiftPM', async () => {
    const scan = await xcodeFixture();
    const selection = selectGateStack(scan);

    expect(selection.kind).toBe('needs-config');
    expect(selection.stackId).toBe('ios-xcode');
    if (selection.kind === 'needs-config') {
      expect(selection.needs).toContain('scheme');
      expect(selection.needs).toContain('destination');
      expect(selection.needs).toContain('Fastlane');
    }
  });

  it('returns needs-config instead of choosing between Maven and Gradle', async () => {
    const scan = await mavenGradleFixture();
    const selection = selectGateStack(scan);

    expect(selection.kind).toBe('needs-config');
    expect(selection.stackId).toBeUndefined();
    if (selection.kind === 'needs-config') {
      expect(selection.needs).toContain('Resolve Maven/Gradle ambiguity');
    }
  });

  it('falls back to legacy commands when no new stack is detected', async () => {
    const scan = await goFixture();

    expect(selectGateStack(scan)).toMatchObject({
      kind: 'commands',
      stackId: 'go',
      commands: { test: 'go test ./...' },
    });
  });
});

describe('renderGateStarter', () => {
  it('marks Node test and typecheck required, lint and build advisory', async () => {
    const config = parseStarter(renderGateStarter(await nodeFixture()));
    const commands = config.gates.code.commands;

    expect(commands.test).toEqual({ command: 'pnpm test', mode: 'required' });
    expect(commands.typecheck).toEqual({ command: 'pnpm typecheck', mode: 'required' });
    expect(commands.lint).toEqual({ command: 'pnpm lint', mode: 'advisory' });
    expect(commands.build).toEqual({ command: 'pnpm build', mode: 'advisory' });
    expect(config.gates.source).toEqual({ mode: 'required' });
    expect(config.gates.docs).toEqual({ mode: 'check' });
  });

  it('uses Android Gradle commands with advisory lint', async () => {
    const scan = await androidFixture();
    const config = parseStarter(renderGateStarter(scan));
    const commands = config.gates.code.commands;

    expect(scan.stacks.map((stack) => stack.id)).toEqual(['android']);
    expect(commands.test).toEqual({ command: './gradlew test', mode: 'required' });
    expect(commands.lint).toEqual({ command: './gradlew lint', mode: 'advisory' });
    expect(commands.build).toEqual({
      command: './gradlew assembleDebug',
      mode: 'advisory',
    });
    expect(commands.typecheck).toBeUndefined();
  });

  it('emits a required Xcode test with command null and needs', async () => {
    const starter = renderGateStarter(await xcodeFixture());
    const config = parseStarter(starter);
    const commands = config.gates.code.commands;

    expect(starter).toContain('command: null');
    expect(starter).toContain('needs:');
    expect(commands.test?.command).toBeNull();
    expect(commands.test?.mode).toBe('required');
    expect(commands.test?.needs).toContain('scheme');
    expect(commands.test?.needs).toContain('destination');
    expect(commands.test?.needs).toContain('Fastlane');
    expect(Object.keys(commands)).toEqual(['test']);
  });

  it('uses SwiftPM commands when Xcode evidence also exists', async () => {
    const starter = renderGateStarter(await swiftpmWithXcodeFixture());
    const config = parseStarter(starter);
    const commands = config.gates.code.commands;

    expect(commands.test).toEqual({ command: 'swift test', mode: 'required' });
    expect(commands.lint).toEqual({ command: 'swiftlint', mode: 'advisory' });
    expect(commands.build).toEqual({ command: 'swift build', mode: 'advisory' });
    expect(starter).not.toContain('command: null');
    expect(starter).not.toContain('xcodebuild');
  });

  it('prefers Maven over legacy Node commands in a mixed repository', async () => {
    const scan = await legacyNodeWithMavenFixture();
    const starter = renderGateStarter(scan);
    const commands = parseStarter(starter).gates.code.commands;

    expect(commands.test).toEqual({ command: 'mvn test', mode: 'required' });
    expect(commands.build).toEqual({
      command: 'mvn -DskipTests compile',
      mode: 'advisory',
    });
    expect(starter).not.toContain('pnpm test');
  });

  it('does not choose between Maven and Gradle', async () => {
    const config = parseStarter(renderGateStarter(await mavenGradleFixture()));
    const commands = config.gates.code.commands;

    expect(commands.test?.command).toBeNull();
    expect(commands.test?.mode).toBe('required');
    expect(commands.test?.needs).toContain('Resolve Maven/Gradle ambiguity');
    expect(Object.keys(commands)).toEqual(['test']);
  });

  it('keeps legacy primary commands when no new stack is detected', async () => {
    const config = parseStarter(renderGateStarter(await goFixture()));
    const commands = config.gates.code.commands;

    expect(commands.test).toEqual({ command: 'go test ./...', mode: 'required' });
    expect(commands.lint).toEqual({ command: 'go vet ./...', mode: 'advisory' });
    expect(commands.build).toEqual({ command: 'go build ./...', mode: 'advisory' });
  });

  it('emits no fake commands for an empty project', async () => {
    const starter = renderGateStarter(await emptyFixture());
    const config = parseStarter(starter);

    expect(config.gates.code.commands).toEqual({});
    expect(starter).toContain('commands: {}');
  });

  it('emits commands in a stable order', async () => {
    const scan = await nodeFixture();

    expect(Object.keys(parseStarter(renderGateStarter(scan)).gates.code.commands))
      .toEqual(['test', 'typecheck', 'lint', 'build']);
    expect(renderGateStarter(scan)).toBe(renderGateStarter(scan));
  });

  it('produces YAML accepted by GateConfigSchema for every detected stack', async () => {
    const scans = [
      await nodeFixture(),
      await androidFixture(),
      await xcodeFixture(),
      await swiftpmWithXcodeFixture(),
      await legacyNodeWithMavenFixture(),
      await mavenGradleFixture(),
      await goFixture(),
      await emptyFixture(),
    ];

    for (const scan of scans) {
      const starter = renderGateStarter(scan);
      expect(() => GateConfigSchema.parse(parse(starter))).not.toThrow();
    }
  });
});
