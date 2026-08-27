import { describe, expect, it } from 'vitest';
import { conversationId, createConversationService } from '../../../src/conversations/index.js';
import { correlationId } from '../../../src/kernel/index.js';
import { InMemoryEventJournal } from '../../../src/persistence/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { workId } from '../../support/identities.js';

const context = {
  commandId: 'command-1',
  correlationId: correlationId('conversation-test'),
  actor: { kind: 'operator' as const, id: 'operator-1' },
  occurredAt: '2026-08-27T12:00:00.000Z',
};

describe('ConversationService', () => {
  it('creates a WorkItem conversation and records attributed entries in order', async () => {
    const service = createConversationService(new InMemoryEventJournal(new FakeClock()));
    const id = conversationId('conversation-00000000000000000000000000');
    const workItemId = workId('conversation');

    await service.create({ conversationId: id, workItemId }, context);
    await service.record(
      {
        conversationId: id,
        entryId: 'entry-1',
        body: 'Please investigate the failure.',
        origin: { kind: 'control-plane', actorId: 'operator-1' },
      },
      { ...context, commandId: 'command-2' },
    );
    await service.record(
      {
        conversationId: id,
        entryId: 'entry-2',
        body: 'I am investigating it.',
        origin: { kind: 'agent', actorId: 'wake', runId: 'run-1', stage: 'implement' },
      },
      { ...context, commandId: 'command-3' },
    );

    await expect(service.get(id)).resolves.toEqual({
      conversationId: id,
      workItemId,
      entries: [
        {
          entryId: 'entry-1',
          body: 'Please investigate the failure.',
          occurredAt: context.occurredAt,
          origin: { kind: 'control-plane', actorId: 'operator-1' },
          deleted: false,
          revisions: [{ body: 'Please investigate the failure.', occurredAt: context.occurredAt }],
        },
        {
          entryId: 'entry-2',
          body: 'I am investigating it.',
          occurredAt: context.occurredAt,
          origin: { kind: 'agent', actorId: 'wake', runId: 'run-1', stage: 'implement' },
          deleted: false,
          revisions: [{ body: 'I am investigating it.', occurredAt: context.occurredAt }],
        },
      ],
      resources: [],
    });
  });

  it('retains resource participation and the audit trail for entry edits and deletion', async () => {
    const service = createConversationService(new InMemoryEventJournal(new FakeClock()));
    const id = conversationId('conversation-00000000000000000000000001');
    await service.create({ conversationId: id, workItemId: workId('conversation-links') }, context);
    await service.associateResource(
      { conversationId: id, resourceId: 'resource-1', threadId: 'thread-1' },
      { ...context, commandId: 'associate' },
    );
    await service.record(
      {
        conversationId: id,
        entryId: 'entry-1',
        body: 'Original text',
        origin: {
          kind: 'external',
          adapter: 'github',
          actorId: 'octocat',
          resourceId: 'resource-1',
          threadId: 'thread-1',
          messageId: 'comment-1',
        },
      },
      { ...context, commandId: 'record' },
    );
    await service.revise(
      { conversationId: id, entryId: 'entry-1', body: 'Revised text' },
      { ...context, commandId: 'revise' },
    );
    await service.tombstone(
      { conversationId: id, entryId: 'entry-1' },
      { ...context, commandId: 'tombstone' },
    );

    await expect(service.get(id)).resolves.toMatchObject({
      resources: [{ resourceId: 'resource-1', threadId: 'thread-1' }],
      entries: [
        {
          entryId: 'entry-1',
          body: 'Revised text',
          deleted: true,
          revisions: [{ body: 'Original text' }, { body: 'Revised text' }],
        },
      ],
    });
  });
});
