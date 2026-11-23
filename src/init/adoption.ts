import { ConfigError } from '../core/errors.ts';
import { loadProjectManifest } from '../model/project-manifest.ts';
import { resolveScopeMarker, type Scope } from '../model/scope.ts';

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
