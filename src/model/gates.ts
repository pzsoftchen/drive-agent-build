import { z } from 'zod';

export const GATE_MODES = ['required', 'check', 'advisory', 'off'] as const;
export type GateMode = (typeof GATE_MODES)[number];

export const GATE_COMMAND_NAMES = ['test', 'typecheck', 'lint', 'build'] as const;
export type GateCommandName = (typeof GATE_COMMAND_NAMES)[number];

export interface XcodeBuildConfig {
  project?: string;
  workspace?: string;
  scheme: string;
  destination: string;
  configuration?: string;
}

export interface GateCommandConfig {
  command?: string | null;
  xcodebuild?: XcodeBuildConfig;
  mode: GateMode;
  needs?: string;
}

export interface GateConfig {
  version: 1;
  gates: {
    source: { mode: 'required' };
    code: { commands: Partial<Record<GateCommandName, GateCommandConfig>> };
    docs: { mode: GateMode; command?: string };
  };
}

export const GateModeSchema = z.enum(GATE_MODES);

const NonBlankStringSchema = z.string().refine(
  (value) => value.trim().length > 0,
  { message: 'must not be blank' },
);

const RunnableCommandSchema = z.string().min(1).refine(
  (value) => value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .some((line) => !line.startsWith('#')),
  { message: 'command must contain an executable line, not only comments or whitespace' },
);

export const XcodeBuildConfigSchema = z
  .object({
    project: NonBlankStringSchema.optional(),
    workspace: NonBlankStringSchema.optional(),
    scheme: NonBlankStringSchema,
    destination: NonBlankStringSchema,
    configuration: NonBlankStringSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasProject = value.project !== undefined;
    const hasWorkspace = value.workspace !== undefined;
    if (hasProject === hasWorkspace) {
      ctx.addIssue({
        code: 'custom',
        path: ['project'],
        message: 'exactly one of project or workspace is required',
      });
    }
  });

export const GateCommandConfigSchema = z
  .object({
    command: RunnableCommandSchema.nullable().optional(),
    xcodebuild: XcodeBuildConfigSchema.optional(),
    mode: GateModeSchema,
    needs: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasCommand = value.command !== undefined;
    const hasXcodebuild = value.xcodebuild !== undefined;
    if (hasCommand === hasXcodebuild) {
      ctx.addIssue({
        code: 'custom',
        path: hasCommand ? ['xcodebuild'] : ['command'],
        message: 'exactly one of command or xcodebuild is required',
      });
    }
  });

/**
 * Command names are a closed set, so an object with optional keys rejects
 * unknown names with a strict-object error instead of accepting arbitrary keys.
 */
export const GateCommandsSchema = z
  .object({
    test: GateCommandConfigSchema.optional(),
    typecheck: GateCommandConfigSchema.optional(),
    lint: GateCommandConfigSchema.optional(),
    build: GateCommandConfigSchema.optional(),
  })
  .strict();

export const GateConfigSchema = z
  .object({
    version: z.literal(1),
    gates: z
      .object({
        source: z
          .object({ mode: z.literal('required') })
          .strict(),
        code: z
          .object({ commands: GateCommandsSchema })
          .strict(),
        docs: z
          .object({
            mode: GateModeSchema,
            command: RunnableCommandSchema.optional(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
