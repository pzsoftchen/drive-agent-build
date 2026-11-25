import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadGateConfig } from '../../src/core/gate-config.ts';
import { makeTempDir } from '../helpers/tmp.ts';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await makeTempDir('dab-gates-');
  dirs.push(dir);
  return dir;
}

async function writeConfig(root: string, content: string): Promise<void> {
  await mkdir(join(root, '.agents'), { recursive: true });
  await writeFile(join(root, '.agents/gates.yaml'), content);
}

const VALID_CONFIG = `version: 1
gates:
  source:
    mode: required
  code:
    commands:
      test:
        command: pnpm test
        mode: required
  docs:
    mode: check
`;

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('loadGateConfig', () => {
  it('reports a missing file without diagnostics', async () => {
    const root = await tempDir();

    const result = await loadGateConfig(root);

    expect(result.exists).toBe(false);
    expect(result.config).toBeUndefined();
    expect(result.diagnostics).toEqual([]);
  });

  it('maps invalid YAML to a governed error diagnostic', async () => {
    const root = await tempDir();
    await writeConfig(root, 'version: [1\n');

    const result = await loadGateConfig(root);

    expect(result.exists).toBe(true);
    expect(result.config).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: 'gate.config-yaml',
      severity: 'error',
      file: '.agents/gates.yaml',
    });
    expect(result.diagnostics[0]?.message).toContain('invalid YAML');
  });

  it('maps schema errors to a governed error with the config path', async () => {
    const root = await tempDir();
    await writeConfig(root, 'version: 2\ngates: {}\n');

    const result = await loadGateConfig(root);

    expect(result.exists).toBe(true);
    expect(result.config).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: 'gate.config-invalid',
      severity: 'error',
      file: '.agents/gates.yaml',
    });
    expect(result.diagnostics[0]?.message).toContain('invalid .agents/gates.yaml');
    expect(result.diagnostics[0]?.hint).toBeDefined();
  });

  it('rejects source.mode off during load', async () => {
    const root = await tempDir();
    await writeConfig(root, `version: 1
gates:
  source:
    mode: off
  code:
    commands: {}
  docs:
    mode: check
`);

    const result = await loadGateConfig(root);

    expect(result.config).toBeUndefined();
    expect(result.diagnostics[0]).toMatchObject({
      code: 'gate.config-invalid',
      severity: 'error',
      file: '.agents/gates.yaml',
    });
  });

  it('returns the parsed config for a valid file', async () => {
    const root = await tempDir();
    await writeConfig(root, VALID_CONFIG);

    const result = await loadGateConfig(root);

    expect(result.exists).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.config?.version).toBe(1);
    expect(result.config?.gates.source.mode).toBe('required');
    expect(result.config?.gates.code.commands.test).toEqual({
      command: 'pnpm test',
      mode: 'required',
    });
    expect(result.config?.gates.docs).toEqual({ mode: 'check' });
  });
});
