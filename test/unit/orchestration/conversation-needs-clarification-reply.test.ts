import { EventProcessorHost, correlationId } from '@atolis-hq/eventing';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  createInMemoryProcessorRunSerialiser,
} from '@atolis-hq/eventing/memory';
import { expect, it } from 'vitest';
import {
  conversationIdForWorkItem,
  createConversationService,
} from '../../../src/conversations/index.js';
import { createConversationCommandReactor } from '../../../src/orchestration/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { workId } from '../../support/identities.js';

it('resumes a needs-clarification stage from an unprivileged plain reply', async () => {
  const clock = new FakeClock();
  const journal = new InMemoryEventJournal(clock);
  const conversations = createConversationService(journal);
  const workItemId = workId('conversation-clarification');
  const resumes: unknown[][] = [];
  const reactor = createConversationCommandReactor({
    async applyConversationCommand() {
      return false;
    },
    async listAll() {
      return [{ workflowInstanceId: 'workflow-clarification', workItemId }];
    },
    async resumeNeedsClarificationStage(...input: unknown[]) {
      resumes.push(input);
    },
  } as never);
  const context = {
    commandId: 'external-comment',
    correlationId: correlationId('conversation-clarification'),
    occurredAt: clock.now().toISOString(),
    actor: { kind: 'integration' as const, id: 'github' },
  };

  await conversations.createForWorkItem(workItemId, context);
  await conversations.record(
    {
      conversationId: conversationIdForWorkItem(workItemId),
      entryId: 'github-comment-clarification',
      body: 'Use the latest commit as the source of truth.',
      origin: {
        kind: 'external',
        adapter: 'github',
        actorId: 'contributor',
        resourceId: 'resource-1',
        threadId: 'org/repo#7',
        messageId: '102',
        authorized: false,
      },
    },
    context,
  );

  await new EventProcessorHost(
    journal,
    new InMemoryCheckpointStore(),
    createInMemoryProcessorRunSerialiser(),
    clock,
  ).runOnce(reactor.processor);

  expect(resumes).toHaveLength(1);
  expect(resumes[0]).toMatchObject(['workflow-clarification', expect.anything()]);
});
