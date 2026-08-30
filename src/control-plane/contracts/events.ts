import { z } from 'zod';
import {
  EventSourceKind,
  createEventData,
  eventDataSchema,
  eventEnvelopeSchema,
  type CommandContext,
  type EventDataUnion,
  type EventEnvelope,
  type EventUnion,
} from '../../kernel/index.js';
import { ControlStreamKind, type ControlStreamRef } from './streams.js';

export const ControlEventType = {
  DispatchPaused: 'control-plane.dispatch-paused',
  DispatchResumed: 'control-plane.dispatch-resumed',
  RunnerPaused: 'control-plane.runner-paused',
  RunnerResumed: 'control-plane.runner-resumed',
} as const;

export const RunnerPauseCause = { Manual: 'manual', Quota: 'quota' } as const;

export const ControlEventNamespace = 'control-plane.' as const;

export interface ControlEventPayloads {
  readonly [ControlEventType.DispatchPaused]: {
    readonly resumeAt: string;
    readonly reason: string;
  };
  readonly [ControlEventType.DispatchResumed]: { readonly resumedAt: string };
  readonly [ControlEventType.RunnerPaused]: {
    readonly runnerName: string;
    readonly cause: (typeof RunnerPauseCause)[keyof typeof RunnerPauseCause];
    readonly reason: string;
    readonly resumeAt?: string | undefined;
  };
  readonly [ControlEventType.RunnerResumed]: {
    readonly runnerName: string;
    readonly resumedAt: string;
  };
}

export type ControlEvent = EventUnion<ControlEventPayloads, ControlStreamRef>;

export type ControlEventData = EventDataUnion<ControlEventPayloads>;

const streamSchema = z
  .object({ kind: z.literal(ControlStreamKind.Global), id: z.literal('global') })
  .strict();
const eventSchema: z.ZodType<ControlEvent> = z.union([
  eventEnvelopeSchema.extend({
    event: eventDataSchema.extend({
      eventType: z.literal(ControlEventType.DispatchPaused),
      payload: z
        .object({ resumeAt: z.string().datetime({ offset: true }), reason: z.string().min(1) })
        .strict(),
    }),
    stream: streamSchema,
  }),
  eventEnvelopeSchema.extend({
    event: eventDataSchema.extend({
      eventType: z.literal(ControlEventType.DispatchResumed),
      payload: z.object({ resumedAt: z.string().datetime({ offset: true }) }).strict(),
    }),
    stream: streamSchema,
  }),
  eventEnvelopeSchema.extend({
    event: eventDataSchema.extend({
      eventType: z.literal(ControlEventType.RunnerPaused),
      payload: z
        .object({
          runnerName: z.string().trim().min(1),
          cause: z.enum(RunnerPauseCause),
          reason: z.string().min(1),
          resumeAt: z.string().datetime({ offset: true }).optional(),
        })
        .strict()
        .superRefine((value, context) => {
          if (value.cause === RunnerPauseCause.Quota && value.resumeAt === undefined)
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'Quota runner pauses require resumeAt',
            });
        }),
    }),
    stream: streamSchema,
  }),
  eventEnvelopeSchema.extend({
    event: eventDataSchema.extend({
      eventType: z.literal(ControlEventType.RunnerResumed),
      payload: z
        .object({
          runnerName: z.string().trim().min(1),
          resumedAt: z.string().datetime({ offset: true }),
        })
        .strict(),
    }),
    stream: streamSchema,
  }),
]);

export function decodeControlEvent(event: EventEnvelope): ControlEvent {
  const result = eventSchema.safeParse(event);
  if (!result.success)
    throw new Error(`Invalid Control Plane event ${event.event.eventId}: ${result.error.message}`, {
      cause: result.error,
    });
  return result.data;
}

export function selectControlEvent(event: EventEnvelope): ControlEvent | null {
  return event.event.eventType.startsWith(ControlEventNamespace) ? decodeControlEvent(event) : null;
}

export function createControlEventData<Type extends keyof ControlEventPayloads>(
  eventType: Type,
  payload: ControlEventPayloads[Type],
  context: CommandContext,
): ControlEventData {
  return createEventData({
    eventId: `${context.commandId}:${eventType}`,
    eventType,
    occurredAt: context.occurredAt,
    correlationId: context.correlationId,
    causationId: context.commandId,
    actor: context.actor,
    source: { kind: EventSourceKind.Internal, id: ControlStreamKind.Global },
    payload,
  }) as ControlEventData;
}
