import type { ProjectionDefinition } from '@atolis-hq/eventing';
import { ControlEventType, selectControlEvent } from '../contracts/events.js';
import { ControlStreamKind } from '../contracts/streams.js';
import type { TriggerInvocationView } from './trigger-projection.js';

/** One history document per top-level WorkItem, independent of operational scope state. */
export const triggerInvocationProjection: ProjectionDefinition<TriggerInvocationView | null> = {
  name: ControlStreamKind.TriggerInvocation,
  select(envelope) {
    const event = selectControlEvent(envelope);
    return event?.stream.kind === ControlStreamKind.TriggerInvocation
      ? { key: event.stream.id }
      : null;
  },
  initial: () => null,
  project(previous, envelope) {
    const event = selectControlEvent(envelope);
    if (event === null) return previous;
    switch (event.event.eventType) {
      case ControlEventType.TriggerInvocationClaimed:
        return { claim: event.event.payload, claimedAt: event.event.occurredAt };
      case ControlEventType.TriggerInvocationStarted:
        if (previous === null) throw new Error('Trigger start without invocation claim');
        return { ...previous, startedAt: event.event.occurredAt };
      case ControlEventType.TriggerInvocationFinished:
        if (previous === null) throw new Error('Trigger result without invocation claim');
        return { ...previous, result: event.event.payload, finishedAt: event.event.occurredAt };
      default:
        return previous;
    }
  },
};
