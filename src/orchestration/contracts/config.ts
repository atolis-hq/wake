import { z } from 'zod';
import {
  ApprovalAuthorityKind,
  ConversationSurfaceCapability,
  WorkflowStatus,
} from './vocabulary.js';

import {
  ActivityEventType,
  PullRequestCheckState,
  PullRequestState,
  type ActivityName,
} from '../../activities/index.js';
import { WorkspaceMode, type WorkspaceMode as WorkspaceModeType } from '../../execution/index.js';
import { MatchMode } from '../../kernel/index.js';
import type { CommandName, SignalName, StageName, WatchId, WorkflowName } from './identifiers.js';
import type { TransitionTargetKind } from './vocabulary.js';

export interface ActivityExecutionConfig {
  readonly workspace?: WorkspaceModeType | undefined;
  readonly runnerPool?: string | undefined;
}

const identifier = z.string().trim().min(1);
const bound = z.object({ max: z.number().int().positive() }).strict();
const approvalAuthorityKind = z.enum([
  ApprovalAuthorityKind.Human,
  ApprovalAuthorityKind.Auto,
  ApprovalAuthorityKind.Watch,
]);
// Shorthand: a bare `human`/`auto` string, or an explicit `{ kind: watch, id }` reference.
const approvalAuthorityConfigSchema = z.union([
  z.literal(ApprovalAuthorityKind.Human),
  z.literal(ApprovalAuthorityKind.Auto),
  z.object({ kind: z.literal(ApprovalAuthorityKind.Watch), id: identifier }).strict(),
]);

export const awaitConfigSchema = z
  .object({
    signal: identifier,
    from: z.array(approvalAuthorityConfigSchema).min(1).readonly(),
  })
  .strict();
const watchGateConfigSchema = z.union([
  identifier,
  z
    .object({
      watch: identifier,
      onReject: z.object({ then: identifier }).strict().optional(),
    })
    .strict(),
]);
const resourceTransitionConfigSchema = z.union([
  z
    .object({
      events: z.tuple([z.literal(ActivityEventType.PrReviewAccepted)]),
      then: identifier.optional(),
    })
    .strict(),
  z
    .object({
      events: z.tuple([z.literal(ActivityEventType.PrStateChanged)]),
      where: z.object({ state: z.literal(PullRequestState.Merged) }).strict(),
      then: identifier.optional(),
    })
    .strict(),
  z
    .object({
      events: z.tuple([z.literal(ActivityEventType.PrChecksChanged)]),
      where: z.object({ checks: z.literal(PullRequestCheckState.Failing) }).strict(),
      then: identifier.optional(),
    })
    .strict(),
]);
const commandName = z.string().regex(/^\/[a-z][a-z0-9-]*$/);

export const surfaceCapabilitySchema = z.enum([
  ConversationSurfaceCapability.Review,
  ConversationSurfaceCapability.Chat,
  ConversationSurfaceCapability.Operator,
]);

export const commandPolicyConfigSchema = z
  .object({
    capabilities: z
      .record(z.string().trim().min(1), z.array(surfaceCapabilitySchema).readonly())
      .default({}),
    replace: z.boolean().default(false),
  })
  .strict()
  .default({ capabilities: {}, replace: false });
const canonicalEventName = z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/);
const watchStatus = z.enum([WorkflowStatus.Active, WorkflowStatus.Waiting, WorkflowStatus.Blocked]);
const failingChecksWatchPredicateSchema = z
  .object({ checks: z.literal(PullRequestCheckState.Failing) })
  .strict();

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
    where: failingChecksWatchPredicateSchema.optional(),
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
    await: awaitConfigSchema.optional(),
    watchGates: z.array(watchGateConfigSchema).optional(),
    resourceTransitions: z.array(resourceTransitionConfigSchema).min(1).optional(),
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
        runnerPool: identifier.optional(),
      })
      .strict()
      .optional(),
    on: z
      .record(identifier, outcomeRouteConfigSchema)
      .refine((value) => Object.keys(value).length > 0),
    requiresApproval: z.boolean().optional(),
  })
  .strict();

