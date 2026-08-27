import type { EntityRef } from '../../kernel/index.js';
import type { ConversationId } from './identifiers.js';

export const ConversationStreamKind = { Conversation: 'conversation' } as const;
export type ConversationStreamRef = EntityRef<
  typeof ConversationStreamKind.Conversation,
  ConversationId
>;
export const conversationStream = (id: ConversationId): ConversationStreamRef => ({
  kind: ConversationStreamKind.Conversation,
  id,
});
