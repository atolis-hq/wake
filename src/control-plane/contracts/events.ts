import {
  eventDataSchema,
  eventEnvelopeSchema,
  type EventDataUnion,
  type EventEnvelope,
  type EventUnion,
} from '@atolis-hq/eventing';
import { z } from 'zod';
import { WorkflowStatus } from '../../orchestration/index.js';
import {
  ControlStreamKind,
  type GlobalControlStreamRef,
  type TriggerControlStreamRef,
  type TriggerInvocationStreamRef,
} from './streams.js';
import { TriggerSkipReason } from './trigger-skip-reason.js';

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

export const TriggerSourceKind = { Event: 'event', Cron: 'cron', Manual: 'manual' } as const;

const manualStartedShape = { started: true };

export const ManualTriggerDisposition = {
  Started: Object.keys(manualStartedShape)[0]! as keyof typeof manualStartedShape,
  Coalesced: TriggerRequestDisposition.Coalesced,
  Skipped: TriggerRequestDisposition.Skipped,
} as const;

export const manualTriggerOutcomeSchema = z.discriminatedUnion('disposition', [
  z.object({ disposition: z.literal(ManualTriggerDisposition.Started) }).strict(),
  z.object({ disposition: z.literal(ManualTriggerDisposition.Coalesced) }).strict(),
  z
    .object({
      disposition: z.literal(ManualTriggerDisposition.Skipped),
      reason: z.enum(TriggerSkipReason),
    })
    .strict(),
]);

export type ManualTriggerOutcome = z.infer<typeof manualTriggerOutcomeSchema>;

export const triggerSourceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal(TriggerSourceKind.Manual),
      commandId: z.string().min(1),
      operator: z.string().min(1),
    })
    .strict(),
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
    readonly manualOutcome?: ManualTriggerOutcome | undefined;
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
    readonly coordinationKey: string;
    readonly workflowInstanceId?: string | undefined;
    readonly outcomeCount?: number | undefined;
  };
  readonly [ControlEventType.TriggerResumed]: {
    readonly triggerId: string;
    readonly coordinationKey: string;
  };
  readonly [ControlEventType.TriggerInvocationFinished]: {
    readonly triggerId: string;
    readonly workflowInstanceId: string;
    readonly workItemId: string;
    readonly coordinationKey: string;
    readonly status: typeof WorkflowStatus.Completed | typeof WorkflowStatus.Superseded;
    readonly reason?: string | undefined;
  };
  readonly [ControlEventType.TriggerInvocationStarted]: {
    readonly triggerId: string;
    readonly coordinationKey: string;
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

type InvocationEventType =
  | typeof ControlEventType.TriggerInvocationClaimed
  | typeof ControlEventType.TriggerInvocationStarted
  | typeof ControlEventType.TriggerInvocationFinished;

type TriggerEventType =
  | typeof ControlEventType.TriggerRequestRecorded
  | typeof ControlEventType.TriggerPaused
  | typeof ControlEventType.TriggerResumed;

export type ControlEvent =
  | EventUnion<Pick<ControlEventPayloads, InvocationEventType>, TriggerInvocationStreamRef>
  | EventUnion<Pick<ControlEventPayloads, TriggerEventType>, TriggerControlStreamRef>
  | EventUnion<
      Omit<ControlEventPayloads, InvocationEventType | TriggerEventType>,
      GlobalControlStreamRef
    >;

export type ControlEventData = EventDataUnion<ControlEventPayloads>;

const streamSchema = z
  .object({ kind: z.literal(ControlStreamKind.Global), id: z.literal('global') })
  .strict();
const triggerStreamSchema = z
  .object({ kind: z.literal(ControlStreamKind.Trigger), id: z.string().min(1) })
  .strict();
const invocationStreamSchema = z
  .object({ kind: z.literal(ControlStreamKind.TriggerInvocation), id: z.string().min(1) })
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
          manualOutcome: manualTriggerOutcomeSchema.optional(),
        })
        .strict(),
    }),
    stream: triggerStreamSchema,
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
    stream: invocationStreamSchema,
  }),
  eventEnvelopeSchema.extend({
    event: eventDataSchema.extend({
      eventType: z.literal(ControlEventType.TriggerPaused),
      payload: z
        .object({
          triggerId: z.string().min(1),
          coordinationKey: z.string().min(1),
          reason: z.string().min(1),
          workflowInstanceId: z.string().min(1).optional(),
          outcomeCount: z.number().int().nonnegative().optional(),
        })
        .strict()
        .refine(
          (value) =>
            (value.workflowInstanceId === undefined) === (value.outcomeCount === undefined),
          {
            message: 'Failure pause requires both workflow identity and outcome count',
          },
        ),
    }),
    stream: triggerStreamSchema,
  }),
  eventEnvelopeSchema.extend({
    event: eventDataSchema.extend({
      eventType: z.literal(ControlEventType.TriggerResumed),
      payload: z
        .object({ triggerId: z.string().min(1), coordinationKey: z.string().min(1) })
        .strict(),
    }),
    stream: triggerStreamSchema,
  }),
  eventEnvelopeSchema.extend({
    event: eventDataSchema.extend({
      eventType: z.literal(ControlEventType.TriggerInvocationFinished),
      payload: z
        .object({
          triggerId: z.string().min(1),
          workflowInstanceId: z.string().min(1),
          workItemId: z.string().min(1),
          coordinationKey: z.string().min(1),
          status: z.enum([WorkflowStatus.Completed, WorkflowStatus.Superseded]),
          reason: z.string().optional(),
        })
        .strict(),
    }),
    stream: invocationStreamSchema,
  }),
  eventEnvelopeSchema.extend({
    event: eventDataSchema.extend({
      eventType: z.literal(ControlEventType.TriggerInvocationStarted),
      payload: z
        .object({
          triggerId: z.string().min(1),
          coordinationKey: z.string().min(1),
          source: triggerSourceSchema,
          workItemId: z.string().min(1),
          workflowInstanceId: z.string().min(1),
          workflowName: z.string().min(1),
        })
        .strict(),
    }),
    stream: invocationStreamSchema,
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
  const decoded = result.data;
  if (
    'workItemId' in decoded.event.payload &&
    decoded.stream.id !== decoded.event.payload.workItemId
  )
    throw new Error(
      `Invalid Control Plane event ${event.event.eventId}: invocation stream identity mismatch`,
    );
  if (
    decoded.stream.kind === ControlStreamKind.Trigger &&
    'coordinationKey' in decoded.event.payload &&
    decoded.stream.id !== decoded.event.payload.coordinationKey
  )
    throw new Error(
      `Invalid Control Plane event ${event.event.eventId}: coordination stream identity mismatch`,
    );
  return decoded;
}

export function selectControlEvent(event: EventEnvelope): ControlEvent | null {
  return event.event.eventType.startsWith(ControlEventNamespace) ? decodeControlEvent(event) : null;
}
