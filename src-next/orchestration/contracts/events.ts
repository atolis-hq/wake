import { z } from 'zod';
import type { ActivityOutcome, WaitingActivityOutcome } from '../../activities/index.js';
import {
  eventEnvelopeSchema,
  type EventDraftUnion,
  type EventEnvelope,
  type EventUnion,
} from '../../kernel/index.js';
import { workItemId, type WorkItemId } from '../../work/index.js';
import {
  type ChildOrchestrationGroupStreamId,
  type ChildOrchestrationGroupStreamRef,
  type PrimaryOrchestrationGroupStreamRef,
  type WorkflowInstanceStreamRef,
} from './streams.js';
import {
  activityRequestedSchema,
  childGroupIdSchema,
  childGroupStreamSchema,
  childMetadataSchema,
  childMetadataShape,
  emptySchema,
  expectationSchema,
  outcomeSchema,
  primaryGroupStreamSchema,
  signalSchema,
  waitingOutcomeSchema,
  workflowInstanceIdSchema,
  workflowStreamSchema,
} from './event-payload-schema.js';
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
  readonly [OrchestrationEventType.StageEntered]: { readonly stage: string };
  readonly [OrchestrationEventType.ActivityRequested]: ActivityRequestedPayload;
  readonly [OrchestrationEventType.ActivityStarted]: { readonly activationId: string };
  readonly [OrchestrationEventType.ActivityOutcomeAccepted]: {
    readonly activationId: string;
    readonly outcome: ActivityOutcome;
  };
  readonly [OrchestrationEventType.ActivityWaiting]: {
    readonly activationId: string;
    readonly intentEventId: string;
    readonly signalKind: string;
    readonly outcome: WaitingActivityOutcome;
  };
  readonly [OrchestrationEventType.SignalWaitStarted]: SignalExpectation;
  readonly [OrchestrationEventType.SignalAccepted]: OrchestrationSignal;
  readonly [OrchestrationEventType.SupplementalActivityQueued]: {
    readonly activity: string;
    readonly input: unknown;
    readonly requestedBy: string;
  };
  readonly [OrchestrationEventType.SupplementalActivityDequeued]: {
    readonly activity: string;
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
    readonly workflowInstanceId: string;
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
  readonly kind: typeof OrchestrationEventType.ChildCompleted;
  readonly childWorkflowInstanceId: string;
  readonly requestId: string;
}

const workflowEnvelope = <Type extends string, Payload extends z.ZodType>(
  eventType: Type,
  payload: Payload,
) =>
  eventEnvelopeSchema.extend({
    eventType: z.literal(eventType),
    stream: workflowStreamSchema,
    payload,
  });
const primaryGroupEnvelope = <Type extends string, Payload extends z.ZodType>(
  eventType: Type,
  payload: Payload,
) =>
  eventEnvelopeSchema.extend({
    eventType: z.literal(eventType),
    stream: primaryGroupStreamSchema,
    payload,
  });
const childGroupEnvelope = <Type extends string, Payload extends z.ZodType>(
  eventType: Type,
  payload: Payload,
) =>
  eventEnvelopeSchema.extend({
    eventType: z.literal(eventType),
    stream: childGroupStreamSchema,
    payload,
  });
