import { EventSourceKind, type CommandContext } from '@atolis-hq/eventing';
import { createResourceEventData } from '../contracts/event-factory.js';
import { type ResourceEventData, type ResourceEventPayloads } from '../contracts/events.js';
import type { ResourceId } from '../contracts/identifiers.js';
import type { ResourceRepository } from './resource-repository.js';

export async function appendResourceEvent(
  repository: ResourceRepository,
  resourceId: ResourceId,
  draft: ResourceEventData,
): Promise<void> {
  const loaded = await repository.load(resourceId);
  await repository.append(resourceId, loaded.sequence, [draft]);
}

export type ResourceDraftInput = {
  [Type in keyof ResourceEventPayloads]: {
    readonly eventType: Type;
    readonly payload: ResourceEventPayloads[Type];
  };
}[keyof ResourceEventPayloads];

export function resourceDraft(
  context: CommandContext,
  input: ResourceDraftInput,
): ResourceEventData {
  return createResourceEventData({
    eventId: `${context.commandId}:${input.eventType}`,
    occurredAt: context.occurredAt,
    correlationId: context.correlationId,
    causationId: context.commandId,
    actor: context.actor,
    source: { kind: EventSourceKind.Internal, id: 'resource-service' },
    ...input,
  });
}
