import { z } from 'zod';

export const PROJECTION_KINDS = ['agent', 'skill', 'rule'] as const;
export const NEUTRAL_HOOK_EVENTS = [
  'session_start',
  'session_end',
  'pre_tool',
  'post_tool',
  'post_edit',
  'user_prompt',
  'agent_stop',
  'subagent_stop',
  'pre_compact',
  'notification',
] as const;
export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'Setup',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'PreToolUse',
  'PermissionRequest',
  'PermissionDenied',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'Notification',
  'MessageDisplay',
  'SubagentStart',
  'SubagentStop',
  'TaskCreated',
  'TaskCompleted',
  'Stop',
  'StopFailure',
  'TeammateIdle',
  'InstructionsLoaded',
  'ConfigChange',
  'CwdChanged',
  'DirectoryAdded',
  'FileChanged',
  'WorktreeCreate',
  'WorktreeRemove',
  'PreCompact',
  'PostCompact',
  'PreModelSwitch',
  'PostModelSwitch',
  'Elicitation',
  'ElicitationResult',
  'SessionEnd',
] as const;
export const CAPABILITIES = ['web', 'web-search', 'notebook'] as const;
export const AGENT_PERMISSION_MODES = [
  'default',
  'manual',
  'acceptEdits',
  'auto',
  'dontAsk',
  'bypassPermissions',
  'plan',
] as const;
export const MEMORY_STATUSES = ['active', 'superseded'] as const;

export const DocsLanguageSchema = z.enum(['auto', 'en', 'zh']);
export const DocsConfigSchema = z
  .object({ language: DocsLanguageSchema.default('auto') })
  .strict()
  .default({ language: 'auto' });

export const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const SHA256_HEX = /^[a-f0-9]{64}$/;
export const SAFE_HOOK_ENTRY = /^[A-Za-z0-9._/-]+$/;

export const ProjectionSchema = z
  .object({
    kind: z.enum(PROJECTION_KINDS),
    name: z.string().min(1),
    source: z.string().min(1),
    target: z.string().min(1),
    link: z.literal('symlink'),
    sourceSha256: z.string().regex(SHA256_HEX),
  })
  .strict();

export const TARGET_PROVIDERS = ['claude-code', 'codex', 'dsh'] as const;

