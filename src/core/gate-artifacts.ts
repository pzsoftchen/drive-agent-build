import {
  GATE_COMMAND_NAMES,
  GATE_MODES,
  type GateCommandConfig,
  type GateCommandName,
  type GateConfig,
  type GateMode,
  type XcodeBuildConfig,
} from '../model/gates.ts';
import type { ScanResult } from '../init/scanner.ts';
import { sha256 } from './hash.ts';

export interface ResolvedGateCommand {
  command: string | null;
  mode: GateMode;
  needs?: string;
}

export interface GateSnapshot {
  version: 1;
  generated: { dabVersion: string; sha256: string };
  gates: {
    source: { mode: 'required' };
    code: { commands: Partial<Record<GateCommandName, ResolvedGateCommand>> };
    docs: { mode: GateMode; command?: string };
  };
}

export type GateSnapshotGates = GateSnapshot['gates'];

const SAFE_SHELL_ARGUMENT = /^[A-Za-z0-9_.,:=+/@%-]+$/;

/**
 * Quote a single shell argument. Values with spaces (for example an Xcode
 * destination) must stay one argument. Xcode only runs on macOS, so POSIX
 * double-quote escaping is sufficient here.
 */
function quoteShellArgument(value: string): string {
  if (SAFE_SHELL_ARGUMENT.test(value)) {
    return value;
  }
  const escaped = value.replace(/["\\$`]/g, (character) => `\\${character}`);
  return `"${escaped}"`;
}

/**
 * Turn structured xcodebuild config into the equivalent shell command. Missing
 * scheme or destination is rejected by the authored schema before reaching
 * this point; DAB never guesses them.
 */
export function renderXcodebuildCommand(config: XcodeBuildConfig): string {
  const parts = ['xcodebuild', 'test'];
  if (config.project !== undefined) {
    parts.push('-project', quoteShellArgument(config.project));
  }
  if (config.workspace !== undefined) {
    parts.push('-workspace', quoteShellArgument(config.workspace));
  }
  parts.push('-scheme', quoteShellArgument(config.scheme));
  parts.push('-destination', quoteShellArgument(config.destination));
  if (config.configuration !== undefined) {
    parts.push('-configuration', quoteShellArgument(config.configuration));
  }
  return parts.join(' ');
}

/** Resolve one authored command to the shape stored in the snapshot. */
export function resolveGateCommand(config: GateCommandConfig): ResolvedGateCommand {
  const command = config.xcodebuild === undefined
    ? (config.command ?? null)
    : renderXcodebuildCommand(config.xcodebuild);
  const resolved: ResolvedGateCommand = { command, mode: config.mode };
  if (config.needs !== undefined) {
    resolved.needs = config.needs;
  }
  return resolved;
}

/**
 * Build the canonical `gates` object: fixed key order, fixed command order and
 * no scanner defaults. The authored config is the only source here, so an
 * omitted command stays omitted and `command: null` stays unresolved.
 */
export function canonicalGateGates(config: GateConfig): GateSnapshotGates {
  const commands: Partial<Record<GateCommandName, ResolvedGateCommand>> = {};
  for (const name of GATE_COMMAND_NAMES) {
    const entry = config.gates.code.commands[name];
    if (entry !== undefined) {
      commands[name] = resolveGateCommand(entry);
    }
  }
  const docs: GateSnapshotGates['docs'] = { mode: config.gates.docs.mode };
  if (config.gates.docs.command !== undefined) {
    docs.command = config.gates.docs.command;
  }
  return {
    source: { mode: 'required' },
    code: { commands },
    docs,
  };
}

/** SHA-256 over the canonical `gates` object, excluding `generated` metadata. */
export function hashGateGates(gates: GateSnapshotGates): string {
  return sha256(JSON.stringify(gates));
}

export function renderGateSnapshot(snapshot: GateSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

/**
 * Compile the runner's JSON snapshot from the authored config.
 *
 * `scan` is accepted for interface stability but deliberately unused: an
 * existing `.agents/gates.yaml` is authoritative, and scanner defaults must
 * never backfill commands the project omitted.
 */
export function compileGateSnapshot(
  config: GateConfig,
  scan: ScanResult,
  version: string,
): { snapshot: GateSnapshot; content: string; hash: string } {
  void scan;
  const gates = canonicalGateGates(config);
  const hash = hashGateGates(gates);
  const snapshot: GateSnapshot = {
    version: 1,
    generated: { dabVersion: version, sha256: hash },
    gates,
  };
  return { snapshot, content: renderGateSnapshot(snapshot), hash };
}

/**
 * Rewrite wrapper commands for the host platform. The snapshot keeps canonical
 * POSIX wrapper commands so the same file works on every platform; the runner
 * applies this transformation with `process.platform` before spawning.
 */
const WINDOWS_WRAPPERS: ReadonlyArray<readonly [posix: string, windows: string]> = [
  ['./mvnw', 'mvnw.cmd'],
  ['./gradlew', 'gradlew.bat'],
];

export function normalizeGateCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') {
    return command;
  }
  for (const [posix, windows] of WINDOWS_WRAPPERS) {
    if (command === posix) {
      return windows;
    }
    if (command.startsWith(`${posix} `) || command.startsWith(`${posix}\t`)) {
      return `${windows}${command.slice(posix.length)}`;
    }
  }
  return command;
}

export interface GateRunnerMarker {
  version: string;
  sha256: string;
}

const MARKER_LINE =
  /^[ \t]*\/\/[ \t]*dab-gate-runner:[ \t]*([^\s]+)[ \t]+sha256=([0-9a-f]{64})[ \t]*$/m;

const MARKER_LINE_WITH_NEWLINE =
  /^[ \t]*\/\/[ \t]*dab-gate-runner:[^\n]*[ \t]*(?:\r?\n|$)/m;

export function formatGateRunnerMarker(marker: GateRunnerMarker): string {
  return `// dab-gate-runner: ${marker.version} sha256=${marker.sha256}`;
}

export function parseGateRunnerMarker(text: string): GateRunnerMarker | undefined {
  const match = MARKER_LINE.exec(text);
  if (match === null) {
    return undefined;
  }
  const [, version, digest] = match;
  return { version: version as string, sha256: digest as string };
}

/** Remove the managed marker line; text without a marker is unchanged. */
export function removeGateRunnerMarker(text: string): string {
  return text.replace(MARKER_LINE_WITH_NEWLINE, '');
}

/** SHA-256 of the runner body after removing the marker line. */
export function hashGateRunnerBody(text: string): string {
  return sha256(removeGateRunnerMarker(text));
}

export type GateSnapshotParseResult =
  | { ok: true; snapshot: GateSnapshot }
  | { ok: false; kind: 'modified' | 'unversioned'; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isGateMode(value: unknown): value is GateMode {
  return typeof value === 'string' && (GATE_MODES as readonly string[]).includes(value);
}

function isCommandName(value: string): value is GateCommandName {
  return (GATE_COMMAND_NAMES as readonly string[]).includes(value);
}

function isHex64(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function parseGates(value: unknown): GateSnapshotGates | string {
  if (!isRecord(value)) {
    return 'gates must be an object';
  }
  if (!hasOnlyKeys(value, ['source', 'code', 'docs'])) {
    return 'gates contains unknown keys';
  }
  const source = value.source;
  if (!isRecord(source) || !hasOnlyKeys(source, ['mode']) || source.mode !== 'required') {
    return 'gates.source.mode must be required';
  }
  const code = value.code;
  if (!isRecord(code) || !hasOnlyKeys(code, ['commands']) || !isRecord(code.commands)) {
    return 'gates.code.commands must be an object';
  }
  for (const name of Object.keys(code.commands)) {
    if (!isCommandName(name)) {
      return `unknown code command: ${name}`;
    }
    const entry = code.commands[name];
    if (!isRecord(entry) || !hasOnlyKeys(entry, ['command', 'mode', 'needs'])) {
      return `invalid code command entry: ${name}`;
    }
    if (!('command' in entry)) {
      return `code command has no command field: ${name}`;
    }
    if (
      entry.command !== null
      && (typeof entry.command !== 'string' || entry.command.length === 0)
    ) {
      return `code command must be a string or null: ${name}`;
    }
    if (!isGateMode(entry.mode)) {
      return `invalid code command mode: ${name}`;
    }
    if (
      entry.needs !== undefined
      && (typeof entry.needs !== 'string' || entry.needs.length === 0)
    ) {
      return `invalid code command needs: ${name}`;
    }
  }
  const docs = value.docs;
  if (!isRecord(docs) || !hasOnlyKeys(docs, ['mode', 'command'])) {
    return 'gates.docs is invalid';
  }
  if (!isGateMode(docs.mode)) {
    return 'gates.docs.mode is invalid';
  }
  if (
    docs.command !== undefined
    && (typeof docs.command !== 'string' || docs.command.length === 0)
  ) {
    return 'gates.docs.command is invalid';
  }

  const commands: Partial<Record<GateCommandName, ResolvedGateCommand>> = {};
  for (const name of GATE_COMMAND_NAMES) {
    const entry = code.commands[name];
    if (entry === undefined) {
      continue;
    }
    if (!isRecord(entry)) {
      return `invalid code command entry: ${name}`;
    }
    const resolved: ResolvedGateCommand = {
      command: entry.command as string | null,
      mode: entry.mode as GateMode,
    };
    if (entry.needs !== undefined) {
      resolved.needs = entry.needs as string;
    }
    commands[name] = resolved;
  }
  const canonicalDocs: GateSnapshotGates['docs'] = { mode: docs.mode as GateMode };
  if (docs.command !== undefined) {
    canonicalDocs.command = docs.command as string;
  }
  return {
    source: { mode: 'required' },
    code: { commands },
    docs: canonicalDocs,
  };
}

/**
 * Parse and self-verify a generated snapshot. Snapshot metadata that cannot be
 * recognized is `unversioned`; recognized metadata whose gates fail validation
 * or no longer match `generated.sha256` is `modified`. Both are preserved by
 * normalize, and the runner treats either as CONFIG.
 */
export function parseGateSnapshot(text: string): GateSnapshotParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, kind: 'unversioned', reason: 'not valid JSON' };
  }
  if (!isRecord(value)) {
    return { ok: false, kind: 'unversioned', reason: 'not a JSON object' };
  }
  if (value.version !== 1) {
    return { ok: false, kind: 'unversioned', reason: 'unsupported snapshot version' };
  }
  const generated = value.generated;
  if (
    !isRecord(generated)
    || typeof generated.dabVersion !== 'string'
    || generated.dabVersion.length === 0
    || !isHex64(generated.sha256)
  ) {
    return { ok: false, kind: 'unversioned', reason: 'missing generated metadata' };
  }
  const parsed = parseGates(value.gates);
  if (typeof parsed === 'string') {
    return { ok: false, kind: 'modified', reason: parsed };
  }
  if (hashGateGates(parsed) !== generated.sha256) {
    return {
      ok: false,
      kind: 'modified',
      reason: 'gates hash does not match generated.sha256',
    };
  }
  return {
    ok: true,
    snapshot: {
      version: 1,
      generated: { dabVersion: generated.dabVersion, sha256: generated.sha256 },
      gates: parsed,
    },
  };
}
