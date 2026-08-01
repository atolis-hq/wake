import type { ActivationId, ActivityName, ActivityOutcome } from '../../activities/index.js';
import type { EventDraftUnion, EventUnion } from '../../kernel/index.js';
import type { WorkItemId } from '../../work/index.js';
import type { OrchestrationWaitingActivityOutcome } from './activity-outcome.js';
import type {
  ActivityRequestedPayload,
  CausalActivationRejectedPayload,
  ChildCompletedPayload,
  ChildCompletionConsumedPayload,
  ChildCoordinationMetadata,
  ChildRequestedPayload,
  ChildStartedPayload,
  GroupBudgetExhaustedPayload,
  OrchestrationSignal,
  SignalExpectation,
} from './event-types.js';
import type {
  OrchestrationGroupId,
  StageName,
  WorkflowInstanceId,
  WorkflowName,
} from './identifiers.js';
import type {
  ChildOrchestrationGroupStreamId,
  ChildOrchestrationGroupStreamRef,
  PrimaryOrchestrationGroupStreamRef,
  WorkflowInstanceStreamRef,
} from './streams.js';

export type {
  ActivityRequestedPayload,
  CausalActivationRejectedPayload,
  ChildCompletedPayload,
  ChildCompletionConsumedPayload,
  ChildCoordinationMetadata,
  ChildRequestedPayload,
  ChildStartedPayload,
  ChildWorkflowRequest,
  GroupBudgetExhaustedPayload,
  OrchestrationSignal,
  SignalExpectation,
  SupplementalActivityRequest,
} from './event-types.js';

export const OrchestrationEventType = {
  InstanceStarted: 'orchestration.instance-started',
  StageEntered: 'orchestration.stage-entered',
  ActivityRequested: 'orchestration.activity-requested',
  ActivityStarted: 'orchestration.activity-started',
  ActivityOutcomeAccepted: 'orchestration.activity-outcome-accepted',
  ActivityWaiting: 'orchestration.activity-waiting',
  SignalWaitStarted: 'orchestration.signal-wait-started',
  SignalAccepted: 'orchestration.signal-accepted',
  SupplementalActivityQueued: 'orchestration.supplemental-activity-queued',
  SupplementalActivityDequeued: 'orchestration.supplemental-activity-dequeued',
  RepeatCounted: 'orchestration.repeat-counted',
  RetryCounted: 'orchestration.retry-counted',
  InstanceCompleted: 'orchestration.instance-completed',
  InstanceBlocked: 'orchestration.instance-blocked',
  InstanceSuperseded: 'orchestration.instance-superseded',
  ChildRequested: 'orchestration.child-requested',
  ChildStarted: 'orchestration.child-started',
  ChildCompleted: 'orchestration.child-completed',
  ChildCompletionConsumed: 'orchestration.child-completion-consumed',
  CausalActivationRejected: 'orchestration.causal-activation-rejected',
  GroupBudgetExhausted: 'orchestration.group-budget-exhausted',
  PrimaryClaimed: 'orchestration.primary-claimed',
  GroupClaimed: 'orchestration.group-claimed',
} as const;

