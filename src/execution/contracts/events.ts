import { z } from 'zod';
import {
  activationId,
  activityName,
  activityOrchestrationGroupId,
  activityWorkflowInstanceId,
  ExternalExecutionKind,
  type ActivationId,
  type ActivityName,
  type ActivityOrchestrationGroupId,
  type ActivityOutcome,
  type ActivityWorkflowInstanceId,
} from '../../activities/index.js';
import {
  brandedStringSchema,
  eventEnvelopeSchema,
  offsetIsoTimestampSchema,
  type EventDraftUnion,
  type EventEnvelope,
  type EventUnion,
} from '../../kernel/index.js';
import { runId } from './identifiers.js';
import type { Cancellation, ExternalExecutionReference, Lease } from './liveness.js';
import type { ExecutionFailure, RecordedRunnerResult, RecoveredRunResult } from './results.js';
import { ExecutionStreamKind, type ActivationStreamRef, type RunStreamRef } from './streams.js';
import {
  ExecutionCancellationReason,
  ExecutionFailureCode,
  RunStatus,
  WorkspaceMode,
} from './vocabulary.js';

export const runStartedPayloadSchema = z
  .object({
    activationId: brandedStringSchema(activationId),
    activity: brandedStringSchema(activityName),
    stage: z.string().min(1).optional(),
    workflowInstanceId: brandedStringSchema(activityWorkflowInstanceId),
    orchestrationGroupId: brandedStringSchema(activityOrchestrationGroupId),
    attempt: z.number().int().positive(),
    startedAt: offsetIsoTimestampSchema,
    runner: z
      .object({
        name: z.string().min(1),
        model: z.string().min(1).optional(),
        effort: z.string().min(1).optional(),
        pool: z.string().min(1).optional(),
        cli: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    workspace: z
      .object({
        mode: z.enum([WorkspaceMode.ReadOnly, WorkspaceMode.Branch]),
        path: z.string().min(1),
        branch: z.string().min(1).optional(),
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
    // Legacy persisted events may still carry these fields; new writers never emit them.
    output: z.string().optional(),
    runner: z.string().min(1).optional(),
    agent: z
      .object({
        outcome: z.enum(['DONE', 'REJECTED', 'BLOCKED', 'FAILED']),
        displayBody: z.string(),
        artifacts: z
          .array(
            z
              .object({
                kind: z.string().min(1),
                externalKey: z
                  .object({ adapter: z.string().min(1), key: z.string().min(1) })
                  .strict(),
              })
              .strict(),
          )
          .optional(),
        metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
      })
      .strict()
      .optional(),
  })
  .strict();

export const ExecutionEventType = {
  RunStarted: 'execution.run-started',
  RunSucceeded: 'execution.run-succeeded',
  RunFailed: 'execution.run-failed',
  RunLeaseClaimed: 'execution.run-lease-claimed',
  RunLeaseRenewed: 'execution.run-lease-renewed',
  RunExternalExecutionReported: 'execution.run-external-execution-reported',
  RunRunnerResultReported: 'execution.run-runner-result-reported',
  RunWorkspaceCleanupFailed: 'execution.workspace-cleanup-failed',
  RunCancellationRequested: 'execution.run-cancellation-requested',
  RunCancellationConfirmed: 'execution.run-cancellation-confirmed',
  RunCancelled: 'execution.run-cancelled',
  RunRecovered: 'execution.run-recovered',
  RunAmbiguityObserved: 'execution.run-ambiguity-observed',
  RunAmbiguous: 'execution.run-ambiguous',
  ActivationClaimed: 'execution.activation-claimed',
  ActivationReleased: 'execution.activation-released',
} as const;

export const ExecutionEventNamespace = 'execution.' as const;

export interface RunStartedPayload {
  readonly activationId: ActivationId;
  readonly activity: ActivityName;
  readonly stage?: string | undefined;
  readonly workflowInstanceId: ActivityWorkflowInstanceId;
  readonly orchestrationGroupId: ActivityOrchestrationGroupId;
  readonly attempt: number;
  readonly startedAt: string;
  readonly runner?:
    | {
        readonly name: string;
        readonly model?: string | undefined;
        readonly effort?: string | undefined;
        readonly pool?: string | undefined;
        readonly cli?: string | undefined;
      }
    | undefined;
  readonly workspace?:
    | {
        readonly mode: typeof WorkspaceMode.ReadOnly | typeof WorkspaceMode.Branch;
        readonly path: string;
        readonly branch?: string | undefined;
      }
    | undefined;
}

export interface RunExecutionEventPayloads {
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
  readonly [ExecutionEventType.RunRunnerResultReported]: RecordedRunnerResult;
  readonly [ExecutionEventType.RunWorkspaceCleanupFailed]: { readonly message: string };
  readonly [ExecutionEventType.RunCancellationRequested]: {
    readonly requestedAt: string;
    readonly reason: Cancellation['reason'];
  };
  readonly [ExecutionEventType.RunCancellationConfirmed]: { readonly confirmedAt: string };
  readonly [ExecutionEventType.RunCancelled]: { readonly finishedAt: string };
  readonly [ExecutionEventType.RunRecovered]: RecoveredRunResult;
  readonly [ExecutionEventType.RunAmbiguityObserved]: {
    readonly reason: string;
    readonly attempt: number;
  };
  readonly [ExecutionEventType.RunAmbiguous]: {
    readonly reason: string;
    readonly finishedAt: string;
  };
}

export interface ActivationExecutionEventPayloads {
  readonly [ExecutionEventType.ActivationClaimed]: {
    readonly runId: ReturnType<typeof runId>;
    readonly owner: string;
    readonly expiresAt: string;
  };
  readonly [ExecutionEventType.ActivationReleased]: {
    readonly runId: ReturnType<typeof runId>;
  };
}

export type RunExecutionEvent = EventUnion<RunExecutionEventPayloads, RunStreamRef>;

export type RunExecutionEventDraft = EventDraftUnion<RunExecutionEventPayloads, RunStreamRef>;

export type ActivationExecutionEvent = EventUnion<
  ActivationExecutionEventPayloads,
  ActivationStreamRef
>;

export type ActivationExecutionEventDraft = EventDraftUnion<
  ActivationExecutionEventPayloads,
  ActivationStreamRef
>;

export type ExecutionEvent = RunExecutionEvent | ActivationExecutionEvent;

export type ExecutionEventDraft = RunExecutionEventDraft | ActivationExecutionEventDraft;

const runStreamSchema = z
  .object({
    kind: z.literal(ExecutionStreamKind.Run),
    id: brandedStringSchema(runId),
  })
  .strict();
const activationStreamSchema = z
  .object({
    kind: z.literal(ExecutionStreamKind.Activation),
    id: brandedStringSchema(activationId),
  })
  .strict();

const runEventSchema: z.ZodType<RunExecutionEvent> = z.discriminatedUnion('eventType', [
  eventEnvelopeSchema.extend({
    eventType: z.literal(ExecutionEventType.RunStarted),
    stream: runStreamSchema,
    payload: runStartedPayloadSchema,
  }),
  eventEnvelopeSchema.extend({
    eventType: z.literal(ExecutionEventType.RunRunnerResultReported),
    stream: runStreamSchema,
    payload: runnerResultPayloadSchema,
  }),
  eventEnvelopeSchema.extend({
    eventType: z.literal(ExecutionEventType.RunWorkspaceCleanupFailed),
    stream: runStreamSchema,
    payload: z.object({ message: z.string().min(1) }).strict(),
  }),
  eventEnvelopeSchema.extend({
    eventType: z.literal(ExecutionEventType.RunCancelled),
    stream: runStreamSchema,
    payload: z.object({ finishedAt: offsetIsoTimestampSchema }).strict(),
  }),
  eventEnvelopeSchema.extend({
    eventType: z.literal(ExecutionEventType.RunSucceeded),
    stream: runStreamSchema,
    payload: z
      .object({
        outcome: z.object({ kind: z.string().min(1), data: z.unknown().optional() }).strict(),
        finishedAt: offsetIsoTimestampSchema,
      })
      .strict(),
  }),
  eventEnvelopeSchema.extend({
    eventType: z.literal(ExecutionEventType.RunFailed),
    stream: runStreamSchema,
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
    stream: runStreamSchema,
    payload: leasePayloadSchema,
  }),
  eventEnvelopeSchema.extend({
    eventType: z.literal(ExecutionEventType.RunLeaseRenewed),
    stream: runStreamSchema,
    payload: leasePayloadSchema,
  }),
  eventEnvelopeSchema.extend({
    eventType: z.literal(ExecutionEventType.RunExternalExecutionReported),
    stream: runStreamSchema,
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
    stream: runStreamSchema,
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
    stream: runStreamSchema,
    payload: z.object({ confirmedAt: offsetIsoTimestampSchema }).strict(),
  }),
  eventEnvelopeSchema.extend({
    eventType: z.literal(ExecutionEventType.RunRecovered),
    stream: runStreamSchema,
    payload: z
      .object({
        result: runnerResultPayloadSchema,
        outcome: z.object({ kind: z.string().min(1), data: z.unknown().optional() }).strict(),
        finishedAt: offsetIsoTimestampSchema,
      })
      .strict(),
  }),
  eventEnvelopeSchema.extend({
    eventType: z.literal(ExecutionEventType.RunAmbiguityObserved),
    stream: runStreamSchema,
    payload: z.object({ reason: z.string().min(1), attempt: z.number().int().positive() }).strict(),
  }),
  eventEnvelopeSchema.extend({
    eventType: z.literal(ExecutionEventType.RunAmbiguous),
    stream: runStreamSchema,
    payload: z.object({ reason: z.string().min(1), finishedAt: offsetIsoTimestampSchema }).strict(),
  }),
]);

const activationEventSchema: z.ZodType<ActivationExecutionEvent> = z.discriminatedUnion(
  'eventType',
  [
    eventEnvelopeSchema.extend({
      eventType: z.literal(ExecutionEventType.ActivationClaimed),
      stream: activationStreamSchema,
      payload: z
        .object({
          runId: brandedStringSchema(runId),
          owner: z.string().min(1),
          expiresAt: offsetIsoTimestampSchema,
        })
        .strict(),
    }),
    eventEnvelopeSchema.extend({
      eventType: z.literal(ExecutionEventType.ActivationReleased),
      stream: activationStreamSchema,
      payload: z.object({ runId: brandedStringSchema(runId) }).strict(),
    }),
  ],
);

const eventSchema: z.ZodType<ExecutionEvent> = z.union([runEventSchema, activationEventSchema]);

export function decodeExecutionEvent(event: EventEnvelope): ExecutionEvent {
  const result = eventSchema.safeParse(event);
  if (!result.success) throw invalidExecutionEvent(event, result.error);
  return result.data;
}

export function decodeRunExecutionEvent(event: EventEnvelope): RunExecutionEvent {
  const result = runEventSchema.safeParse(event);
  if (!result.success) throw invalidExecutionEvent(event, result.error);
  return result.data;
}

export function decodeActivationExecutionEvent(event: EventEnvelope): ActivationExecutionEvent {
  const result = activationEventSchema.safeParse(event);
  if (!result.success) throw invalidExecutionEvent(event, result.error);
  return result.data;
}

export function selectExecutionEvent(event: EventEnvelope): ExecutionEvent | null {
  return event.eventType.startsWith(ExecutionEventNamespace) ? decodeExecutionEvent(event) : null;
}

export function selectRunExecutionEvent(event: EventEnvelope): RunExecutionEvent | null {
  if (!event.eventType.startsWith(ExecutionEventNamespace)) return null;
  if (event.stream.kind === ExecutionStreamKind.Run) return decodeRunExecutionEvent(event);
  decodeExecutionEvent(event);
  return null;
}

export function selectActivationExecutionEvent(
  event: EventEnvelope,
): ActivationExecutionEvent | null {
  if (!event.eventType.startsWith(ExecutionEventNamespace)) return null;
  if (event.stream.kind === ExecutionStreamKind.Activation)
    return decodeActivationExecutionEvent(event);
  decodeExecutionEvent(event);
  return null;
}

function invalidExecutionEvent(event: EventEnvelope, cause: z.ZodError): Error {
  return new Error(
    `Invalid Execution event ${event.eventId} at global position ${event.globalPosition} (${event.eventType}): ${cause.message}`,
    { cause },
  );
}
