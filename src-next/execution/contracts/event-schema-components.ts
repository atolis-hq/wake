import { z } from 'zod';
import {
  activationId,
  activityName,
  activityOrchestrationGroupId,
  activityWorkflowInstanceId,
} from '../../activities/index.js';
import { brandedStringSchema, offsetIsoTimestampSchema } from '../../kernel/index.js';
import { RunStatus, WorkspaceMode } from './vocabulary.js';

export const runStartedPayloadSchema = z
  .object({
    activationId: brandedStringSchema(activationId),
    activity: brandedStringSchema(activityName),
    workflowInstanceId: brandedStringSchema(activityWorkflowInstanceId),
    orchestrationGroupId: brandedStringSchema(activityOrchestrationGroupId),
    attempt: z.number().int().positive(),
    startedAt: offsetIsoTimestampSchema,
    runner: z
      .object({ name: z.string().min(1), model: z.string().min(1).optional() })
      .strict()
      .optional(),
    workspace: z
      .object({
        mode: z.enum([WorkspaceMode.ReadOnly, WorkspaceMode.Branch]),
        path: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

export const leasePayloadSchema = z
  .object({
    owner: z.string().min(1),
    acquiredAt: offsetIsoTimestampSchema,
    expiresAt: offsetIsoTimestampSchema,
  })
  .strict();

export const runnerResultPayloadSchema = z
  .object({
    transport: z.enum([
      RunStatus.Succeeded,
      RunStatus.Failed,
      RunStatus.Cancelled,
      RunStatus.Ambiguous,
    ]),
    output: z.string(),
    runner: z.string().min(1),
    model: z.string().optional(),
    sessionId: z.string().optional(),
    tokenUsage: z
      .object({
        input: z.number(),
        output: z.number(),
        cacheRead: z.number().optional(),
        cacheWrite: z.number().optional(),
        costUsd: z.number().optional(),
      })
      .strict()
      .optional(),
    failure: z
      .object({ kind: z.string().min(1), message: z.string() })
      .strict()
      .optional(),
  })
  .strict();
