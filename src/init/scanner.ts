import { readdir } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import type { Diagnostic } from '../core/diagnostics.ts';
import { lstatOrNull, readTextFile } from '../core/fs-atomic.ts';
import { toPosix } from '../core/paths.ts';

export type ProjectLanguage =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'generic';
export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun' | 'none';

export interface ScanCommandSet {
  test?: string;
  build?: string;
  lint?: string;
  typecheck?: string;
}

export interface ScanResult {
  projectName: string;
  projectId: string;
  language: ProjectLanguage;
  packageManager: PackageManager;
  commands: ScanCommandSet;
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

async function exists(path: string): Promise<boolean> {
  return (await lstatOrNull(path)) !== null;
}

async function readPackageJson(root: string): Promise<{
  value?: PackageJson;
  exists: boolean;
  diagnostics: Diagnostic[];
}> {
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

async function detectLanguage(
  root: string,
  hasPackageJson: boolean,
): Promise<ProjectLanguage> {
  if (await exists(join(root, 'tsconfig.json'))) {
    return 'typescript';
  }
  if (hasPackageJson) {
    return 'javascript';
  }
  if (
    await exists(join(root, 'pyproject.toml'))
    || await exists(join(root, 'setup.py'))
    || await exists(join(root, 'requirements.txt'))
  ) {
    return 'python';
  }
  if (await exists(join(root, 'go.mod'))) {
    return 'go';
  }
  if (await exists(join(root, 'Cargo.toml'))) {
    return 'rust';
  }
  return 'generic';
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
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
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
  const language = await detectLanguage(root, packageFile.exists);
  const sourceDirs = await detectSourceDirs(root);

  let commands: ScanCommandSet;
  switch (language) {
    case 'typescript':
    case 'javascript':
      commands = await nodeCommands(packageManager, packageFile.value);
      break;
    case 'python':
      commands = await pythonCommands(root);
      break;
    case 'go':
      commands = {
        test: 'go test ./...',
        build: 'go build ./...',
        lint: 'go vet ./...',
      };
      break;
    case 'rust':
      commands = {
        test: 'cargo test',
        build: 'cargo build',
        lint: 'cargo clippy -- -D warnings',
      };
      break;
    case 'generic':
      commands = {};
      break;
  }

  const projectName = packageFile.value?.name ?? basename(root);
  return {
    projectName,
    projectId: slugify(projectName),
    language,
    packageManager,
    commands,
    sourceDirs,
    hasAgentsMd: await exists(join(root, 'AGENTS.md')),
    hasClaudeSettings: await exists(join(root, '.claude/settings.json')),
    existingAgents: await existingAgentFiles(root),
    diagnostics: packageFile.diagnostics,
  };
}
