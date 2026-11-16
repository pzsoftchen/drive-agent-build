import type { z } from 'zod';
import type { Diagnostic } from '../core/diagnostics.ts';
import type {
  AgentFrontmatterSchema,
  ClaudeCodePolicySchema,
  GeneratedManifestSchema,
  HookSpecSchema,
  MemoryEntrySchema,
  PolicySpecSchema,
  ProjectManifestSchema,
  ProjectionSchema,
} from './schemas.ts';

export type ProjectManifest = z.infer<typeof ProjectManifestSchema>;
export type GeneratedManifest = z.infer<typeof GeneratedManifestSchema>;
export type Projection = z.infer<typeof ProjectionSchema>;
export type PolicySpec = z.infer<typeof PolicySpecSchema>;
export type ClaudeCodePolicy = z.infer<typeof ClaudeCodePolicySchema>;
export type HookSpec = z.infer<typeof HookSpecSchema>;
export type AgentFrontmatter = z.infer<typeof AgentFrontmatterSchema>;
export type MemoryEntryFrontmatter = z.infer<typeof MemoryEntrySchema>;

export interface ProjectPaths {
  root: string;
  agents: string;
  claude: string;
  manifest: string;
}

export interface DiscoveryResult<T> {
  items: T[];
  diagnostics: Diagnostic[];
}

export interface AgentHookDefinition {
  id: string;
  event: string;
  matcher?: string;
  command: string;
  timeout?: number;
  source: string;
}

export interface AgentDefinition {
  file: string;
  name: string;
  description: string;
  tools: string[];
  disallowedTools: string[];
  model?: string;
  permissionMode?: string;
  memory?: string;
  hooks: AgentHookDefinition[];
  body: string;
  frontmatter: AgentFrontmatter;
}

export interface SkillDefinition {
  dir: string;
  file: string;
  name: string;
  description: string;
  frontmatter: Record<string, unknown>;
}

export interface RuleDefinition {
  file: string;
  name: string;
  paths: string[];
  body: string;
}

export interface LoadedHook {
  spec: HookSpec;
  dir: string;
  entryPath: string;
  metadataPath: string;
}

export interface MemoryEntry {
  file: string;
  title: string;
  source: string;
  reviewBy: string;
  updated?: string;
  status?: string;
  body: string;
}
