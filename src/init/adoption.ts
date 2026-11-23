import { open, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ConfigError } from '../core/errors.ts';
import { ensureDir, lstatOrNull } from '../core/fs-atomic.ts';
import { MIN_CLAUDE_CODE_VERSION } from '../core/version-check.ts';
import { loadProjectManifest } from '../model/project-manifest.ts';
import { ProjectManifestSchema } from '../model/schemas.ts';
import { resolveScopeMarker, type Scope } from '../model/scope.ts';
import type { ProjectManifest } from '../model/types.ts';
import type { ScanResult } from './scanner.ts';
import {
  renderAgentsMd,
  renderClaudeCodePolicy,
  renderDabYaml,
  renderMemoryIndex,
  renderProjectPolicy,
} from './templates.ts';

export type AdoptionPhase = 'initialized' | 'partial' | 'uninitialized';

export interface AdoptionRoot {
  scope: Scope;
  root: string;
  sourceRoot: string;
  manifestPath: string;
  instructionsPath: string;
  phase: AdoptionPhase;
  manifestValid: boolean;
}

async function isManifestValid(marker: {
  root: string;
  scope: Scope;
  hasManifest: boolean;
}): Promise<boolean> {
  if (!marker.hasManifest) {
    return false;
  }
  try {
    await loadProjectManifest(marker.root, { scope: marker.scope });
    return true;
  } catch (error) {
    // An authored manifest that cannot be parsed stays in place; callers see
    // manifestValid=false and must not overwrite it.
    if (error instanceof ConfigError) {
      return false;
    }
    throw error;
  }
}

function classifyPhase(input: {
  manifestValid: boolean;
  hasManifest: boolean;
  hasAgents: boolean;
}): AdoptionPhase {
  if (input.manifestValid && input.hasAgents) {
    return 'initialized';
  }
  if (input.hasManifest || input.hasAgents) {
    return 'partial';
  }
  return 'uninitialized';
}

export async function resolveAdoptionRoot(
  input: { cwd: string; home: string },
): Promise<AdoptionRoot> {
  const marker = await resolveScopeMarker(input);
  const manifestValid = await isManifestValid(marker);
  return {
    scope: marker.scope,
    root: marker.root,
    sourceRoot: marker.sourceRoot,
    manifestPath: marker.manifestPath,
    instructionsPath: marker.instructionsPath,
    phase: classifyPhase({
      manifestValid,
      hasManifest: marker.hasManifest,
      hasAgents: marker.hasAgents,
    }),
    manifestValid,
  };
}

export interface MinimalSourcePlan {
  files: Record<string, string>;
  directories: string[];
  manifest: ProjectManifest;
}

const MINIMAL_DIRECTORIES = [
  '.agents/agents',
  '.agents/skills',
  '.agents/notes',
  '.agents/rules',
  '.agents/hooks',
] as const;

function minimalManifest(scan: ScanResult, scope: Scope): ProjectManifest {
  return ProjectManifestSchema.parse({
    version: 2,
    scope,
    project: { id: scan.projectId, name: scan.projectName },
    profile: 'feature',
    targets: [{
      provider: 'claude-code',
      enabled: true,
      options: {
        minVersion: MIN_CLAUDE_CODE_VERSION,
        instructions: 'symlink',
      },
    }],
    paths: { agents: '.agents', claude: '.claude' },
  });
}

export function minimalSourcePlan(scan: ScanResult, scope: Scope): MinimalSourcePlan {
  const agentsMd = scope === 'global' ? '.agents/AGENTS.md' : 'AGENTS.md';
  const manifest = scope === 'global' ? '.agents/dab.yaml' : 'dab.yaml';
  return {
    files: {
      [agentsMd]: renderAgentsMd(scan),
      [manifest]: renderDabYaml(scan, scope),
      '.agents/policies/project.yaml': renderProjectPolicy(),
      '.agents/adapters/claude-code.yaml': renderClaudeCodePolicy(),
      '.agents/memory/INDEX.md': renderMemoryIndex(),
    },
    directories: [...MINIMAL_DIRECTORIES],
    manifest: minimalManifest(scan, scope),
  };
}

export async function planSourceWrites(
  root: string,
  plan: MinimalSourcePlan,
): Promise<{ create: string[]; skip: string[] }> {
  const create: string[] = [];
  const skip: string[] = [];
  for (const relativePath of Object.keys(plan.files)) {
    if ((await lstatOrNull(join(root, relativePath))) === null) {
      create.push(relativePath);
    } else {
      skip.push(relativePath);
    }
  }
  return { create, skip };
}

/**
 * Create a file only when it does not exist. `wx` makes the check and the
 * create one filesystem operation, so an authored file that appears between
 * planning and writing is never replaced.
 */
async function writeMissingFile(filePath: string, content: string): Promise<boolean> {
  await ensureDir(dirname(filePath));
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, 'wx', 0o644);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw error;
  }
  try {
    await handle.writeFile(content);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(filePath, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  return true;
}

export async function writeSourceFiles(
  root: string,
  plan: MinimalSourcePlan,
): Promise<{ created: string[]; skipped: string[] }> {
  for (const directory of plan.directories) {
    await ensureDir(join(root, directory));
  }
  const created: string[] = [];
  const skipped: string[] = [];
  for (const [relativePath, content] of Object.entries(plan.files)) {
    if (await writeMissingFile(join(root, relativePath), content)) {
      created.push(relativePath);
    } else {
      skipped.push(relativePath);
    }
  }
  return { created, skipped };
}
