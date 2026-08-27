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

export interface AssociateConversationResource {
  readonly conversationId: ConversationId;
  readonly resourceId: string;
  readonly threadId?: string | undefined;
}

export interface ReviseConversationEntry {
  readonly conversationId: ConversationId;
  readonly entryId: string;
  readonly body: string;
}

export interface TombstoneConversationEntry {
  readonly conversationId: ConversationId;
  readonly entryId: string;
}

export interface RecordConversationEntryRepresentation {
  readonly conversationId: ConversationId;
  readonly entryId: string;
  readonly resourceId: string;
  readonly externalId: string;
}
