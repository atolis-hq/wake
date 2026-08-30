import { expect, it } from 'vitest';
import {
  conversationId,
  conversationProjection,
  conversationStream,
} from '../../../src/conversations/index.js';
import { createEventData } from '../../../src/kernel/index.js';
import { workId } from '../../support/identities.js';

it('projects entries by conversation stream', () => {
  const id = conversationId('conversation-00000000000000000000000000');
  const event = {
    ...createEventData({
      eventId: 'entry',
      eventType: 'conversation.created',
      occurredAt: '2026-08-27T12:00:00.000Z',
      correlationId: 'correlation',
      causationId: 'command',
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      stream: conversationStream(id),
      payload: { workItemId: workId('conversation') },
    }),
    recordedAt: '2026-08-27T12:00:00.000Z',
    sequence: 1,
    globalPosition: 1,
  };
  expect(conversationProjection.project(conversationProjection.initial(id), event)).toMatchObject({
    conversationId: id,
    workItemId: workId('conversation'),
  });
});