export const TargetConfigSchema = z
  .object({
    provider: z.enum(TARGET_PROVIDERS),
    enabled: z.boolean().default(true),
    options: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const GeneratedTargetSchema = z
  .object({
    provider: z.enum(TARGET_PROVIDERS),
    settings: z
      .object({ path: z.string().min(1), sha256: z.string().regex(SHA256_HEX) })
      .strict()
      .nullable()
      .default(null),
    instructions: z
      .object({
        path: z.literal('.claude/CLAUDE.md'),
        mode: z.enum(['symlink', 'generated']),
        sha256: z.string().regex(SHA256_HEX),
      })
      .strict()
      .nullable()
      .default(null),
    projections: z.array(ProjectionSchema).default([]),
  })
  .strict();

export const GeneratedManifestSchema = z
  .object({ targets: z.array(GeneratedTargetSchema) })
  .strict();

export const ProjectManifestSchema = z
  .object({
    version: z.literal(2),
    scope: z.enum(['project', 'global']),
    project: z
      .object({
        id: z.string().min(1),
        name: z.string().min(1),
        goal: z.string().min(1).optional(),
      })
      .strict(),
    profile: z.enum(['generic', 'feature']),
    docs: DocsConfigSchema,
    targets: z.array(TargetConfigSchema).min(1),
    paths: z
      .object({
        agents: z.string().min(1).default('.agents'),
        claude: z.string().min(1).default('.claude'),
      })
      .strict()
      .default({ agents: '.agents', claude: '.claude' }),
    generated: GeneratedManifestSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const target of value.targets) {
      if (seen.has(target.provider)) {
        ctx.addIssue({
          code: 'custom',
          path: ['targets'],
          message: `duplicate target provider: ${target.provider}`,
        });
      }
      seen.add(target.provider);
    }
  });

export const LegacyGeneratedManifestSchema = z
  .object({
    settings: z
      .object({
        path: z.string().min(1),
        sha256: z.string().regex(SHA256_HEX),
      })
      .strict(),
    instructions: z
      .object({
        path: z.literal('.claude/CLAUDE.md'),
        sha256: z.string().regex(SHA256_HEX),
      })
      .strict()
      .nullable()
      .default(null),
    projections: z.array(ProjectionSchema),
  })
  .strict();

export const LegacyProjectManifestSchema = z
  .object({
    version: z.literal(1),
    project: z
      .object({
        id: z.string().min(1),
        name: z.string().min(1),
        goal: z.string().min(1).optional(),
      })
      .strict(),
    profile: z.literal('feature'),
    docs: DocsConfigSchema.optional(),
    target: z
      .object({
        provider: z.literal('claude-code'),
        minVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
        claudeMdShim: z.boolean().default(true),
      })
      .strict(),
    paths: z
      .object({
        agents: z.string().min(1).default('.agents'),
        claude: z.string().min(1).default('.claude'),
      })
      .strict()
      .default({ agents: '.agents', claude: '.claude' }),
    generated: LegacyGeneratedManifestSchema.optional(),
  })
  .strict();

const PathDenySchema = z
  .object({
    deny: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .default({ deny: [] });

export const PolicySpecSchema = z
  .object({
    version: z.literal(1),
    defaultMode: z.enum(['default', 'plan', 'acceptEdits']).default('default'),
    read: PathDenySchema,
    write: PathDenySchema,
    execute: z
      .object({
        deny: z.array(z.string().min(1)).default([]),
        ask: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .default({ deny: [], ask: [] }),
    capabilities: z
      .object({
        deny: z.array(z.enum(CAPABILITIES)).default([]),
      })
      .strict()
      .default({ deny: [] }),
  })
  .strict();

export const ClaudeCodePolicySchema = z
  .object({
    version: z.literal(1),
    provider: z.literal('claude-code'),
    permissions: z
      .object({
        allow: z.array(z.string().min(1)).default([]),
        ask: z.array(z.string().min(1)).default([]),
        deny: z.array(z.string().min(1)).default([]),
        disableBypassPermissionsMode: z.literal('disable').default('disable'),
      })
      .strict()
      .default({ allow: [], ask: [], deny: [], disableBypassPermissionsMode: 'disable' }),
  })
  .strict();

export const HookSpecSchema = z
  .object({
    id: z.string().regex(KEBAB_CASE),
    event: z.enum(NEUTRAL_HOOK_EVENTS),
    matcher: z.string().min(1).optional(),
    entry: z.string().min(1).regex(SAFE_HOOK_ENTRY),
    runner: z.enum(['node', 'exec']).default('node'),
    timeout: z.number().int().min(1).max(300).default(30),
    order: z.number().int().min(0).max(1000).default(100),
  })
  .strict();

export const AgentFrontmatterSchema = z
  .object({
    name: z.string().min(1).max(256).regex(KEBAB_CASE),
    description: z.string().min(1),
    tools: z.union([z.string(), z.array(z.string())]).optional(),
    disallowedTools: z.union([z.string(), z.array(z.string())]).optional(),
    model: z.string().min(1).optional(),
    permissionMode: z.enum(AGENT_PERMISSION_MODES).optional(),
    maxTurns: z.number().int().positive().optional(),
    autoCompactWindow: z.union([z.string(), z.number()]).optional(),
    skills: z.array(z.string()).optional(),
    mcpServers: z.union([z.array(z.string()), z.record(z.string(), z.unknown())]).optional(),
    hooks: z.record(z.string(), z.unknown()).optional(),
    memory: z.enum(['user', 'project', 'local']).optional(),
    background: z.boolean().optional(),
    omitClaudeMd: z.boolean().optional(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    isolation: z.string().optional(),
    color: z.string().optional(),
    initialPrompt: z.string().optional(),
    experimental: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const SkillFrontmatterSchema = z
  .object({
    name: z.string().min(1).regex(KEBAB_CASE).optional(),
    description: z.string().min(1),
    when_to_use: z.string().optional(),
    'argument-hint': z.string().optional(),
    arguments: z.union([z.array(z.string()), z.string()]).optional(),
    'disable-model-invocation': z.boolean().optional(),
    'user-invocable': z.boolean().optional(),
    'allowed-tools': z.union([z.string(), z.array(z.string())]).optional(),
    'disallowed-tools': z.union([z.string(), z.array(z.string())]).optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
    context: z.string().optional(),
    agent: z.string().optional(),
    background: z.boolean().optional(),
    hooks: z.record(z.string(), z.unknown()).optional(),
    paths: z.union([z.string(), z.array(z.string())]).optional(),
    shell: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    license: z.string().optional(),
    compatibility: z.string().optional(),
  })
  .passthrough();

export const RuleFrontmatterSchema = z
  .object({
    paths: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
  })
  .passthrough();

export const MemoryEntrySchema = z
  .object({
    title: z.string().min(1),
    source: z.string().min(1),
    review_by: z.string().regex(ISO_DATE),
    updated: z.string().regex(ISO_DATE).optional(),
    status: z.enum(MEMORY_STATUSES).optional(),
  })
  .strict();

