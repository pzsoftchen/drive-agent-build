import { stringify } from 'yaml';
import type { ScanCommandSet, ScanResult, ScanStackId } from './scanner.ts';
import type {
  GateCommandConfig,
  GateCommandName,
  GateConfig,
  GateMode,
} from '../model/gates.ts';

const GATE_TEMPLATE_COMMANDS: ReadonlyArray<readonly [GateCommandName, GateMode]> = [
  ['test', 'required'],
  ['typecheck', 'required'],
  ['lint', 'advisory'],
  ['build', 'advisory'],
];

/**
 * New-stack precedence for gate commands. The scanner keeps legacy
 * Node/Python/Go/Rust stacks first for `ScanResult.language`/`commands`
 * compatibility, so gates must select the new stacks explicitly.
 */
const NEW_STACK_PRIORITY: readonly ScanStackId[] = [
  'android',
  'java-gradle',
  'java-maven',
  'ios-swiftpm',
  'ios-xcode',
];

export const MAVEN_GRADLE_NEEDS =
  'Resolve Maven/Gradle ambiguity in .agents/gates.yaml: keep one build system or set an explicit test command.';

export const XCODE_NEEDS =
  'Configure the Xcode scheme and destination, or add a Fastlane test command, in .agents/gates.yaml.';

export type GateStackSelection =
  | { kind: 'commands'; stackId?: ScanStackId; commands: ScanCommandSet }
  | { kind: 'needs-config'; stackId?: ScanStackId; needs: string };

/**
 * Choose the stack whose commands feed `.agents/gates.yaml`.
 *
 * - Maven plus Gradle/Android is ambiguous and stays needs-config.
 * - Android suppresses Java Gradle through scanner detection.
 * - SwiftPM wins over Xcode evidence; Xcode-only is needs-config.
 * - Otherwise the legacy primary scanner commands are used.
 */
export function selectGateStack(scan: ScanResult): GateStackSelection {
  const byId = new Map(scan.stacks.map((stack) => [stack.id, stack]));
  const hasMaven = byId.has('java-maven');
  const hasGradle = byId.has('java-gradle') || byId.has('android');
  if (hasMaven && hasGradle) {
    return { kind: 'needs-config', needs: MAVEN_GRADLE_NEEDS };
  }

  for (const id of NEW_STACK_PRIORITY) {
    const stack = byId.get(id);
    if (stack === undefined) {
      continue;
    }
    if (id === 'ios-xcode') {
      return { kind: 'needs-config', stackId: id, needs: XCODE_NEEDS };
    }
    return { kind: 'commands', stackId: id, commands: stack.commands };
  }

  return { kind: 'commands', stackId: scan.stacks[0]?.id, commands: scan.commands };
}

function starterCommands(
  selection: GateStackSelection,
): Partial<Record<GateCommandName, GateCommandConfig>> {
  if (selection.kind === 'needs-config') {
    return {
      test: { command: null, mode: 'required', needs: selection.needs },
    };
  }

  const commands: Partial<Record<GateCommandName, GateCommandConfig>> = {};
  for (const [name, mode] of GATE_TEMPLATE_COMMANDS) {
    const command = selection.commands[name];
    if (command !== undefined && command.trim().length > 0) {
      commands[name] = { command, mode };
    }
  }
  return commands;
}

/**
 * Render the authored gate starter from scanner results. The output is
 * deterministic: command modes and key order never depend on object insertion
 * order from the scanner.
 */
export function renderGateStarter(scan: ScanResult): string {
  const config: GateConfig = {
    version: 1,
    gates: {
      source: { mode: 'required' },
      code: { commands: starterCommands(selectGateStack(scan)) },
      docs: { mode: 'check' },
    },
  };
  const text = stringify(config, { lineWidth: 0 });
  return text.endsWith('\n') ? text : `${text}\n`;
}
