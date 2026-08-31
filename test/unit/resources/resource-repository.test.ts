import { createEventData } from '@atolis-hq/eventing';
import { expect, it, vi } from 'vitest';
import { InMemoryEventJournal } from '../../../src/persistence/index.js';
import {
  ResourceEventType,
  ResourceRepository,
  resourceId,
  resourceKind,
  resourceStream,
} from '../../../src/resources/index.js';
import { FakeClock } from '../../e2e/support/world.js';

const first = resourceId('resource-00000000000000000000000001');
const second = resourceId('resource-00000000000000000000000002');

it('refreshes the resource materialized view after an append and skips reads while unchanged', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const repository = new ResourceRepository(journal);
  await discover(journal, first, 0);
  const readAll = vi.spyOn(journal, 'readAll');

  expect(await repository.listResourceIds()).toEqual([first]);
  readAll.mockClear();
  expect(await repository.listResourceIds()).toEqual([first]);
  expect(readAll).not.toHaveBeenCalled();

  await discover(journal, second, 0);
  expect(await repository.listResourceIds()).toEqual([first, second]);
});

async function discover(journal: InMemoryEventJournal, id: typeof first, sequence: number) {
  const stream = resourceStream(id);
  await journal.appendToStream(stream, sequence, [
    createEventData({
      eventId: `${id}:discovered`,
      eventType: ResourceEventType.ResourceDiscovered,
      occurredAt: '2026-08-01T12:00:00Z',
      correlationId: 'resource-test',
      causationId: 'resource-test',
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      payload: {
        kind: resourceKind('issue'),
        externalKey: { adapter: 'fake', key: id },
        capabilities: [],
      },
    }),
  ]);
}
