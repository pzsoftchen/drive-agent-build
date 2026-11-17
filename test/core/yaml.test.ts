import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigError } from '../../src/core/errors.ts';
import {
  loadYamlDocument,
  parseYamlDocument,
  saveYamlDocument,
} from '../../src/core/yaml.ts';
import { makeTempDir, removeTempDir } from '../helpers/tmp.ts';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await makeTempDir();
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => removeTempDir(dir)));
});

describe('yaml documents', () => {
  it('preserves leading comments when a generated section is updated', () => {
    const doc = parseYamlDocument(
      '# project manifest\nversion: 1\nproject:\n  name: demo\n',
      'dab.yaml',
    );
    doc.setIn(['generated', 'settings'], { path: '.claude/settings.json', sha256: 'abc' });

    const text = doc.toString({ lineWidth: 0 });
    expect(text).toContain('# project manifest');
    expect(text).toContain('generated:');
    expect(text).toContain('.claude/settings.json');
  });

  it('saves and reloads a document with a final newline', async () => {
    const dir = await tempDir();
    const file = join(dir, 'dab.yaml');
    const doc = parseYamlDocument('version: 1\nproject:\n  name: demo\n', file);
    doc.setIn(['generated', 'settings'], { path: 'x', sha256: 'y' });

    await saveYamlDocument(file, doc);

    const text = await readFile(file, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    const loaded = await loadYamlDocument(file);
    expect(loaded.toJS()).toMatchObject({
      version: 1,
      generated: { settings: { path: 'x', sha256: 'y' } },
    });
  });

  it('throws a ConfigError with the file name for invalid YAML', () => {
    expect(() => parseYamlDocument('a: [', 'broken.yaml')).toThrow(ConfigError);
    expect(() => parseYamlDocument('a: [', 'broken.yaml')).toThrow(/broken\.yaml/);
  });
});
