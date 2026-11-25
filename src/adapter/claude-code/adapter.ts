import type { Diagnostic } from '../../core/diagnostics.ts';
import { withFixWarning } from '../../core/diagnostics.ts';
import { DabError } from '../../core/errors.ts';
import { sha256 } from '../../core/hash.ts';
import {
  checkInstructions,
  checkProjections,
  checkSettings,
} from '../../detect/checks.ts';
import { getGeneratedTarget } from '../../model/project-manifest.ts';
import { loadClaudeCodePolicy } from '../../model/policy.ts';
import type {
  ClaudeCodePolicy,
  GeneratedTarget,
  ProjectPaths,
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
import {
  applyInstructions,
  planInstructions,
} from './instructions.ts';
import { parseClaudeTargetOptions } from './options.ts';
import { compilePolicy } from './policy-compile.ts';
import {
  applyProjectionActions,
  discoverProjections,
  planProjectionActions,
  type ProjectionAction,
} from './projection.ts';
import {
  applySettings,
  globalSettingsWarning,
  planSettings,
  type SettingsPlan,
} from './settings-plan.ts';
import { renderSettings } from './settings.ts';
import { checkClaudeCode } from './version.ts';

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

function policyDiagnostic(error: DabError): Diagnostic {
  return {
    code: error.code,
    severity: 'error',
    message: error.message,
    file: '.agents/adapters/claude-code.yaml',
    ...(error.hint === undefined ? {} : { hint: error.hint }),
  };
}

async function loadTargetPolicy(
  paths: ProjectPaths,
): Promise<{ policy: ClaudeCodePolicy } | { diagnostic: Diagnostic }> {
  try {
    const loaded = await loadClaudeCodePolicy(paths);
    return { policy: loaded.policy };
  } catch (error) {
    if (error instanceof DabError) {
      return { diagnostic: policyDiagnostic(error) };
    }
    throw error;
  }
}

function emptyPlan(diagnostics: Diagnostic[]): TargetNormalizePlan {
  return {
    provider: 'claude-code',
    diagnostics,
    actions: [],
    generated: {
      provider: 'claude-code',
      settings: null,
      instructions: null,
      projections: [],
    },
    apply: async () => ({ applied: 0, backups: [] }),
  };
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

async function normalize(input: TargetNormalizeInput): Promise<TargetNormalizePlan> {
  const options = parseClaudeTargetOptions(input.target);
  const generatedRecord = getGeneratedTarget(input.manifest, 'claude-code');
  const targetPolicy = await loadTargetPolicy(input.paths);
  if ('diagnostic' in targetPolicy) {
    return emptyPlan([targetPolicy.diagnostic]);
  }
  const backend = await checkClaudeCode(options.minVersion, input.runner);
  const diagnostics: Diagnostic[] = [...backend.diagnostics];

  if (hasBackendVersionError(diagnostics)) {
    return emptyPlan(diagnostics);
  }

  const discovered = await discoverProjections(input.paths.root, input.paths, {
    agents: input.facts.agents.items,
    skills: input.facts.skills.items,
    rules: input.facts.rules.items,
  });
  diagnostics.push(...discovered.diagnostics);

  const compiled = compilePolicy(
    input.facts.policy,
    targetPolicy.policy,
    input.facts.hooks.items,
  );
  diagnostics.push(...compiled.diagnostics);

  const global = input.paths.scope === 'global';
  let settingsPlan: SettingsPlan | undefined;
  let settingsContent: string | undefined;
  if (global) {
    diagnostics.push(globalSettingsWarning());
  } else {
    settingsContent = renderSettings(compiled.effective);
    settingsPlan = await planSettings(
      input.paths.root,
      generatedRecord,
      settingsContent,
    );
  }

  const instructionPlan = await planInstructions({
    root: input.paths.root,
    paths: input.paths,
    mode: options.instructions,
    generated: generatedRecord,
    fix: input.fix,
  });
  const projectionPlan = await planProjectionActions(
    input.paths.root,
    discovered.projections,
    generatedRecord,
    {
      fix: input.fix,
      importedTargets: new Set(input.importedTargets ?? []),
    },
  );

  const backupTargets = new Set(
    projectionPlan.actions
      .filter(
        (action) =>
          action.type === 'backup-and-replace' || action.type === 'backup-and-remove',
      )
      .map((action) => action.projection.target),
  );
  const projectionsWarnable = input.fix && backupTargets.size > 0;
  const instructionBacksUp = instructionPlan.action === 'backup-and-repair'
    || instructionPlan.action === 'backup-and-remove';
  const settingsBacksUp = settingsPlan?.action === 'backup-and-write';
  diagnostics.push(
    ...projectionPlan.conflicts.map((item) =>
      (projectionsWarnable && item.file !== undefined && backupTargets.has(item.file)
        ? withFixWarning(item)
        : item)),
    ...(instructionPlan.conflict === undefined
      ? []
      : [input.fix && instructionBacksUp
        ? withFixWarning(instructionPlan.conflict)
        : instructionPlan.conflict]),
    ...(settingsPlan?.conflict === undefined
      ? []
      : [input.fix && settingsBacksUp
        ? withFixWarning(settingsPlan.conflict)
        : settingsPlan.conflict]),
  );

  const instructionConflictFatal = instructionPlan.conflict !== undefined
    && !(input.fix && instructionBacksUp);
  const instructionsRecord = options.instructions === 'disabled'
    || instructionConflictFatal
    || instructionPlan.sha256 === undefined
    ? null
    : {
      path: '.claude/CLAUDE.md' as const,
      mode: options.instructions,
      sha256: instructionPlan.sha256,
    };
  const generated: GeneratedTarget = {
    provider: 'claude-code',
    settings: settingsPlan === undefined || settingsContent === undefined
      ? null
      : {
        path: settingsPlan.path,
        sha256: sha256(settingsContent),
      },
    instructions: instructionsRecord,
    projections: discovered.projections,
  };

  const actions = projectionPlan.actions.map(describeProjectionAction);
  if (instructionPlan.action !== 'none') {
    actions.push(`instructions ${instructionPlan.action} .claude/CLAUDE.md`);
  }
  if (settingsPlan !== undefined && settingsPlan.action !== 'none') {
    actions.push(`settings ${settingsPlan.action} ${settingsPlan.path}`);
  }

  return {
    provider: 'claude-code',
    diagnostics,
    actions,
    generated,
    ...(settingsPlan === undefined
      ? {}
      : {
        settings: {
          path: settingsPlan.path,
          sha256: settingsPlan.sha256,
          changed: settingsPlan.changed,
        },
      }),
    instructions: {
      path: '.claude/CLAUDE.md',
      mode: options.instructions,
      action: instructionPlan.action,
      sha256: instructionPlan.sha256 ?? '',
    },
    apply: async ({ backupRoot }) => {
      const projectionApplied = await applyProjectionActions(
        input.paths.root,
        projectionPlan.actions,
        { backupRoot, sourceRoot: '.agents' },
      );
      const instructionBackups = await applyInstructions(
        input.paths.root,
        instructionPlan,
        backupRoot,
      );
      const settingsBackups = settingsPlan === undefined || settingsContent === undefined
        ? []
        : await applySettings(
          input.paths.root,
          settingsPlan,
          settingsContent,
          backupRoot,
        );
      return {
        applied: projectionApplied.applied
          + (instructionPlan.action === 'none' ? 0 : 1)
          + (settingsPlan === undefined || settingsPlan.action === 'none' ? 0 : 1),
        backups: [...projectionApplied.backups, ...instructionBackups, ...settingsBackups],
      };
    },
  };
}

async function detect(input: TargetContext): Promise<TargetDetectOutcome> {
  const options = parseClaudeTargetOptions(input.target);
  const generated = getGeneratedTarget(input.manifest, 'claude-code');
  const diagnostics: Diagnostic[] = [];

  const targetPolicy = await loadTargetPolicy(input.paths);
  if ('diagnostic' in targetPolicy) {
    return {
      provider: 'claude-code',
      diagnostics: [targetPolicy.diagnostic],
      statuses: [],
    };
  }

  const backend = await checkClaudeCode(options.minVersion, input.runner);
  diagnostics.push(...backend.diagnostics);

  const discovered = await discoverProjections(input.paths.root, input.paths, {
    agents: input.facts.agents.items,
    skills: input.facts.skills.items,
    rules: input.facts.rules.items,
  });
  diagnostics.push(...discovered.diagnostics);

  const compiled = compilePolicy(
    input.facts.policy,
    targetPolicy.policy,
    input.facts.hooks.items,
  );
  diagnostics.push(...compiled.diagnostics);

  if (input.paths.scope === 'global') {
    diagnostics.push(globalSettingsWarning());
  } else {
    const expectedSettings = renderSettings(compiled.effective);
    diagnostics.push(
      ...await checkSettings(input.paths.root, input.paths, generated, expectedSettings),
    );
  }
  diagnostics.push(
    ...await checkInstructions(input.paths.root, input.paths, options.instructions, generated),
  );
  diagnostics.push(
    ...await checkProjections(
      input.paths.root,
      input.paths,
      discovered.projections,
      generated,
      new Set(input.importedTargets ?? []),
    ),
  );

  const projected = new Set(
    discovered.projections.map((item) => projectionKey(item.kind, item.name)),
  );
  const statuses: TargetFactStatus[] = [
    {
      kind: 'instructions',
      name: 'CLAUDE.md',
      status: options.instructions === 'disabled' ? 'not-applicable' : 'generated',
    },
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
