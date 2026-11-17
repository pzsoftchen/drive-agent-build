import { normalizeProject } from '../../src/commands/normalize.ts';
import { makeProject, writeProjectFile, type ProjectFixture } from './project.ts';

const projectPolicy = `version: 1
defaultMode: default
read:
  deny:
    - .env
write:
  deny:
    - .claude/settings.json
execute:
  ask:
    - git push
capabilities:
  deny:
    - web
`;

const adapterPolicy = `version: 1
provider: claude-code
permissions:
  deny:
    - Bash(sudo:*)
`;

const hookMetadata = `id: protect-generated
event: pre_tool
matcher: Edit|Write|MultiEdit
entry: run.mjs
runner: node
timeout: 10
order: 10
`;

export async function populateProject(project: ProjectFixture): Promise<void> {
  await writeProjectFile(project.root, 'AGENTS.md', '# Project\n\nRead this first.\n');
  await writeProjectFile(
    project.root,
    'dab.yaml',
    `version: 2
scope: project
project:
  id: demo
  name: Demo
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
`,
  );
  await writeProjectFile(project.root, '.agents/policies/project.yaml', projectPolicy);
  await writeProjectFile(project.root, '.agents/adapters/claude-code.yaml', adapterPolicy);
  await writeProjectFile(
    project.root,
    '.agents/agents/reviewer.md',
    '---\nname: reviewer\ndescription: Reviews changes.\ntools: Read, Grep, Glob\n---\nReview.\n',
  );
  await writeProjectFile(
    project.root,
    '.agents/skills/doc-sync/SKILL.md',
    '---\nname: doc-sync\ndescription: Keeps docs paired.\n---\nSync docs.\n',
  );
  await writeProjectFile(project.root, '.agents/rules/testing.md', 'Run tests.\n');
  await writeProjectFile(
    project.root,
    '.agents/hooks/protect-generated/hook.yaml',
    hookMetadata,
  );
  await writeProjectFile(
    project.root,
    '.agents/hooks/protect-generated/run.mjs',
    'process.exit(0);\n',
  );
  await writeProjectFile(project.root, '.agents/memory/INDEX.md', '# Memory\n');
}

export async function makeInitializedProject(): Promise<ProjectFixture> {
  const project = await makeProject();
  await populateProject(project);
  await normalizeProject({ cwd: project.root });
  return project;
}
