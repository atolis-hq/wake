import type { ActivityOutcome, WaitingActivityOutcome } from '../../activities/index.js';
import type { EventDraftUnion, EventUnion } from '../../kernel/index.js';
import type { WorkItemId } from '../../work/index.js';
import type { StageConfig } from './config.js';
import type { OrchestrationGroupStreamRef, WorkflowInstanceStreamRef } from './streams.js';

type OrchestrationEventName<Suffix extends string> = `orchestration.${Suffix}`;

export interface ChildCoordinationMetadata {
  readonly parentWorkflowInstanceId: string;
  readonly watchId: string;
  readonly triggerId: string;
  readonly orchestrationGroupId: string;
  readonly causalCycleId: string;
  readonly requestId: string;
  readonly childWorkflowInstanceId: string;
}

export interface ChildRequestedPayload extends ChildCoordinationMetadata {
  readonly workflowName: string;
}

export type ChildStartedPayload = ChildCoordinationMetadata;
export type ChildCompletedPayload = ChildCoordinationMetadata;
export type ChildCompletionConsumedPayload = ChildCoordinationMetadata;
export type CausalActivationRejectedPayload = ChildCoordinationMetadata;

export interface GroupBudgetExhaustedPayload extends ChildCoordinationMetadata {
  readonly maxPerGroup: number;
}

export interface ActivityRequestedPayload {
  readonly activationId: string;
  readonly ordinal: number;
  readonly activity: string;
  readonly input: unknown;
  readonly execution?: StageConfig['execution'] | undefined;
  readonly followOnIndex?: number | undefined;
  readonly supplemental?: boolean | undefined;
}

export interface SignalExpectation {
  readonly signalKind: string;
  readonly resourceId?: string | undefined;
  readonly revision?: string | undefined;
}

export interface OrchestrationSignal {
  readonly kind: string;
  readonly resourceId?: string | undefined;
  readonly revision?: string | undefined;
  readonly actorId: string;
  readonly actorDecision: {
    readonly authorized: boolean;
    readonly evidenceId: string;
  };
  readonly providerEventId: string;
}

interface OrchestrationPayloadsByName {
  readonly InstanceStarted:
    | {
        readonly workItemId: WorkItemId;
        readonly workflowName: string;
        readonly orchestrationGroupId: string;
        readonly entry: string;
      }
    | ({
        readonly workItemId: WorkItemId;
        readonly workflowName: string;
        readonly orchestrationGroupId: string;
        readonly entry: string;
      } & ChildCoordinationMetadata);
  readonly StageEntered: { readonly stage: string };
  readonly ActivityRequested: ActivityRequestedPayload;
  readonly ActivityStarted: { readonly activationId: string };
  readonly ActivityOutcomeAccepted: {
    readonly activationId: string;
    readonly outcome: ActivityOutcome;
  };
  readonly ActivityWaiting: {
    readonly activationId: string;
    readonly intentEventId: string;
    readonly signalKind: string;
    readonly outcome: WaitingActivityOutcome;
  };
  readonly SignalWaitStarted: SignalExpectation;
  readonly SignalAccepted: OrchestrationSignal;
  readonly SupplementalActivityQueued: {
    readonly activity: string;
    readonly input: unknown;
    readonly requestedBy: string;
  };
  readonly SupplementalActivityDequeued: {
    readonly activity: string;
    readonly requestedBy: string;
  };
  readonly RepeatCounted: {
    readonly routeId: string;
    readonly count: number;
  };
  readonly RetryCounted: {
    readonly retryKey: string;
    readonly count: number;
  };
  readonly InstanceCompleted: Readonly<Record<never, never>>;
  readonly InstanceBlocked: { readonly reason: string };
  readonly InstanceSuperseded: Readonly<Record<never, never>>;
  readonly ChildRequested: ChildRequestedPayload;
  readonly ChildStarted: ChildStartedPayload;
  readonly ChildCompleted: ChildCompletedPayload;
  readonly ChildCompletionConsumed: ChildCompletionConsumedPayload;
  readonly CausalActivationRejected: CausalActivationRejectedPayload;
  readonly GroupBudgetExhausted: GroupBudgetExhaustedPayload;
  readonly PrimaryClaimed: {
    readonly workItemId: WorkItemId;
    readonly workflowInstanceId: string;
  };
  readonly GroupClaimed: {
    readonly key: string;
    readonly requestId: string;
  };
}

