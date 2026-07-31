import { WorkflowStatus } from './vocabulary.js';
import { z } from 'zod';

import { EventActorKind } from '../../kernel/index.js';
import { type ActivityName } from '../../activities/index.js';
import { WorkspaceMode, type WorkspaceMode as WorkspaceModeType } from '../../execution/index.js';
import type { CommandName, SignalName, StageName, WorkflowName } from './identifiers.js';
import { TransitionTargetKind } from './vocabulary.js';

export interface ActivityExecutionConfig {
  readonly workspace?: WorkspaceModeType | undefined;
  readonly tier?: string | undefined;
}

const identifier = z.string().trim().min(1);
const bound = z.object({ max: z.number().int().positive() }).strict();
const actorKind = z.enum([
  EventActorKind.System,
  EventActorKind.Operator,
  EventActorKind.Agent,
  EventActorKind.Integration,
]);
const commandName = z.string().regex(/^\/[a-z][a-z0-9-]*$/);
const canonicalEventName = z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/);
const watchStatus = z.enum([WorkflowStatus.Active, WorkflowStatus.Waiting, WorkflowStatus.Blocked]);
export const watchConfigSchema = z
  .object({
    id: identifier,
    while: z
      .object({
        stages: z.array(identifier).min(1).readonly(),
        statuses: z.array(watchStatus).min(1).readonly(),
      })
      .strict(),
    on: z
      .object({ events: z.array(canonicalEventName).min(1).readonly() })
      .strict()
      .optional(),
    schedule: z.object({ cron: identifier }).strict().optional(),
    workflow: identifier,
    maxPerGroup: z.number().int().positive(),
  })
  .strict()
  .refine((value) => value.on !== undefined || value.schedule !== undefined, {
    message: 'Watch requires on or schedule',
  });
export const followOnActivityConfigSchema = z
  .object({
    use: identifier,
    with: z.unknown().optional(),
  })
  .strict();
export const outcomeRouteConfigSchema = z
  .object({
    activities: z.array(followOnActivityConfigSchema).readonly().optional(),
    then: identifier,
    repeat: bound.optional(),
    retry: bound.optional(),
  })
  .strict();
export const stageConfigSchema = z
  .object({
    activity: identifier,
    with: z.unknown().optional(),
    execution: z
      .object({
        workspace: z
          .enum([WorkspaceMode.None, WorkspaceMode.ReadOnly, WorkspaceMode.Branch])
          .optional(),
        tier: identifier.optional(),
      })
      .strict()
      .optional(),
    on: z
      .record(identifier, outcomeRouteConfigSchema)
      .refine((value) => Object.keys(value).length > 0),
  })
  .strict();
export const supplementalCommandConfigSchema = z
  .object({
    activity: identifier,
    with: z.unknown().optional(),
    allowedActors: z.array(actorKind).min(1).readonly(),
  })
  .strict();
export const workflowDefinitionConfigSchema = z
  .object({
    entry: identifier.optional(),
    commands: z.record(commandName, supplementalCommandConfigSchema).optional(),
    watches: z.array(watchConfigSchema).readonly().optional(),
    stages: z
      .record(identifier, stageConfigSchema)
      .refine((value) => Object.keys(value).length > 0),
  })
  .strict();

export type FollowOnActivityConfig = z.infer<typeof followOnActivityConfigSchema>;
export type OutcomeRouteConfig = z.infer<typeof outcomeRouteConfigSchema>;
export type StageConfig = z.infer<typeof stageConfigSchema>;
export type SupplementalCommandConfig = z.infer<typeof supplementalCommandConfigSchema>;
export type WatchConfig = z.infer<typeof watchConfigSchema>;
export type WorkflowDefinitionConfig = z.infer<typeof workflowDefinitionConfigSchema>;

export type TransitionTarget =
  | { readonly kind: typeof TransitionTargetKind.Stage; readonly stage: StageName }
  | { readonly kind: typeof TransitionTargetKind.Complete }
  | { readonly kind: typeof TransitionTargetKind.AwaitSignal; readonly signal: SignalName };

export interface CompiledFollowOnActivity {
  readonly use: ActivityName;
  readonly with: unknown;
}
export interface CompiledOutcomeRoute extends Omit<OutcomeRouteConfig, 'activities' | 'then'> {
  readonly id: string;
  readonly target: TransitionTarget;
  readonly activities?: readonly CompiledFollowOnActivity[];
}
export interface CompiledStage extends Omit<StageConfig, 'activity' | 'execution' | 'on'> {
  readonly activity: ActivityName;
  readonly execution?: ActivityExecutionConfig;
  readonly on: Readonly<Record<string, CompiledOutcomeRoute>>;
}
export interface CompiledSupplementalCommand extends Omit<SupplementalCommandConfig, 'activity'> {
  readonly activity: ActivityName;
  readonly allowedActors: SupplementalCommandConfig['allowedActors'];
}
export interface CompiledWatch extends Omit<WatchConfig, 'workflow' | 'while'> {
  readonly workflow: WorkflowName;
  readonly while: Omit<WatchConfig['while'], 'stages'> & {
    readonly stages: readonly StageName[];
  };
}
export interface CompiledWorkflow {
  readonly name: WorkflowName;
  readonly entry: StageName;
  readonly commands: Readonly<Record<CommandName, CompiledSupplementalCommand>>;
  readonly watches: readonly Readonly<CompiledWatch>[];
  readonly stages: Readonly<Record<StageName, CompiledStage>>;
}
