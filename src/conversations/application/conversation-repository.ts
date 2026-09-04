import type { EventJournal } from '@atolis-hq/eventing';
import {
  decodeConversationEvent,
  selectConversationEvent,
  type ConversationEvent,
  type ConversationEventData,
} from '../contracts/events.js';
import type { ConversationId } from '../contracts/identifiers.js';
import { conversationStream } from '../contracts/streams.js';
import type { ConversationView } from '../contracts/views.js';
import { foldConversation } from '../domain/conversation.js';

export class ConversationRepository {
  constructor(private readonly journal: EventJournal) {}
  async load(
    id: ConversationId,
  ): Promise<{ readonly sequence: number; readonly view: ConversationView | null }> {
    const events = await this.journal.readStream(conversationStream(id));
    return {
      sequence: events.length,
      view: foldConversation(
        events
          .map(selectConversationEvent)
          .filter((event): event is ConversationEvent => event !== null),
      ),
    };
  }

  async append(id: ConversationId, expected: number, drafts: readonly ConversationEventData[]) {
    return (await this.journal.appendToStream(conversationStream(id), expected, drafts)).map(
      decodeConversationEvent,
    );
  }
}
