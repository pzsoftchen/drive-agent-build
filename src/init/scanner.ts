import { readdir } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import {
  dedupeDiagnostics,
  type Diagnostic,
} from '../core/diagnostics.ts';
import { lstatOrNull, readTextFile } from '../core/fs-atomic.ts';
import { toPosix } from '../core/paths.ts';
import { pathProblemFrom } from '../core/practice-paths.ts';

export type ProjectLanguage =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'kotlin'
  | 'swift'
  | 'objective-c'
  | 'generic';
export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun' | 'none';

export type ScanStackId =
  | 'node'
  | 'python'
  | 'go'
  | 'rust'
  | 'java-maven'
  | 'java-gradle'
  | 'android'
  | 'ios-swiftpm'
  | 'ios-xcode';

export interface ScanCommandSet {
  test?: string;
  build?: string;
  lint?: string;
  typecheck?: string;
}

export interface ScanStack {
  id: ScanStackId;
  language: ProjectLanguage;
  platform?: 'android' | 'ios';
  commands: ScanCommandSet;
  evidence: string[];
  diagnostics: Diagnostic[];
}

export interface ScanResult {
  projectName: string;
  projectId: string;
  language: ProjectLanguage;
  packageManager: PackageManager;
  commands: ScanCommandSet;
  stacks: ScanStack[];
  sourceDirs: string[];
  hasAgentsMd: boolean;
  hasClaudeSettings: boolean;
  existingAgents: string[];
  diagnostics: Diagnostic[];
}

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
}

interface PackageFile {
  value?: PackageJson;
  exists: boolean;
  diagnostics: Diagnostic[];
}

async function exists(path: string): Promise<boolean> {
  return (await lstatOrNull(path)) !== null;
}

async function firstExisting(
  root: string,
  names: readonly string[],
): Promise<string | undefined> {
  for (const name of names) {
    if (await exists(join(root, name))) {
      return name;
    }
  }
  return undefined;
}

async function readPackageJson(root: string): Promise<PackageFile> {
  const path = join(root, 'package.json');
  if (!(await exists(path))) {
    return { exists: false, diagnostics: [] };
  }
  try {
    const value = JSON.parse(await readTextFile(path)) as PackageJson;
    return { value, exists: true, diagnostics: [] };
  } catch {
    return {
      exists: true,
      diagnostics: [{
        code: 'scan.package-json',
        severity: 'warning',
        message: 'package.json is not valid JSON',
        file: 'package.json',
        hint: 'DAB continued with conservative defaults.',
      }],
    };
  }
}

async function detectPackageManager(root: string, hasPackageJson: boolean): Promise<PackageManager> {
  for (const [file, manager] of [
    ['pnpm-lock.yaml', 'pnpm'],
    ['package-lock.json', 'npm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
  ] as const) {
    if (await exists(join(root, file))) {
      return manager;
    }
  }
  return hasPackageJson ? 'npm' : 'none';
}

const LOCKFILE_NAMES = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
] as const;
const PYTHON_EVIDENCE = ['pyproject.toml', 'setup.py', 'requirements.txt'] as const;
const GRADLE_FILES = [
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
] as const;
const ANDROID_MANIFEST = 'app/src/main/AndroidManifest.xml';
const ANDROID_PLUGIN = /com\.android\.(?:application|library)/;
const KOTLIN_PLUGIN = /(?:org\.jetbrains\.kotlin\.android|org\.jetbrains\.kotlin\.jvm|kotlin\("android"\))/;
const JAVA_BUILD_IDS: ReadonlySet<ScanStackId> = new Set([
  'java-maven',
  'java-gradle',
  'android',
]);

function mavenCommands(runner: string): ScanCommandSet {
  return {
    test: `${runner} test`,
    build: `${runner} -DskipTests compile`,
  };
}

function gradleCommands(runner: string): ScanCommandSet {
  return {
    test: `${runner} test`,
    build: `${runner} classes`,
  };
}

function androidCommands(runner: string): ScanCommandSet {
  return {
    test: `${runner} test`,
    lint: `${runner} lint`,
    build: `${runner} assembleDebug`,
  };
}

