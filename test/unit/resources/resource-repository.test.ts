import { createEventData } from '@atolis-hq/eventing';
import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { expect, it, vi } from 'vitest';
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

it('limits retry and outcome scans to resources with pending attention', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const repository = new ResourceRepository(journal);
  await discover(journal, first, 0);
  await discover(journal, second, 0);
  expect(await repository.listRetryCandidateIds()).toEqual([]);
  expect(await repository.listPendingOutcomeCandidateIds()).toEqual([]);

  await append(journal, first, 1, ResourceEventType.WorkCorrelationRetryPending, {
    attemptCount: 1,
    lastFailureReason: 'missing',
  });
  await append(journal, second, 1, ResourceEventType.ExternalOutcomeObserved, {
    sourceObservationId: 'obs-1',
    outcome: 'completed',
    revision: 'r1',
  });
  expect(await repository.listRetryCandidateIds()).toEqual([first]);
  expect(await repository.listPendingOutcomeCandidateIds()).toEqual([second]);

  await append(journal, first, 2, ResourceEventType.WorkCorrelationUnresolvable, {
    externalKey: { adapter: 'fake', key: first },
    attemptCount: 4,
    lastFailureReason: 'missing',
  });
  await append(journal, second, 2, ResourceEventType.ExternalOutcomeConsumed, {
    sourceObservationId: 'obs-1',
  });
  expect(await repository.listRetryCandidateIds()).toEqual([]);
  expect(await repository.listPendingOutcomeCandidateIds()).toEqual([]);
});

async function append(
  journal: InMemoryEventJournal,
  id: typeof first,
  sequence: number,
  eventType: string,
  payload: Record<string, unknown>,
) {
  await journal.appendToStream(resourceStream(id), sequence, [
    createEventData({
      eventId: `${id}:${eventType}:${sequence}`,
      eventType,
      occurredAt: '2026-08-01T12:00:00Z',
      correlationId: 'resource-test',
      causationId: 'resource-test',
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      payload,
    } as never),
  ]);
}

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
