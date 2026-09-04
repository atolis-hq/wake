import { correlationId, EventActorKind, type CommandContext } from '@atolis-hq/eventing';
import type { selectOrchestrationEvent } from '../contracts/event-decoder.js';

type PersistedEvent = Parameters<typeof selectOrchestrationEvent>[0];

export function reactorCommandContext(
  event: PersistedEvent,
  suffix: string,
  actorId: string,
): CommandContext {
  return {
    commandId: `${event.event.eventId}:${suffix}`,
    correlationId: correlationId(event.event.correlationId),
    occurredAt: event.event.occurredAt,
    actor: { kind: EventActorKind.System, id: actorId },
  };
}
