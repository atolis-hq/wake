import { z } from 'zod';
import { workflowInstanceId } from './identifiers.js';
import {
  childOrchestrationGroupStreamId,
  OrchestrationStreamKind,
  primaryOrchestrationGroupStreamId,
} from './streams.js';

export const workflowInstanceIdSchema = z.string().min(1).transform(workflowInstanceId);
export const workflowStreamSchema = z
  .object({
    kind: z.literal(OrchestrationStreamKind.WorkflowInstance),
    id: workflowInstanceIdSchema,
  })
  .strict();
const primaryGroupIdSchema = z
  .string()
  .regex(/^primary:work-[a-z0-9-]+$/)
  .transform(primaryOrchestrationGroupStreamId);
export const childGroupIdSchema = z
  .string()
  .regex(/^group:[^:]+:watch:[^:]+$/)
  .transform(childOrchestrationGroupStreamId);
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
  orchestrationGroupId: z.string().min(1),
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
export const activityRequestedSchema = z
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
export const expectationSchema = z
  .object({
    signalKind: z.string().min(1),
    resourceId: z.string().optional(),
    revision: z.string().optional(),
  })
  .strict();
export const signalSchema = z
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
export const emptySchema = z.object({}).strict();
