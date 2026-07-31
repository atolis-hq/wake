import { z } from 'zod';
import {
  activationId,
  activityName,
  activityOrchestrationGroupId,
  activityWorkflowInstanceId,
  type ActivationId,
  type ActivityName,
  type ActivityOrchestrationGroupId,
  type ActivityOutcome,
  type ActivityWorkflowInstanceId,
} from '../../activities/index.js';
import {
  eventEnvelopeSchema,
  brandedStringSchema,
  offsetIsoTimestampSchema,
  type EventDraftUnion,
  type EventEnvelope,
  type EventUnion,
} from '../../kernel/index.js';
import { runId } from './identifiers.js';
import { ExecutionStreamKind, type RunStreamRef } from './streams.js';
import {
  ExecutionCancellationReason,
  ExecutionFailureCode,
  RunStatus,
  WorkspaceMode,
} from './vocabulary.js';
import { ExternalExecutionKind } from '../../activities/index.js';
import type { ExecutionFailure } from './views.js';
import type {
  Cancellation,
  ExternalExecutionReference,
  Lease,
  RecoveredRunResult,
} from './liveness.js';

export const ExecutionEventType = {
  RunStarted: 'execution.run-started',
  RunSucceeded: 'execution.run-succeeded',
  RunFailed: 'execution.run-failed',
  RunLeaseClaimed: 'execution.run-lease-claimed',
  RunLeaseRenewed: 'execution.run-lease-renewed',
  RunExternalExecutionReported: 'execution.run-external-execution-reported',
  RunCancellationRequested: 'execution.run-cancellation-requested',
  RunCancellationConfirmed: 'execution.run-cancellation-confirmed',
  RunCancelled: 'execution.run-cancelled',
  RunRecovered: 'execution.run-recovered',
  RunAmbiguous: 'execution.run-ambiguous',
} as const;

export interface RunStartedPayload {
  readonly activationId: ActivationId;
  readonly activity: ActivityName;
  readonly workflowInstanceId: ActivityWorkflowInstanceId;
  readonly orchestrationGroupId: ActivityOrchestrationGroupId;
  readonly attempt: number;
  readonly startedAt: string;
  readonly workspace?:
    | {
        readonly mode: typeof WorkspaceMode.ReadOnly | typeof WorkspaceMode.Branch;
        readonly path: string;
      }
    | undefined;
}

export interface ExecutionEventPayloads {
  readonly [ExecutionEventType.RunStarted]: RunStartedPayload;
  readonly [ExecutionEventType.RunSucceeded]: {
    readonly outcome: ActivityOutcome;
    readonly finishedAt: string;
  };
  readonly [ExecutionEventType.RunFailed]: {
    readonly failure: ExecutionFailure;
    readonly finishedAt: string;
  };
  readonly [ExecutionEventType.RunLeaseClaimed]: Lease;
  readonly [ExecutionEventType.RunLeaseRenewed]: Lease;
  readonly [ExecutionEventType.RunExternalExecutionReported]: ExternalExecutionReference;
  readonly [ExecutionEventType.RunCancellationRequested]: {
    readonly requestedAt: string;
    readonly reason: Cancellation['reason'];
  };
  readonly [ExecutionEventType.RunCancellationConfirmed]: { readonly confirmedAt: string };
  readonly [ExecutionEventType.RunCancelled]: { readonly finishedAt: string };
  readonly [ExecutionEventType.RunRecovered]: RecoveredRunResult;
  readonly [ExecutionEventType.RunAmbiguous]: {
    readonly reason: string;
    readonly finishedAt: string;
  };
}

export type ExecutionEvent = EventUnion<ExecutionEventPayloads, RunStreamRef>;
export type ExecutionEventDraft = EventDraftUnion<ExecutionEventPayloads, RunStreamRef>;
const streamSchema = z
  .object({
    kind: z.literal(ExecutionStreamKind.Run),
    id: brandedStringSchema(runId),
  })
  .strict();
