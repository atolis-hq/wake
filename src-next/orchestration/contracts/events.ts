import { z } from 'zod';
import { eventEnvelopeSchema, type EventEnvelope } from '../../kernel/index.js';
import { workItemId } from '../../work/index.js';
import { workflowInstanceId } from './identifiers.js';
import { orchestrationGroupStreamId, OrchestrationStreamKind } from './streams.js';
import type { OrchestrationEvent, WorkflowOrchestrationEvent } from './event-types.js';
export type {
  ActivityRequestedPayload,
  CausalActivationRejectedPayload,
  ChildCompletedPayload,
  ChildCompletionConsumedPayload,
  ChildCompletionSignal,
  ChildCoordinationEventDraft,
  ChildCoordinationEventPayloads,
  ChildCoordinationMetadata,
  ChildRequestedPayload,
  ChildStartedPayload,
  ChildWorkflowRequest,
  GroupBudgetExhaustedPayload,
  OrchestrationEvent,
  OrchestrationEventDraft,
  OrchestrationEventPayloads,
  OrchestrationGroupEvent,
  OrchestrationGroupEventDraft,
  OrchestrationSignal,
  SignalExpectation,
  SupplementalActivityRequest,
  WorkflowOrchestrationEvent,
  WorkflowOrchestrationEventDraft,
  WorkflowOrchestrationEventName,
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

const workflowInstanceIdSchema = z.string().min(1).transform(workflowInstanceId);
const workflowStreamSchema = z
  .object({
    kind: z.literal(OrchestrationStreamKind.WorkflowInstance),
    id: workflowInstanceIdSchema,
  })
  .strict();
const groupIdPattern = /^(?:primary:work-[a-z0-9-]+|group:[^:]+:watch:[^:]+)$/;
const groupIdSchema = z.string().regex(groupIdPattern).transform(orchestrationGroupStreamId);
const groupStreamSchema = z
  .object({
    kind: z.literal(OrchestrationStreamKind.Group),
    id: groupIdSchema,
  })
  .strict();
const childMetadataShape = {
  parentWorkflowInstanceId: workflowInstanceIdSchema,
  watchId: z.string().min(1),
  triggerId: z.string().min(1),
  orchestrationGroupId: z.string().min(1),
  causalCycleId: z.string().min(1),
  requestId: z.string().min(1),
  childWorkflowInstanceId: workflowInstanceIdSchema,
} as const;
const childMetadataSchema = z.object(childMetadataShape).strict();
const outcomeSchema = z.object({ kind: z.string().min(1), data: z.unknown().optional() }).strict();
const waitingOutcomeSchema = z
  .object({
    kind: z.literal('waiting'),
    data: z.object({ intentEventId: z.string().min(1), signalKind: z.string().min(1) }).strict(),
  })
  .strict();
const executionSchema = z
  .object({
    workspace: z.enum(['none', 'read-only', 'branch']).optional(),
    tier: z.string().min(1).optional(),
  })
  .strict();
const activityRequestedSchema = z
  .object({
    activationId: z.string().min(1),
    ordinal: z.number().int().positive(),
    activity: z.string().min(1),
    input: z.unknown(),
    execution: executionSchema.optional(),
    followOnIndex: z.number().int().nonnegative().optional(),
    supplemental: z.literal(true).optional(),
  })
  .strict();
const expectationSchema = z
  .object({
    signalKind: z.string().min(1),
    resourceId: z.string().optional(),
    revision: z.string().optional(),
  })
  .strict();
const signalSchema = z
  .object({
    kind: z.string().min(1),
    resourceId: z.string().optional(),
    revision: z.string().optional(),
    actorId: z.string().min(1),
    actorDecision: z.object({ authorized: z.boolean(), evidenceId: z.string().min(1) }).strict(),
    providerEventId: z.string().min(1),
    childWorkflowInstanceId: workflowInstanceIdSchema.optional(),
    requestId: z.string().optional(),
  })
  .strict();
const emptySchema = z.object({}).strict();
const workflowEnvelope = <Type extends string, Payload extends z.ZodType>(
  eventType: Type,
  payload: Payload,
) =>
  eventEnvelopeSchema.extend({
    eventType: z.literal(eventType),
    stream: workflowStreamSchema,
    payload,
  });
const groupEnvelope = <Type extends string, Payload extends z.ZodType>(
  eventType: Type,
  payload: Payload,
) =>
  eventEnvelopeSchema.extend({
    eventType: z.literal(eventType),
    stream: groupStreamSchema,
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
  groupEnvelope(
    OrchestrationEventType.PrimaryClaimed,
    z
      .object({
        workItemId: z.string().transform(workItemId),
        workflowInstanceId: workflowInstanceIdSchema,
      })
      .strict(),
  ),
  groupEnvelope(
    OrchestrationEventType.GroupClaimed,
    z.object({ key: groupIdSchema, requestId: z.string().min(1) }).strict(),
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
