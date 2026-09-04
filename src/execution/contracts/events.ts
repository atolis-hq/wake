import {
  eventDataSchema,
  eventEnvelopeSchema,
  type EventDataUnion,
  type EventEnvelope,
  type EventUnion,
} from '@atolis-hq/eventing';
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
import { brandedStringSchema, offsetIsoTimestampSchema } from '../../kernel/index.js';
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

export const runPreparationStartedPayloadSchema = z
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
        outcome: z.enum(['DONE', 'REJECTED', 'BLOCKED', 'FAILED', 'NEEDS_CLARIFICATION']),
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
  RunPreparationStarted: 'execution.run-preparation-started',
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

export interface RunPreparationStartedPayload {
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
}

export interface RunExecutionEventPayloads {
  readonly [ExecutionEventType.RunPreparationStarted]: RunPreparationStartedPayload;
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

export type RunExecutionEventData = EventDataUnion<RunExecutionEventPayloads>;

export type ActivationExecutionEvent = EventUnion<
  ActivationExecutionEventPayloads,
  ActivationStreamRef
>;

export type ActivationExecutionEventData = EventDataUnion<ActivationExecutionEventPayloads>;

export type ExecutionEvent = RunExecutionEvent | ActivationExecutionEvent;

export type ExecutionEventData = RunExecutionEventData | ActivationExecutionEventData;

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

const runEventSchema: z.ZodType<RunExecutionEvent> = eventEnvelopeSchema.extend({
  event: z.discriminatedUnion('eventType', [
    eventDataSchema.extend({
      eventType: z.literal(ExecutionEventType.RunPreparationStarted),
      payload: runPreparationStartedPayloadSchema,
    }),
    eventDataSchema.extend({
      eventType: z.literal(ExecutionEventType.RunStarted),
      payload: runStartedPayloadSchema,
    }),
    eventDataSchema.extend({
      eventType: z.literal(ExecutionEventType.RunRunnerResultReported),
      payload: runnerResultPayloadSchema,
    }),
    eventDataSchema.extend({
      eventType: z.literal(ExecutionEventType.RunWorkspaceCleanupFailed),
      payload: z.object({ message: z.string().min(1) }).strict(),
    }),
    eventDataSchema.extend({
      eventType: z.literal(ExecutionEventType.RunCancelled),
      payload: z.object({ finishedAt: offsetIsoTimestampSchema }).strict(),
    }),
    eventDataSchema.extend({
      eventType: z.literal(ExecutionEventType.RunSucceeded),
      payload: z
        .object({
          outcome: z.object({ kind: z.string().min(1), data: z.unknown().optional() }).strict(),
          finishedAt: offsetIsoTimestampSchema,
        })
        .strict(),
    }),
    eventDataSchema.extend({
      eventType: z.literal(ExecutionEventType.RunFailed),
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
    eventDataSchema.extend({
      eventType: z.literal(ExecutionEventType.RunLeaseClaimed),
      payload: leasePayloadSchema,
    }),
    eventDataSchema.extend({
      eventType: z.literal(ExecutionEventType.RunLeaseRenewed),
      payload: leasePayloadSchema,
    }),
    eventDataSchema.extend({
      eventType: z.literal(ExecutionEventType.RunExternalExecutionReported),
      payload: z
        .object({
          kind: z.enum([ExternalExecutionKind.Process, ExternalExecutionKind.RemoteSession]),
          id: z.string().min(1),
          startedAt: offsetIsoTimestampSchema,
        })
        .strict(),
    }),
    eventDataSchema.extend({
      eventType: z.literal(ExecutionEventType.RunCancellationRequested),
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
    eventDataSchema.extend({
      eventType: z.literal(ExecutionEventType.RunCancellationConfirmed),
      payload: z.object({ confirmedAt: offsetIsoTimestampSchema }).strict(),
    }),
    eventDataSchema.extend({
      eventType: z.literal(ExecutionEventType.RunRecovered),
      payload: z
        .object({
          result: runnerResultPayloadSchema,
          outcome: z.object({ kind: z.string().min(1), data: z.unknown().optional() }).strict(),
          finishedAt: offsetIsoTimestampSchema,
        })
        .strict(),
    }),
    eventDataSchema.extend({
      eventType: z.literal(ExecutionEventType.RunAmbiguityObserved),
      payload: z
        .object({ reason: z.string().min(1), attempt: z.number().int().positive() })
        .strict(),
    }),
    eventDataSchema.extend({
      eventType: z.literal(ExecutionEventType.RunAmbiguous),
      payload: z
        .object({ reason: z.string().min(1), finishedAt: offsetIsoTimestampSchema })
        .strict(),
    }),
  ]),
  stream: runStreamSchema,
});

const activationEventSchema: z.ZodType<ActivationExecutionEvent> = eventEnvelopeSchema.extend({
  event: z.discriminatedUnion('eventType', [
    eventDataSchema.extend({
      eventType: z.literal(ExecutionEventType.ActivationClaimed),
      payload: z
        .object({
          runId: brandedStringSchema(runId),
          owner: z.string().min(1),
          expiresAt: offsetIsoTimestampSchema,
        })
        .strict(),
    }),
    eventDataSchema.extend({
      eventType: z.literal(ExecutionEventType.ActivationReleased),
      payload: z.object({ runId: brandedStringSchema(runId) }).strict(),
    }),
  ]),
  stream: activationStreamSchema,
});

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
  return event.event.eventType.startsWith(ExecutionEventNamespace)
    ? decodeExecutionEvent(event)
    : null;
}

export function selectRunExecutionEvent(event: EventEnvelope): RunExecutionEvent | null {
  if (!event.event.eventType.startsWith(ExecutionEventNamespace)) return null;
  if (event.stream.kind === ExecutionStreamKind.Run) return decodeRunExecutionEvent(event);
  decodeExecutionEvent(event);
  return null;
}

export function selectActivationExecutionEvent(
  event: EventEnvelope,
): ActivationExecutionEvent | null {
  if (!event.event.eventType.startsWith(ExecutionEventNamespace)) return null;
  if (event.stream.kind === ExecutionStreamKind.Activation)
    return decodeActivationExecutionEvent(event);
  decodeExecutionEvent(event);
  return null;
}

function invalidExecutionEvent(event: EventEnvelope, cause: z.ZodError): Error {
  return new Error(
    `Invalid Execution event ${event.event.eventId} at global position ${event.globalPosition} (${event.event.eventType}): ${cause.message}`,
    { cause },
  );
}
