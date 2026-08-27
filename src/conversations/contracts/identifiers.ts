import type { Brand } from '../../kernel/index.js';

export type ConversationId = Brand<string, 'ConversationId'>;

export function conversationId(value: string): ConversationId {
  if (!/^conversation-[0-9a-hjkmnp-tv-z]{26}$/.test(value))
    throw new Error('Invalid ConversationId');
  return value as ConversationId;
}
