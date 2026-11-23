import type { ProjectManifest } from '../model/types.ts';
import { ProjectManifestSchema } from '../model/schemas.ts';
import { MIN_CLAUDE_CODE_VERSION } from '../core/version-check.ts';
import type { Scope } from '../model/scope.ts';
import type { ScanResult } from './scanner.ts';
import {
  renderAgentsMd,
  renderClaudeCodePolicy,
  renderDabYaml,
  renderMemoryIndex,
  renderProjectPolicy,
  type DocumentationLinks,
} from './templates.ts';

export interface MinimalSourcePlan {
  files: Record<string, string>;
  directories: string[];
  manifest: ProjectManifest;
}

export interface MinimalSourceOptions {
  /** Project-scope documentation links; omitted when no docs section belongs in AGENTS.md. */
  documentation?: DocumentationLinks;
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
    profile: 'generic',
    docs: { language: 'auto' },
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

export function minimalSourcePlan(
  scan: ScanResult,
  scope: Scope,
  options: MinimalSourceOptions = {},
): MinimalSourcePlan {
  const agentsMd = scope === 'global' ? '.agents/AGENTS.md' : 'AGENTS.md';
  const manifest = scope === 'global' ? '.agents/dab.yaml' : 'dab.yaml';
  return {
    files: {
      [agentsMd]: renderAgentsMd(
        scan,
        undefined,
        options.documentation === undefined ? {} : { documentation: options.documentation },
      ),
      [manifest]: renderDabYaml(scan, scope, { profile: 'generic' }),
      '.agents/policies/project.yaml': renderProjectPolicy(),
      '.agents/adapters/claude-code.yaml': renderClaudeCodePolicy(),
      '.agents/memory/INDEX.md': renderMemoryIndex(),
    },
    directories: [...MINIMAL_DIRECTORIES],
    manifest: minimalManifest(scan, scope),
  };
}
