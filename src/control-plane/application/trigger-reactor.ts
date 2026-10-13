import {
  correlationId,
  defineEventProcessor,
  EventActorKind,
  EventProcessorCategory,
  EventProcessorReplayPolicy,
  type EventEnvelope,
} from '@atolis-hq/eventing';
import type { TriggerConfig } from '../contracts/config.js';
import { TriggerSourceKind } from '../contracts/events.js';
import { ControlStreamKind } from '../contracts/streams.js';
import type { TriggerService } from './trigger-service.js';

export function createTriggerReactor(
  service: TriggerService,
  config: TriggerConfig,
  decode: (event: EventEnvelope) => void,
) {
  return defineEventProcessor({
    consumer: `reactor:control-plane.trigger:${config.id}`,
    name: 'workflow-triggers',
    owner: ControlStreamKind.Global,
    category: EventProcessorCategory.Reactor,
    replayPolicy: EventProcessorReplayPolicy.Idempotent,
    select(event) {
      if (!config.on.events?.includes(event.event.eventType)) return null;
      decode(event);
      return event;
    },
    async handle(event) {
      await service.start(
        config,
        {
          kind: TriggerSourceKind.Event,
          eventId: event.event.eventId,
          eventType: event.event.eventType,
        },
        {
          commandId: `trigger:${config.id}:${event.event.eventId}`,
          correlationId: correlationId(`trigger:${config.id}:${event.event.eventId}`),
          occurredAt: event.event.occurredAt,
          actor: { kind: EventActorKind.System, id: config.id },
        },
        event,
      );
    },
  });
}
