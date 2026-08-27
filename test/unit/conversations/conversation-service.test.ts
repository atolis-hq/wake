import { describe, expect, it } from 'vitest';
import { correlationId } from '../../../src/kernel/index.js';
import { InMemoryEventJournal } from '../../../src/persistence/index.js';
import { createConversationService, conversationId } from '../../../src/conversations/index.js';
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
        },
        {
          entryId: 'entry-2',
          body: 'I am investigating it.',
          occurredAt: context.occurredAt,
          origin: { kind: 'agent', actorId: 'wake', runId: 'run-1', stage: 'implement' },
        },
      ],
      resources: [],
    });
  });
});
