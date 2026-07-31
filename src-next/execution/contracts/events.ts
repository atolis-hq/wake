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
import { ExecutionFailureCode, WorkspaceMode } from './vocabulary.js';
import type { ExecutionFailure } from './views.js';

export const ExecutionEventType = {
  RunStarted: 'execution.run-started',
  RunSucceeded: 'execution.run-succeeded',
  RunFailed: 'execution.run-failed',
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
}

export type ExecutionEvent = EventUnion<ExecutionEventPayloads, RunStreamRef>;
export type ExecutionEventDraft = EventDraftUnion<ExecutionEventPayloads, RunStreamRef>;

const streamSchema = z
  .object({
    kind: z.literal(ExecutionStreamKind.Run),
    id: brandedStringSchema(runId),
  })
  .strict();
const eventSchema = z.discriminatedUnion('eventType', [
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
]);

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
