import { join } from 'node:path';
import { Document } from 'yaml';
import { ConfigError } from '../core/errors.ts';
import { lstatOrNull } from '../core/fs-atomic.ts';
import { resolveInside } from '../core/paths.ts';
import { loadYamlDocument, saveYamlDocument } from '../core/yaml.ts';
import {
  GeneratedManifestSchema,
  ProjectManifestSchema,
} from './schemas.ts';
import type { GeneratedManifest, ProjectManifest, ProjectPaths } from './types.ts';

export interface LoadedProjectManifest {
  manifest: ProjectManifest;
  document: Document.Parsed;
  path: string;
}

function zodMessage(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path.length === 0 ? issue.message : `${path}: ${issue.message}`;
    })
    .join('; ');
}

export async function loadProjectManifest(root: string): Promise<LoadedProjectManifest> {
  const path = join(root, 'dab.yaml');
  if ((await lstatOrNull(path)) === null) {
    throw new ConfigError(
      'dab.yaml not found',
      'config.missing',
      { hint: 'Run "dab init" to create a project manifest.' },
    );
  }
  const document = await loadYamlDocument(path);
  const parsed = ProjectManifestSchema.safeParse(document.toJS());
  if (!parsed.success) {
    throw new ConfigError(
      `invalid dab.yaml: ${zodMessage(parsed.error)}`,
      'config.invalid',
      { details: parsed.error.issues },
    );
  }
  if (parsed.data.paths.agents !== '.agents' || parsed.data.paths.claude !== '.claude') {
    throw new ConfigError(
      'custom paths are not supported in v0.1',
      'config.paths-unsupported',
      {
        details: parsed.data.paths,
        hint: 'Use the default .agents and .claude paths.',
      },
    );
  }
  return { manifest: parsed.data, document, path };
}

export async function writeProjectManifest(
  root: string,
  manifest: ProjectManifest,
): Promise<void> {
  const validated = ProjectManifestSchema.parse(manifest);
  const document = new Document(validated);
  await saveYamlDocument(join(root, 'dab.yaml'), document);
}

export async function updateGeneratedManifest(
  root: string,
  generated: GeneratedManifest,
): Promise<void> {
  const validated = GeneratedManifestSchema.parse(generated);
  const loaded = await loadProjectManifest(root);
  loaded.document.setIn(['generated'], validated);
  await saveYamlDocument(loaded.path, loaded.document);
}

export function resolveProjectPaths(root: string, manifest: ProjectManifest): ProjectPaths {
  return {
    root,
    agents: resolveInside(root, manifest.paths.agents),
    claude: resolveInside(root, manifest.paths.claude),
    manifest: join(root, 'dab.yaml'),
  };
}
