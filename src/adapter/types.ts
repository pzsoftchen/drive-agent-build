import type { CommandRunner } from '../core/command.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import type { SourceFacts } from '../model/facts.ts';
import type {
  GeneratedTarget,
  ProjectManifest,
  ProjectPaths,
  TargetConfig,
  TargetProvider,
} from '../model/types.ts';

export interface TargetContext {
  paths: ProjectPaths;
  manifest: ProjectManifest;
  target: TargetConfig;
  facts: SourceFacts;
  runner?: CommandRunner;
}

export interface TargetNormalizeInput extends TargetContext {
  fix: boolean;
  dryRun: boolean;
  now?: Date;
}

export interface TargetSettingsPlan {
  path: string;
  sha256: string;
  changed: boolean;
}

export interface TargetInstructionsPlan {
  path: string;
  mode: string;
  action: string;
  sha256: string;
}

export interface TargetNormalizePlan {
  provider: TargetProvider;
  diagnostics: Diagnostic[];
  actions: string[];
  generated: GeneratedTarget;
  settings?: TargetSettingsPlan;
  instructions?: TargetInstructionsPlan;
  /**
   * `backups` may be absolute or relative to the scope root; the command layer
   * resolves and reports them relative to the scope root.
   */
  apply(options: { backupRoot: string }): Promise<{ applied: number; backups: string[] }>;
}

export type TargetFactKind =
  | 'instructions'
  | 'agent'
  | 'skill'
  | 'rule'
  | 'policy'
  | 'hook';

export type TargetFactState =
  | 'native'
  | 'mapped'
  | 'generated'
  | 'unsupported'
  | 'not-applicable'
  | 'missing';

export interface TargetFactStatus {
  kind: TargetFactKind;
  name: string;
  status: TargetFactState;
  detail?: string;
}

export interface TargetDetectOutcome {
  provider: TargetProvider;
  diagnostics: Diagnostic[];
  statuses: TargetFactStatus[];
}

export interface TargetAdapter {
  readonly provider: TargetProvider;
  normalize(input: TargetNormalizeInput): Promise<TargetNormalizePlan>;
  detect(input: TargetContext): Promise<TargetDetectOutcome>;
}
