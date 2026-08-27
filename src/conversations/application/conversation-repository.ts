import type { EventJournal } from '../../kernel/index.js';
import {
  decodeConversationEvent,
  selectConversationEvent,
  type ConversationEvent,
  type ConversationEventDraft,
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
  async append(id: ConversationId, expected: number, drafts: readonly ConversationEventDraft[]) {
    return (await this.journal.append(conversationStream(id), expected, drafts)).map(
      decodeConversationEvent,
    );
  }
}
