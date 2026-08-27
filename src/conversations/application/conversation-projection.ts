import type { ProjectionDefinition } from '../../kernel/index.js';
import { ConversationEventType, selectConversationEvent } from '../contracts/events.js';
import { ConversationStreamKind } from '../contracts/streams.js';
import type { ConversationView } from '../contracts/views.js';

export const conversationProjection: ProjectionDefinition<ConversationView | null> = {
  name: ConversationStreamKind.Conversation,
  select(event) {
    const owned = selectConversationEvent(event);
    return owned === null ? null : { key: owned.stream.id };
  },
  initial: () => null,
  project(previous, event) {
    const owned = selectConversationEvent(event);
    if (owned === null) return previous;
    if (owned.eventType === ConversationEventType.Created)
      return {
        conversationId: owned.stream.id,
        workItemId: owned.payload.workItemId,
        entries: [],
        resources: [],
      };
    if (
      previous === null ||
      previous.entries.some((entry) => entry.entryId === owned.payload.entryId)
    )
      return previous;
    return {
      ...previous,
      entries: [
        ...previous.entries,
        {
          entryId: owned.payload.entryId,
          body: owned.payload.body,
          occurredAt: owned.occurredAt,
          origin: owned.payload.origin,
        },
      ],
    };
  },
};
