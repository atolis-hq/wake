import { correlationId } from '@atolis-hq/eventing';
import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { expect, it } from 'vitest';
import {
  createConversationService,
  postControlPlaneEntry,
} from '../../../src/conversations/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { workId } from '../../support/identities.js';

const context = {
  commandId: 'delegation:grant-1',
  correlationId: correlationId('opening-entry'),
  actor: { kind: 'system' as const, id: 'delegation' },
  occurredAt: '2026-10-22T12:00:00.000Z',
};
const input = {
  workItemId: workId('child'),
  entryId: 'delegation:grant-1',
  authorId: 'delegation:work-parent',
  body: 'Objective: add a.txt',
};

it('creates the conversation and opens it with an attributed control-plane entry', async () => {
  const conversations = createConversationService(new InMemoryEventJournal(new FakeClock()));

  await postControlPlaneEntry(conversations, input, context);

  const view = await conversations.forWorkItem(input.workItemId);
  expect(view?.entries).toHaveLength(1);
  expect(view?.entries[0]).toMatchObject({
    entryId: 'delegation:grant-1',
    body: 'Objective: add a.txt',
    origin: { kind: 'control-plane', actorId: 'delegation:work-parent' },
  });
});

it('records the opening entry once when registration is replayed', async () => {
  const conversations = createConversationService(new InMemoryEventJournal(new FakeClock()));

  await postControlPlaneEntry(conversations, input, context);
  await postControlPlaneEntry(conversations, input, context);

  expect((await conversations.forWorkItem(input.workItemId))?.entries).toHaveLength(1);
});

it('keeps an existing conversation and appends the opening entry after earlier entries', async () => {
  const conversations = createConversationService(new InMemoryEventJournal(new FakeClock()));
  await conversations.createForWorkItem(input.workItemId, { ...context, commandId: 'earlier' });

  await postControlPlaneEntry(conversations, input, context);

  expect(
    (await conversations.forWorkItem(input.workItemId))?.entries.map((e) => e.entryId),
  ).toEqual(['delegation:grant-1']);
});
