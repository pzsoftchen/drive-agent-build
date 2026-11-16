import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../../src/core/fs-atomic.ts';
import { makeTempDir } from './tmp.ts';

export interface ProjectFixture {
  root: string;
  agents: string;
  claude: string;
}

export async function makeProject(prefix = 'dab-model-'): Promise<ProjectFixture> {
  const root = await makeTempDir(prefix);
  const agents = join(root, '.agents');
  const claude = join(root, '.claude');
  await mkdir(join(agents, 'agents'), { recursive: true });
  await mkdir(join(agents, 'skills'), { recursive: true });
  await mkdir(join(agents, 'rules'), { recursive: true });
  await mkdir(join(agents, 'hooks'), { recursive: true });
  await mkdir(join(agents, 'memory'), { recursive: true });
  await mkdir(claude, { recursive: true });
  return { root, agents, claude };
}

export async function writeProjectFile(
  root: string,
  relativePath: string,
  content: string,
): Promise<void> {
  await writeFileAtomic(join(root, relativePath), content);
}
