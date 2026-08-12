import type {
  ActivationId,
  ActivityName,
  ActivityOutcome,
  ActivityOutcomeKind,
} from '../../activities/index.js';
import type { EventDraftUnion, EventUnion } from '../../kernel/index.js';
import type { WorkItemId } from '../../work/index.js';
import type { OrchestrationWaitingActivityOutcome } from './activity-outcome.js';
import type { ApprovalAuthority, StageConfig, TransitionTarget } from './config.js';
import type {
  CommandName,
  OrchestrationGroupId,
  SignalName,
  StageName,
  WorkflowInstanceId,
  WorkflowName,
} from './identifiers.js';
import { signalName } from './identifiers.js';
import type {
  ChildOrchestrationGroupStreamId,
  ChildOrchestrationGroupStreamRef,
  PrimaryOrchestrationGroupStreamRef,
  WorkflowInstanceStreamRef,
} from './streams.js';

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
  OperatorRetryRequested: 'orchestration.operator-retry-requested',
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
  readonly [OrchestrationEventType.OperatorRetryRequested]: {
    readonly activationId: ActivationId;
    readonly commandId: string;
  };
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

export interface ChildCoordinationMetadata {
  readonly parentWorkflowInstanceId: WorkflowInstanceId;
  readonly watchId: string;
  readonly triggerId: string;
  readonly orchestrationGroupId: OrchestrationGroupId;
  readonly causalCycleId: string;
  readonly requestId: string;
  readonly childWorkflowInstanceId: WorkflowInstanceId;
}

export interface ChildRequestedPayload extends ChildCoordinationMetadata {
  readonly workflowName: WorkflowName;
}

export type ChildStartedPayload = ChildCoordinationMetadata;

export type ChildCompletedPayload = ChildCoordinationMetadata;

export type ChildCompletionConsumedPayload = ChildCoordinationMetadata;

export type CausalActivationRejectedPayload = ChildCoordinationMetadata;

export interface GroupBudgetExhaustedPayload extends ChildCoordinationMetadata {
  readonly maxPerGroup: number;
}

export interface ActivityRequestedPayload {
  readonly activationId: ActivationId;
  readonly ordinal: number;
  readonly activity: ActivityName;
  readonly input: unknown;
  readonly execution?: StageConfig['execution'] | undefined;
  readonly followOnIndex?: number | undefined;
  readonly supplemental?: boolean | undefined;
}

export interface SignalExpectation {
  readonly signalKind: SignalName;
  readonly resourceId?: string | undefined;
  readonly revision?: string | undefined;
  readonly from?: readonly ApprovalAuthority[] | undefined;
  readonly resume?: TransitionTarget | undefined;
  readonly onRejectResume?: TransitionTarget | undefined;
}

export interface OrchestrationSignal {
  readonly kind: SignalName;
  readonly resourceId?: string | undefined;
  readonly revision?: string | undefined;
  readonly actorId: string;
  readonly actorDecision: { readonly authorized: boolean; readonly evidenceId: string };
  readonly providerEventId: string;
  readonly authority?: ApprovalAuthority | undefined;
  readonly outcome?: ActivityOutcomeKind | undefined;
}

export interface SupplementalActivityRequest {
  readonly command: CommandName;
}

export interface ChildWorkflowRequest {
  readonly parentWorkflowInstanceId: WorkflowInstanceId;
  readonly watchId: string;
  readonly triggerId: string;
  readonly workflowName: WorkflowName;
  readonly causalCycleId: string;
  readonly requestId: WorkflowInstanceId;
}

export const WatchGateVerdictSignal = signalName('orchestration.watch-gate-verdict');

export const ApprovedSignal = signalName('approved');

/**
 * Every consumer that needs to know whether a wait renders as "awaiting
 * approval" externally (GitHub labels, the operator board, the agent-run
 * comment footer) must derive it from this single predicate, or it silently
 * falls out of sync whenever a new approval-style signal kind is added —
 * exactly what happened when the watchGate verdict channel shipped and only
 * some of those consumers were updated to recognize it.
 */
export function isApprovalAwaitingSignalKind(signalKind: SignalName): boolean {
  return signalKind === ApprovedSignal || signalKind === WatchGateVerdictSignal;
}
