import type { EventEnvelope, ProjectionDefinition } from '@atolis-hq/eventing';
import {
  ControlEventType,
  TriggerRequestDisposition,
  TriggerSourceKind,
  selectControlEvent,
  type ControlEventPayloads,
  type TriggerSource,
} from '../contracts/events.js';

export const triggerProjectionName = 'control-plane-triggers';

export const maximumTriggerSources = 64;

export interface TriggerInvocationView {
  readonly claim: ControlEventPayloads[typeof ControlEventType.TriggerInvocationClaimed];
  readonly claimedAt: string;
  readonly startedAt?: string;
  readonly result?: ControlEventPayloads[typeof ControlEventType.TriggerInvocationFinished];
  readonly finishedAt?: string;
  readonly failureOutcomeCount?: number;
}

export interface TriggerView {
  readonly lastStarts: Readonly<Record<string, string>>;
  readonly pauses: Readonly<Record<string, string>>;
  /** Latest recorded request per trigger, rather than an occurrence history. */
  readonly requests: readonly ControlEventPayloads[typeof ControlEventType.TriggerRequestRecorded][];
  readonly coalesced: Readonly<
    Record<
      string,
      ControlEventPayloads[typeof ControlEventType.TriggerRequestRecorded] & {
        readonly sources: readonly TriggerSource[];
        readonly manualRequest?:
          ControlEventPayloads[typeof ControlEventType.TriggerRequestRecorded] | undefined;
      }
    >
  >;
  /** Operational projections contain only active claims; explicit service inspection includes history. */
  readonly invocations: readonly TriggerInvocationView[];
}

export const triggerProjection: ProjectionDefinition<TriggerView> = {
  name: triggerProjectionName,
  select(envelope) {
    const event = selectControlEvent(envelope);
    return event !== null && 'coordinationKey' in event.event.payload
      ? { key: event.event.payload.coordinationKey }
      : null;
  },
  initial: () => ({ lastStarts: {}, pauses: {}, requests: [], coalesced: {}, invocations: [] }),
  project(previous, envelope: EventEnvelope) {
    const event = selectControlEvent(envelope);
    if (event === null) return previous;
    switch (event.event.eventType) {
      case ControlEventType.TriggerRequestRecorded: {
        const request = event.event.payload;
        return {
          ...previous,
          requests: [
            ...previous.requests.filter((last) => last.triggerId !== request.triggerId),
            request,
          ],
          coalesced:
            request.disposition === TriggerRequestDisposition.Coalesced
              ? {
                  ...previous.coalesced,
                  [request.coordinationKey]: pendingRequest(previous, request),
                }
              : request.disposition === TriggerRequestDisposition.Started
                ? previous.coalesced
                : withoutCoalesced(previous.coalesced, request),
        };
      }
      case ControlEventType.TriggerInvocationClaimed: {
        const claim = event.event.payload;
        const { [claim.coordinationKey]: _, ...coalesced } = previous.coalesced;
        return {
          ...previous,
          coalesced,
          invocations: [...previous.invocations, { claim, claimedAt: event.event.occurredAt }],
        };
      }
      case ControlEventType.TriggerInvocationStarted: {
        const payload = event.event.payload;
        return {
          ...previous,
          lastStarts: { ...previous.lastStarts, [payload.triggerId]: event.event.occurredAt },
          invocations: previous.invocations.map((invocation) =>
            invocation.claim.workflowInstanceId === payload.workflowInstanceId
              ? { ...invocation, startedAt: event.event.occurredAt }
              : invocation,
          ),
        };
      }
      case ControlEventType.TriggerInvocationFinished: {
        const payload = event.event.payload;
        return {
          ...previous,
          invocations: previous.invocations.filter(
            (invocation) => invocation.claim.workflowInstanceId !== payload.workflowInstanceId,
          ),
        };
      }
      case ControlEventType.TriggerPaused: {
        const payload = event.event.payload;
        return {
          ...previous,
          pauses: { ...previous.pauses, [payload.triggerId]: payload.reason },
          invocations: pausedInvocations(previous, payload),
          coalesced: pendingAfterPause(previous.coalesced, payload.coordinationKey),
        };
      }
      case ControlEventType.TriggerResumed: {
        const { [event.event.payload.triggerId]: _, ...pauses } = previous.pauses;
        return { ...previous, pauses };
      }
      default:
        return previous;
    }
  },
};

function withoutCoalesced(
  coalesced: TriggerView['coalesced'],
  request: TriggerView['requests'][number],
): TriggerView['coalesced'] {
  const key = request.coordinationKey;
  // An ineligible new occurrence does not discard another trigger's coalesced request.
  if (
    coalesced[key]?.triggerId !== request.triggerId ||
    JSON.stringify(coalesced[key]?.source) !== JSON.stringify(request.source)
  )
    return coalesced;
  const { [key]: _, ...rest } = coalesced;
  return rest;
}

function pausedInvocations(
  previous: TriggerView,
  payload: ControlEventPayloads[typeof ControlEventType.TriggerPaused],
): readonly TriggerInvocationView[] {
  return previous.invocations.map((invocation) =>
    payload.workflowInstanceId === invocation.claim.workflowInstanceId &&
    payload.outcomeCount !== undefined
      ? { ...invocation, failureOutcomeCount: payload.outcomeCount }
      : invocation,
  );
}

function pendingRequest(
  previous: TriggerView,
  request: TriggerView['requests'][number],
): TriggerView['coalesced'][string] {
  return {
    ...request,
    manualRequest:
      request.source.kind === TriggerSourceKind.Manual
        ? request
        : previous.coalesced[request.coordinationKey]?.manualRequest,
    sources: [
      ...(previous.coalesced[request.coordinationKey]?.sources ?? []),
      request.source,
    ].slice(0, maximumTriggerSources),
  };
}

function pendingAfterPause(
  coalesced: TriggerView['coalesced'],
  coordinationKey: string,
): TriggerView['coalesced'] {
  const request = coalesced[coordinationKey];
  if (request === undefined) return coalesced;
  const { [coordinationKey]: _, ...rest } = coalesced;
  if (request.manualRequest === undefined) return rest;
  return {
    ...rest,
    [coordinationKey]: {
      ...request,
      ...request.manualRequest,
      sources: request.sources.filter((source) => source.kind === TriggerSourceKind.Manual),
    },
  };
}