const eventSchema = z.discriminatedUnion('eventType', [
  workflowEnvelope(
    OrchestrationEventType.InstanceStarted,
    z.union([
      z
        .object({
          workItemId: z.string().transform(workItemId),
          workflowName: z.string().min(1),
          orchestrationGroupId: z.string().min(1),
          entry: z.string().min(1),
        })
        .strict(),
      z
        .object({
          workItemId: z.string().transform(workItemId),
          workflowName: z.string().min(1),
          entry: z.string().min(1),
          ...childMetadataShape,
        })
        .strict(),
    ]),
  ),
  workflowEnvelope(
    OrchestrationEventType.StageEntered,
    z.object({ stage: z.string().min(1) }).strict(),
  ),
  workflowEnvelope(OrchestrationEventType.ActivityRequested, activityRequestedSchema),
  workflowEnvelope(
    OrchestrationEventType.ActivityStarted,
    z.object({ activationId: z.string().min(1) }).strict(),
  ),
  workflowEnvelope(
    OrchestrationEventType.ActivityOutcomeAccepted,
    z
      .object({
        activationId: z.string().min(1),
        outcome: outcomeSchema,
      })
      .strict(),
  ),
  workflowEnvelope(
    OrchestrationEventType.ActivityWaiting,
    z
      .object({
        activationId: z.string().min(1),
        intentEventId: z.string().min(1),
        signalKind: z.string().min(1),
        outcome: waitingOutcomeSchema,
      })
      .strict(),
  ),
  workflowEnvelope(OrchestrationEventType.SignalWaitStarted, expectationSchema),
  workflowEnvelope(OrchestrationEventType.SignalAccepted, signalSchema),
  workflowEnvelope(
    OrchestrationEventType.SupplementalActivityQueued,
    z
      .object({
        activity: z.string().min(1),
        input: z.unknown(),
        requestedBy: z.string().min(1),
      })
      .strict(),
  ),
  workflowEnvelope(
    OrchestrationEventType.SupplementalActivityDequeued,
    z
      .object({
        activity: z.string().min(1),
        requestedBy: z.string().min(1),
      })
      .strict(),
  ),
  workflowEnvelope(
    OrchestrationEventType.RepeatCounted,
    z.object({ routeId: z.string().min(1), count: z.number().int().positive() }).strict(),
  ),
  workflowEnvelope(
    OrchestrationEventType.RetryCounted,
    z.object({ retryKey: z.string().min(1), count: z.number().int().positive() }).strict(),
  ),
  workflowEnvelope(OrchestrationEventType.InstanceCompleted, emptySchema),
  workflowEnvelope(
    OrchestrationEventType.InstanceBlocked,
    z.object({ reason: z.string() }).strict(),
  ),
  workflowEnvelope(OrchestrationEventType.InstanceSuperseded, emptySchema),
  workflowEnvelope(
    OrchestrationEventType.ChildRequested,
    z.object({ ...childMetadataShape, workflowName: z.string().min(1) }).strict(),
  ),
  workflowEnvelope(OrchestrationEventType.ChildStarted, childMetadataSchema),
  workflowEnvelope(OrchestrationEventType.ChildCompleted, childMetadataSchema),
  workflowEnvelope(OrchestrationEventType.ChildCompletionConsumed, childMetadataSchema),
  workflowEnvelope(OrchestrationEventType.CausalActivationRejected, childMetadataSchema),
  workflowEnvelope(
    OrchestrationEventType.GroupBudgetExhausted,
    z.object({ ...childMetadataShape, maxPerGroup: z.number().int().positive() }).strict(),
  ),
  primaryGroupEnvelope(
    OrchestrationEventType.PrimaryClaimed,
    z
      .object({
        workItemId: z.string().transform(workItemId),
        workflowInstanceId: workflowInstanceIdSchema,
      })
      .strict(),
  ),
  childGroupEnvelope(
    OrchestrationEventType.GroupClaimed,
    z.object({ key: childGroupIdSchema, requestId: z.string().min(1) }).strict(),
  ),
]);

export function decodeOrchestrationEvent(event: EventEnvelope): OrchestrationEvent {
  const result = eventSchema.safeParse(event);
  if (!result.success) throw invalidOrchestrationEvent(event, result.error);
  return result.data;
}

export function selectOrchestrationEvent(event: EventEnvelope): OrchestrationEvent | null {
  return event.eventType.startsWith('orchestration.') ? decodeOrchestrationEvent(event) : null;
}

export function selectWorkflowOrchestrationEvent(
  event: EventEnvelope,
): WorkflowOrchestrationEvent | null {
  const owned = selectOrchestrationEvent(event);
  if (owned === null) return null;
  switch (owned.eventType) {
    case OrchestrationEventType.PrimaryClaimed:
    case OrchestrationEventType.GroupClaimed:
      return null;
    default:
      return owned;
  }
}

function invalidOrchestrationEvent(event: EventEnvelope, cause: z.ZodError): Error {
  return new Error(
    `Invalid Orchestration event ${event.eventId} at global position ${event.globalPosition} (${event.eventType}): ${cause.message}`,
    { cause },
  );
}
