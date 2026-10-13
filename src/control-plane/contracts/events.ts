import {
  eventDataSchema,
  eventEnvelopeSchema,
  type EventDataUnion,
  type EventEnvelope,
  type EventUnion,
} from '@atolis-hq/eventing';
import { z } from 'zod';
import { WorkflowStatus } from '../../orchestration/index.js';
import { ControlStreamKind, type ControlStreamRef } from './streams.js';

export const ControlEventType = {
  TriggerRequestRecorded: 'control-plane.trigger-request-recorded',
  TriggerInvocationClaimed: 'control-plane.trigger-invocation-claimed',
  TriggerPaused: 'control-plane.trigger-paused',
  TriggerResumed: 'control-plane.trigger-resumed',
  TriggerInvocationFinished: 'control-plane.trigger-invocation-finished',
  TriggerInvocationStarted: 'control-plane.trigger-invocation-started',
  DispatchPaused: 'control-plane.dispatch-paused',
  DispatchResumed: 'control-plane.dispatch-resumed',
  RunnerPaused: 'control-plane.runner-paused',
  RunnerResumed: 'control-plane.runner-resumed',
} as const;

export const RunnerPauseCause = { Manual: 'manual', Quota: 'quota' } as const;

export const ControlEventNamespace = 'control-plane.' as const;

export const TriggerRequestDisposition = { Coalesced: 'coalesced', Skipped: 'skipped' } as const;

export const TriggerSourceKind = { Event: 'event', Cron: 'cron' } as const;

export const triggerSourceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal(TriggerSourceKind.Event),
      eventId: z.string().min(1),
      eventType: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal(TriggerSourceKind.Cron),
      slot: z.string().datetime({ offset: true }),
    })
    .strict(),
]);

export type TriggerSource = z.infer<typeof triggerSourceSchema>;

export interface ControlEventPayloads {
  readonly [ControlEventType.TriggerRequestRecorded]: {
    readonly triggerId: string;
    readonly coordinationKey: string;
    readonly source: TriggerSource;
    readonly disposition: (typeof TriggerRequestDisposition)[keyof typeof TriggerRequestDisposition];
  };
  readonly [ControlEventType.TriggerInvocationClaimed]: {
    readonly triggerId: string;
    readonly coordinationKey: string;
    readonly source: TriggerSource;
    readonly sources: readonly TriggerSource[];
    readonly workItemId: string;
    readonly workflowInstanceId: string;
    readonly workflowName: string;
  };
  readonly [ControlEventType.TriggerPaused]: {
    readonly triggerId: string;
    readonly reason: string;
  };
  readonly [ControlEventType.TriggerResumed]: { readonly triggerId: string };
  readonly [ControlEventType.TriggerInvocationFinished]: {
    readonly triggerId: string;
    readonly workflowInstanceId: string;
    readonly status:
      | typeof WorkflowStatus.Completed
      | typeof WorkflowStatus.Blocked
      | typeof WorkflowStatus.Superseded;
    readonly reason?: string | undefined;
  };
  readonly [ControlEventType.TriggerInvocationStarted]: {
    readonly triggerId: string;
    readonly source: TriggerSource;
    readonly workItemId: string;
    readonly workflowInstanceId: string;
    readonly workflowName: string;
  };
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
      eventType: z.literal(ControlEventType.TriggerRequestRecorded),
      payload: z
        .object({
          triggerId: z.string().min(1),
          coordinationKey: z.string().min(1),
          source: triggerSourceSchema,
          disposition: z.enum(TriggerRequestDisposition),
        })
        .strict(),
    }),
    stream: streamSchema,
  }),
  eventEnvelopeSchema.extend({
    event: eventDataSchema.extend({
      eventType: z.literal(ControlEventType.TriggerInvocationClaimed),
      payload: z
        .object({
          triggerId: z.string().min(1),
          coordinationKey: z.string().min(1),
          source: triggerSourceSchema,
          sources: z.array(triggerSourceSchema).min(1),
          workItemId: z.string().min(1),
          workflowInstanceId: z.string().min(1),
          workflowName: z.string().min(1),
        })
        .strict(),
    }),
    stream: streamSchema,
  }),
  eventEnvelopeSchema.extend({
    event: eventDataSchema.extend({
      eventType: z.literal(ControlEventType.TriggerPaused),
      payload: z.object({ triggerId: z.string().min(1), reason: z.string().min(1) }).strict(),
    }),
    stream: streamSchema,
  }),
  eventEnvelopeSchema.extend({
    event: eventDataSchema.extend({
      eventType: z.literal(ControlEventType.TriggerResumed),
      payload: z.object({ triggerId: z.string().min(1) }).strict(),
    }),
    stream: streamSchema,
  }),
  eventEnvelopeSchema.extend({
    event: eventDataSchema.extend({
      eventType: z.literal(ControlEventType.TriggerInvocationFinished),
      payload: z
        .object({
          triggerId: z.string().min(1),
          workflowInstanceId: z.string().min(1),
          status: z.enum([
            WorkflowStatus.Completed,
            WorkflowStatus.Blocked,
            WorkflowStatus.Superseded,
          ]),
          reason: z.string().optional(),
        })
        .strict(),
    }),
    stream: streamSchema,
  }),
  eventEnvelopeSchema.extend({
    event: eventDataSchema.extend({
      eventType: z.literal(ControlEventType.TriggerInvocationStarted),
      payload: z
        .object({
          triggerId: z.string().min(1),
          source: triggerSourceSchema,
          workItemId: z.string().min(1),
          workflowInstanceId: z.string().min(1),
          workflowName: z.string().min(1),
        })
        .strict(),
    }),
    stream: streamSchema,
  }),
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
