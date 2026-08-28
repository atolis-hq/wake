import type { ProjectionDefinition } from '../../kernel/index.js';
import { selectConversationEvent } from '../contracts/events.js';
import { ConversationStreamKind } from '../contracts/streams.js';
import type { ConversationView } from '../contracts/views.js';
import { applyConversationEvent } from '../domain/conversation.js';

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
    return applyConversationEvent(previous, owned);
  },
};