export const supplementalCommandConfigSchema = z
  .object({
    activity: identifier,
    with: z.unknown().optional(),
    allowedActors: z.array(approvalAuthorityKind).min(1).readonly(),
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

export type CommandPolicyConfig = z.infer<typeof commandPolicyConfigSchema>;

// A single identifier is shorthand for a one-entry list, so every facet is matched the same way.
const selectorValues = z
  .union([identifier, z.array(identifier).min(1)])
  .transform((value): readonly string[] => (typeof value === 'string' ? [value] : value));

export const workflowSelectorConfigSchema = z
  .object({
    match: z
      .object({
        tags: selectorValues.optional(),
        kind: selectorValues.optional(),
        adapter: selectorValues.optional(),
      })
      .strict()
      .refine((value) => Object.values(value).some((facet) => facet !== undefined), {
        message: 'Workflow selector match requires at least one of tags, kind, or adapter',
      }),
    matchMode: z.enum([MatchMode.Any, MatchMode.All]).default(MatchMode.Any),
    workflow: identifier,
  })
  .strict();

export type WorkflowSelectorConfig = z.infer<typeof workflowSelectorConfigSchema>;

export type FollowOnActivityConfig = z.infer<typeof followOnActivityConfigSchema>;

export type AwaitConfig = z.infer<typeof awaitConfigSchema>;

export type WatchGateConfig = z.infer<typeof watchGateConfigSchema>;

export type ResourceTransitionConfig = z.infer<typeof resourceTransitionConfigSchema>;

export type OutcomeRouteConfig = z.infer<typeof outcomeRouteConfigSchema>;

export type StageConfig = z.infer<typeof stageConfigSchema>;

export type SupplementalCommandConfig = z.infer<typeof supplementalCommandConfigSchema>;

export type WatchConfig = z.infer<typeof watchConfigSchema>;

export type WorkflowDefinitionConfig = z.infer<typeof workflowDefinitionConfigSchema>;

export type TransitionTarget =
  | { readonly kind: typeof TransitionTargetKind.Stage; readonly stage: StageName }
  | { readonly kind: typeof TransitionTargetKind.Complete }
  | { readonly kind: typeof TransitionTargetKind.AwaitSignal; readonly signal: SignalName }
  | { readonly kind: typeof TransitionTargetKind.ResourceTransitionWait };

// A discriminated union, not `{ kind, id? }`: a flat optional id would let
// `{ kind: 'human', id: x }` and `{ kind: 'watch' }` both type-check.
export type ApprovalAuthority =
  | { readonly kind: typeof ApprovalAuthorityKind.Human }
  | { readonly kind: typeof ApprovalAuthorityKind.Auto }
  | { readonly kind: typeof ApprovalAuthorityKind.Watch; readonly watch: WatchId };

export interface CompiledAwait {
  readonly signal: SignalName;
  readonly from: readonly ApprovalAuthority[];
  readonly resume: TransitionTarget;
}

export interface CompiledWatchGate {
  readonly watch: WatchId;
  readonly onRejectTarget: TransitionTarget;
}

export interface CompiledFollowOnActivity {
  readonly use: ActivityName;
  readonly with: unknown;
}

export interface CompiledOutcomeRoute extends Omit<
  OutcomeRouteConfig,
  'activities' | 'then' | 'await' | 'watchGates' | 'resourceTransitions'
> {
  readonly id: string;
  readonly target: TransitionTarget;
  readonly reentryTarget: TransitionTarget;
  readonly activities?: readonly CompiledFollowOnActivity[];
  readonly await?: CompiledAwait;
  readonly watchGates?: readonly CompiledWatchGate[];
  readonly resourceTransitions?: readonly CompiledResourceTransition[];
}

export interface CompiledResourceTransition {
  readonly event:
    | typeof ActivityEventType.PrReviewAccepted
    | typeof ActivityEventType.PrStateChanged
    | typeof ActivityEventType.PrChecksChanged;
  readonly where?:
    | { readonly state: typeof PullRequestState.Merged }
    | { readonly checks: typeof PullRequestCheckState.Failing };
  readonly target: TransitionTarget;
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

export interface CompiledWatch extends Omit<WatchConfig, 'workflow' | 'while' | 'id'> {
  readonly id: WatchId;
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
