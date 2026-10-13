import type { EventEnvelope, ProjectionDefinition } from '@atolis-hq/eventing';
import {
  ControlEventType,
  TriggerRequestDisposition,
  selectControlEvent,
  type ControlEventPayloads,
  type TriggerSource,
} from '../contracts/events.js';

export const triggerProjectionName = 'control-plane-triggers';

export interface TriggerView {
  readonly pauses: Readonly<Record<string, string>>;
  readonly requests: readonly ControlEventPayloads[typeof ControlEventType.TriggerRequestRecorded][];
  readonly coalesced: Readonly<
    Record<
      string,
      ControlEventPayloads[typeof ControlEventType.TriggerRequestRecorded] & {
        readonly sources: readonly TriggerSource[];
      }
    >
  >;
  readonly invocations: readonly {
    readonly claim: ControlEventPayloads[typeof ControlEventType.TriggerInvocationClaimed];
    readonly claimedAt: string;
    readonly startedAt?: string;
    readonly result?: ControlEventPayloads[typeof ControlEventType.TriggerInvocationFinished];
    readonly finishedAt?: string;
  }[];
}

export const triggerProjection: ProjectionDefinition<TriggerView> = {
  name: triggerProjectionName,
  select(envelope) {
    return selectControlEvent(envelope) === null ? null : { key: 'global' };
  },
  initial: () => ({ pauses: {}, requests: [], coalesced: {}, invocations: [] }),
  project(previous, envelope: EventEnvelope) {
    const event = selectControlEvent(envelope);
    if (event === null) return previous;
    switch (event.event.eventType) {
      case ControlEventType.TriggerRequestRecorded: {
        const request = event.event.payload;
        return {
          ...previous,
          requests: [...previous.requests, request],
          coalesced:
            request.disposition === TriggerRequestDisposition.Coalesced
              ? {
                  ...previous.coalesced,
                  [request.coordinationKey]: {
                    ...request,
                    sources: [
                      ...(previous.coalesced[request.coordinationKey]?.sources ?? []),
                      request.source,
                    ],
                  },
                }
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
          invocations: previous.invocations.map((invocation) =>
            invocation.claim.workflowInstanceId === payload.workflowInstanceId
              ? { ...invocation, result: payload, finishedAt: event.event.occurredAt }
              : invocation,
          ),
        };
      }
      case ControlEventType.TriggerPaused: {
        const payload = event.event.payload;
        return {
          ...previous,
          pauses: { ...previous.pauses, [payload.triggerId]: payload.reason },
          coalesced: Object.fromEntries(
            Object.entries(previous.coalesced).filter(
              ([, request]) => request.triggerId !== payload.triggerId,
            ),
          ),
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