async function swiftPackageCommands(root: string): Promise<ScanCommandSet> {
  return {
    test: 'swift test',
    build: 'swift build',
    ...(await exists(join(root, '.swiftlint.yml')) ? { lint: 'swiftlint' } : {}),
  };
}

interface GradleFacts {
  files: string[];
  isAndroid: boolean;
  hasManifest: boolean;
  content: string;
  wrapper?: string;
}

async function gradleFacts(root: string): Promise<GradleFacts> {
  const files: string[] = [];
  let content = '';
  let isAndroid = false;
  for (const name of GRADLE_FILES) {
    const path = join(root, name);
    if (!(await exists(path))) {
      continue;
    }
    const text = await readTextFile(path);
    files.push(name);
    content += text;
    isAndroid ||= ANDROID_PLUGIN.test(text);
  }
  const hasManifest = await exists(join(root, ANDROID_MANIFEST));
  return {
    files,
    isAndroid: isAndroid || hasManifest,
    hasManifest,
    content,
    wrapper: await firstExisting(root, ['gradlew', 'gradlew.bat']),
  };
}

async function androidLanguage(root: string, gradleContent: string): Promise<ProjectLanguage> {
  if (KOTLIN_PLUGIN.test(gradleContent)) {
    return 'kotlin';
  }
  for (const dir of ['app/src/main/kotlin', 'src/main/kotlin']) {
    const info = await lstatOrNull(join(root, dir));
    if (info?.isDirectory() === true) {
      return 'kotlin';
    }
  }
  return 'java';
}

async function xcodeEvidence(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const evidence = entries
    .map((entry) => entry.name)
    .filter((name) => name.endsWith('.xcodeproj') || name.endsWith('.xcworkspace'))
    .sort();
  for (const name of ['Podfile', 'Cartfile']) {
    if (await exists(join(root, name))) {
      evidence.push(name);
    }
  }
  return evidence;
}

function isXcodeProject(name: string): boolean {
  return name.endsWith('.xcodeproj') || name.endsWith('.xcworkspace');
}

async function nodeStack(
  root: string,
  packageManager: PackageManager,
  packageFile: PackageFile,
): Promise<ScanStack | undefined> {
  const hasTsconfig = await exists(join(root, 'tsconfig.json'));
  if (!packageFile.exists && !hasTsconfig) {
    return undefined;
  }
  const evidence: string[] = [];
  if (packageFile.exists) {
    evidence.push('package.json');
  }
  if (hasTsconfig) {
    evidence.push('tsconfig.json');
  }
  for (const lockfile of LOCKFILE_NAMES) {
    if (await exists(join(root, lockfile))) {
      evidence.push(lockfile);
    }
  }
  return {
    id: 'node',
    language: hasTsconfig ? 'typescript' : 'javascript',
    commands: await nodeCommands(packageManager, packageFile.value),
    evidence,
    diagnostics: [],
  };
}

async function pythonStack(root: string): Promise<ScanStack | undefined> {
  const evidence: string[] = [];
  for (const name of PYTHON_EVIDENCE) {
    if (await exists(join(root, name))) {
      evidence.push(name);
    }
  }
  if (evidence.length === 0) {
    return undefined;
  }
  return {
    id: 'python',
    language: 'python',
    commands: await pythonCommands(root),
    evidence,
    diagnostics: [],
  };
}

async function mavenStack(root: string): Promise<ScanStack | undefined> {
  if (!(await exists(join(root, 'pom.xml')))) {
    return undefined;
  }
  const wrapper = await firstExisting(root, ['mvnw', 'mvnw.cmd']);
  const runner = wrapper === 'mvnw' ? './mvnw' : 'mvn';
  return {
    id: 'java-maven',
    language: 'java',
    commands: mavenCommands(runner),
    evidence: ['pom.xml', ...(wrapper === undefined ? [] : [wrapper])],
    diagnostics: [],
  };
}

