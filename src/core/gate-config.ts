import { join } from 'node:path';
import type { Diagnostic } from './diagnostics.ts';
import { ConfigError, DabError } from './errors.ts';
import { lstatOrNull } from './fs-atomic.ts';
import { assertRealPathInsideRoot } from './paths.ts';
import { loadYamlDocument } from './yaml.ts';
import { GateConfigSchema, type GateConfig } from '../model/gates.ts';

export const GATE_CONFIG_PATH = '.agents/gates.yaml';

export interface LoadedGateConfig {
  exists: boolean;
  config?: GateConfig;
  diagnostics: Diagnostic[];
}

function zodMessage(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path.length === 0 ? issue.message : `${path}: ${issue.message}`;
    })
    .join('; ');
}

function lineFrom(error: DabError): number | undefined {
  const details = error.details;
  if (typeof details !== 'object' || details === null || !('line' in details)) {
    return undefined;
  }
  const line = (details as { line?: unknown }).line;
  return typeof line === 'number' ? line : undefined;
}

function dabErrorDiagnostic(error: DabError): Diagnostic {
  const line = lineFrom(error);
  if (error instanceof ConfigError && error.code === 'config.yaml') {
    return {
      code: 'gate.config-yaml',
      severity: 'error',
      message: error.message,
      file: GATE_CONFIG_PATH,
      ...(line === undefined ? {} : { line }),
      hint: error.hint ?? 'Fix the YAML syntax in .agents/gates.yaml before running DAB again.',
    };
  }
  return {
    code: error.code,
    severity: 'error',
    message: error.message,
    file: GATE_CONFIG_PATH,
    ...(line === undefined ? {} : { line }),
    hint: error.hint ?? 'Fix .agents/gates.yaml; DAB never overwrites the authored file.',
  };
}

/**
 * Read and validate the authored `.agents/gates.yaml`. Missing files are a
 * normal absent state; parse and schema failures become blocking diagnostics
 * so callers can report them instead of crashing. This function never writes.
 */
export async function loadGateConfig(root: string): Promise<LoadedGateConfig> {
  const absolute = join(root, '.agents', 'gates.yaml');
  if ((await lstatOrNull(absolute)) === null) {
    return { exists: false, diagnostics: [] };
  }

  let value: unknown;
  try {
    await assertRealPathInsideRoot(root, GATE_CONFIG_PATH);
    value = (await loadYamlDocument(absolute)).toJS();
  } catch (error) {
    if (error instanceof DabError) {
      return { exists: true, diagnostics: [dabErrorDiagnostic(error)] };
    }
    return {
      exists: true,
      diagnostics: [{
        code: 'gate.config-unreadable',
        severity: 'error',
        message: `gate configuration cannot be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
        file: GATE_CONFIG_PATH,
        hint: 'Fix the file permissions or replace .agents/gates.yaml.',
      }],
    };
  }

  const parsed = GateConfigSchema.safeParse(value);
  if (!parsed.success) {
    return {
      exists: true,
      diagnostics: [{
        code: 'gate.config-invalid',
        severity: 'error',
        message: `invalid ${GATE_CONFIG_PATH}: ${zodMessage(parsed.error)}`,
        file: GATE_CONFIG_PATH,
        hint: 'Fix the authored gate configuration; DAB never overwrites .agents/gates.yaml.',
      }],
    };
  }

  return { exists: true, config: parsed.data, diagnostics: [] };
}
