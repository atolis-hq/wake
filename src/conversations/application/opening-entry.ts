import type { CommandContext } from '@atolis-hq/eventing';
import type { WorkItemId } from '../../work/index.js';
import { conversationIdForWorkItem } from '../contracts/identifiers.js';
import { ConversationOriginKind } from '../contracts/vocabulary.js';
import type { ConversationService } from './conversation-service.js';

/**
 * Starts a work item's conversation with a message authored by Wake on someone's behalf,
 * such as a delegating parent's assignment. Both steps are idempotent, so a replayed
 * registration records the message once.
 */
export async function recordOpeningEntry(
  conversations: Pick<ConversationService, 'createForWorkItem' | 'record'>,
  input: {
    readonly workItemId: WorkItemId;
    readonly entryId: string;
    readonly authorId: string;
    readonly body: string;
  },
  context: CommandContext,
): Promise<void> {
  await conversations.createForWorkItem(input.workItemId, context);
  await conversations.record(
    {
      conversationId: conversationIdForWorkItem(input.workItemId),
      entryId: input.entryId,
      body: input.body,
      origin: { kind: ConversationOriginKind.ControlPlane, actorId: input.authorId },
    },
    context,
  );
}
