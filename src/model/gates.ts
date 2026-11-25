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

export const XcodeBuildConfigSchema = z
  .object({
    project: z.string().min(1).optional(),
    workspace: z.string().min(1).optional(),
    scheme: z.string().min(1),
    destination: z.string().min(1),
    configuration: z.string().min(1).optional(),
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
    command: z.string().min(1).nullable().optional(),
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
            command: z.string().min(1).optional(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
