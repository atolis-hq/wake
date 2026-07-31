import { z } from 'zod';
import type { ActivityOutcome } from '../../activities/index.js';
import {
  eventEnvelopeSchema,
  type EventDraftUnion,
  type EventEnvelope,
  type EventUnion,
} from '../../kernel/index.js';
import { runId } from './identifiers.js';
import { ExecutionStreamKind, type RunStreamRef } from './streams.js';

export const ExecutionEventType = {
  RunStarted: 'execution.run-started',
  RunSucceeded: 'execution.run-succeeded',
  RunFailed: 'execution.run-failed',
} as const;

export interface RunStartedPayload {
  readonly activationId: string;
  readonly activity: string;
  readonly attempt: number;
  readonly startedAt: string;
  readonly workspace?: { readonly mode: 'read-only' | 'branch'; readonly path: string } | undefined;
}

export interface ExecutionEventPayloads {
  readonly [ExecutionEventType.RunStarted]: RunStartedPayload;
  readonly [ExecutionEventType.RunSucceeded]: {
    readonly outcome: ActivityOutcome;
    readonly finishedAt: string;
  };
  readonly [ExecutionEventType.RunFailed]: {
    readonly failure: { readonly kind: string; readonly message: string };
    readonly finishedAt: string;
  };
}

export type ExecutionEvent = EventUnion<ExecutionEventPayloads, RunStreamRef>;
export type ExecutionEventDraft = EventDraftUnion<ExecutionEventPayloads, RunStreamRef>;

const timestampSchema = z.iso.datetime({ offset: true });
const streamSchema = z
  .object({
    kind: z.literal(ExecutionStreamKind.Run),
    id: z.string().transform(runId),
  })
  .strict();
const eventSchema = z.discriminatedUnion('eventType', [
  eventEnvelopeSchema.extend({
    eventType: z.literal(ExecutionEventType.RunStarted),
    stream: streamSchema,
    payload: z
      .object({
        activationId: z.string().min(1),
        activity: z.string().min(1),
        attempt: z.number().int().positive(),
        startedAt: timestampSchema,
        workspace: z
          .object({ mode: z.enum(['read-only', 'branch']), path: z.string().min(1) })
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
        finishedAt: timestampSchema,
      })
      .strict(),
  }),
  eventEnvelopeSchema.extend({
    eventType: z.literal(ExecutionEventType.RunFailed),
    stream: streamSchema,
    payload: z
      .object({
        failure: z.object({ kind: z.string(), message: z.string() }).strict(),
        finishedAt: timestampSchema,
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
