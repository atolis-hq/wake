import type { Brand } from '../../kernel/index.js';
import type { WorkItemId } from '../../work/index.js';

export type ConversationId = Brand<string, 'ConversationId'>;

export function conversationId(value: string): ConversationId {
  if (!/^conversation-[0-9a-hjkmnp-tv-z]{26}$/.test(value))
    throw new Error('Invalid ConversationId');
  return value as ConversationId;
}

export function conversationIdForWorkItem(workItemId: WorkItemId): ConversationId {
  return conversationId(`conversation-${String(workItemId).slice('work-'.length)}`);
}
