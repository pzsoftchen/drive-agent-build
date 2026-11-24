import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { ConfigError } from '../core/errors.ts';
import { isPathInside } from '../core/paths.ts';

export type Scope = 'project' | 'global';

export interface SourceRoot {
  scope: Scope;
  root: string;
  sourceRoot: string;
  manifest: string;
  instructions: string;
}

export interface ScopeMarker {
  scope: Scope;
  root: string;
  sourceRoot: string;
  manifestPath: string;
  instructionsPath: string;
  hasManifest: boolean;
  hasAgents: boolean;
}

const MISSING_HINT = 'Run "dab init" in the project root or "dab init ~/.agents" for global scope.';
const GLOBAL_HINT = 'Run dab init ~/.agents for global scope.';
const NESTED_HINT = 'Run "dab init" from the repository root instead.';
const HOME_PROJECT_HINT = 'Remove or move $HOME/dab.yaml before running dab init ~/.agents.';

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isEnoent(error)) {
      return false;
    }
    throw error;
  }
}

interface CanonicalPath {
  real: string;
  exists: boolean;
}

async function canonical(path: string): Promise<CanonicalPath> {
  try {
    return { real: await realpath(path), exists: true };
  } catch (error) {
    if (isEnoent(error)) {
      return { real: resolve(path), exists: false };
    }
    throw error;
  }
}

async function canonicalNearest(path: string): Promise<string> {
  const absolute = resolve(path);
  let current = absolute;
  const missing: string[] = [];
  for (;;) {
    const info = await canonical(current);
    if (info.exists) {
      return missing.length === 0 ? info.real : join(info.real, ...missing);
    }
    const parent = dirname(current);
    if (parent === current) {
      return absolute;
    }
    missing.unshift(basename(current));
    current = parent;
  }
}

async function hasManifest(dir: string): Promise<boolean> {
  return exists(join(dir, 'dab.yaml'));
}

async function hasAgentsTree(dir: string): Promise<boolean> {
  return exists(join(dir, '.agents'));
}

async function findProjectRoot(cwd: string, home: string): Promise<string | null> {
  const homeInfo = await canonical(home);
  let candidate = cwd;
  for (;;) {
    const manifest = await hasManifest(candidate);
    if (manifest) {
      return candidate;
    }
    if (await hasAgentsTree(candidate)) {
      const candidateInfo = await canonical(candidate);
      // ~/.agents is the global source root, not a parent project.
      if (candidateInfo.real !== homeInfo.real) {
        return candidate;
      }
    }
    const parent = dirname(candidate);
    if (parent === candidate) {
      return null;
    }
    candidate = parent;
  }
}

async function findGitRoot(cwd: string): Promise<string> {
  let candidate = cwd;
  for (;;) {
    if (await exists(join(candidate, '.git'))) {
      return candidate;
    }
    const parent = dirname(candidate);
    if (parent === candidate) {
      return cwd;
    }
    candidate = parent;
  }
}

export async function resolveScopeMarker(
  options: { cwd: string; home: string },
): Promise<ScopeMarker> {
  const cwd = resolve(options.cwd);
  const home = resolve(options.home);
  const globalSource = join(home, '.agents');
  const globalInfo = await canonical(globalSource);
  if (globalInfo.exists) {
    const cwdInfo = await canonical(cwd);
    if (isPathInside(globalInfo.real, cwdInfo.real)) {
      return {
        scope: 'global',
        root: home,
        sourceRoot: globalSource,
        manifestPath: join(globalSource, 'dab.yaml'),
        instructionsPath: join(globalSource, 'AGENTS.md'),
        hasManifest: await hasManifest(globalSource),
        hasAgents: globalInfo.exists,
      };
    }
  }

  const found = await findProjectRoot(cwd, home);
  if (found !== null) {
    return {
      scope: 'project',
      root: found,
      sourceRoot: join(found, '.agents'),
      manifestPath: join(found, 'dab.yaml'),
      instructionsPath: join(found, 'AGENTS.md'),
      hasManifest: await hasManifest(found),
      hasAgents: await hasAgentsTree(found),
    };
  }

  // Uninitialized project: anchor on the nearest git root, or cwd when the
  // directory is not tracked by git. Neither marker exists on this path.
  const root = await findGitRoot(cwd);
  return {
    scope: 'project',
    root,
    sourceRoot: join(root, '.agents'),
    manifestPath: join(root, 'dab.yaml'),
    instructionsPath: join(root, 'AGENTS.md'),
    hasManifest: false,
    hasAgents: false,
  };
}

export async function resolveSourceRoot(
  options: { cwd: string; home: string },
): Promise<SourceRoot> {
  const cwd = resolve(options.cwd);
  const home = resolve(options.home);
  const globalSource = join(home, '.agents');
  const globalInfo = await canonical(globalSource);
  if (globalInfo.exists) {
    const cwdInfo = await canonical(cwd);
    if (isPathInside(globalInfo.real, cwdInfo.real)) {
      return {
        scope: 'global',
        root: home,
        sourceRoot: globalSource,
        manifest: join(globalSource, 'dab.yaml'),
        instructions: join(globalSource, 'AGENTS.md'),
      };
    }
  }

  const found = await findProjectRoot(cwd, home);
  if (found === null) {
    throw new ConfigError(
      `no dab.yaml or .agents directory found from ${cwd}`,
      'config.source-root-missing',
      { hint: MISSING_HINT },
    );
  }
  return {
    scope: 'project',
    root: found,
    sourceRoot: join(found, '.agents'),
    manifest: join(found, 'dab.yaml'),
    instructions: join(found, 'AGENTS.md'),
  };
}

export async function assertInitRoot(
  options: { root: string; home: string },
): Promise<Scope> {
  const root = resolve(options.root);
  const home = resolve(options.home);
  const homeCanonical = await canonicalNearest(home);
  const globalSource = join(home, '.agents');
  const globalInfo = await canonical(globalSource);
  const globalCanonical = await canonicalNearest(globalSource);
  // Resolve every existing prefix so a symlinked parent cannot hide an
  // enclosing source root from the ancestor walk below.
  const rootCanonical = await canonicalNearest(root);

  if (rootCanonical === globalCanonical) {
    if (await hasManifest(homeCanonical)) {
      throw new ConfigError(
        'refusing to initialize global scope while $HOME is a project root',
        'config.source-root-nested',
        { hint: HOME_PROJECT_HINT },
      );
    }
    return 'global';
  }
  if (globalInfo.exists && isPathInside(globalCanonical, rootCanonical)) {
    throw new ConfigError(
      `refusing to initialize inside the global source root: ${root}`,
      'config.source-root-nested',
      { hint: GLOBAL_HINT },
    );
  }

  if (globalInfo.exists && rootCanonical === homeCanonical) {
    throw new ConfigError(
      'refusing to initialize project scope at $HOME while ~/.agents is the global source root',
      'config.source-root-nested',
      { hint: GLOBAL_HINT },
    );
  }

  let candidate = dirname(rootCanonical);
  for (;;) {
    const manifest = await hasManifest(candidate);
    const agents = await hasAgentsTree(candidate);
    const isHome = await canonicalNearest(candidate) === homeCanonical;
    if (!(isHome && agents && !manifest) && (manifest || agents)) {
      throw new ConfigError(
        `refusing to initialize inside an existing source root: ${candidate}`,
        'config.source-root-nested',
        { hint: NESTED_HINT },
      );
    }
    const parent = dirname(candidate);
    if (parent === candidate) {
      break;
    }
    candidate = parent;
  }
  return 'project';
}
