import { join, relative } from 'node:path';
import { ConfigError, ValidationError } from '../core/errors.ts';
import { lstatOrNull } from '../core/fs-atomic.ts';
import { assertRealPathInsideRoot, toPosix } from '../core/paths.ts';
import { loadYamlDocument } from '../core/yaml.ts';
import { ClaudeCodePolicySchema, PolicySpecSchema } from './schemas.ts';
import type { ClaudeCodePolicy, PolicySpec, ProjectPaths } from './types.ts';

export interface LoadedPolicySources {
  project: PolicySpec;
  adapter: ClaudeCodePolicy;
  projectPath: string;
  adapterPath: string;
}

function zodMessage(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path.length === 0 ? issue.message : `${path}: ${issue.message}`;
    })
    .join('; ');
}

async function requireFile(path: string, relativePath: string): Promise<void> {
  if ((await lstatOrNull(path)) === null) {
    throw new ConfigError(
      `policy file not found: ${relativePath}`,
      'policy.missing',
      { hint: 'Run "dab init" or restore the authored policy file.' },
    );
  }
}

export async function loadPolicySources(paths: ProjectPaths): Promise<LoadedPolicySources> {
  const projectAbsolute = join(paths.agents, 'policies', 'project.yaml');
  const adapterAbsolute = join(paths.agents, 'adapters', 'claude-code.yaml');
  const projectPath = toPosix(relative(paths.root, projectAbsolute));
  const adapterPath = toPosix(relative(paths.root, adapterAbsolute));

  await requireFile(projectAbsolute, projectPath);
  await requireFile(adapterAbsolute, adapterPath);
  await assertRealPathInsideRoot(paths.root, projectPath);
  await assertRealPathInsideRoot(paths.root, adapterPath);

  const projectDocument = await loadYamlDocument(projectAbsolute);
  const project = PolicySpecSchema.safeParse(projectDocument.toJS());
  if (!project.success) {
    throw new ValidationError(
      `invalid ${projectPath}: ${zodMessage(project.error)}`,
      'policy.invalid',
      { details: project.error.issues },
    );
  }

  const adapterDocument = await loadYamlDocument(adapterAbsolute);
  const adapter = ClaudeCodePolicySchema.safeParse(adapterDocument.toJS());
  if (!adapter.success) {
    throw new ValidationError(
      `invalid ${adapterPath}: ${zodMessage(adapter.error)}`,
      'policy.invalid',
      { details: adapter.error.issues },
    );
  }

  return {
    project: project.data,
    adapter: adapter.data,
    projectPath,
    adapterPath,
  };
}
