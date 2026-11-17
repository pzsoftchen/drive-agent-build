import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeProjectFile } from './project.ts';
import { makeTempDir } from './tmp.ts';

export interface GlobalFixture {
  home: string;
  agents: string;
  claude: string;
}

export async function makeGlobalFixture(): Promise<GlobalFixture> {
  const home = await makeTempDir('dab-home-');
  const agents = join(home, '.agents');
  for (const dir of ['agents', 'skills', 'rules', 'hooks', 'memory', 'policies', 'adapters']) {
    await mkdir(join(agents, dir), { recursive: true });
  }
  await writeProjectFile(home, '.agents/AGENTS.md', '# Global instructions\n');
  await writeProjectFile(home, '.agents/dab.yaml', `version: 2
scope: global
project:
  id: global
  name: Global
profile: feature
targets:
  - provider: claude-code
    enabled: true
    options:
      minVersion: 2.1.277
      instructions: symlink
paths:
  agents: .agents
  claude: .claude
`);
  await writeProjectFile(home, '.agents/policies/project.yaml', 'version: 1\n');
  await writeProjectFile(home, '.agents/adapters/claude-code.yaml', 'version: 1\nprovider: claude-code\n');
  await writeProjectFile(
    home,
    '.agents/agents/reviewer.md',
    '---\nname: reviewer\ndescription: Reviews changes.\n---\nReview.\n',
  );
  await writeProjectFile(
    home,
    '.agents/skills/doc-sync/SKILL.md',
    '---\nname: doc-sync\ndescription: Keeps docs paired.\n---\nSync docs.\n',
  );
  await writeProjectFile(home, '.agents/rules/testing.md', 'Run tests.\n');
  await writeProjectFile(
    home,
    '.agents/hooks/protect-generated/hook.yaml',
    'id: protect-generated\nevent: pre_tool\nmatcher: Edit|Write\nentry: run.mjs\nrunner: node\ntimeout: 10\norder: 10\n',
  );
  await writeProjectFile(home, '.agents/hooks/protect-generated/run.mjs', 'process.exit(0);\n');
  await writeProjectFile(home, '.agents/memory/INDEX.md', '# Memory\n');
  return { home, agents, claude: join(home, '.claude') };
}
