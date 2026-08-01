import { activationId, activityName, ActivityOutcomeKind } from '../../activities/index.js';
import { WorkspaceMode } from '../../execution/index.js';
import { z } from 'zod';
import { brandedStringSchema } from '../../kernel/index.js';
import {
  orchestrationActivityOutcome,
  type OrchestrationWaitingActivityOutcome,
} from './activity-outcome.js';
import {
  orchestrationGroupId,
  signalName,
  stageName,
  watchId,
  workflowInstanceId,
} from './identifiers.js';
import {
  childOrchestrationGroupStreamId,
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
]);
export const expectationSchema = z
  .object({
    signalKind: brandedStringSchema(signalName),
    resourceId: z.string().optional(),
    revision: z.string().optional(),
    from: z.array(approvalAuthoritySchema).min(1).optional(),
    resume: transitionTargetSchema.optional(),
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
  })
  .strict();
export const emptySchema = z.object({}).strict();