export interface OrchestrationEventPayloads {
  readonly [OrchestrationEventType.InstanceStarted]:
    | {
        readonly workItemId: WorkItemId;
        readonly workflowName: WorkflowName;
        readonly orchestrationGroupId: OrchestrationGroupId;
        readonly entry: StageName;
      }
    | ({
        readonly workItemId: WorkItemId;
        readonly workflowName: WorkflowName;
        readonly orchestrationGroupId: OrchestrationGroupId;
        readonly entry: StageName;
      } & ChildCoordinationMetadata);
  readonly [OrchestrationEventType.StageEntered]: { readonly stage: StageName };
  readonly [OrchestrationEventType.ActivityRequested]: ActivityRequestedPayload;
  readonly [OrchestrationEventType.ActivityStarted]: { readonly activationId: ActivationId };
  readonly [OrchestrationEventType.ActivityOutcomeAccepted]: {
    readonly activationId: ActivationId;
    readonly outcome: ActivityOutcome;
  };
  readonly [OrchestrationEventType.ActivityWaiting]: {
    readonly activationId: ActivationId;
    readonly outcome: OrchestrationWaitingActivityOutcome;
  };
  readonly [OrchestrationEventType.SignalWaitStarted]: SignalExpectation;
  readonly [OrchestrationEventType.SignalAccepted]: OrchestrationSignal;
  readonly [OrchestrationEventType.SupplementalActivityQueued]: {
    readonly activity: ActivityName;
    readonly input: unknown;
    readonly requestedBy: string;
  };
  readonly [OrchestrationEventType.SupplementalActivityDequeued]: {
    readonly activity: ActivityName;
    readonly requestedBy: string;
  };
  readonly [OrchestrationEventType.RepeatCounted]: {
    readonly routeId: string;
    readonly count: number;
  };
  readonly [OrchestrationEventType.RetryCounted]: {
    readonly retryKey: string;
    readonly count: number;
  };
  readonly [OrchestrationEventType.InstanceCompleted]: Readonly<Record<never, never>>;
  readonly [OrchestrationEventType.InstanceBlocked]: { readonly reason: string };
  readonly [OrchestrationEventType.InstanceSuperseded]: Readonly<Record<never, never>>;
  readonly [OrchestrationEventType.ChildRequested]: ChildRequestedPayload;
  readonly [OrchestrationEventType.ChildStarted]: ChildStartedPayload;
  readonly [OrchestrationEventType.ChildCompleted]: ChildCompletedPayload;
  readonly [OrchestrationEventType.ChildCompletionConsumed]: ChildCompletionConsumedPayload;
  readonly [OrchestrationEventType.CausalActivationRejected]: CausalActivationRejectedPayload;
  readonly [OrchestrationEventType.GroupBudgetExhausted]: GroupBudgetExhaustedPayload;
  readonly [OrchestrationEventType.PrimaryClaimed]: {
    readonly workItemId: WorkItemId;
    readonly workflowInstanceId: WorkflowInstanceId;
  };
  readonly [OrchestrationEventType.GroupClaimed]: {
    readonly key: ChildOrchestrationGroupStreamId;
    readonly requestId: string;
  };
}

type WorkflowEventType = Exclude<
  keyof OrchestrationEventPayloads,
  typeof OrchestrationEventType.PrimaryClaimed | typeof OrchestrationEventType.GroupClaimed
>;

export type WorkflowOrchestrationEventName = WorkflowEventType;

type WorkflowEventPayloads = Pick<OrchestrationEventPayloads, WorkflowEventType>;

type PrimaryGroupEventPayloads = Pick<
  OrchestrationEventPayloads,
  typeof OrchestrationEventType.PrimaryClaimed
>;

type ChildGroupEventPayloads = Pick<
  OrchestrationEventPayloads,
  typeof OrchestrationEventType.GroupClaimed
>;

export type WorkflowOrchestrationEvent = EventUnion<
  WorkflowEventPayloads,
  WorkflowInstanceStreamRef
>;

type PrimaryOrchestrationGroupEvent = EventUnion<
  PrimaryGroupEventPayloads,
  PrimaryOrchestrationGroupStreamRef
>;

type ChildOrchestrationGroupEvent = EventUnion<
  ChildGroupEventPayloads,
  ChildOrchestrationGroupStreamRef
>;

export type OrchestrationGroupEvent = PrimaryOrchestrationGroupEvent | ChildOrchestrationGroupEvent;

export type WorkflowOrchestrationEventDraft = EventDraftUnion<
  WorkflowEventPayloads,
  WorkflowInstanceStreamRef
>;

type PrimaryOrchestrationGroupEventDraft = EventDraftUnion<
  PrimaryGroupEventPayloads,
  PrimaryOrchestrationGroupStreamRef
>;

type ChildOrchestrationGroupEventDraft = EventDraftUnion<
  ChildGroupEventPayloads,
  ChildOrchestrationGroupStreamRef
>;

export type OrchestrationGroupEventDraft =
  PrimaryOrchestrationGroupEventDraft | ChildOrchestrationGroupEventDraft;

export type OrchestrationEvent = WorkflowOrchestrationEvent | OrchestrationGroupEvent;

export type OrchestrationEventDraft =
  WorkflowOrchestrationEventDraft | OrchestrationGroupEventDraft;

export type ChildCoordinationEventDraft = Extract<
  OrchestrationEventDraft,
  {
    readonly eventType:
      | typeof OrchestrationEventType.ChildRequested
      | typeof OrchestrationEventType.ChildStarted
      | typeof OrchestrationEventType.ChildCompleted
      | typeof OrchestrationEventType.ChildCompletionConsumed
      | typeof OrchestrationEventType.CausalActivationRejected
      | typeof OrchestrationEventType.GroupBudgetExhausted;
  }
>;

export type ChildCoordinationEventPayloads = Pick<
  OrchestrationEventPayloads,
  ChildCoordinationEventDraft['eventType']
>;

export interface ChildCompletionSignal extends OrchestrationSignal {
  readonly childWorkflowInstanceId: WorkflowInstanceId;
  readonly requestId: string;
}
