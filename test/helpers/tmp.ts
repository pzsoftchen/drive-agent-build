import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function makeTempDir(prefix = 'dab-test-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
