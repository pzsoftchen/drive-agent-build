import { join } from 'node:path';
import { Document, isMap } from 'yaml';
import { ConfigError } from '../core/errors.ts';
import { lstatOrNull } from '../core/fs-atomic.ts';
import { resolveInside } from '../core/paths.ts';
import { loadYamlDocument, saveYamlDocument } from '../core/yaml.ts';
import {
  GeneratedManifestSchema,
  LegacyProjectManifestSchema,
  ProjectManifestSchema,
} from './schemas.ts';
import type { Scope } from './scope.ts';
import type {
  GeneratedManifest,
  GeneratedTarget,
  LegacyProjectManifest,
  ProjectManifest,
  ProjectPaths,
  TargetConfig,
  TargetProvider,
} from './types.ts';

export interface LoadedProjectManifest {
  manifest: ProjectManifest;
  document: Document.Parsed;
  path: string;
  legacy: boolean;
  scope: Scope;
}

export interface LoadProjectManifestOptions {
  scope?: Scope;
}

export type InterimClaudeOptions = {
  minVersion: string;
  instructions: 'generated' | 'disabled';
};

const INTERIM_CLAUDE_OPTION_KEYS = new Set(['minVersion', 'instructions']);
const MIN_VERSION = /^\d+\.\d+\.\d+$/;
const MANIFEST_FIELD_ORDER = [
  'version',
  'scope',
  'project',
  'profile',
  'targets',
  'paths',
  'generated',
] as const;

function zodMessage(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path.length === 0 ? issue.message : `${path}: ${issue.message}`;
    })
    .join('; ');
}

export function manifestPath(root: string, scope: Scope = 'project'): string {
  return scope === 'global' ? join(root, '.agents', 'dab.yaml') : join(root, 'dab.yaml');
}

function missingManifest(scope: Scope): ConfigError {
  const hint = scope === 'global'
    ? 'Run "dab init ~/.agents" to create a global manifest.'
    : 'Run "dab init" to create a project manifest.';
  const file = scope === 'global' ? '.agents/dab.yaml' : 'dab.yaml';
  return new ConfigError(`${file} not found`, 'config.missing', { hint });
}

function assertSupportedPaths(paths: { agents: string; claude: string }): void {
  if (paths.agents !== '.agents' || paths.claude !== '.claude') {
    throw new ConfigError(
      'custom paths are not supported in v0.1',
      'config.paths-unsupported',
      {
        details: paths,
        hint: 'Use the default .agents and .claude paths.',
      },
    );
  }
}

function migrateLegacyGenerated(
  legacy: NonNullable<LegacyProjectManifest['generated']>,
): GeneratedManifest {
  return {
    targets: [{
      provider: 'claude-code',
      settings: legacy.settings,
      instructions: legacy.instructions === null
        ? null
        : { ...legacy.instructions, mode: 'generated' },
      projections: legacy.projections,
    }],
  };
}

function migrateV1Manifest(legacy: LegacyProjectManifest): ProjectManifest {
  const migrated: ProjectManifest = {
    version: 2,
    scope: 'project',
    project: legacy.project,
    profile: legacy.profile,
    targets: [{
      provider: 'claude-code',
      enabled: true,
      options: {
        minVersion: legacy.target.minVersion,
        instructions: legacy.target.claudeMdShim ? 'generated' : 'disabled',
      },
    }],
    paths: legacy.paths,
    ...(legacy.generated === undefined
      ? {}
      : { generated: migrateLegacyGenerated(legacy.generated) }),
  };
  const parsed = ProjectManifestSchema.safeParse(migrated);
  if (!parsed.success) {
    throw new ConfigError(
      `invalid dab.yaml: ${zodMessage(parsed.error)}`,
      'config.invalid',
      { details: parsed.error.issues },
    );
  }
  return parsed.data;
}

function duplicateTargetIssue(
  error: { issues: Array<{ code: string; path: PropertyKey[]; message: string }> },
): { message: string } | undefined {
  return error.issues.find(
    (issue) =>
      issue.code === 'custom'
      && issue.path.length === 1
      && issue.path[0] === 'targets'
      && issue.message.startsWith('duplicate target provider'),
  );
}

