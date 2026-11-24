import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { discoverProjections } from '../../src/adapter/claude-code/projection.ts';
import { normalizeProject } from '../../src/commands/normalize.ts';
import { AUTHORING_SKILL_NAMES } from '../../src/init/practice-authoring.ts';
import {
  loadProjectManifest,
  resolveProjectPaths,
  updateGeneratedManifest,
} from '../../src/model/project-manifest.ts';
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

/**
 * Refresh recorded projection hashes after a test rewrites authored content,
 * without running normalize. This keeps drift checks focused on the state under
 * test instead of adding a `generated.manifest-stale` warning that would also
 * fail `--strict`.
 */
export async function syncGeneratedProjections(root: string): Promise<void> {
  const loaded = await loadProjectManifest(root);
  const generated = loaded.manifest.generated;
  if (generated === undefined) {
    throw new Error('project fixture has no generated manifest');
  }
  const paths = resolveProjectPaths(root, loaded.manifest);
  const discovered = await discoverProjections(root, paths);
  await updateGeneratedManifest(root, {
    targets: generated.targets.map((target) => (
      target.provider === 'claude-code'
        ? { ...target, projections: discovered.projections }
        : target
    )),
  });
}

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
  // Fixtures model an initialized project from before the practice layer: the
  // practice tests need a clean baseline where docs and authoring skills are
  // still missing. Drop the scaffolded practice artifacts and their generated
  // projection records so the remaining generated state stays self-consistent.
  const loaded = await loadProjectManifest(project.root);
  const generated = loaded.manifest.generated;
  if (generated !== undefined) {
    const practiceTargets = new Set(
      AUTHORING_SKILL_NAMES.map((name) => `.claude/skills/${name}`),
    );
    await updateGeneratedManifest(project.root, {
      targets: generated.targets.map((target) => ({
        ...target,
        projections: target.projections.filter(
          (projection) => !practiceTargets.has(projection.target),
        ),
      })),
    });
  }
  await rm(join(project.root, 'docs'), { recursive: true, force: true });
  for (const name of AUTHORING_SKILL_NAMES) {
    await rm(join(project.root, '.agents/skills', name), { recursive: true, force: true });
    await rm(join(project.root, '.claude/skills', name), { recursive: true, force: true });
  }
  return project;
}
