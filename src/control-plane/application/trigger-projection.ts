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
        readonly manualRequests: readonly ControlEventPayloads[typeof ControlEventType.TriggerRequestRecorded][];
        /** Lets a skipped manual command leave automatic work claimable under its own trigger. */
        readonly automaticRequests: readonly ControlEventPayloads[typeof ControlEventType.TriggerRequestRecorded][];
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

/** A manual head is consumed alone while other manual or automatic work is still queued. */
function consumesWholeRequest(
  pending: TriggerView['coalesced'][string] | undefined,
  request: TriggerView['requests'][number],
): boolean {
  if (pending?.triggerId !== request.triggerId) return false;
  if (JSON.stringify(pending.source) !== JSON.stringify(request.source)) return false;
  return (
    request.source.kind !== TriggerSourceKind.Manual ||
    (pending.automaticRequests.length === 0 && pending.manualRequests.length <= 1)
  );
}

function withoutCoalesced(
  coalesced: TriggerView['coalesced'],
  request: TriggerView['requests'][number],
): TriggerView['coalesced'] {
  const key = request.coordinationKey;
  // An ineligible new occurrence does not discard another trigger's coalesced request.
  if (!consumesWholeRequest(coalesced[key], request)) {
    const pending = coalesced[key];
    if (pending === undefined || request.source.kind !== TriggerSourceKind.Manual) return coalesced;
    const commandId = request.source.commandId;
    const retained = pending.manualRequests.filter(
      (manual) =>
        manual.triggerId !== request.triggerId ||
        manual.source.kind !== TriggerSourceKind.Manual ||
        manual.source.commandId !== commandId,
    );
    if (retained.length === pending.manualRequests.length) return coalesced;
    // Skipping a manual command must not discard other queued work; the head stays pending work.
    const head = pending.automaticRequests.at(-1) ?? retained.at(-1);
    const removedHead = JSON.stringify(pending.source) === JSON.stringify(request.source);
    return {
      ...coalesced,
      [key]: {
        ...pending,
        ...(removedHead && head !== undefined ? head : {}),
        manualRequests: retained,
        sources: pending.sources.filter(
          (source) => source.kind !== TriggerSourceKind.Manual || source.commandId !== commandId,
        ),
      },
    };
  }
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
    manualRequests: [
      ...(previous.coalesced[request.coordinationKey]?.manualRequests ?? []),
      ...(request.source.kind === TriggerSourceKind.Manual ? [request] : []),
    ].slice(0, maximumTriggerSources),
    automaticRequests: [
      ...(previous.coalesced[request.coordinationKey]?.automaticRequests ?? []),
      ...(request.source.kind === TriggerSourceKind.Manual ? [] : [request]),
    ].slice(-maximumTriggerSources),
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
  const manualRequest = request.manualRequests.at(-1);
  if (manualRequest === undefined) return rest;
  return {
    ...rest,
    [coordinationKey]: {
      ...request,
      ...manualRequest,
      automaticRequests: [],
      sources: request.sources.filter((source) => source.kind === TriggerSourceKind.Manual),
    },
  };
}
