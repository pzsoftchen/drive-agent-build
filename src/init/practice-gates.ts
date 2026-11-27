import type { PracticeContext, PracticePack, PracticeTargetSet } from './practice.ts';
import {
  GATE_CONFIG_PATH,
  GATE_RUNNER_PATH,
  GATE_SNAPSHOT_PATH,
  planGateArtifacts,
} from './gate-artifacts.ts';

const GATE_PATHS = [GATE_CONFIG_PATH, GATE_RUNNER_PATH, GATE_SNAPSHOT_PATH] as const;

function verificationTargets(context: PracticeContext): PracticeTargetSet {
  if (context.scope !== 'project') {
    return { paths: [] };
  }
  return {
    paths: [...GATE_PATHS],
    directories: ['scripts'],
  };
}

/**
 * Project-only verification pack. It owns the missing-file plan for the
 * authored gate config and the generated runner/snapshot.
 *
 * The shared gate planner is authoritative for content: an existing
 * `.agents/gates.yaml` is compiled into the snapshot with no scanner backfill,
 * and an invalid config yields no planned content. The practice planner only
 * writes files that are still missing, so an existing config, runner or
 * snapshot is never overwritten. Managed updates of existing artifacts belong
 * to normalize, not to this pack.
 */
export const verificationPack: PracticePack = {
  id: 'verification',
  targets: verificationTargets,
  async files(context) {
    if (context.scope !== 'project') {
      return {};
    }
    const plan = await planGateArtifacts({
      root: context.root,
      scan: context.scan,
      version: context.version,
    });
    const creates = new Set(
      plan.actions
        .filter((action) => action.kind === 'create')
        .map((action) => action.path),
    );
    const files: Record<string, string> = {};
    for (const [path, content] of Object.entries(plan.files)) {
      if (creates.has(path)) {
        files[path] = content;
      }
    }
    return files;
  },
};