async function gradleStack(
  root: string,
  facts: GradleFacts,
): Promise<ScanStack | undefined> {
  if (facts.isAndroid) {
    const evidence = [
      ...facts.files,
      ...(facts.hasManifest ? [ANDROID_MANIFEST] : []),
      ...(facts.wrapper === undefined ? [] : [facts.wrapper]),
    ];
    const runner = facts.wrapper === 'gradlew' ? './gradlew' : 'gradle';
    return {
      id: 'android',
      language: await androidLanguage(root, facts.content),
      platform: 'android',
      commands: androidCommands(runner),
      evidence,
      diagnostics: [],
    };
  }
  if (facts.files.length === 0) {
    return undefined;
  }
  const runner = facts.wrapper === 'gradlew' ? './gradlew' : 'gradle';
  return {
    id: 'java-gradle',
    language: 'java',
    commands: gradleCommands(runner),
    evidence: [...facts.files, ...(facts.wrapper === undefined ? [] : [facts.wrapper])],
    diagnostics: [],
  };
}

async function swiftPackageStack(root: string): Promise<ScanStack | undefined> {
  if (!(await exists(join(root, 'Package.swift')))) {
    return undefined;
  }
  return {
    id: 'ios-swiftpm',
    language: 'swift',
    platform: 'ios',
    commands: await swiftPackageCommands(root),
    evidence: [
      'Package.swift',
      ...(await exists(join(root, '.swiftlint.yml')) ? ['.swiftlint.yml'] : []),
    ],
    diagnostics: [],
  };
}

async function xcodeStack(root: string): Promise<ScanStack | undefined> {
  const evidence = await xcodeEvidence(root);
  const project = evidence.find(isXcodeProject);
  if (project === undefined) {
    return undefined;
  }
  return {
    id: 'ios-xcode',
    language: 'swift',
    platform: 'ios',
    commands: {},
    evidence,
    diagnostics: [{
      code: 'scan.ios-xcode-needs-config',
      severity: 'warning',
      message: 'Xcode project needs a scheme and destination before gates can run',
      file: project,
      hint: 'Configure xcodebuild scheme/destination in .agents/gates.yaml.',
    }],
  };
}

function markJavaBuildAmbiguity(stacks: readonly ScanStack[]): Diagnostic | undefined {
  const ids = new Set(stacks.map((stack) => stack.id));
  const hasMaven = ids.has('java-maven');
  const hasGradle = ids.has('java-gradle') || ids.has('android');
  if (!hasMaven || !hasGradle) {
    return undefined;
  }
  const diagnostic: Diagnostic = {
    code: 'scan.multiple-java-builds',
    severity: 'warning',
    message: 'Maven and Gradle build files both describe this Java project',
    hint: 'Keep one build system or override code commands in .agents/gates.yaml.',
  };
  for (const stack of stacks) {
    if (JAVA_BUILD_IDS.has(stack.id)) {
      stack.diagnostics.push(diagnostic);
    }
  }
  return diagnostic;
}

/**
 * Detect stacks in primary-precedence order. Existing Node/Python/Go/Rust
 * detection stays first so `ScanResult.language`/`commands` keep their
 * historical values; Java/Android and iOS stacks follow. The first stack is
 * the primary stack.
 */
async function detectStacks(
  root: string,
  packageFile: PackageFile,
  packageManager: PackageManager,
): Promise<ScanStack[]> {
  const stacks: ScanStack[] = [];
  const node = await nodeStack(root, packageManager, packageFile);
  if (node !== undefined) {
    stacks.push(node);
  }
  const python = await pythonStack(root);
  if (python !== undefined) {
    stacks.push(python);
  }
  if (await exists(join(root, 'go.mod'))) {
    stacks.push({
      id: 'go',
      language: 'go',
      commands: {
        test: 'go test ./...',
        build: 'go build ./...',
        lint: 'go vet ./...',
      },
      evidence: ['go.mod'],
      diagnostics: [],
    });
  }
  if (await exists(join(root, 'Cargo.toml'))) {
    stacks.push({
      id: 'rust',
      language: 'rust',
      commands: {
        test: 'cargo test',
        build: 'cargo build',
        lint: 'cargo clippy -- -D warnings',
      },
      evidence: ['Cargo.toml'],
      diagnostics: [],
    });
  }
  const maven = await mavenStack(root);
  if (maven !== undefined) {
    stacks.push(maven);
  }
  const gradle = await gradleStack(root, await gradleFacts(root));
  if (gradle !== undefined) {
    stacks.push(gradle);
  }
  const swiftPackage = await swiftPackageStack(root);
  if (swiftPackage !== undefined) {
    stacks.push(swiftPackage);
  }
  const xcode = await xcodeStack(root);
  if (xcode !== undefined) {
    stacks.push(xcode);
  }
  return stacks;
}

