import { describe, expect, it } from 'vitest';
import { GateConfigSchema } from '../../src/model/gates.ts';

function validConfig(): Record<string, unknown> {
  return {
    version: 1,
    gates: {
      source: { mode: 'required' },
      code: {
        commands: {
          test: { command: 'pnpm test', mode: 'required' },
          typecheck: { command: 'pnpm typecheck', mode: 'required' },
          lint: { command: 'pnpm lint', mode: 'advisory' },
        },
      },
      docs: { mode: 'check' },
    },
  };
}

function withTestCommand(command: Record<string, unknown>): Record<string, unknown> {
  const config = validConfig();
  const gates = config.gates as Record<string, Record<string, Record<string, unknown>>>;
  gates.code!.commands = { test: command };
  return config;
}

function issues(value: unknown): Array<{ path: PropertyKey[]; message: string }> {
  const result = GateConfigSchema.safeParse(value);
  if (result.success) {
    throw new Error('expected GateConfigSchema to reject the value');
  }
  return result.error.issues;
}

function issuePaths(value: unknown): string[] {
  return issues(value).map((issue) => issue.path.map(String).join('.'));
}

function messages(value: unknown): string {
  return issues(value).map((issue) => issue.message).join('; ');
}

describe('GateConfigSchema', () => {
  it('accepts a Node config with command and mode entries', () => {
    const parsed = GateConfigSchema.parse(validConfig());
    expect(parsed.version).toBe(1);
    expect(parsed.gates.source.mode).toBe('required');
    expect(parsed.gates.code.commands.test).toEqual({
      command: 'pnpm test',
      mode: 'required',
    });
    expect(parsed.gates.code.commands.lint).toEqual({
      command: 'pnpm lint',
      mode: 'advisory',
    });
    expect(parsed.gates.docs).toEqual({ mode: 'check' });
  });

  it('accepts a structured xcodebuild config with workspace or project', () => {
    const workspace = withTestCommand({
      xcodebuild: {
        workspace: 'App.xcworkspace',
        scheme: 'App',
        destination: 'platform=iOS Simulator,name=iPhone 16',
      },
      mode: 'required',
    });
    const parsedWorkspace = GateConfigSchema.parse(workspace);
    expect(parsedWorkspace.gates.code.commands.test?.xcodebuild).toEqual({
      workspace: 'App.xcworkspace',
      scheme: 'App',
      destination: 'platform=iOS Simulator,name=iPhone 16',
    });

    const project = withTestCommand({
      xcodebuild: {
        project: 'App.xcodeproj',
        scheme: 'App',
        destination: 'platform=iOS Simulator,name=iPhone 16',
        configuration: 'Debug',
      },
      mode: 'required',
    });
    expect(GateConfigSchema.safeParse(project).success).toBe(true);
  });

  it('accepts command: null with a needs explanation', () => {
    const config = withTestCommand({
      command: null,
      mode: 'required',
      needs: 'Configure the Xcode scheme and destination in .agents/gates.yaml.',
    });
    const parsed = GateConfigSchema.parse(config);
    expect(parsed.gates.code.commands.test).toEqual({
      command: null,
      mode: 'required',
      needs: 'Configure the Xcode scheme and destination in .agents/gates.yaml.',
    });
  });

  it('rejects command and xcodebuild together', () => {
    const config = withTestCommand({
      command: 'xcodebuild test',
      xcodebuild: {
        workspace: 'App.xcworkspace',
        scheme: 'App',
        destination: 'platform=iOS Simulator,name=iPhone 16',
      },
      mode: 'required',
    });
    expect(issuePaths(config)).toContain('gates.code.commands.test.xcodebuild');
    expect(messages(config)).toContain('exactly one of command or xcodebuild');
  });

  it('rejects a command entry with neither command nor xcodebuild', () => {
    const config = withTestCommand({ mode: 'required' });
    expect(issuePaths(config)).toContain('gates.code.commands.test.command');
    expect(messages(config)).toContain('exactly one of command or xcodebuild');
  });

  it('rejects xcodebuild without scheme or destination', () => {
    const missingScheme = withTestCommand({
      xcodebuild: {
        workspace: 'App.xcworkspace',
        destination: 'platform=iOS Simulator,name=iPhone 16',
      },
      mode: 'required',
    });
    expect(issuePaths(missingScheme)).toContain(
      'gates.code.commands.test.xcodebuild.scheme',
    );

    const missingDestination = withTestCommand({
      xcodebuild: { workspace: 'App.xcworkspace', scheme: 'App' },
      mode: 'required',
    });
    expect(issuePaths(missingDestination)).toContain(
      'gates.code.commands.test.xcodebuild.destination',
    );
  });

  it('requires exactly one of xcodebuild project or workspace', () => {
    const base = {
      scheme: 'App',
      destination: 'platform=iOS Simulator,name=iPhone 16',
    };
    const neither = withTestCommand({ xcodebuild: base, mode: 'required' });
    expect(messages(neither)).toContain('exactly one of project or workspace');

    const both = withTestCommand({
      xcodebuild: { ...base, project: 'App.xcodeproj', workspace: 'App.xcworkspace' },
      mode: 'required',
    });
    expect(messages(both)).toContain('exactly one of project or workspace');
  });

  it('rejects unknown keys at every level', () => {
    const topLevel = validConfig();
    topLevel.extra = true;
    expect(GateConfigSchema.safeParse(topLevel).success).toBe(false);

    const command = withTestCommand({ command: 'pnpm test', mode: 'required', extra: true });
    expect(GateConfigSchema.safeParse(command).success).toBe(false);

    const xcode = withTestCommand({
      xcodebuild: {
        workspace: 'App.xcworkspace',
        scheme: 'App',
        destination: 'platform=iOS Simulator,name=iPhone 16',
        extra: true,
      },
      mode: 'required',
    });
    expect(GateConfigSchema.safeParse(xcode).success).toBe(false);

    const docs = validConfig();
    const gates = docs.gates as Record<string, Record<string, unknown>>;
    gates.docs = { mode: 'check', extra: true };
    expect(GateConfigSchema.safeParse(docs).success).toBe(false);
  });

  it('rejects source.mode other than required', () => {
    const off = validConfig();
    const gates = off.gates as Record<string, Record<string, unknown>>;
    gates.source = { mode: 'off' };
    expect(GateConfigSchema.safeParse(off).success).toBe(false);
  });

  it('rejects unknown command names', () => {
    const config = validConfig();
    const gates = config.gates as Record<string, Record<string, Record<string, unknown>>>;
    gates.code!.commands = {
      test: { command: 'pnpm test', mode: 'required' },
      coverage: { command: 'pnpm coverage', mode: 'advisory' },
    };
    expect(GateConfigSchema.safeParse(config).success).toBe(false);
  });

  it('rejects unknown versions and modes', () => {
    const version = validConfig();
    version.version = 2;
    expect(GateConfigSchema.safeParse(version).success).toBe(false);

    const mode = withTestCommand({ command: 'pnpm test', mode: 'blocking' });
    expect(GateConfigSchema.safeParse(mode).success).toBe(false);
  });

  it('rejects empty command strings', () => {
    const command = withTestCommand({ command: '', mode: 'required' });
    expect(GateConfigSchema.safeParse(command).success).toBe(false);

    const docs = validConfig();
    const gates = docs.gates as Record<string, Record<string, unknown>>;
    gates.docs = { mode: 'check', command: '' };
    expect(GateConfigSchema.safeParse(docs).success).toBe(false);
  });
});
