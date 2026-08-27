import type { WorkItemId } from '../../work/index.js';
import type { ConversationId } from './identifiers.js';
import type { ConversationOriginKind } from './vocabulary.js';

export type ConversationEntryOrigin =
  | { readonly kind: typeof ConversationOriginKind.ControlPlane; readonly actorId: string }
  | {
      readonly kind: typeof ConversationOriginKind.Agent;
      readonly actorId: string;
      readonly runId: string;
      readonly stage?: string | undefined;
    }
  | {
      readonly kind: typeof ConversationOriginKind.External;
      readonly adapter: string;
      readonly actorId: string;
      readonly resourceId: string;
      readonly threadId: string;
      readonly messageId: string;
      readonly location?:
        | {
            readonly path: string;
            readonly line: number;
            readonly side: 'LEFT' | 'RIGHT';
          }
        | undefined;
    };

export interface ConversationEntryView {
  readonly entryId: string;
  readonly body: string;
  readonly occurredAt: string;
  readonly origin: ConversationEntryOrigin;
  readonly deleted: boolean;
  readonly revisions: readonly { readonly body: string; readonly occurredAt: string }[];
  readonly representations: readonly { readonly resourceId: string; readonly externalId: string }[];
}

export interface ConversationResourceView {
  readonly resourceId: string;
  readonly threadId?: string | undefined;
}

export interface ConversationView {
  readonly conversationId: ConversationId;
  readonly workItemId: WorkItemId;
  readonly entries: readonly ConversationEntryView[];
  readonly resources: readonly ConversationResourceView[];
}
