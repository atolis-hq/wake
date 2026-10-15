import { z } from 'zod';
import {
  TriggerStatus,
  type OrphanedInstructionsResponse,
  type TriggerResponse,
} from '../../../api/contracts/index.js';
import { WorkflowStatusValue } from '../../../api/contracts/transport-values.js';
import {
  manualTriggerOutcomeSchema,
  triggerDefinitionSchema,
  TriggerRequestDisposition,
  triggerSkipDiagnosticSchema,
  triggerSourceSchema,
  WorkflowStatus,
} from './trigger-transport.js';

const request = z.object({
  triggerId: z.string(),
  coordinationKey: z.string(),
  source: triggerSourceSchema,
  disposition: z.enum(TriggerRequestDisposition),
  sources: z.array(triggerSourceSchema),
  manualOutcome: manualTriggerOutcomeSchema.optional(),
  activeWorkItemId: z.string().nullable(),
});
const invocation = z.object({
  claim: z.object({
    triggerId: z.string(),
    coordinationKey: z.string(),
    source: triggerSourceSchema,
    sources: z.array(triggerSourceSchema),
    workItemId: z.string(),
    workflowInstanceId: z.string(),
    workflowName: z.string(),
  }),
  claimedAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  failureOutcomeCount: z.number().optional(),
  result: z
    .object({
      triggerId: z.string(),
      coordinationKey: z.string(),
      workItemId: z.string(),
      workflowInstanceId: z.string(),
      status: z.enum([WorkflowStatus.Completed, WorkflowStatus.Superseded]),
      reason: z.string().optional(),
    })
    .optional(),
  workItemKey: z.string(),
});
const schema = z.object({
  operatorInstructions: z
    .object({
      contextScope: z.string(),
      revisionId: z.string(),
      content: z.string(),
      author: z.string(),
      occurredAt: z.string(),
    })
    .nullable()
    .optional(),
  activeInvocation: z
    .object({
      activeWorkItemId: z.string(),
      workItemKey: z.string(),
      triggerId: z.string(),
      workflowInstanceId: z.string(),
      workflowStatus: z.enum(WorkflowStatusValue).nullable(),
      blockReason: z.string().nullable(),
      retryEligible: z.boolean(),
    })
    .nullable(),
  triggerId: z.string(),
  status: z.enum(TriggerStatus),
  definition: triggerDefinitionSchema.nullable(),
  paused: z.boolean(),
  pauseReason: z.string().nullable(),
  nextOccurrence: z.string().nullable(),
  pending: z.array(request),
  latestSkip: triggerSkipDiagnosticSchema.nullable(),
  invocations: z.array(invocation),
});

export function decodeTrigger(value: unknown): TriggerResponse {
  return schema.parse(value);
}

export function decodeTriggers(value: unknown): readonly TriggerResponse[] {
  return z.array(schema).parse(value);
}

export function decodeOrphanedInstructions(
  value: unknown,
): readonly OrphanedInstructionsResponse[] {
  return z
    .array(
      z.object({
        contextScope: z.string(),
        revisionId: z.string(),
        content: z.string().nullable(),
        author: z.string(),
        occurredAt: z.string(),
      }),
    )
    .parse(value);
}
