import { join, relative } from 'node:path';
import { ConfigError, ValidationError } from '../core/errors.ts';
import { lstatOrNull } from '../core/fs-atomic.ts';
import { assertRealPathInsideRoot, toPosix } from '../core/paths.ts';
import { loadYamlDocument } from '../core/yaml.ts';
import { ClaudeCodePolicySchema, PolicySpecSchema } from './schemas.ts';
import type { ClaudeCodePolicy, PolicySpec, ProjectPaths } from './types.ts';

export interface LoadedCommonPolicy {
  policy: PolicySpec;
  path: string;
}

export interface LoadedClaudeCodePolicy {
  policy: ClaudeCodePolicy;
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

async function requireFile(path: string, relativePath: string): Promise<void> {
  if ((await lstatOrNull(path)) === null) {
    throw new ConfigError(
      `policy file not found: ${relativePath}`,
      'policy.missing',
      { hint: 'Run "dab init" or restore the authored policy file.' },
    );
  }
}

async function loadPolicyValue(
  root: string,
  absolutePath: string,
  relativePath: string,
): Promise<unknown> {
  await requireFile(absolutePath, relativePath);
  await assertRealPathInsideRoot(root, relativePath);
  const document = await loadYamlDocument(absolutePath);
  return document.toJS();
}

export async function loadCommonPolicy(paths: ProjectPaths): Promise<LoadedCommonPolicy> {
  const absolute = join(paths.agents, 'policies', 'project.yaml');
  const relativePath = toPosix(relative(paths.root, absolute));
  const value = await loadPolicyValue(paths.root, absolute, relativePath);
  const parsed = PolicySpecSchema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError(
      `invalid ${relativePath}: ${zodMessage(parsed.error)}`,
      'policy.invalid',
      { details: parsed.error.issues },
    );
  }
  return { policy: parsed.data, path: relativePath };
}

export async function loadClaudeCodePolicy(paths: ProjectPaths): Promise<LoadedClaudeCodePolicy> {
  const absolute = join(paths.agents, 'adapters', 'claude-code.yaml');
  const relativePath = toPosix(relative(paths.root, absolute));
  const value = await loadPolicyValue(paths.root, absolute, relativePath);
  const parsed = ClaudeCodePolicySchema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError(
      `invalid ${relativePath}: ${zodMessage(parsed.error)}`,
      'policy.invalid',
      { details: parsed.error.issues },
    );
  }
  return { policy: parsed.data, path: relativePath };
}
