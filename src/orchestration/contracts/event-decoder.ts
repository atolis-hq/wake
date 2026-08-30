import { z } from 'zod';

import {
  activationId,
  ActivityEventType,
  activityName,
  ActivityOutcomeKind,
  PullRequestCheckState,
  PullRequestState,
} from '../../activities/index.js';
import { WorkspaceMode } from '../../execution/index.js';
import {
  brandedStringSchema,
  eventDataSchema,
  eventEnvelopeSchema,
  type EventEnvelope,
} from '../../kernel/index.js';
import { workItemId } from '../../work/index.js';
import {
  orchestrationActivityOutcome,
  type OrchestrationWaitingActivityOutcome,
} from './activity-outcome.js';
import type { CompiledWorkflow } from './config.js';
import {
  OrchestrationEventType,
  type OrchestrationEvent,
  type WorkflowOrchestrationEvent,
} from './events.js';
import {
  orchestrationGroupId,
  signalName,
  stageName,
  watchId,
  workflowInstanceId,
  workflowName,
} from './identifiers.js';
import {
  childOrchestrationGroupStreamId,
  isWorkflowInstanceStream,
  OrchestrationStreamKind,
  primaryOrchestrationGroupStreamId,
} from './streams.js';
import { ApprovalAuthorityKind, TransitionTargetKind } from './vocabulary.js';

export const workflowInstanceIdSchema = brandedStringSchema(workflowInstanceId);

export const workflowStreamSchema = z
  .object({
    kind: z.literal(OrchestrationStreamKind.WorkflowInstance),
    id: workflowInstanceIdSchema,
  })
  .strict();
const primaryGroupIdSchema = brandedStringSchema(primaryOrchestrationGroupStreamId);

export const childGroupIdSchema = brandedStringSchema(childOrchestrationGroupStreamId);

export const primaryGroupStreamSchema = z
  .object({
    kind: z.literal(OrchestrationStreamKind.Group),
    id: primaryGroupIdSchema,
  })
  .strict();

export const childGroupStreamSchema = z
  .object({
    kind: z.literal(OrchestrationStreamKind.Group),
    id: childGroupIdSchema,
  })
  .strict();

const workflowDefinitionsStreamSchema = z
  .object({
    kind: z.literal(OrchestrationStreamKind.WorkflowDefinitions),
    id: z.literal('registry'),
  })
  .strict();

export const childMetadataShape = {
  parentWorkflowInstanceId: workflowInstanceIdSchema,
  watchId: z.string().min(1),
  triggerId: z.string().min(1),
  orchestrationGroupId: brandedStringSchema(orchestrationGroupId),
  causalCycleId: z.string().min(1),
  requestId: z.string().min(1),
  childWorkflowInstanceId: workflowInstanceIdSchema,
} as const;

export const childMetadataSchema = z.object(childMetadataShape).strict();

export const outcomeSchema = z
  .object({ kind: z.string().min(1), data: z.unknown().optional() })
  .strict();

export const waitingOutcomeSchema = z
  .object({
    kind: z.literal(ActivityOutcomeKind.Waiting),
    data: z
      .object({
        intentEventId: z.string().min(1),
        signalKind: brandedStringSchema(signalName),
      })
      .strict(),
  })
  .strict()
  .transform((outcome): OrchestrationWaitingActivityOutcome =>
    orchestrationActivityOutcome(outcome),
  );
const executionSchema = z
  .object({
    workspace: z
      .enum([WorkspaceMode.None, WorkspaceMode.ReadOnly, WorkspaceMode.Branch])
      .optional(),
    runnerPool: z.string().min(1).optional(),
  })
  .strict();

export const activityRequestedSchema = z
  .object({
    activationId: brandedStringSchema(activationId),
    ordinal: z.number().int().positive(),
    activity: brandedStringSchema(activityName),
    stage: brandedStringSchema(stageName).optional(),
    input: z.unknown(),
    execution: executionSchema.optional(),
    followOnIndex: z.number().int().nonnegative().optional(),
    supplemental: z.literal(true).optional(),
  })
  .strict();
const approvalAuthoritySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal(ApprovalAuthorityKind.Human) }).strict(),
  z.object({ kind: z.literal(ApprovalAuthorityKind.Auto) }).strict(),
  z
    .object({ kind: z.literal(ApprovalAuthorityKind.Watch), watch: brandedStringSchema(watchId) })
    .strict(),
]);
const transitionTargetSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal(TransitionTargetKind.Stage), stage: brandedStringSchema(stageName) })
    .strict(),
  z.object({ kind: z.literal(TransitionTargetKind.Complete) }).strict(),
  z
    .object({
      kind: z.literal(TransitionTargetKind.AwaitSignal),
      signal: brandedStringSchema(signalName),
    })
    .strict(),
  z.object({ kind: z.literal(TransitionTargetKind.ResourceTransitionWait) }).strict(),
]);
const resourceTransitionSchema = z
  .object({
    event: z.enum([
      ActivityEventType.PrReviewAccepted,
      ActivityEventType.PrStateChanged,
      ActivityEventType.PrChecksChanged,
    ]),
    where: z
      .union([
        z.object({ state: z.literal(PullRequestState.Merged) }).strict(),
        z.object({ checks: z.literal(PullRequestCheckState.Failing) }).strict(),
      ])
      .optional(),
    target: transitionTargetSchema,
  })
  .strict();

export const expectationSchema = z
  .object({
    signalKind: brandedStringSchema(signalName),
    resourceId: z.string().optional(),
    revision: z.string().optional(),
    from: z.array(approvalAuthoritySchema).min(1).optional(),
    resume: transitionTargetSchema.optional(),
    onRejectResume: transitionTargetSchema.optional(),
    resourceTransitions: z.array(resourceTransitionSchema).min(1).optional(),
  })
  .strict();

export const signalSchema = z
  .object({
    kind: brandedStringSchema(signalName),
    resourceId: z.string().optional(),
    revision: z.string().optional(),
    actorId: z.string().min(1),
    actorDecision: z.object({ authorized: z.boolean(), evidenceId: z.string().min(1) }).strict(),
    providerEventId: z.string().min(1),
    childWorkflowInstanceId: workflowInstanceIdSchema.optional(),
    requestId: z.string().optional(),
    authority: approvalAuthoritySchema.optional(),
    outcome: z
      .enum([
        ActivityOutcomeKind.Done,
        ActivityOutcomeKind.Rejected,
        ActivityOutcomeKind.Blocked,
        ActivityOutcomeKind.Failed,
      ])
      .optional(),
  })
  .strict();

export const emptySchema = z.object({}).strict();

export const workflowEnvelope = <Type extends string, Payload extends z.ZodType>(
  eventType: Type,
  payload: Payload,
) =>
  eventEnvelopeSchema.extend({
    event: eventDataSchema.extend({
      eventType: z.literal(eventType),
      payload,
    }),
    stream: workflowStreamSchema,
  });

export const primaryGroupEnvelope = <Type extends string, Payload extends z.ZodType>(
  eventType: Type,
  payload: Payload,
) =>
  eventEnvelopeSchema.extend({
    event: eventDataSchema.extend({
      eventType: z.literal(eventType),
      payload,
    }),
    stream: primaryGroupStreamSchema,
  });

export const childGroupEnvelope = <Type extends string, Payload extends z.ZodType>(
  eventType: Type,
  payload: Payload,
) =>
  eventEnvelopeSchema.extend({
    event: eventDataSchema.extend({
      eventType: z.literal(eventType),
      payload,
    }),
    stream: childGroupStreamSchema,
  });

