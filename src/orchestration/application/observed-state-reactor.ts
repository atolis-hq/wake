import {
  defineEventProcessor,
  EventProcessorCategory,
  EventProcessorReplayPolicy,
  type EventEnvelope,
} from '@atolis-hq/eventing';
import { selectOrchestrationEvent } from '../contracts/event-decoder.js';
import { OrchestrationEventType } from '../contracts/events.js';

export function createObservedStateReactor(orchestration: {
  retryObservedState(event: EventEnvelope): Promise<boolean>;
}) {
  // Bootstrap once from durable state; an observed wait-start re-arms a dormant reactor.
  let active = true;
  return defineEventProcessor({
    consumer: 'reactor:orchestration.observed-state',
    name: 'observed-state',
    owner: 'orchestration',
    category: EventProcessorCategory.Reactor,
    replayPolicy: EventProcessorReplayPolicy.Idempotent,
    batchSize: 100,
    select: (event) => event,
    async handle(event) {
      const fact = selectOrchestrationEvent(event);
      const startsWait =
        fact?.event.eventType === OrchestrationEventType.SignalWaitStarted &&
        fact.event.payload.observed !== undefined;
      if (active || startsWait) active = await orchestration.retryObservedState(event);
    },
  });
}