const eventSchema: z.ZodType<ExecutionEvent> = z.discriminatedUnion('eventType', [
  eventEnvelopeSchema.extend({
    eventType: z.literal(ExecutionEventType.RunStarted),
    stream: streamSchema,
    payload: z
      .object({
        activationId: brandedStringSchema(activationId),
        activity: brandedStringSchema(activityName),
        workflowInstanceId: brandedStringSchema(activityWorkflowInstanceId),
        orchestrationGroupId: brandedStringSchema(activityOrchestrationGroupId),
        attempt: z.number().int().positive(),
        startedAt: offsetIsoTimestampSchema,
        workspace: z
          .object({
            mode: z.enum([WorkspaceMode.ReadOnly, WorkspaceMode.Branch]),
            path: z.string().min(1),
          })
          .strict()
          .optional(),
      })
      .strict(),
  }),
  eventEnvelopeSchema.extend({
    eventType: z.literal(ExecutionEventType.RunCancelled),
    stream: streamSchema,
    payload: z.object({ finishedAt: offsetIsoTimestampSchema }).strict(),
  }),
  eventEnvelopeSchema.extend({
    eventType: z.literal(ExecutionEventType.RunSucceeded),
    stream: streamSchema,
    payload: z
      .object({
        outcome: z.object({ kind: z.string().min(1), data: z.unknown().optional() }).strict(),
        finishedAt: offsetIsoTimestampSchema,
      })
      .strict(),
  }),
  eventEnvelopeSchema.extend({
    eventType: z.literal(ExecutionEventType.RunFailed),
    stream: streamSchema,
    payload: z
      .object({
        failure: z
          .object({
            kind: z.enum([ExecutionFailureCode.Unexpected]),
            message: z.string(),
            details: z
              .object({
                sourceKind: z.string().min(1),
                sourceDetails: z.unknown().optional(),
              })
              .strict()
              .optional(),
          })
          .strict(),
        finishedAt: offsetIsoTimestampSchema,
      })
      .strict(),
  }),
  eventEnvelopeSchema.extend({
    eventType: z.literal(ExecutionEventType.RunLeaseClaimed),
    stream: streamSchema,
    payload: leaseSchema(),
  }),
  eventEnvelopeSchema.extend({
    eventType: z.literal(ExecutionEventType.RunLeaseRenewed),
    stream: streamSchema,
    payload: leaseSchema(),
  }),
  eventEnvelopeSchema.extend({
    eventType: z.literal(ExecutionEventType.RunExternalExecutionReported),
    stream: streamSchema,
    payload: z
      .object({
        kind: z.enum([ExternalExecutionKind.Process, ExternalExecutionKind.RemoteSession]),
        id: z.string().min(1),
        startedAt: offsetIsoTimestampSchema,
      })
      .strict(),
  }),
  eventEnvelopeSchema.extend({
    eventType: z.literal(ExecutionEventType.RunCancellationRequested),
    stream: streamSchema,
    payload: z
      .object({
        requestedAt: offsetIsoTimestampSchema,
        reason: z.enum(
          Object.values(ExecutionCancellationReason) as [
            ExecutionCancellationReason,
            ...ExecutionCancellationReason[],
          ],
        ),
      })
      .strict(),
  }),
  eventEnvelopeSchema.extend({
    eventType: z.literal(ExecutionEventType.RunCancellationConfirmed),
    stream: streamSchema,
    payload: z.object({ confirmedAt: offsetIsoTimestampSchema }).strict(),
  }),
  eventEnvelopeSchema.extend({
    eventType: z.literal(ExecutionEventType.RunRecovered),
    stream: streamSchema,
    payload: z
      .object({
        result: runnerResultSchema(),
        outcome: z.object({ kind: z.string().min(1), data: z.unknown().optional() }).strict(),
        finishedAt: offsetIsoTimestampSchema,
      })
      .strict(),
  }),
  eventEnvelopeSchema.extend({
    eventType: z.literal(ExecutionEventType.RunAmbiguous),
    stream: streamSchema,
    payload: z.object({ reason: z.string().min(1), finishedAt: offsetIsoTimestampSchema }).strict(),
  }),
]);

function leaseSchema() {
  return z
    .object({
      owner: z.string().min(1),
      acquiredAt: offsetIsoTimestampSchema,
      expiresAt: offsetIsoTimestampSchema,
    })
    .strict();
}

function runnerResultSchema() {
  return z
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
}

export function decodeExecutionEvent(event: EventEnvelope): ExecutionEvent {
  const result = eventSchema.safeParse(event);
  if (!result.success) throw invalidExecutionEvent(event, result.error);
  return result.data;
}

export function selectExecutionEvent(event: EventEnvelope): ExecutionEvent | null {
  return event.eventType.startsWith('execution.') ? decodeExecutionEvent(event) : null;
}

function invalidExecutionEvent(event: EventEnvelope, cause: z.ZodError): Error {
  return new Error(
    `Invalid Execution event ${event.eventId} at global position ${event.globalPosition} (${event.eventType}): ${cause.message}`,
    { cause },
  );
}
