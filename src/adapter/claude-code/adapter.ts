import type { Diagnostic } from '../../core/diagnostics.ts';
import { withFixWarning } from '../../core/diagnostics.ts';
import { sha256 } from '../../core/hash.ts';
import {
  checkProjections,
  checkSettings,
  checkShim,
} from '../../detect/checks.ts';
import { getGeneratedTarget } from '../../model/project-manifest.ts';
import type {
  GeneratedTarget,
  Projection,
  TargetProvider,
} from '../../model/types.ts';
import type {
  TargetAdapter,
  TargetContext,
  TargetDetectOutcome,
  TargetFactStatus,
  TargetNormalizeInput,
  TargetNormalizePlan,
} from '../types.ts';
import { parseClaudeTargetOptions } from './options.ts';
import { compilePolicy } from './policy-compile.ts';
import {
  applyClaudeMdShim,
  applyProjectionActions,
  discoverProjections,
  planClaudeMdShim,
  planProjectionActions,
  renderClaudeMdShim,
  type ProjectionAction,
} from './projection.ts';
import { applySettings, planSettings } from './settings-plan.ts';
import { renderSettings } from './settings.ts';
import { checkClaudeCode } from './version.ts';

export interface ClaudeTargetNormalizePlan extends TargetNormalizePlan {
  // Compatibility bridge for the single-target normalize command. Task 4
  // switches the public result to string actions and can drop this field.
  projectionActions: ProjectionAction[];
}

function describeProjectionAction(action: ProjectionAction): string {
  switch (action.type) {
    case 'add-manifest':
    case 'remove-manifest':
      return `${action.type} ${action.projection.target}`;
    default:
      return `${action.type} ${action.projection.target} -> ${action.linkTarget}`;
  }
}

