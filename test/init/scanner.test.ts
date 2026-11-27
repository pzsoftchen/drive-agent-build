import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scanProject } from '../../src/init/scanner.ts';
import { makeTempDir } from '../helpers/tmp.ts';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await makeTempDir('dab-scan-');
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('scanProject', () => {
  it('detects a TypeScript pnpm repo and its scripts', async () => {
    const root = await tempDir();
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'demo-app',
        scripts: {
          test: 'vitest run',
          build: 'tsc',
          lint: 'eslint .',
          typecheck: 'tsc --noEmit',
        },
      }),
    );
    await writeFile(join(root, 'pnpm-lock.yaml'), '');
    await writeFile(join(root, 'tsconfig.json'), '{}');
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src/index.ts'), 'export {};\n');

    const scan = await scanProject(root);

    expect(scan.language).toBe('typescript');
    expect(scan.packageManager).toBe('pnpm');
    expect(scan.projectName).toBe('demo-app');
    expect(scan.commands.test).toBe('pnpm test');
    expect(scan.commands.build).toBe('pnpm build');
    expect(scan.commands.lint).toBe('pnpm lint');
    expect(scan.commands.typecheck).toBe('pnpm typecheck');
    expect(scan.sourceDirs).toContain('src');
    expect(scan.hasAgentsMd).toBe(false);
    expect(scan.hasClaudeSettings).toBe(false);
    expect(scan.stacks).toHaveLength(1);
    expect(scan.stacks[0]).toMatchObject({
      id: 'node',
      language: 'typescript',
      commands: {
        test: 'pnpm test',
        build: 'pnpm build',
        lint: 'pnpm lint',
        typecheck: 'pnpm typecheck',
      },
    });
  });

  it('detects Python tools', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'pyproject.toml'), '[tool.pytest.ini_options]\n');
    await writeFile(join(root, 'ruff.toml'), '');

    const scan = await scanProject(root);

    expect(scan.language).toBe('python');
    expect(scan.commands.test).toBe('python -m pytest');
    expect(scan.commands.lint).toBe('ruff check .');
    expect(scan.packageManager).toBe('none');
    expect(scan.stacks[0]).toMatchObject({
      id: 'python',
      language: 'python',
      commands: { test: 'python -m pytest', lint: 'ruff check .' },
    });
  });

  it('detects Go and Rust standard commands', async () => {
    const goRoot = await tempDir();
    await writeFile(join(goRoot, 'go.mod'), 'module example.com/demo\n');
    const go = await scanProject(goRoot);
    expect(go.language).toBe('go');
    expect(go.commands).toMatchObject({
      test: 'go test ./...',
      build: 'go build ./...',
      lint: 'go vet ./...',
    });
    expect(go.stacks[0]).toMatchObject({
      id: 'go',
      language: 'go',
      commands: go.commands,
    });

    const rustRoot = await tempDir();
    await writeFile(join(rustRoot, 'Cargo.toml'), '[package]\nname = "demo"\n');
    const rust = await scanProject(rustRoot);
    expect(rust.language).toBe('rust');
    expect(rust.commands).toMatchObject({
      test: 'cargo test',
      build: 'cargo build',
      lint: 'cargo clippy -- -D warnings',
    });
    expect(rust.stacks[0]).toMatchObject({
      id: 'rust',
      language: 'rust',
      commands: rust.commands,
    });
  });

  it('falls back to generic when no ecosystem is detected', async () => {
    const root = await tempDir();
    const scan = await scanProject(root);
    expect(scan.language).toBe('generic');
    expect(scan.packageManager).toBe('none');
    expect(scan.commands.test).toBeUndefined();
    expect(scan.sourceDirs).toEqual([]);
    expect(scan.stacks).toEqual([]);
  });

  it('detects existing AGENTS.md, Claude settings and agent files', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'AGENTS.md'), '# Existing\n');
    await mkdir(join(root, '.claude'));
    await writeFile(join(root, '.claude/settings.json'), '{}\n');
    await mkdir(join(root, '.agents/agents'), { recursive: true });
    await writeFile(join(root, '.agents/agents/reviewer.md'), 'x\n');

    const scan = await scanProject(root);

    expect(scan.hasAgentsMd).toBe(true);
    expect(scan.hasClaudeSettings).toBe(true);
    expect(scan.existingAgents).toContain('.agents/agents/reviewer.md');
  });

  it('reports an invalid package.json without crashing', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'package.json'), '{not json');

    const scan = await scanProject(root);

    expect(scan.language).toBe('javascript');
    expect(scan.diagnostics.map((item) => item.code)).toContain('scan.package-json');
  });

  it('detects Maven with a wrapper and without a wrapper', async () => {
    const wrapped = await tempDir();
    await writeFile(join(wrapped, 'pom.xml'), '<project />\n');
    await writeFile(join(wrapped, 'mvnw'), '#!/bin/sh\n');

    const withWrapper = await scanProject(wrapped);

    expect(withWrapper.language).toBe('java');
    expect(withWrapper.stacks[0]).toMatchObject({
      id: 'java-maven',
      language: 'java',
      commands: {
        test: './mvnw test',
        build: './mvnw -DskipTests compile',
      },
    });
    expect(withWrapper.stacks[0]?.evidence).toContain('pom.xml');
    expect(withWrapper.stacks[0]?.evidence).toContain('mvnw');
    expect(withWrapper.commands.test).toBe('./mvnw test');
    expect(withWrapper.commands.build).toBe('./mvnw -DskipTests compile');

    const plain = await tempDir();
    await writeFile(join(plain, 'pom.xml'), '<project />\n');

    const withoutWrapper = await scanProject(plain);

    expect(withoutWrapper.stacks[0]).toMatchObject({
      id: 'java-maven',
      commands: {
        test: 'mvn test',
        build: 'mvn -DskipTests compile',
      },
    });
    expect(withoutWrapper.commands.test).toBe('mvn test');
  });

  it('detects Java Gradle and prefers its wrapper', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'build.gradle'), 'plugins { id "java" }\n');
    await writeFile(join(root, 'gradlew'), '#!/bin/sh\n');

    const scan = await scanProject(root);

    expect(scan.language).toBe('java');
    expect(scan.stacks[0]).toMatchObject({
      id: 'java-gradle',
      language: 'java',
      commands: {
        test: './gradlew test',
        build: './gradlew classes',
      },
    });
    expect(scan.stacks[0]?.evidence).toContain('build.gradle');
    expect(scan.stacks[0]?.evidence).toContain('gradlew');
    expect(scan.commands.test).toBe('./gradlew test');
  });

  it('detects Android before plain Java Gradle', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'settings.gradle.kts'), 'rootProject.name = "demo"\n');
    await writeFile(
      join(root, 'build.gradle.kts'),
      'plugins { id("com.android.application") }\n',
    );
    await writeFile(join(root, 'gradlew'), '#!/bin/sh\n');

    const scan = await scanProject(root);

    expect(scan.stacks[0]).toMatchObject({
      id: 'android',
      platform: 'android',
      commands: {
        test: './gradlew test',
        lint: './gradlew lint',
        build: './gradlew assembleDebug',
      },
    });
    expect(scan.stacks.filter((stack) => stack.id === 'java-gradle')).toEqual([]);
    expect(scan.commands.test).toBe('./gradlew test');
    expect(scan.commands.lint).toBe('./gradlew lint');
    expect(scan.commands.build).toBe('./gradlew assembleDebug');
  });

  it('detects Android from an app manifest without Gradle files', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'app/src/main'), { recursive: true });
    await writeFile(join(root, 'app/src/main/AndroidManifest.xml'), '<manifest />\n');

    const scan = await scanProject(root);

    expect(scan.stacks[0]).toMatchObject({
      id: 'android',
      platform: 'android',
      commands: {
        test: 'gradle test',
        lint: 'gradle lint',
        build: 'gradle assembleDebug',
      },
    });
    expect(scan.stacks[0]?.evidence).toContain('app/src/main/AndroidManifest.xml');
  });

  it('detects SwiftPM and Xcode evidence', async () => {
    const swiftpmRoot = await tempDir();
    await writeFile(join(swiftpmRoot, 'Package.swift'), '// swift-tools-version:6.0\n');
    await writeFile(join(swiftpmRoot, '.swiftlint.yml'), 'disabled_rules: []\n');

    const swiftpm = await scanProject(swiftpmRoot);

    expect(swiftpm.language).toBe('swift');
    expect(swiftpm.stacks[0]).toMatchObject({
      id: 'ios-swiftpm',
      language: 'swift',
      platform: 'ios',
      commands: {
        test: 'swift test',
        build: 'swift build',
        lint: 'swiftlint',
      },
    });
    expect(swiftpm.commands.test).toBe('swift test');
    expect(swiftpm.commands.lint).toBe('swiftlint');

    const xcodeRoot = await tempDir();
    await mkdir(join(xcodeRoot, 'App.xcodeproj'));

    const xcode = await scanProject(xcodeRoot);

    expect(xcode.language).toBe('swift');
    expect(xcode.stacks[0]).toMatchObject({
      id: 'ios-xcode',
      language: 'swift',
      platform: 'ios',
      commands: {},
    });
    expect(xcode.stacks[0]?.evidence).toContain('App.xcodeproj');
    expect(xcode.commands.test).toBeUndefined();
    expect(xcode.stacks[0]?.diagnostics.map((item) => item.code))
      .toContain('scan.ios-xcode-needs-config');
    expect(xcode.diagnostics.map((item) => item.code))
      .toContain('scan.ios-xcode-needs-config');
  });

  it('keeps SwiftPM as primary when Xcode evidence is also present', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'Package.swift'), '// swift-tools-version:6.0\n');
    await mkdir(join(root, 'App.xcodeproj'));

    const scan = await scanProject(root);

    expect(scan.stacks[0]?.id).toBe('ios-swiftpm');
    const xcode = scan.stacks.find((stack) => stack.id === 'ios-xcode');
    expect(xcode?.evidence).toContain('App.xcodeproj');
    expect(xcode?.commands).toEqual({});
    expect(scan.commands.test).toBe('swift test');
    expect(scan.stacks.filter((stack) => stack.commands.test === 'swift test')).toHaveLength(1);
  });

  it('reports Maven and Gradle ambiguity without choosing one', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'pom.xml'), '<project />\n');
    await writeFile(join(root, 'build.gradle'), 'plugins { id "java" }\n');

    const scan = await scanProject(root);

    expect(scan.language).toBe('java');
    expect(scan.stacks.map((stack) => stack.id)).toEqual(['java-maven', 'java-gradle']);
    expect(scan.commands).toEqual({});
    expect(scan.diagnostics.map((item) => item.code)).toContain('scan.multiple-java-builds');
    for (const stack of scan.stacks) {
      expect(stack.diagnostics.map((item) => item.code)).toContain('scan.multiple-java-builds');
      expect(stack.commands.test).toBeDefined();
    }
  });

  it('does not report Xcode needs-config without an Xcode project', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'Package.swift'), '// swift-tools-version:6.0\n');

    const scan = await scanProject(root);

    expect(scan.diagnostics.map((item) => item.code))
      .not.toContain('scan.ios-xcode-needs-config');
  });

  it('falls back to system Maven when only a Windows wrapper exists', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'pom.xml'), '<project />\n');
    await writeFile(join(root, 'mvnw.cmd'), '@echo off\r\n');

    const scan = await scanProject(root);

    expect(scan.stacks[0]).toMatchObject({
      id: 'java-maven',
      commands: {
        test: 'mvn test',
        build: 'mvn -DskipTests compile',
      },
    });
    expect(scan.stacks[0]?.evidence).toContain('mvnw.cmd');
  });

  it('falls back to system Gradle when only a Windows wrapper exists', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'build.gradle'), 'plugins { id "java" }\n');
    await writeFile(join(root, 'gradlew.bat'), '@echo off\r\n');

    const scan = await scanProject(root);

    expect(scan.stacks[0]).toMatchObject({
      id: 'java-gradle',
      commands: {
        test: 'gradle test',
        build: 'gradle classes',
      },
    });
    expect(scan.stacks[0]?.evidence).toContain('gradlew.bat');
  });
});