interface OrchestrationEventNames {
  readonly InstanceStarted: OrchestrationEventName<'instance-started'>;
  readonly StageEntered: OrchestrationEventName<'stage-entered'>;
  readonly ActivityRequested: OrchestrationEventName<'activity-requested'>;
  readonly ActivityStarted: OrchestrationEventName<'activity-started'>;
  readonly ActivityOutcomeAccepted: OrchestrationEventName<'activity-outcome-accepted'>;
  readonly ActivityWaiting: OrchestrationEventName<'activity-waiting'>;
  readonly SignalWaitStarted: OrchestrationEventName<'signal-wait-started'>;
  readonly SignalAccepted: OrchestrationEventName<'signal-accepted'>;
  readonly SupplementalActivityQueued: OrchestrationEventName<'supplemental-activity-queued'>;
  readonly SupplementalActivityDequeued: OrchestrationEventName<'supplemental-activity-dequeued'>;
  readonly RepeatCounted: OrchestrationEventName<'repeat-counted'>;
  readonly RetryCounted: OrchestrationEventName<'retry-counted'>;
  readonly InstanceCompleted: OrchestrationEventName<'instance-completed'>;
  readonly InstanceBlocked: OrchestrationEventName<'instance-blocked'>;
  readonly InstanceSuperseded: OrchestrationEventName<'instance-superseded'>;
  readonly ChildRequested: OrchestrationEventName<'child-requested'>;
  readonly ChildStarted: OrchestrationEventName<'child-started'>;
  readonly ChildCompleted: OrchestrationEventName<'child-completed'>;
  readonly ChildCompletionConsumed: OrchestrationEventName<'child-completion-consumed'>;
  readonly CausalActivationRejected: OrchestrationEventName<'causal-activation-rejected'>;
  readonly GroupBudgetExhausted: OrchestrationEventName<'group-budget-exhausted'>;
  readonly PrimaryClaimed: OrchestrationEventName<'primary-claimed'>;
  readonly GroupClaimed: OrchestrationEventName<'group-claimed'>;
}

export type OrchestrationEventPayloads = {
  readonly [
    Name in keyof OrchestrationPayloadsByName as OrchestrationEventNames[Name]
  ]: OrchestrationPayloadsByName[Name];
};

type WorkflowEventType = Exclude<
  keyof OrchestrationEventPayloads,
  OrchestrationEventName<'primary-claimed'> | OrchestrationEventName<'group-claimed'>
>;
export type WorkflowOrchestrationEventName = WorkflowEventType;
type GroupEventType =
  OrchestrationEventName<'primary-claimed'> | OrchestrationEventName<'group-claimed'>;
type WorkflowEventPayloads = Pick<OrchestrationEventPayloads, WorkflowEventType>;
type GroupEventPayloads = Pick<OrchestrationEventPayloads, GroupEventType>;

export type WorkflowOrchestrationEvent = EventUnion<
  WorkflowEventPayloads,
  WorkflowInstanceStreamRef
>;
export type OrchestrationGroupEvent = EventUnion<GroupEventPayloads, OrchestrationGroupStreamRef>;
export type WorkflowOrchestrationEventDraft = EventDraftUnion<
  WorkflowEventPayloads,
  WorkflowInstanceStreamRef
>;
export type OrchestrationGroupEventDraft = EventDraftUnion<
  GroupEventPayloads,
  OrchestrationGroupStreamRef
>;
export type OrchestrationEvent = WorkflowOrchestrationEvent | OrchestrationGroupEvent;
export type OrchestrationEventDraft =
  WorkflowOrchestrationEventDraft | OrchestrationGroupEventDraft;
export type ChildCoordinationEventDraft = Extract<
  OrchestrationEventDraft,
  {
    readonly eventType:
      | OrchestrationEventName<'child-requested'>
      | OrchestrationEventName<'child-started'>
      | OrchestrationEventName<'child-completed'>
      | OrchestrationEventName<'child-completion-consumed'>
      | OrchestrationEventName<'causal-activation-rejected'>
      | OrchestrationEventName<'group-budget-exhausted'>;
  }
>;
export type ChildCoordinationEventPayloads = Pick<
  OrchestrationEventPayloads,
  ChildCoordinationEventDraft['eventType']
>;

export interface ChildCompletionSignal extends OrchestrationSignal {
  readonly kind: OrchestrationEventName<'child-completed'>;
  readonly childWorkflowInstanceId: string;
  readonly requestId: string;
}

export interface SupplementalActivityRequest {
  readonly command: string;
}

export interface ChildWorkflowRequest {
  readonly parentWorkflowInstanceId: string;
  readonly watchId: string;
  readonly triggerId: string;
  readonly workflowName: string;
  readonly causalCycleId: string;
  readonly requestId: string;
}
