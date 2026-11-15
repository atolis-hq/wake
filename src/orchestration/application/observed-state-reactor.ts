import {
  defineEventProcessor,
  EventProcessorCategory,
  EventProcessorReplayPolicy,
  type EventEnvelope,
} from '@atolis-hq/eventing';

export function createObservedStateReactor(orchestration: {
  retryObservedState(event: EventEnvelope): Promise<void>;
}) {
  return defineEventProcessor({
    consumer: 'reactor:orchestration.observed-state',
    name: 'observed-state',
    owner: 'orchestration',
    category: EventProcessorCategory.Reactor,
    replayPolicy: EventProcessorReplayPolicy.Idempotent,
    batchSize: 100,
    select: (event) => event,
    handle: (event) => orchestration.retryObservedState(event),
  });
}
