import { formatGateRunnerMarker } from '../core/gate-artifacts.ts';
import { sha256 } from '../core/hash.ts';

/**
 * Stable runner body. Keep this text free of project-specific commands and of
 * DAB version strings: only the marker line changes between DAB releases, so
 * an unmodified runner is provably current through its body hash.
 *
 * This is a plain script rather than a generated command list. It reads
 * `scripts/dab-gates.json`, runs the source gate first, then every configured
 * code and docs command without short-circuiting.
 */
export const GATE_RUNNER_BODY = `import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMAND_NAMES = ['test', 'typecheck', 'lint', 'build'];
const MODES = ['required', 'check', 'advisory', 'off'];
const DAB_PACKAGE = '@saydone/dab';
const SNAPSHOT_FILE = fileURLToPath(new URL('./dab-gates.json', import.meta.url));
const PROJECT_ROOT = dirname(dirname(SNAPSHOT_FILE));
const MAX_OUTPUT = 4000;
const SAFE_TOKENS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.,:=+/@%-';
const HEX = '0123456789abcdef';
const WINDOWS_WRAPPERS = [
  ['./mvnw', 'mvnw.cmd'],
  ['./gradlew', 'gradlew.bat'],
];

let jsonMode = false;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      return false;
    }
  }
  return true;
}

function isMode(value) {
  return typeof value === 'string' && MODES.includes(value);
}

function isHex64(value) {
  if (typeof value !== 'string' || value.length !== 64) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!HEX.includes(value[index])) {
      return false;
    }
  }
  return true;
}

function canonicalGates(gates) {
  const commands = {};
  for (const name of COMMAND_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(gates.code.commands, name)) {
      continue;
    }
    const entry = gates.code.commands[name];
    const resolved = { command: entry.command, mode: entry.mode };
    if (entry.needs !== undefined) {
      resolved.needs = entry.needs;
    }
    commands[name] = resolved;
  }
  const docs = { mode: gates.docs.mode };
  if (gates.docs.command !== undefined) {
    docs.command = gates.docs.command;
  }
  return { source: { mode: 'required' }, code: { commands: commands }, docs: docs };
}

function gatesProblem(gates) {
  if (!isRecord(gates)) {
    return 'gates must be an object';
  }
  if (!hasOnlyKeys(gates, ['source', 'code', 'docs'])) {
    return 'gates has unknown keys';
  }
  if (!isRecord(gates.source) || !hasOnlyKeys(gates.source, ['mode']) || gates.source.mode !== 'required') {
    return 'gates.source.mode must be required';
  }
  if (!isRecord(gates.code) || !hasOnlyKeys(gates.code, ['commands']) || !isRecord(gates.code.commands)) {
    return 'gates.code.commands must be an object';
  }
  for (const name of Object.keys(gates.code.commands)) {
    if (!COMMAND_NAMES.includes(name)) {
      return 'unknown code command: ' + name;
    }
    const entry = gates.code.commands[name];
    if (!isRecord(entry) || !hasOnlyKeys(entry, ['command', 'mode', 'needs'])) {
      return 'invalid code command entry: ' + name;
    }
    if (!Object.prototype.hasOwnProperty.call(entry, 'command')) {
      return 'code command has no command field: ' + name;
    }
    if (entry.command !== null && (typeof entry.command !== 'string' || entry.command.length === 0)) {
      return 'code command must be a string or null: ' + name;
    }
    if (!isMode(entry.mode)) {
      return 'invalid code command mode: ' + name;
    }
    if (entry.needs !== undefined && (typeof entry.needs !== 'string' || entry.needs.length === 0)) {
      return 'invalid code command needs: ' + name;
    }
  }
  if (!isRecord(gates.docs) || !hasOnlyKeys(gates.docs, ['mode', 'command'])) {
    return 'gates.docs is invalid';
  }
  if (!isMode(gates.docs.mode)) {
    return 'gates.docs.mode is invalid';
  }
  if (gates.docs.command !== undefined && (typeof gates.docs.command !== 'string' || gates.docs.command.length === 0)) {
    return 'gates.docs.command is invalid';
  }
  return undefined;
}

function hashGates(gates) {
  return createHash('sha256').update(JSON.stringify(canonicalGates(gates))).digest('hex');
}

function loadSnapshot() {
  let text;
  try {
    text = readFileSync(SNAPSHOT_FILE, 'utf8');
  } catch (error) {
    return { error: 'cannot read scripts/dab-gates.json: ' + error.message };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: 'scripts/dab-gates.json is not valid JSON' };
  }
  if (!isRecord(value)) {
    return { error: 'scripts/dab-gates.json is not a JSON object' };
  }
  if (value.version !== 1) {
    return { error: 'unsupported gate snapshot version' };
  }
  const generated = value.generated;
  if (!isRecord(generated) || typeof generated.dabVersion !== 'string' || !isHex64(generated.sha256)) {
    return { error: 'gate snapshot generated metadata is invalid' };
  }
  const problem = gatesProblem(value.gates);
  if (problem !== undefined) {
    return { error: 'gate snapshot is invalid: ' + problem };
  }
  if (hashGates(value.gates) !== generated.sha256) {
    return { error: 'gate snapshot gates hash does not match generated.sha256' };
  }
  return { gates: canonicalGates(value.gates) };
}

function normalizeCommand(command) {
  if (process.platform !== 'win32') {
    return command;
  }
  for (const pair of WINDOWS_WRAPPERS) {
    const posix = pair[0];
    const windows = pair[1];
    if (command === posix) {
      return windows;
    }
    if (command.startsWith(posix + ' ') || command.startsWith(posix + '\\t')) {
      return windows + command.slice(posix.length);
    }
  }
  return command;
}

function shellQuote(value) {
  let safe = value.length > 0;
  for (const character of value) {
    if (!SAFE_TOKENS.includes(character)) {
      safe = false;
      break;
    }
  }
  if (safe) {
    return value;
  }
  if (process.platform === 'win32') {
    return '"' + value + '"';
  }
  let escaped = '';
  for (const character of value) {
    if (character === '"' || character === '$' || character.charCodeAt(0) === 92 || character.charCodeAt(0) === 96) {
      escaped += String.fromCharCode(92);
    }
    escaped += character;
  }
  return '"' + escaped + '"';
}

function commandWorks(command) {
  const probe = spawnSync(command, { shell: true, stdio: 'ignore' });
  return probe.status === 0;
}

function resolveDab() {
  const fromEnv = process.env.DAB_BIN;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return shellQuote(fromEnv);
  }
  const binaryName = process.platform === 'win32' ? 'dab.cmd' : 'dab';
  const local = join(PROJECT_ROOT, 'node_modules', '.bin', binaryName);
  if (existsSync(local)) {
    return shellQuote(local);
  }
  if (commandWorks('dab --version')) {
    return 'dab';
  }
  const npx = 'npx --no-install ' + DAB_PACKAGE;
  if (commandWorks(npx + ' --version')) {
    return npx;
  }
  return undefined;
}

function errorMessage(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') {
    return error.message;
  }
  return String(error);
}

function summarize(stdout, stderr) {
  const text = (stdout + stderr).trim();
  if (text.length <= MAX_OUTPUT) {
    return text;
  }
  return text.slice(text.length - MAX_OUTPUT);
}

function runCommand(command) {
  return new Promise(function (resolve) {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = function (value) {
      if (settled) {
        return;
      }
      settled = true;
      value.durationMs = Date.now() - started;
      value.stdout = stdout;
      value.stderr = stderr;
      resolve(value);
    };
    let child;
    try {
      child = spawn(command, {
        shell: true,
        cwd: PROJECT_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({ error: error });
      return;
    }
    child.stdout.on('data', function (chunk) {
      stdout += chunk.toString();
      if (!jsonMode) {
        process.stdout.write(chunk);
      }
    });
    child.stderr.on('data', function (chunk) {
      stderr += chunk.toString();
      if (!jsonMode) {
        process.stderr.write(chunk);
      }
    });
    child.on('error', function (error) {
      finish({ error: error });
    });
    child.on('close', function (code) {
      finish({ exitCode: code === null ? 1 : code });
    });
  });
}

function result(fields) {
  const item = {
    gate: fields.gate,
    status: fields.status,
    durationMs: fields.durationMs,
  };
  if (fields.name !== undefined) {
    item.name = fields.name;
  }
  if (fields.mode !== undefined) {
    item.mode = fields.mode;
  }
  if (fields.command !== undefined) {
    item.command = fields.command;
  }
  if (fields.exitCode !== undefined) {
    item.exitCode = fields.exitCode;
  }
  if (fields.message !== undefined) {
    item.message = fields.message;
  }
  if (fields.output !== undefined && fields.output.length > 0) {
    item.output = fields.output;
  }
  return item;
}

async function runGate(gate, name, command, mode, needs) {
  if (mode === 'off') {
    return result({
      gate: gate,
      name: name,
      mode: mode,
      status: 'SKIP',
      durationMs: 0,
      message: 'gate is disabled by mode: off',
    });
  }
  if (command === null) {
    return result({
      gate: gate,
      name: name,
      mode: mode,
      status: 'CONFIG',
      durationMs: 0,
      message: needs === undefined ? 'command needs project configuration' : needs,
    });
  }
  const normalized = normalizeCommand(command);
  const outcome = await runCommand(normalized);
  if (outcome.error !== undefined) {
    return result({
      gate: gate,
      name: name,
      mode: mode,
      command: normalized,
      status: 'ERROR',
      durationMs: outcome.durationMs,
      message: 'command could not start: ' + errorMessage(outcome.error),
    });
  }
  const succeeded = outcome.exitCode === 0;
  const status = succeeded ? 'PASS' : (mode === 'required' ? 'FAIL' : 'WARN');
  return result({
    gate: gate,
    name: name,
    mode: mode,
    command: normalized,
    status: status,
    exitCode: outcome.exitCode,
    durationMs: outcome.durationMs,
    output: summarize(outcome.stdout, outcome.stderr),
  });
}

async function runSourceGate() {
  const dab = resolveDab();
  if (dab === undefined) {
    return result({
      gate: 'source',
      mode: 'required',
      status: 'ERROR',
      durationMs: 0,
      message: 'DAB binary not found; install @saydone/dab or set DAB_BIN (npx --no-install never uses the network)',
    });
  }
  const command = dab + ' detect --strict';
  const outcome = await runCommand(command);
  if (outcome.error !== undefined) {
    return result({
      gate: 'source',
      mode: 'required',
      command: command,
      status: 'ERROR',
      durationMs: outcome.durationMs,
      message: 'source gate could not start: ' + errorMessage(outcome.error),
    });
  }
  return result({
    gate: 'source',
    mode: 'required',
    command: command,
    status: outcome.exitCode === 0 ? 'PASS' : 'FAIL',
    exitCode: outcome.exitCode,
    durationMs: outcome.durationMs,
    output: summarize(outcome.stdout, outcome.stderr),
  });
}

async function runConfiguredGates(gates, results) {
  const names = COMMAND_NAMES.filter(function (name) {
    return Object.prototype.hasOwnProperty.call(gates.code.commands, name);
  });
  if (names.length === 0) {
    results.push(result({
      gate: 'code',
      status: 'WARN',
      durationMs: 0,
      message: 'no code commands are configured; run dab normalize or add commands to .agents/gates.yaml',
    }));
  }
  for (const name of names) {
    const entry = gates.code.commands[name];
    results.push(await runGate('code', name, entry.command, entry.mode, entry.needs));
  }

  if (gates.docs.mode === 'off') {
    results.push(result({
      gate: 'docs',
      mode: 'off',
      status: 'SKIP',
      durationMs: 0,
      message: 'docs gate is disabled by mode: off',
    }));
  } else if (gates.docs.command === undefined) {
    if (gates.docs.mode === 'required') {
      results.push(result({
        gate: 'docs',
        mode: 'required',
        status: 'CONFIG',
        durationMs: 0,
        message: 'docs gate is required but has no command',
      }));
    } else {
      results.push(result({
        gate: 'docs',
        mode: gates.docs.mode,
        status: 'SKIP',
        durationMs: 0,
        message: 'no docs command configured; generated docs are covered by the source gate',
      }));
    }
  } else {
    results.push(await runGate('docs', undefined, gates.docs.command, gates.docs.mode, undefined));
  }
}

function resolveExitCode(results, strict) {
  let code = 0;
  for (const item of results) {
    if (item.status === 'ERROR') {
      code = 2;
      continue;
    }
    if (item.status === 'CONFIG') {
      if (item.mode === 'required' || item.mode === undefined) {
        code = Math.max(code, 2);
      } else if (strict) {
        code = Math.max(code, 1);
      }
      continue;
    }
    if (item.status === 'FAIL') {
      code = Math.max(code, 1);
      continue;
    }
    if (item.status === 'WARN' && strict) {
      code = Math.max(code, 1);
    }
  }
  return code;
}

function printResult(item) {
  const label = item.name === undefined ? item.gate : item.gate + '.' + item.name;
  let line = 'GATE ' + label + ' ' + item.status;
  if (item.command !== undefined) {
    line += ' (' + item.command + ')';
  }
  if (item.exitCode !== undefined) {
    line += ' exit ' + item.exitCode;
  }
  line += ' ' + item.durationMs + 'ms';
  process.stdout.write(line + '\\n');
  if (item.message !== undefined) {
    process.stdout.write('  ' + item.message + '\\n');
  }
}

async function main() {
  const args = process.argv.slice(2);
  let strict = false;
  for (const argument of args) {
    if (argument === '--json') {
      jsonMode = true;
    } else if (argument === '--strict') {
      strict = true;
    } else {
      process.stderr.write('dab-check: unknown argument: ' + argument + '\\n');
      process.exitCode = 2;
      return;
    }
  }

  const started = Date.now();
  const results = [];

  results.push(await runSourceGate());

  const loaded = loadSnapshot();
  if (loaded.error !== undefined) {
    results.push(result({
      gate: 'config',
      name: 'snapshot',
      mode: 'required',
      status: 'CONFIG',
      durationMs: 0,
      message: loaded.error + '; run dab normalize',
    }));
  } else {
    await runConfiguredGates(loaded.gates, results);
  }

  const exitCode = resolveExitCode(results, strict);
  if (jsonMode) {
    const payload = {
      version: 1,
      strict: strict,
      ok: exitCode === 0,
      exitCode: exitCode,
      durationMs: Date.now() - started,
      results: results,
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + '\\n');
  } else {
    for (const item of results) {
      printResult(item);
    }
    process.stdout.write('GATE RESULT ' + (exitCode === 0 ? 'PASS' : 'FAIL') + ' exit ' + exitCode + '\\n');
  }
  process.exitCode = exitCode;
}

main().catch(function (error) {
  process.stderr.write('dab-check: ' + errorMessage(error) + '\\n');
  process.exitCode = 2;
});
`;

export function renderGateRunner(version: string): string {
  const marker = formatGateRunnerMarker({
    version,
    sha256: sha256(GATE_RUNNER_BODY),
  });
  return `${marker}\n${GATE_RUNNER_BODY}`;
}