function dedupeDiagnostics(items: readonly Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = [item.code, item.severity, item.file ?? '', item.line ?? '', item.message].join('|');
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function hasBackendVersionError(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some(
    (item) => item.code === 'backend.version' && item.severity === 'error',
  );
}

function projectionKey(kind: Projection['kind'], name: string): string {
  return `${kind}\0${name}`;
}

function projectedStatus(
  kind: 'agent' | 'skill' | 'rule',
  name: string,
  projected: ReadonlySet<string>,
): TargetFactStatus {
  if (projected.has(projectionKey(kind, name))) {
    return { kind, name, status: 'native' };
  }
  return {
    kind,
    name,
    status: 'missing',
    detail: 'no projection was generated for this fact',
  };
}

async function normalize(input: TargetNormalizeInput): Promise<ClaudeTargetNormalizePlan> {
  const options = parseClaudeTargetOptions(input.target);
  const generatedRecord = getGeneratedTarget(input.manifest, 'claude-code');
  const backend = await checkClaudeCode(options.minVersion, input.runner);
  const diagnostics: Diagnostic[] = [...backend.diagnostics];

  if (hasBackendVersionError(diagnostics)) {
    return {
      provider: 'claude-code',
      diagnostics,
      actions: [],
      projectionActions: [],
      generated: {
        provider: 'claude-code',
        settings: null,
        instructions: null,
        projections: [],
      },
      apply: async () => ({ applied: 0, backups: [] }),
    };
  }

  const discovered = await discoverProjections(input.paths.root, input.paths, {
    agents: input.facts.agents.items,
    skills: input.facts.skills.items,
    rules: input.facts.rules.items,
  });
  diagnostics.push(...discovered.diagnostics);

  const compiled = compilePolicy(
    input.facts.policies.project,
    input.facts.policies.adapter,
    input.facts.hooks.items,
  );
  diagnostics.push(...compiled.diagnostics);
  const settingsContent = renderSettings(compiled.effective);

  const settingsPlan = await planSettings(
    input.paths.root,
    generatedRecord,
    settingsContent,
  );
  const shimPlan = await planClaudeMdShim(input.paths.root, {
    enabled: options.instructions !== 'disabled',
    generated: generatedRecord,
    fix: input.fix,
  });
  const projectionPlan = await planProjectionActions(
    input.paths.root,
    discovered.projections,
    generatedRecord,
    { fix: input.fix },
  );

  const conflictDiagnostics = [
    ...projectionPlan.conflicts,
    ...(shimPlan.conflict === undefined ? [] : [shimPlan.conflict]),
    ...(settingsPlan.conflict === undefined ? [] : [settingsPlan.conflict]),
  ];
  diagnostics.push(
    ...conflictDiagnostics.map((item) => (input.fix ? withFixWarning(item) : item)),
  );

  const shimContent = renderClaudeMdShim();
  const shimRemoved = shimPlan.action === 'remove' || shimPlan.action === 'backup-and-remove';
  const generated: GeneratedTarget = {
    provider: 'claude-code',
    settings: {
      path: settingsPlan.path,
      sha256: sha256(settingsContent),
    },
    instructions: options.instructions === 'generated' && !shimRemoved
      ? {
        path: '.claude/CLAUDE.md',
        mode: 'generated',
        sha256: sha256(shimContent),
      }
      : null,
    projections: discovered.projections,
  };

  const actions = projectionPlan.actions.map(describeProjectionAction);
  if (shimPlan.action !== 'none') {
    actions.push(`instructions ${shimPlan.action} .claude/CLAUDE.md`);
  }
  if (settingsPlan.action !== 'none') {
    actions.push(`settings ${settingsPlan.action} ${settingsPlan.path}`);
  }

  return {
    provider: 'claude-code',
    diagnostics,
    actions,
    projectionActions: [...projectionPlan.actions],
    generated,
    settings: {
      path: settingsPlan.path,
      sha256: settingsPlan.sha256,
      changed: settingsPlan.changed,
    },
    instructions: {
      path: '.claude/CLAUDE.md',
      mode: 'generated',
      action: shimPlan.action,
      sha256: sha256(shimContent),
    },
    apply: async ({ backupRoot }) => {
      const projectionApplied = await applyProjectionActions(
        input.paths.root,
        projectionPlan.actions,
        { backupRoot, sourceRoot: '.agents' },
      );
      const shimBackups = await applyClaudeMdShim(
        input.paths.root,
        shimPlan.action,
        { backupRoot },
      );
      const settingsBackups = await applySettings(
        input.paths.root,
        settingsPlan,
        settingsContent,
        backupRoot,
      );
      return {
        applied: projectionApplied.applied
          + (shimPlan.action === 'none' ? 0 : 1)
          + (settingsPlan.action === 'none' ? 0 : 1),
        backups: [...projectionApplied.backups, ...shimBackups, ...settingsBackups],
      };
    },
  };
}

async function detect(input: TargetContext): Promise<TargetDetectOutcome> {
  const options = parseClaudeTargetOptions(input.target);
  const generated = getGeneratedTarget(input.manifest, 'claude-code');
  const diagnostics: Diagnostic[] = [];

  const backend = await checkClaudeCode(options.minVersion, input.runner);
  diagnostics.push(...backend.diagnostics);

  const discovered = await discoverProjections(input.paths.root, input.paths, {
    agents: input.facts.agents.items,
    skills: input.facts.skills.items,
    rules: input.facts.rules.items,
  });
  diagnostics.push(...discovered.diagnostics);

  const compiled = compilePolicy(
    input.facts.policies.project,
    input.facts.policies.adapter,
    input.facts.hooks.items,
  );
  diagnostics.push(...compiled.diagnostics);
  const expectedSettings = renderSettings(compiled.effective);

  diagnostics.push(
    ...await checkSettings(input.paths.root, input.paths, generated, expectedSettings),
  );
  diagnostics.push(
    ...await checkShim(input.paths.root, {
      enabled: options.instructions !== 'disabled',
      generated,
    }),
  );
  diagnostics.push(
    ...await checkProjections(input.paths.root, input.paths, discovered.projections, generated),
  );

  const projected = new Set(
    discovered.projections.map((item) => projectionKey(item.kind, item.name)),
  );
  const statuses: TargetFactStatus[] = [
    { kind: 'instructions', name: 'CLAUDE.md', status: 'generated' },
    ...input.facts.agents.items.map((item): TargetFactStatus =>
      projectedStatus('agent', item.name, projected)),
    ...input.facts.skills.items.map((item): TargetFactStatus =>
      projectedStatus('skill', item.name, projected)),
    ...input.facts.rules.items.map((item): TargetFactStatus =>
      projectedStatus('rule', item.name, projected)),
    { kind: 'policy', name: 'project', status: 'mapped' },
    ...input.facts.hooks.items.map((item): TargetFactStatus =>
      ({ kind: 'hook', name: item.spec.id, status: 'mapped' })),
  ];

  return {
    provider: 'claude-code',
    diagnostics: dedupeDiagnostics(diagnostics),
    statuses,
  };
}

export const claudeCodeAdapter = {
  provider: 'claude-code' as TargetProvider,
  normalize,
  detect,
} satisfies TargetAdapter;