const primaryClaimedEnvelope = primaryGroupEnvelope(
  OrchestrationEventType.PrimaryClaimed,
  z
    .object({
      workItemId: brandedStringSchema(workItemId),
      workflowInstanceId: workflowInstanceIdSchema,
    })
    .strict(),
).superRefine((event, context) => {
  if (event.stream.id !== `primary:${event.event.payload.workItemId}`)
    context.addIssue({
      code: 'custom',
      path: ['event', 'payload', 'workItemId'],
      message: 'Primary claim work item must identify its stream',
    });
});
const groupClaimedEnvelope = childGroupEnvelope(
  OrchestrationEventType.GroupClaimed,
  z.object({ key: childGroupIdSchema, requestId: z.string().min(1) }).strict(),
).superRefine((event, context) => {
  if (event.event.payload.key !== event.stream.id)
    context.addIssue({
      code: 'custom',
      path: ['event', 'payload', 'key'],
      message: 'Group claim key must identify its stream',
    });
});
const groupBudgetGrantedEnvelope = childGroupEnvelope(
  OrchestrationEventType.GroupBudgetGranted,
  z
    .object({ key: childGroupIdSchema, requestId: z.string().min(1), commandId: z.string().min(1) })
    .strict(),
).superRefine((event, context) => {
  if (event.event.payload.key !== event.stream.id)
    context.addIssue({
      code: 'custom',
      path: ['event', 'payload', 'key'],
      message: 'Group budget grant key must identify its stream',
    });
});
const eventSchema = z.union([
  workflowEnvelope(
    OrchestrationEventType.InstanceStarted,
    z.union([
      z
        .object({
          workItemId: brandedStringSchema(workItemId),
          workflowName: brandedStringSchema(workflowName),
          orchestrationGroupId: brandedStringSchema(orchestrationGroupId),
          entry: brandedStringSchema(stageName),
          workflowDefinitionFingerprint: z.string().min(1).optional(),
        })
        .strict(),
      z
        .object({
          workItemId: brandedStringSchema(workItemId),
          workflowName: brandedStringSchema(workflowName),
          entry: brandedStringSchema(stageName),
          workflowDefinitionFingerprint: z.string().min(1).optional(),
          ...childMetadataShape,
        })
        .strict(),
    ]),
  ),
  eventEnvelopeSchema.extend({
    event: eventDataSchema.extend({
      eventType: z.literal(OrchestrationEventType.WorkflowDefinitionRegistered),
      payload: z
        .object({
          workflowName: brandedStringSchema(workflowName),
          fingerprint: z.string().min(1),
          compiledDefinition: z.custom<CompiledWorkflow>(),
        })
        .strict(),
    }),
    stream: workflowDefinitionsStreamSchema,
  }),
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
    OrchestrationEventType.ActivityExecutionFailed,
    z
      .object({
        activationId: brandedStringSchema(activationId),
        runId: z.string().min(1),
        reason: z.string().min(1),
      })
      .strict(),
  ),
  workflowEnvelope(
    OrchestrationEventType.ActivityRetriedForRunnerQuota,
    z
      .object({
        activationId: brandedStringSchema(activationId),
        runId: z.string().min(1),
        runnerName: z.string().min(1),
        message: z.string().min(1),
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
  workflowEnvelope(
    OrchestrationEventType.OperatorRetryRequested,
    z
      .object({
        activationId: brandedStringSchema(activationId),
        commandId: z.string().min(1),
      })
      .strict(),
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
    z
      .object({
        ...childMetadataShape,
        maxPerGroup: z.number().int().positive(),
        workflowName: brandedStringSchema(workflowName).optional(),
      })
      .strict(),
  ),
  primaryClaimedEnvelope,
  groupClaimedEnvelope,
  groupBudgetGrantedEnvelope,
]);

export function decodeOrchestrationEvent(event: EventEnvelope): OrchestrationEvent {
  const result = eventSchema.safeParse(event);
  if (!result.success) throw invalidOrchestrationEvent(event, result.error);
  // Zod represents optional object members as `T | undefined`; the durable
  // contract uses exact optional members for compatibility with old events.
  return result.data as OrchestrationEvent;
}

export function selectOrchestrationEvent(event: EventEnvelope): OrchestrationEvent | null {
  return event.event.eventType.startsWith('orchestration.')
    ? decodeOrchestrationEvent(event)
    : null;
}

export function selectWorkflowOrchestrationEvent(
  event: EventEnvelope,
): WorkflowOrchestrationEvent | null {
  const owned = selectOrchestrationEvent(event);
  if (owned === null) return null;
  return isWorkflowEvent(owned) ? owned : null;
}

function isWorkflowEvent(event: OrchestrationEvent): event is WorkflowOrchestrationEvent {
  return isWorkflowInstanceStream(event.stream);
}

function invalidOrchestrationEvent(event: EventEnvelope, cause: z.ZodError): Error {
  return new Error(
    `Invalid Orchestration event ${event.event.eventId} at global position ${event.globalPosition} (${event.event.eventType}): ${cause.message}`,
    { cause },
  );
}
