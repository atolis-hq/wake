import type { WorkItemId } from '../../work/index.js';
import type { ConversationId } from './identifiers.js';
import type { ConversationEntryOrigin } from './views.js';

export interface CreateConversation {
  readonly conversationId: ConversationId;
  readonly workItemId: WorkItemId;
}

export interface RecordConversationEntry {
  readonly conversationId: ConversationId;
  readonly entryId: string;
  readonly body: string;
  readonly origin: ConversationEntryOrigin;
}
