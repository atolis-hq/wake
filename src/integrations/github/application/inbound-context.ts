import { correlationId, EventActorKind, type CommandContext } from '@atolis-hq/eventing';
import type { GitHubAdapterEvent } from '../contracts/events.js';
import { GitHubAdapter } from '../contracts/vocabulary.js';

export function commandContext(event: GitHubAdapterEvent): CommandContext {
  return {
    commandId: `${event.event.eventId}:inbound`,
    correlationId: correlationId(event.event.correlationId),
    occurredAt: event.event.occurredAt,
    actor: { kind: EventActorKind.Integration, id: GitHubAdapter },
  };
}
