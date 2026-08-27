import type { WorkItemId } from '../../work/index.js';
import type { ConversationId } from './identifiers.js';
import { ConversationOriginKind } from './vocabulary.js';

export type ConversationEntryOrigin =
  | { readonly kind: typeof ConversationOriginKind.ControlPlane; readonly actorId: string }
  | {
      readonly kind: typeof ConversationOriginKind.Agent;
      readonly actorId: string;
      readonly runId: string;
      readonly stage: string;
    }
  | {
      readonly kind: typeof ConversationOriginKind.External;
      readonly adapter: string;
      readonly actorId: string;
      readonly resourceId: string;
      readonly threadId: string;
      readonly messageId: string;
    };

export interface ConversationEntryView {
  readonly entryId: string;
  readonly body: string;
  readonly occurredAt: string;
  readonly origin: ConversationEntryOrigin;
}
export interface ConversationView {
  readonly conversationId: ConversationId;
  readonly workItemId: WorkItemId;
  readonly entries: readonly ConversationEntryView[];
  readonly resources: readonly string[];
}
