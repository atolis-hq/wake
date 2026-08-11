import { correlationId, EventActorKind, type CommandContext } from '../../../kernel/index.js';
import type { GitHubAdapterEvent } from '../contracts/events.js';
import { GitHubAdapter } from '../contracts/vocabulary.js';

export function commandContext(event: GitHubAdapterEvent): CommandContext {
  return {
    commandId: `${event.eventId}:inbound`,
    correlationId: correlationId(event.correlationId),
    occurredAt: event.occurredAt,
    actor: { kind: EventActorKind.Integration, id: GitHubAdapter },
  };
}