export async function loadProjectManifest(
  root: string,
  options: LoadProjectManifestOptions = {},
): Promise<LoadedProjectManifest> {
  const scope = options.scope ?? 'project';
  const path = manifestPath(root, scope);
  if ((await lstatOrNull(path)) === null) {
    throw missingManifest(scope);
  }
  const document = await loadYamlDocument(path);
  const raw: unknown = document.toJS();
  const version = typeof raw === 'object' && raw !== null && 'version' in raw
    ? (raw as { version: unknown }).version
    : undefined;

  if (version === 1) {
    const parsed = LegacyProjectManifestSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ConfigError(
        `invalid dab.yaml: ${zodMessage(parsed.error)}`,
        'config.invalid',
        { details: parsed.error.issues },
      );
    }
    if (scope === 'global') {
      throw new ConfigError(
        'legacy v1 manifests are not supported at the global source root',
        'config.manifest-legacy-global',
        { hint: 'Run "dab init ~/.agents" in a new global source root or migrate the manifest to v2.' },
      );
    }
    assertSupportedPaths(parsed.data.paths);
    return {
      manifest: migrateV1Manifest(parsed.data),
      document,
      path,
      legacy: true,
      scope,
    };
  }

  if (version === 2) {
    const parsed = ProjectManifestSchema.safeParse(raw);
    if (!parsed.success) {
      const duplicate = duplicateTargetIssue(parsed.error);
      if (duplicate !== undefined) {
        throw new ConfigError(
          duplicate.message,
          'config.duplicate-target',
          { details: parsed.error.issues },
        );
      }
      throw new ConfigError(
        `invalid dab.yaml: ${zodMessage(parsed.error)}`,
        'config.invalid',
        { details: parsed.error.issues },
      );
    }
    if (parsed.data.scope !== scope) {
      throw new ConfigError(
        `manifest scope ${parsed.data.scope} does not match the resolved ${scope} source root`,
        'config.scope-mismatch',
        { hint: `The manifest at ${path} must declare "scope: ${scope}".` },
      );
    }
    assertSupportedPaths(parsed.data.paths);
    return {
      manifest: parsed.data,
      document,
      path,
      legacy: false,
      scope,
    };
  }

  throw new ConfigError(
    `invalid dab.yaml: unsupported manifest version: ${String(version)}`,
    'config.invalid',
    { details: { version } },
  );
}

export async function writeProjectManifest(
  root: string,
  manifest: ProjectManifest,
): Promise<void> {
  const validated = ProjectManifestSchema.parse(manifest);
  const document = new Document(validated);
  await saveYamlDocument(resolveProjectPaths(root, validated).manifest, document);
}

function reorderManifestFields(document: Document.Parsed): void {
  const contents = document.contents;
  if (!isMap(contents)) {
    return;
  }
  const rank = new Map<string, number>(
    MANIFEST_FIELD_ORDER.map((key, index) => [key, index]),
  );
  contents.items.sort((left, right) => {
    const leftRank = rank.get(String(left.key)) ?? MANIFEST_FIELD_ORDER.length;
    const rightRank = rank.get(String(right.key)) ?? MANIFEST_FIELD_ORDER.length;
    return leftRank - rightRank;
  });
}

export async function updateGeneratedManifest(
  root: string,
  generated: GeneratedManifest,
  options: LoadProjectManifestOptions = {},
): Promise<void> {
  const validated = GeneratedManifestSchema.parse(generated);
  const loaded = await loadProjectManifest(root, options);
  if (loaded.legacy) {
    loaded.document.set('version', 2);
    loaded.document.set('scope', loaded.scope);
    loaded.document.set('targets', loaded.manifest.targets);
    loaded.document.delete('target');
    reorderManifestFields(loaded.document);
  }
  loaded.document.set('generated', validated);
  await saveYamlDocument(loaded.path, loaded.document);
}

export function resolveProjectPaths(
  root: string,
  manifest: ProjectManifest,
): ProjectPaths {
  const global = manifest.scope === 'global';
  return {
    root,
    scope: manifest.scope,
    agents: resolveInside(root, manifest.paths.agents),
    claude: resolveInside(root, manifest.paths.claude),
    manifest: manifestPath(root, manifest.scope),
    instructions: global ? join(root, '.agents', 'AGENTS.md') : join(root, 'AGENTS.md'),
  };
}

export function getTarget(
  manifest: ProjectManifest,
  provider: TargetProvider,
): TargetConfig | undefined {
  return manifest.targets.find((target) => target.provider === provider);
}

export function getEnabledTargets(manifest: ProjectManifest): TargetConfig[] {
  return manifest.targets.filter((target) => target.enabled);
}

export function getGeneratedTarget(
  manifest: ProjectManifest,
  provider: TargetProvider,
): GeneratedTarget | undefined {
  return manifest.generated?.targets.find((target) => target.provider === provider);
}

export function parseInterimClaudeOptions(target: TargetConfig): InterimClaudeOptions {
  if (target.provider !== 'claude-code') {
    throw new ConfigError(
      `invalid claude-code options: target provider is ${target.provider}`,
      'target.invalid-options',
    );
  }
  for (const key of Object.keys(target.options)) {
    if (!INTERIM_CLAUDE_OPTION_KEYS.has(key)) {
      throw new ConfigError(
        `invalid claude-code options: unknown option ${key}`,
        'target.invalid-options',
      );
    }
  }

  const minVersion = target.options.minVersion;
  if (typeof minVersion !== 'string' || !MIN_VERSION.test(minVersion)) {
    throw new ConfigError(
      'invalid claude-code options: minVersion must be a semantic version',
      'target.invalid-options',
    );
  }
  const instructions = target.options.instructions;
  if (instructions !== 'generated' && instructions !== 'disabled') {
    throw new ConfigError(
      'invalid claude-code options: instructions must be "generated" or "disabled"',
      'target.invalid-options',
    );
  }
  return { minVersion, instructions };
}
