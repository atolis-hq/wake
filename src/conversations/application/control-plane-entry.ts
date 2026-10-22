import type { CommandContext } from '@atolis-hq/eventing';
import type { WorkItemId } from '../../work/index.js';
import { conversationIdForWorkItem } from '../contracts/identifiers.js';
import { ConversationOriginKind } from '../contracts/vocabulary.js';
import type { ConversationService } from './conversation-service.js';

/**
 * Posts a message authored by Wake on someone's behalf (a delegating parent's assignment or
 * reply) to a work item's conversation, creating the conversation if needed. Both steps are
 * idempotent, so a replayed command records the message once.
 */
export async function postControlPlaneEntry(
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