async function detectSourceDirs(root: string): Promise<string[]> {
  const dirs: string[] = [];
  for (const name of ['src', 'app', 'lib', 'packages', 'test', 'tests']) {
    const info = await lstatOrNull(join(root, name));
    if (info?.isDirectory() === true) {
      dirs.push(name);
    }
  }
  return dirs;
}

function scriptCommand(manager: PackageManager, script: string): string | undefined {
  switch (manager) {
    case 'pnpm':
      return `pnpm ${script}`;
    case 'npm':
      return script === 'test' ? 'npm test' : `npm run ${script}`;
    case 'yarn':
      return `yarn ${script}`;
    case 'bun':
      return `bun run ${script}`;
    case 'none':
      return undefined;
  }
}

async function nodeCommands(
  manager: PackageManager,
  packageJson: PackageJson | undefined,
): Promise<ScanCommandSet> {
  const scripts = packageJson?.scripts ?? {};
  return {
    ...(scripts.test === undefined ? {} : { test: scriptCommand(manager, 'test') }),
    ...(scripts.build === undefined ? {} : { build: scriptCommand(manager, 'build') }),
    ...(scripts.lint === undefined ? {} : { lint: scriptCommand(manager, 'lint') }),
    ...(scripts.typecheck === undefined ? {} : { typecheck: scriptCommand(manager, 'typecheck') }),
  };
}

async function pythonCommands(root: string): Promise<ScanCommandSet> {
  let pyproject = '';
  const pyprojectPath = join(root, 'pyproject.toml');
  if (await exists(pyprojectPath)) {
    pyproject = await readTextFile(pyprojectPath);
  }
  const hasPytest = pyproject.includes('[tool.pytest')
    || await exists(join(root, 'pytest.ini'))
    || await exists(join(root, 'conftest.py'));
  const hasRuff = pyproject.includes('[tool.ruff') || await exists(join(root, 'ruff.toml'));
  const hasMypy = pyproject.includes('[tool.mypy') || await exists(join(root, 'mypy.ini'));
  return {
    ...(hasPytest ? { test: 'python -m pytest' } : {}),
    ...(hasRuff ? { lint: 'ruff check .' } : {}),
    ...(hasMypy ? { typecheck: 'mypy .' } : {}),
  };
}

async function existingAgentFiles(root: string): Promise<string[]> {
  const dir = join(root, '.agents/agents');
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    // A regular file at `.agents/agents` raises ENOTDIR instead of ENOENT. The
    // command source-parent probe reports that layout as `path.conflict`, so
    // the scan itself stays empty instead of failing with an internal error.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    if (pathProblemFrom(error) !== undefined) {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => toPosix(relative(root, join(dir, entry.name))))
    .sort();
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length === 0 ? 'project' : slug;
}

export async function scanProject(root: string): Promise<ScanResult> {
  const packageFile = await readPackageJson(root);
  const packageManager = await detectPackageManager(root, packageFile.exists);
  const sourceDirs = await detectSourceDirs(root);
  const stacks = await detectStacks(root, packageFile, packageManager);
  const ambiguity = markJavaBuildAmbiguity(stacks);
  const primary = stacks[0];
  const language: ProjectLanguage = primary?.language ?? 'generic';
  const commands: ScanCommandSet = primary === undefined
    ? {}
    : ambiguity !== undefined && JAVA_BUILD_IDS.has(primary.id)
      ? {}
      : primary.commands;

  const projectName = packageFile.value?.name ?? basename(root);
  return {
    projectName,
    projectId: slugify(projectName),
    language,
    packageManager,
    commands,
    stacks,
    sourceDirs,
    hasAgentsMd: await exists(join(root, 'AGENTS.md')),
    hasClaudeSettings: await exists(join(root, '.claude/settings.json')),
    existingAgents: await existingAgentFiles(root),
    diagnostics: dedupeDiagnostics([
      ...packageFile.diagnostics,
      ...stacks.flatMap((stack) => stack.diagnostics),
    ]),
  };
}
