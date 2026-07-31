import { z } from 'zod';

import { activationId, activityName } from '../../activities/index.js';
import { brandedStringSchema, type EventEnvelope } from '../../kernel/index.js';
import { workItemId } from '../../work/index.js';
import { orchestrationGroupId, stageName, workflowName } from './identifiers.js';
import {
  activityRequestedSchema,
  childGroupIdSchema,
  childMetadataSchema,
  childMetadataShape,
  emptySchema,
  expectationSchema,
  outcomeSchema,
  signalSchema,
  waitingOutcomeSchema,
  workflowInstanceIdSchema,
} from './event-payload-schema.js';
import {
  childGroupEnvelope,
  primaryGroupEnvelope,
  workflowEnvelope,
} from './event-envelope-schema.js';
import {
  OrchestrationEventType,
  type OrchestrationEvent,
  type WorkflowOrchestrationEvent,
} from './events.js';

const primaryClaimedEnvelope = primaryGroupEnvelope(
  OrchestrationEventType.PrimaryClaimed,
  z
    .object({
      workItemId: brandedStringSchema(workItemId),
      workflowInstanceId: workflowInstanceIdSchema,
    })
    .strict(),
).superRefine((event, context) => {
  if (event.stream.id !== `primary:${event.payload.workItemId}`)
    context.addIssue({
      code: 'custom',
      path: ['payload', 'workItemId'],
      message: 'Primary claim work item must identify its stream',
    });
});
const groupClaimedEnvelope = childGroupEnvelope(
  OrchestrationEventType.GroupClaimed,
  z.object({ key: childGroupIdSchema, requestId: z.string().min(1) }).strict(),
).superRefine((event, context) => {
  if (event.payload.key !== event.stream.id)
    context.addIssue({
      code: 'custom',
      path: ['payload', 'key'],
      message: 'Group claim key must identify its stream',
    });
});
const eventSchema = z.discriminatedUnion('eventType', [
  workflowEnvelope(
    OrchestrationEventType.InstanceStarted,
    z.union([
      z
        .object({
          workItemId: brandedStringSchema(workItemId),
          workflowName: brandedStringSchema(workflowName),
          orchestrationGroupId: brandedStringSchema(orchestrationGroupId),
          entry: brandedStringSchema(stageName),
        })
        .strict(),
      z
        .object({
          workItemId: brandedStringSchema(workItemId),
          workflowName: brandedStringSchema(workflowName),
          entry: brandedStringSchema(stageName),
          ...childMetadataShape,
        })
        .strict(),
    ]),
  ),
  workflowEnvelope(
    OrchestrationEventType.StageEntered,
    z.object({ stage: brandedStringSchema(stageName) }).strict(),
  ),
  workflowEnvelope(OrchestrationEventType.ActivityRequested, activityRequestedSchema),
  workflowEnvelope(
    OrchestrationEventType.ActivityStarted,
    z.object({ activationId: brandedStringSchema(activationId) }).strict(),
  ),
  workflowEnvelope(
    OrchestrationEventType.ActivityOutcomeAccepted,
    z
      .object({
        activationId: brandedStringSchema(activationId),
        outcome: outcomeSchema,
      })
      .strict(),
  ),
  workflowEnvelope(
    OrchestrationEventType.ActivityWaiting,
    z
      .object({
        activationId: brandedStringSchema(activationId),
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
        activity: brandedStringSchema(activityName),
        input: z.unknown(),
        requestedBy: z.string().min(1),
      })
      .strict(),
  ),
  workflowEnvelope(
    OrchestrationEventType.SupplementalActivityDequeued,
    z
      .object({
        activity: brandedStringSchema(activityName),
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
    z.object({ ...childMetadataShape, workflowName: brandedStringSchema(workflowName) }).strict(),
  ),
  workflowEnvelope(OrchestrationEventType.ChildStarted, childMetadataSchema),
  workflowEnvelope(OrchestrationEventType.ChildCompleted, childMetadataSchema),
  workflowEnvelope(OrchestrationEventType.ChildCompletionConsumed, childMetadataSchema),
  workflowEnvelope(OrchestrationEventType.CausalActivationRejected, childMetadataSchema),
  workflowEnvelope(
    OrchestrationEventType.GroupBudgetExhausted,
    z.object({ ...childMetadataShape, maxPerGroup: z.number().int().positive() }).strict(),
  ),
  primaryClaimedEnvelope,
  groupClaimedEnvelope,
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
